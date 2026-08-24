/*
    hostscript.jsx - Backend ExtendScript for Premiere Pro CEP Extension
    Auto Import & Cut V2
*/

#target premierepro

// ============================================================================
// PHIEN BAN - phai KHOP voi APP_VERSION trong js/app.js
// Day la 1 trong 2 cho duy nhat ghi so phien ban (cho con lai la app.js).
// Sua ban moi thi sua CA HAI, neu lech panel se tu bao ngay khi mo.
// Dinh dang: MAJOR.MINOR.PATCH - MAJOR = doi dong san pham (V2 -> V3).
//
// Premiere dung CHUNG mot bo may ExtendScript cho moi panel: panel nap sau se
// ghi de ham cua panel nap truoc. Panel doi chieu bien nay de biet script dang
// chay co dung cua no khong.
// ============================================================================
var IMPORTCUT_VERSION = "2.0.1";

var TICKS_PER_SECOND = 254016000000;
var MEDIA_TYPE = 4;
var MAX_SEARCH_DEPTH = 5;
var VIDEO_EXTENSIONS = ["mp4", "mov", "mxf", "mts", "m4v", "avi", "wmv"];
var HEADER_SCAN_ROWS = 20;

var _session = {
    active: false,
    fileCache: {},
    itemCache: {},
    durationCache: {},
    footageFolder: null,
    lastBody: "",
    lastSourceFolder: "",
    lastFileCode: "",
    lastTramFolder: "",
    replacements: {},
    missingSources: {},
    config: {}
};

function escapeUnicode(str) {
    if (!str) return "";
    var res = "";
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code > 127) {
            var hex = code.toString(16);
            while (hex.length < 4) hex = "0" + hex;
            res += "\\u" + hex;
        } else {
            res += str.charAt(i);
        }
    }
    return res;
}

function toJson(obj) {
    if (obj === null || obj === undefined) return "null";
    if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
    if (typeof obj === "string") {
        var s = obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
        return '"' + escapeUnicode(s) + '"';
    }
    if (obj instanceof Array) {
        var arr = [];
        for (var i = 0; i < obj.length; i++) arr.push(toJson(obj[i]));
        return "[" + arr.join(",") + "]";
    }
    if (typeof obj === "object") {
        var props = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) props.push('"' + escapeUnicode(k) + '":' + toJson(obj[k]));
        }
        return "{" + props.join(",") + "}";
    }
    return '""';
}

function parseJson(str) {
    try { return JSON.parse(str); } catch (e) {}
    try { return eval("(" + str + ")"); } catch (e2) { return null; }
}

function trim(s) { return (s === undefined || s === null) ? "" : s.replace(/^\s+|\s+$/g, ""); }
function normalizePath(p) { if (!p) return ""; return trim(p).replace(/\\/g, "/").toLowerCase(); }

function removeAccents(str) {
    if (!str) return "";
    var a = "\u00e0\u00e1\u1ea1\u1ea3\u00e3\u00e2\u1ea7\u1ea5\u1ead\u1ea9\u1eab\u0103\u1eb1\u1eaf\u1eb7\u1eb3\u1eb5\u00e8\u00e9\u1eb9\u1ebb\u1ebd\u00ea\u1ec1\u1ebf\u1ec7\u1ec3\u1ec5\u00ec\u00ed\u1ecb\u1ec9\u0129\u00f2\u00f3\u1ecd\u1ecf\u00f5\u00f4\u1ed3\u1ed1\u1ed9\u1ed5\u1ed7\u01a1\u1edd\u1edb\u1ee3\u1edf\u1ee1\u00f9\u00fa\u1ee5\u1ee7\u0169\u01b0\u1eeb\u1ee9\u1ef1\u1eed\u1eef\u1ef3\u00fd\u1ef5\u1ef7\u1ef9\u0111\u00c0\u00c1\u1ea0\u1ea2\u00c3\u00c2\u1ea6\u1ea4\u1eac\u1ea8\u1eaa\u0102\u1eb0\u1eae\u1eb6\u1eb2\u1eb4\u00c8\u00c9\u1eb8\u1eba\u1ebc\u00ca\u1ec0\u1ebe\u1ec6\u1ec2\u1ec4\u00cc\u00cd\u1eca\u1ec8\u0128\u00d2\u00d3\u1ecc\u1ece\u00d5\u00d4\u1ed2\u1ed0\u1ed8\u1ed4\u1ed6\u01a0\u1edc\u1eda\u1ee2\u1ede\u1ee0\u00d9\u00da\u1ee4\u1ee6\u0168\u01af\u1eea\u1ee8\u1ef0\u1eec\u1eee\u1ef2\u00dd\u1ef4\u1ef6\u1ef8\u0110";
    var b = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD";
    var res = "";
    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i), idx = a.indexOf(ch);
        res += (idx !== -1) ? b.charAt(idx) : ch;
    }
    return res;
}
function normalizeHeader(s) { return removeAccents(trim(s)).replace(/\s+/g, " ").toLowerCase(); }

// ---- CSV ----
function parseCSV(text) {
    var rows = [], row = [], field = "", inQ = false, i = 0, len = text.length;
    while (i < len) {
        var c = text.charAt(i);
        if (inQ) {
            if (c === '"') { if (text.charAt(i+1) === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
            field += c; i++; continue;
        } else {
            if (c === '"') { inQ = true; i++; continue; }
            else if (c === ',') { row.push(field); field = ""; i++; continue; }
            else if (c === '\r') { i++; continue; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
            else { field += c; i++; continue; }
        }
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

function serializeCSV(rows) {
    var output = [];
    for (var r = 0; r < rows.length; r++) {
        var cells = [];
        for (var c = 0; c < rows[r].length; c++) {
            var value = String(rows[r][c] === undefined || rows[r][c] === null ? "" : rows[r][c]);
            if (/[",\r\n]/.test(value)) value = '"' + value.replace(/"/g, '""') + '"';
            cells.push(value);
        }
        output.push(cells.join(","));
    }
    return output.join("\r\n");
}

function cep_applyNormalizedScript(csvContent, editsJson, colsJson) {
    try {
        var rows = parseCSV(csvContent || ""), edits = parseJson(editsJson) || [], cols = parseJson(colsJson) || {};
        for (var i = 0; i < edits.length; i++) {
            var edit = edits[i], rowIndex = parseInt(edit.rowIndex, 10);
            if (!edit || isNaN(rowIndex) || !rows[rowIndex]) continue;
            var fields = ["source", "code", "time", "tramSource", "tramCode", "tramTime"];
            var columns = { source: cols.sourceCol, code: cols.codeCol, time: cols.timeCol,
                tramSource: cols.tramSourceCol, tramCode: cols.tramCodeCol, tramTime: cols.tramTimeCol };
            for (var f = 0; f < fields.length; f++) {
                var field = fields[f], col = columns[field];
                if (col !== undefined && col !== null && parseInt(col, 10) >= 0 && edit[field] !== undefined) rows[rowIndex][parseInt(col, 10)] = String(edit[field]);
            }
        }
        var normalized = serializeCSV(rows);
        var normalizedPath = Folder.temp.fsName + "/autoimportcut_normalized_" + (new Date().getTime()) + ".csv";
        writeTextFile(normalizedPath, normalized, true);
        return toJson({ success: true, csvContent: normalized, normalizedPath: normalizedPath });
    } catch (e) { return toJson({ success: false, error: "Lỗi tạo kịch bản chuẩn hóa: " + e.toString() }); }
}

// =========================================================================
// COLUMN DETECTION - quy tac chung cho MOI kieu bang kich ban
// =========================================================================
// Tu duy theo HANG NGANG, khong doan theo tu khoa header:
//   - Moi cot chua MA FILE mo dau mot NHOM.
//   - Nhom BEN TRAI nhat   = source CHINH -> chen xuong V1.
//   - Nhom xuat hien SAU do = source TRAM -> chen len V2 (tram len clip chinh cung hang).
//   - Cot duong dan cua nhom = cot path gan nhat ben TRAI cot ma file (cap [folder][file]).
//   - Cot timecode cua nhom  = cot time nam trong PHAM VI cot cua nhom do.
// Nho quy tac pham vi, cot kieu "TIMEVOICE OFF" (thoi luong loi thoai) nam ngoai nhom
// se khong bao gio bi nham thanh timecode cat video.
// Bang co the KHONG co cot timecode -> timeCol = -1, clip lay thoi luong mac dinh.

var VOICE_HEADER_HINTS = ["voice", "thoai", "sub", "nhac", "audio", "giong", "mp3", "v.o"];
function isVoiceHeader(t) {
    for (var i = 0; i < VOICE_HEADER_HINTS.length; i++) { if (t.indexOf(VOICE_HEADER_HINTS[i]) !== -1) return true; }
    return false;
}

// Nhieu sheet dan duong dan kem dau nhay bao quanh: "\\NAS\...\A.mp4"
// -> phai bo dau nhay truoc khi kiem tra / mo file, neu khong File() se khong thay.
function stripQuotes(s) {
    return trim(String(s === undefined || s === null ? "" : s)).replace(/^[\s"'\u201c\u201d\u2018\u2019]+/, "").replace(/[\s"'\u201c\u201d\u2018\u2019]+$/, "");
}

function firstLineOf(v) { return stripQuotes(String(v).split(/[\r\n]+/)[0]); }

/** O chua DUONG DAN DAY DU toi 1 file video (khong can cot thu muc di kem). */
function looksLikeFullFilePath(v) {
    var s = firstLineOf(v);
    return looksLikePath(s) && hasVideoExtension(s);
}

function looksLikePath(v) {
    var s = firstLineOf(v);
    if (s.length < 3) return false;
    if (s.charAt(0) === "\\" && s.charAt(1) === "\\") return true;      // UNC \\server\share
    if (/^[a-zA-Z]:[\\\/]/.test(s)) return true;                        // D:\ hoac D:/
    if (/^https?:\/\//i.test(s)) return true;                           // URL
    return false;
}

/** Gia tri o cot source co dung la thu muc/link khong (de loc ghi chu lot vao cot source). */
function looksLikeFolderValue(v) {
    var s = firstLineOf(v);
    if (s === "") return false;
    if (looksLikePath(s)) return true;
    return (s.indexOf("\\") !== -1 || s.indexOf("/") !== -1);
}

function looksLikeCode(v) {
    var s = firstLineOf(v);
    if (s === "" || s.length > 60) return false;
    if (looksLikePath(s)) return false;
    if (/^([Cc]\d{3,}|[Dd][Jj][Ii]_[A-Za-z0-9_\-]+|[Gg][Hh]\d{3,}|[Gg][Pp]\d{3,}|GOPR\d+|FPV\S*|[A-Za-z]{1,4}\d{3,}[A-Za-z0-9_\-]*)$/.test(s)) return true;
    if (hasVideoExtension(s) && s.indexOf("\\") === -1 && s.indexOf("/") === -1) return true;  // "C0704.MP4"
    return false;
}

// Timecode: uu tien dang khoang "0:07 - 0:19", chap nhan mot moc "00:06" / "1:22:30".
// Ti le khung hinh ("9:16", "4:5") luon nam trong cau chu dai nen khong bi tinh.
/**
 * Dang KHOANG timecode "00:24 - 00:36" - tin hieu manh nhat cua cot timecode cat video.
 * Chap nhan don vi dinh kem sau moc gio: "00:40s- 00:45s", "01:20 giay - 01:30".
 */
function looksLikeTimeRange(v) {
    var s = removeAccents(trim(String(v))).toLowerCase();
    if (s === "") return false;
    var hasStartWord = /\b(dau|tu dau|bat dau)\b/.test(s);
    var hasEndWord = /\b(het|cuoi|den het|den cuoi|toi cuoi|end)\b/.test(s);
    var hasTime = /\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?/.test(s);
    var hasSeparator = /[-~\u2013\u2014]/.test(s);
    return hasSeparator && hasTime && (hasStartWord || hasEndWord ||
        /\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?\s*[a-z]{0,5}\s*[-~\u2013\u2014]\s*\d{1,2}\s*:\s*\d{2}/.test(s));
}

// Tu ngu thuong bi go kem timecode trong cot ghi chu: "lay tu 00:40s - 00:45s".
var TIME_NOISE_WORDS = /\b(lay|tu|den|toi|dn|khoang|trong|giay|phut|sec|s|m|cat|doan|canh|time|tc|note|ghi|chu)\b/g;

/**
 * O CHI chua timecode (cho phep nhieu doan tren nhieu dong, cho phep vai tu dem
 * kieu "lay tu ... s"), khong phai cau van co lot moc gio.
 * "00:24 - 00:36"                     -> true
 * "lay tu 00:40s- 00:45s"             -> true
 * "01:12 - 01:16\n01:19 - 01:21"      -> true
 * "Bac si noi tu 0:25 - 0:36 ve benh" -> false
 */
function looksLikeTimeRangeCell(v) {
    var s = trim(String(v));
    if (s === "" || !looksLikeTimeRange(s)) return false;
    var norm = removeAccents(s).toLowerCase();
    var lines = norm.split(/[\r\n]+/), total = 0, good = 0;
    for (var i = 0; i < lines.length; i++) {
        var ln = trim(lines[i]);
        if (ln === "") continue;
        total++;
        var rest = ln.replace(/\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?/g, " ")
                     .replace(TIME_NOISE_WORDS, " ")
                     .replace(/[-~\u2013\u2014\s,;:\.\|\/\(\)\d]+/g, "");
        if (rest.length <= 4) good++;
    }
    return (total > 0 && good * 2 >= total);
}

function looksLikeTimecode(v) {
    var s = trim(String(v));
    if (s === "") return false;
    if (looksLikeTimeRange(s)) return true;
    if (s.length <= 12 && /^([A-Za-z\u00C0-\u1EF9]{1,3}\s+)?\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?$/.test(s)) return true;
    if (/\b(dau|tu dau|bat dau|het|cuoi|den het|den cuoi|toi cuoi|end)\b/i.test(removeAccents(s))) return true;
    if (/\d{2}\s*:\s*\d{2}/.test(s)) return true;
    return false;
}

/** Dem so o khop tung loai (path / code / time) cho tung cot. */
function scanContentScores(rows, fromRow, maxRows) {
    var numCols = 0, r, c;
    for (r = 0; r < rows.length; r++) { if (rows[r] && rows[r].length > numCols) numCols = rows[r].length; }
    var sc = { numCols: numCols, path: [], code: [], time: [], timeRange: [], full: [] };
    for (c = 0; c < numCols; c++) { sc.path[c] = 0; sc.code[c] = 0; sc.time[c] = 0; sc.timeRange[c] = 0; sc.full[c] = 0; }
    var endRow = Math.min(rows.length, fromRow + maxRows);
    for (r = fromRow; r < endRow; r++) {
        var row = rows[r]; if (!row) continue;
        for (c = 0; c < row.length; c++) {
            var v = trim(row[c]); if (v === "") continue;
            if (looksLikePath(v)) { sc.path[c]++; if (looksLikeFullFilePath(v)) sc.full[c]++; }
            else if (looksLikeCode(v)) sc.code[c]++;
            if (looksLikeTimecode(v)) sc.time[c]++;
            if (looksLikeTimeRangeCell(v)) sc.timeRange[c]++;
        }
    }
    return sc;
}

function sortNumAsc(a, b) { return a - b; }

/**
 * Gom cot thanh cac NHOM theo vi tri trai -> phai.
 * Tra ve [{sourceCol, codeCol, timeCol}], phan tu [0] la source chinh.
 */
function buildColumnGroups(sourceCols, codeCols, timeCols, voiceCols, content, blockedCols) {
    var groups = [], usedSrc = {}, usedTime = {}, i, j;
    if (!codeCols || codeCols.length === 0) return groups;
    var pre = [];
    for (i = 0; i < codeCols.length; i++) {
        var codeCol = codeCols[i];
        var nextCode = (i + 1 < codeCols.length) ? codeCols[i + 1] : 99999;
        // Cot chua san DUONG DAN DAY DU toi file -> tu no la ca nhom, khong an cot thu muc nao.
        var isFullCode = !!(content && content.full && content.full[codeCol] >= 1);
        var srcCol = -1;
        if (!isFullCode) {
            for (j = sourceCols.length - 1; j >= 0; j--) {
                if (sourceCols[j] < codeCol && !usedSrc[sourceCols[j]]) { srcCol = sourceCols[j]; break; }
            }
            if (srcCol === -1) {
                for (j = 0; j < sourceCols.length; j++) {
                    if (sourceCols[j] > codeCol && sourceCols[j] < nextCode && !usedSrc[sourceCols[j]]) { srcCol = sourceCols[j]; break; }
                }
            }
            if (srcCol !== -1) usedSrc[srcCol] = true;
        }
        pre.push({ codeCol: codeCol, sourceCol: srcCol, fullPathCode: isFullCode,
                   start: (srcCol !== -1 && srcCol < codeCol) ? srcCol : codeCol });
    }
    // Cot da bi chiem lam source/ma file cua bat ky nhom nao -> khong the la cot timecode.
    var takenCols = {};
    for (i = 0; i < pre.length; i++) {
        takenCols[pre[i].codeCol] = true;
        if (pre[i].sourceCol !== -1) takenCols[pre[i].sourceCol] = true;
    }

    for (i = 0; i < pre.length; i++) {
        var g = pre[i];
        var end = (i + 1 < pre.length) ? pre[i + 1].start : 99999;
        var tCol = -1;
        for (j = 0; j < timeCols.length; j++) {
            if (timeCols[j] >= g.start && timeCols[j] < end && !usedTime[timeCols[j]]) { tCol = timeCols[j]; break; }
        }

        // Header cua nhom co the khong he co chu "TIME" (vd "DOAN VOICE/TRAM", "CAT TU - DEN").
        // Khi do dua vao NOI DUNG: cot nam TRONG pham vi nhom ma du lieu that su la khoang
        // timecode "00:24 - 00:36" thi chinh la cot timecode cua nhom do.
        // Van an toan voi cot "TIMEVOICE OFF" (thoi luong loi thoai) vi cot do nam ngoai pham vi nhom.
        if (tCol === -1 && content && content.timeRange) {
            var bestCol = -1, bestScore = 0, bestDist = 99999;
            var scanEnd = Math.min(end, content.numCols);
            for (j = g.start; j < scanEnd; j++) {
                if (usedTime[j] || takenCols[j]) continue;
                if (blockedCols && blockedCols[j]) continue;
                var score = content.timeRange[j] || 0;
                if (score === 0) continue;
                var dist = Math.abs(j - g.codeCol);
                if (score > bestScore || (score === bestScore && dist < bestDist)) {
                    bestCol = j; bestScore = score; bestDist = dist;
                }
            }
            if (bestCol !== -1) tCol = bestCol;
        }
        // Bang chi co 1 nhom: chap nhan cot time nam ngoai pham vi (vd cot Time dat truoc Source),
        // nhung tuyet doi bo qua cot lien quan loi thoai / voice-off.
        if (tCol === -1 && pre.length === 1) {
            var bestDist = 99999;
            for (j = 0; j < timeCols.length; j++) {
                var tc = timeCols[j];
                if (usedTime[tc] || (voiceCols && voiceCols[tc])) continue;
                var d = Math.abs(tc - g.codeCol);
                if (d < bestDist) { bestDist = d; tCol = tc; }
            }
        }
        if (tCol !== -1) usedTime[tCol] = true;
        groups.push({ sourceCol: g.sourceCol, codeCol: g.codeCol, timeCol: tCol, fullPathCode: g.fullPathCode });
    }
    return groups;
}

function groupsToCols(groups, bodyCol, headerRowIndex, byContent) {
    if (!groups || groups.length === 0) return null;
    var g1 = groups[0], g2 = (groups.length > 1) ? groups[1] : null;
    if (g1.codeCol === -1) return null;
    // Khong co cot thu muc van hop le NEU cot file da chua duong dan day du.
    if (g1.sourceCol === -1 && !g1.fullPathCode) return null;
    return {
        bodyCol: bodyCol,
        sourceCol: g1.sourceCol, codeCol: g1.codeCol, timeCol: g1.timeCol,
        fullPathCode: !!g1.fullPathCode,
        tramSourceCol: g2 ? g2.sourceCol : -1,
        tramCodeCol: g2 ? g2.codeCol : -1,
        tramTimeCol: g2 ? g2.timeCol : -1,
        headerRowIndex: headerRowIndex,
        detectedByContent: byContent,
        groupCount: groups.length
    };
}

function detectColumnsByHeader(rows) {
    var content = scanContentScores(rows, 0, 200);
    for (var r = 0; r < Math.min(HEADER_SCAN_ROWS, rows.length); r++) {
        var row = rows[r]; if (!row) continue;
        var srcC = [], codeC = [], timeC = [], bodyC = [], voiceCols = {}, tramCols = {};
        for (var c = 0; c < row.length; c++) {
            var raw = trim(row[c] || "");
            // O tieu de that su luon la nhan ngan. Duong dan / cau ghi chu dai chi la dong rac
            // dau bang - chung hay chua san chu "Source", "NAS", "time"... nen phai loai truoc.
            if (raw === "" || raw.length > 50 || looksLikePath(raw)) continue;
            var t = normalizeHeader(raw);
            if (t === "") continue;
            if (isVoiceHeader(t)) voiceCols[c] = true;
            if (t.indexOf("tram") !== -1) tramCols[c] = true;
            if (t === "body" || t.indexOf("mach video") !== -1 || t.indexOf("noi dung") !== -1) { bodyC.push(c); continue; }
            if (t.indexOf("time") !== -1 || t.indexOf("thoi gian") !== -1 || t.indexOf("thoi luong") !== -1) { timeC.push(c); continue; }
            if (t.indexOf("source") !== -1 || t.indexOf("thu muc") !== -1 || t.indexOf("duong dan") !== -1 ||
                t.indexOf("folder") !== -1 || t.indexOf("nas") !== -1 || t.indexOf("path") !== -1) { srcC.push(c); continue; }
            if (t.indexOf("ten file") !== -1 || t.indexOf("ma file") !== -1 || t.indexOf("ma so") !== -1 ||
                t === "code" || t === "ma" || (t.indexOf("file") !== -1 && t.indexOf("source") === -1)) { codeC.push(c); continue; }
        }

        // --- Doi chieu voi NOI DUNG THAT: ten header co the dat sai vi tri ---
        // Cot mang ten "SOURCE" nhung ben trong toan ma file -> xep lai thanh cot ma file.
        for (var k = srcC.length - 1; k >= 0; k--) {
            var sCol = srcC[k];
            var strong = (content.code[sCol] >= 2 && content.code[sCol] > content.path[sCol]);
            var pairedWithFolder = (content.code[sCol] >= 1 && content.code[sCol] > content.path[sCol] &&
                                    sCol > 0 && content.path[sCol - 1] >= 1);
            if (strong || pairedWithFolder) { codeC.push(sCol); srcC.splice(k, 1); }
        }
        // Cot mang ten "TIME" nhung khong he chua timecode -> tra ve dung ban chat cua no.
        for (var k2 = timeC.length - 1; k2 >= 0; k2--) {
            var tCol2 = timeC[k2];
            if (content.time[tCol2] > 0) continue;
            timeC.splice(k2, 1);
            if (content.path[tCol2] >= 1) srcC.push(tCol2);
            else if (content.code[tCol2] >= 1) codeC.push(tCol2);
        }
        // Cot "SOURCE" chua san DUONG DAN DAY DU toi file (khong co cot ma file rieng)
        // -> chinh no la cot file, mo thang duong dan do.
        for (var k3 = srcC.length - 1; k3 >= 0; k3--) {
            var fCol = srcC[k3];
            if (content.full[fCol] >= 1) { codeC.push(fCol); srcC.splice(k3, 1); }
        }

        if (codeC.length === 0) continue;
        srcC.sort(sortNumAsc); codeC.sort(sortNumAsc); timeC.sort(sortNumAsc);
        // Cam do noi dung: cot noi dung/loi thoai va cot thoi luong voice-off thuan tuy
        // ("TIMEVOICE OFF", "TIME VOICE") - tru khi header co nhac toi "tram" (vd "DOAN VOICE/TRAM").
        var blocked = {};
        for (var bi = 0; bi < bodyC.length; bi++) blocked[bodyC[bi]] = true;
        for (var vc in voiceCols) { if (voiceCols.hasOwnProperty(vc) && !tramCols[vc]) blocked[vc] = true; }
        var cols = groupsToCols(buildColumnGroups(srcC, codeC, timeC, voiceCols, content, blocked),
                                (bodyC.length > 0 ? bodyC[0] : -1), r, false);
        if (cols) return cols;
    }
    return null;
}

function detectColumnsByContent(rows) {
    var sc = scanContentScores(rows, 0, 200);
    if (sc.numCols === 0) return null;
    var srcC = [], codeC = [], timeC = [];
    for (var c = 0; c < sc.numCols; c++) {
        var p = sc.path[c], k = sc.code[c], t = sc.time[c];
        // Duong dan day du toi file = vua source vua ma file -> xep vao nhom cot file.
        // Bang khong co header: doi it nhat 2 o de tranh mot o duong dan lac vao cot ghi chu
        // bi hieu nham thanh cot file (o le van duoc nhat lai bang quet theo hang ngang).
        if (sc.full[c] >= 2) codeC.push(c);
        // Chap nhan cot chi co 1 ma file neu cot ben trai la cot duong dan (cap [folder][file])
        else if (k >= 1 && k > p && (k >= 2 || (c > 0 && sc.path[c - 1] >= 1))) codeC.push(c);
        else if (p >= 1) srcC.push(c);
        if (t >= 2) timeC.push(c);
    }
    if (codeC.length === 0) return null;
    var groups = buildColumnGroups(srcC, codeC, timeC, {}, sc, null);
    if (groups.length === 0) return null;

    var g = groups[0], firstDataRow = 0;
    for (var r = 0; r < Math.min(30, rows.length); r++) {
        var row = rows[r]; if (!row) continue;
        var pv = (g.sourceCol !== -1 && g.sourceCol < row.length) ? trim(row[g.sourceCol]) : "";
        var kv = (g.codeCol !== -1 && g.codeCol < row.length) ? trim(row[g.codeCol]) : "";
        if (looksLikePath(pv) || looksLikeCode(kv)) { firstDataRow = r; break; }
    }
    // firstDataRow = 0 -> khong co dong tieu de -> headerRowIndex = -1 (khong bo sot dong dau)
    return groupsToCols(groups, -1, firstDataRow - 1, true);
}

function detectColumns(rows) {
    var byH = detectColumnsByHeader(rows);
    if (byH) return byH;
    return detectColumnsByContent(rows);
}

// ---- URL Helpers ----
function extractUrls(text) {
    if (!text) return [];
    var urls = [], regex = /(https?:\/\/[^\s\r\n",<>]+)/gi, match;
    while ((match = regex.exec(text)) !== null) { var u = trim(match[1]); if (u !== "") urls.push(u); }
    return urls;
}
function isEnvatoUrl(url) { return url.toLowerCase().indexOf("envato.com") !== -1; }
function isYouTubeUrl(url) { var l = url.toLowerCase(); return l.indexOf("youtube.com") !== -1 || l.indexOf("youtu.be") !== -1; }
function getExtensionFromUrl(url) {
    var clean = url.split("?")[0].split("#")[0], ld = clean.lastIndexOf(".");
    if (ld !== -1 && ld > clean.lastIndexOf("/")) { var ext = clean.substring(ld+1).toLowerCase(); if (ext.length >= 2 && ext.length <= 4) return ext; }
    return "jpg";
}

function downloadFileFromUrl(url, destPath) {
    try {
        url = trim(url); if (url === "") return null;
        var destFile = new File(destPath);
        if (!destFile.parent.exists) destFile.parent.create();
        if (destFile.exists && destFile.length > 0) return destFile;
        var cleanPath = destPath.replace(/\//g, "\\");
        app.system('C:\\Windows\\System32\\curl.exe -L -k -s -A "Mozilla/5.0" -o "' + cleanPath + '" "' + url + '"');
        var c1 = new File(destPath); if (c1.exists && c1.length > 0) return c1;
        app.system('powershell.exe -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ProgressPreference = \'SilentlyContinue\'; (New-Object Net.WebClient).DownloadFile(\'' + url.replace(/'/g,"''") + '\', \'' + cleanPath.replace(/'/g,"''") + '\')"');
        var c2 = new File(destPath); if (c2.exists && c2.length > 0) return c2;
        return null;
    } catch(e) { return null; }
}

function getOrCreateBlackVideoItem(footageFolder) {
    var folderPath = footageFolder ? footageFolder.fsName : (app.project.path ? new File(app.project.path).parent.fsName : Folder.temp.fsName);
    var blackPath = folderPath + "/Black_Video.png";
    var blackFile = new File(blackPath);
    if (!blackFile.exists || blackFile.length === 0) {
        var b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        app.system('powershell -NoProfile -Command "[IO.File]::WriteAllBytes(\'' + blackPath.replace(/\//g,"\\") + '\', [Convert]::FromBase64String(\'' + b64 + '\'))"');
    }
    return importAndGetProjectItem(blackPath);
}

// ---- Timecode Helpers ----
function parseTimeToSeconds(str) {
    if (!str) return null;
    str = trim(str).replace(/\s+/g, "");
    var parts = str.split(":"), seconds = 0, mult = [1, 60, 3600];
    for (var j = 0; j < parts.length; j++) {
        var idx = parts.length - 1 - j, val = parseFloat(parts[idx]);
        if (isNaN(val)) return null;
        seconds += val * mult[j];
    }
    return seconds;
}

// parseAllTimeRanges: hỗ trợ ô time có nhiều đoạn trên nhiều dòng
// VD: "01:12 - 01:16\n01:19 - 01:21\n01:24 - 01:35" -> [{inSec:72,outSec:76},{inSec:79,outSec:81},{inSec:84,outSec:95}]
function parseAllTimeRanges(str) {
    str = trim(str);
    if (str === "") return [{ mode: "auto" }];
    var upper = removeAccents(str).toUpperCase();
    if (upper === "N.A" || upper === "N/A" || upper === "NA" || upper === "BO QUA") return null; // null = skip row

    var results = [];

    // Split by newline to get individual range lines
    var lines = str.split(/[\r\n]+/);
    for (var li = 0; li < lines.length; li++) {
        var line = trim(lines[li]);
        if (line === "") continue;

        // Extract all timecodes from this line
        var timeRegex = /(\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?)/g;
        var matches = [], match;
        while ((match = timeRegex.exec(line)) !== null) {
            matches.push(match[1].replace(/\s+/g, ""));
        }
        var normalizedLine = removeAccents(line).toLowerCase();
        var hasStartMarker = /\b(dau|tu dau|bat dau)\b/.test(normalizedLine);
        var hasEndMarker = /\b(het|cuoi|den het|den cuoi|toi cuoi|end)\b/.test(normalizedLine);

        if (matches.length >= 1 && hasEndMarker) {
            var endStart = parseTimeToSeconds(matches[0]);
            if (endStart !== null) results.push({ mode: "end", inSec: endStart, outSec: -1 });
        } else if (matches.length >= 1 && hasStartMarker) {
            var startEnd = parseTimeToSeconds(matches[matches.length - 1]);
            if (startEnd !== null) results.push({ mode: "full", inSec: 0, outSec: startEnd });
        } else if (matches.length >= 2) {
            // Line has at least 2 timecodes: treat as start-end range
            var inSec = parseTimeToSeconds(matches[0]);
            var outSec = parseTimeToSeconds(matches[matches.length - 1]);
            if (inSec !== null && outSec !== null && outSec > inSec) {
                results.push({ mode: "full", inSec: inSec, outSec: outSec });
            } else if (inSec !== null) {
                results.push({ mode: "start", inSec: inSec });
            }
        } else if (matches.length === 1) {
            var s = parseTimeToSeconds(matches[0]);
            if (s !== null) results.push({ mode: "start", inSec: s });
        }
        // Line with no timecodes is ignored (may be label text like "hook:")
    }

    if (results.length === 0) return [{ mode: "auto" }];
    return results;
}

// Legacy single-range wrapper (used by tram, url-based clips)
function parseTimeRange(str) {
    var all = parseAllTimeRanges(str);
    if (all === null) return null;
    return all[0];
}

// ---- Split file code from embedded timecode in same cell ----
// Example: "C5439 - 02:00" -> { codes: "C5439", embeddedTime: "02:00" }
// Example: "DJI_0032 00:10-00:45" -> { codes: "DJI_0032", embeddedTime: "00:10-00:45" }
// Recognizes file code patterns: C####, DJI_, GH#, GP#, GOPR, FPV, etc.
function splitCodeAndTimecode(raw) {
    if (!raw || trim(raw) === "") return { codes: "", embeddedTime: "" };

    // Extract all timecode patterns (MM:SS or HH:MM:SS) from the raw string
    var timeRegex = /(\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?)/g;
    var timeMatches = [];
    var match;
    while ((match = timeRegex.exec(raw)) !== null) {
        timeMatches.push(match[1]);
    }

    // Remove timecode patterns from the raw string to get remaining text
    var stripped = raw.replace(/(\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?)/g, " ");
    // Remove separator chars (dash, slash, pipe, parentheses) that surrounded the timecode
    stripped = stripped.replace(/[-\|\(\)~]+/g, " ").replace(/\s+/g, " ");

    // Now extract file code tokens from the stripped text
    // A file code is: C####, DJI_xxxx, GH####, GP####, GOPR####, FPV*, or any ALLCAPS+digit token
    var codePattern = /\b([Cc]\d{3,}|[Dd][Jj][Ii]_\S+|[Gg][Hh]\d+|[Gg][Pp]\d+|[Gg][Oo][Pp][Rr]\d*|[Ff][Pp][Vv]\S*|[A-Z]{1,4}\d{3,}\S*)\b/g;
    var codeTokens = [];
    while ((match = codePattern.exec(stripped)) !== null) {
        var tok = trim(match[1]);
        if (tok !== "") codeTokens.push(tok);
    }

    // If no recognized code pattern found, use the whole stripped text as code (fallback)
    var codesStr = codeTokens.length > 0 ? codeTokens.join("\n") : trim(stripped);
    var embeddedTimeStr = timeMatches.join(" - ");

    return { codes: codesStr, embeddedTime: embeddedTimeStr };
}

// Out point HIEN TAI cua project item. Chi phan anh diem cat dang duoc dat,
// KHONG phai thoi luong that cua media (xem getProjectItemDuration).
function readCurrentOutPointSeconds(projectItem) {
    try {
        var op = projectItem.getOutPoint(MEDIA_TYPE);
        if (op && op.ticks) { var t = parseFloat(op.ticks); if (!isNaN(t) && t > 0) return t / TICKS_PER_SECOND; }
        return null;
    } catch(e) { return null; }
}

var PROBE_SECONDS = 14400; // 4 gio - dai hon moi footage thuc te, van an toan voi so nguyen JS

/**
 * Doc thoi luong media tu metadata cua project (Column.Intrinsic.MediaDuration).
 * Cach nay CHI DOC, khong sua in/out point, va khong bi anh huong boi cac lan cat.
 * Gia tri o dang timecode "HH;MM;SS;FF" -> can frame rate de doi frame ra giay.
 * Tra ve null neu khong doc/khong hieu duoc (de goi tiep phep do khac).
 */
function readMediaDurationFromMetadata(projectItem) {
    var xmp = null;
    try { if (projectItem.getProjectMetadata) xmp = projectItem.getProjectMetadata(); } catch (e) { return null; }
    if (!xmp) return null;

    var m = /Column\.Intrinsic\.MediaDuration[^>]*>([^<]+)</.exec(String(xmp));
    if (!m) return null;

    // Chi chap nhan dang timecode 4 phan HH:MM:SS:FF (hoac dung dau ';').
    var parts = trim(m[1]).split(/[;:]/);
    if (parts.length !== 4) return null;
    var hh = parseFloat(parts[0]), mm = parseFloat(parts[1]), ss = parseFloat(parts[2]), ff = parseFloat(parts[3]);
    if (isNaN(hh) || isNaN(mm) || isNaN(ss) || isNaN(ff)) return null;

    var fps = 0;
    try {
        var fi = projectItem.getFootageInterpretation();
        if (fi && fi.frameRate) fps = parseFloat(fi.frameRate);
    } catch (e2) {}
    if (isNaN(fps) || fps <= 0) fps = 25; // sai so toi da < 1 frame, khong dang ke

    var sec = hh * 3600 + mm * 60 + ss + ff / fps;
    if (isNaN(sec) || sec <= 0 || sec > PROBE_SECONDS) return null;
    return sec;
}

/**
 * Do thoi luong THAT cua media, khong bi anh huong boi cac lan cat truoc do.
 * Cach lam: dat out point ra mot moc vo ly lon; Premiere se ket (clamp) no ve
 * cuoi media -> doc lai chinh la thoi luong that. Neu Premiere nhan nguyen moc
 * vo ly do (khong clamp) thi phep do khong dang tin -> tra ve null.
 * In/out point ban dau duoc phuc hoi sau khi do.
 */
function probeIntrinsicDuration(projectItem) {
    var probeTicks = Math.round(PROBE_SECONDS * TICKS_PER_SECOND);
    var savedIn = null, savedOut = null;
    try { savedIn = projectItem.getInPoint(MEDIA_TYPE); } catch (e1) {}
    try { savedOut = projectItem.getOutPoint(MEDIA_TYPE); } catch (e2) {}

    var result = null;
    try {
        projectItem.setInPoint("0", MEDIA_TYPE);
        projectItem.setOutPoint(probeTicks.toString(), MEDIA_TYPE);
        var op = projectItem.getOutPoint(MEDIA_TYPE);
        if (op && op.ticks) {
            var t = parseFloat(op.ticks);
            // t == probeTicks => Premiere khong clamp, phep do vo nghia.
            if (!isNaN(t) && t > 0 && t < probeTicks * 0.999) result = t / TICKS_PER_SECOND;
        }
    } catch (e3) { result = null; }

    // Phuc hoi out truoc, roi in (tranh in > out lam Premiere bo qua lenh).
    try { if (savedOut && savedOut.ticks) projectItem.setOutPoint(savedOut.ticks.toString(), MEDIA_TYPE); } catch (e4) {}
    try { if (savedIn && savedIn.ticks) projectItem.setInPoint(savedIn.ticks.toString(), MEDIA_TYPE); } catch (e5) {}

    return result;
}

function projectItemCacheKey(projectItem) {
    try { if (projectItem.nodeId) return "n:" + projectItem.nodeId; } catch (e) {}
    try { if (projectItem.name) return "m:" + projectItem.name; } catch (e2) {}
    return null;
}

/**
 * Thoi luong that cua media (giay), hoac null neu khong doc duoc.
 * LUU Y: khong duoc dung getOutPoint() truc tiep lam thoi luong - project item
 * duoc dung lai giua cac dong (itemCache) va giua cac lan chay, nen out point
 * thuong da bi cat ngan tu truoc. Do chinh la nguyen nhan moc "het" (END)
 * bi rot ve defaultDuration 5s.
 */
function getProjectItemDuration(projectItem) {
    if (!projectItem) return null;
    var key = projectItemCacheKey(projectItem);
    if (key !== null && _session.durationCache[key] > 0) return _session.durationCache[key];

    var dur = readMediaDurationFromMetadata(projectItem);   // 1. chi doc, dang tin nhat
    if (dur === null) dur = probeIntrinsicDuration(projectItem); // 2. do bang clamp out point
    if (dur === null) dur = readCurrentOutPointSeconds(projectItem); // 3. cuoi cung: co the bi cat ngan
    if (dur !== null && dur > 0 && key !== null) _session.durationCache[key] = dur;
    return dur;
}

function resolveNormalizedTimeRange(timeInfo, totalDuration, defaultDuration) {
    if (timeInfo.mode !== "end") return null;
    var start = Math.max(0, timeInfo.inSec);
    if (totalDuration !== null && totalDuration > start) {
        return { inSec: start, outSec: totalDuration, exact: true };
    }
    // Khong biet media dai bao nhieu (hoac moc bat dau vuot qua thoi luong doc duoc)
    // -> danh phai lay defaultDuration. Bao cho nguoi dung biet thay vi cat sai am tham.
    return { inSec: start, outSec: start + defaultDuration, exact: false, knownDuration: totalDuration };
}

// ---- File Helpers ----
function hasVideoExtension(filename) {
    var lower = filename.toLowerCase();
    for (var i = 0; i < VIDEO_EXTENSIONS.length; i++) { var ext = "." + VIDEO_EXTENSIONS[i]; if (lower.indexOf(ext) === lower.length - ext.length) return true; }
    return false;
}

function findFilesByCode(folder, code, depth, results) {
    if (depth > MAX_SEARCH_DEPTH || !folder.exists) return;
    var items; try { items = folder.getFiles(); } catch(e) { return; }
    if (!items) return;
    var codeLower = code.toLowerCase();
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item instanceof Folder) findFilesByCode(item, code, depth+1, results);
        else if (item instanceof File && hasVideoExtension(item.name) && item.name.toLowerCase().indexOf(codeLower) !== -1) results.push(item);
    }
}

function findProjectItemByPath(rootItem, targetNorm) {
    for (var i = 0; i < rootItem.children.numItems; i++) {
        var item = rootItem.children[i];
        if (item.type === ProjectItemType.BIN) { var found = findProjectItemByPath(item, targetNorm); if (found) return found; }
        else { try { var mp = item.getMediaPath(); if (mp && normalizePath(mp) === targetNorm) return item; } catch(e) {} }
    }
    return null;
}

function importAndGetProjectItem(fsPath) {
    var normPath = normalizePath(fsPath);
    var existing = findProjectItemByPath(app.project.rootItem, normPath);
    if (existing) return existing;
    // ExtendScript importFiles requires Windows backslash path on Windows
    var winPath = fsPath.replace(/\//g, "\\");
    var ok = app.project.importFiles([winPath], true, app.project.rootItem, false);
    if (!ok) return null;
    var found = findProjectItemByPath(app.project.rootItem, normPath);
    if (found) { waitForMediaReady(found, 6000); return found; }
    var fileNameNorm = normalizePath(new File(fsPath).name);
    for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
        var it = app.project.rootItem.children[i];
        if (normalizePath(it.name) === fileNameNorm) { waitForMediaReady(it, 6000); return it; }
    }
    return null;
}

/**
 * Sau importFiles(), Premiere doc thong tin media BAT DONG BO.
 * Neu goi setInPoint/setOutPoint khi media chua san sang, lenh trim se bi bo qua
 * -> overwriteClip chen NGUYEN clip goc (day chinh la loi "clip dai hon timecode").
 * Ham nay cho den khi project item bao duoc thoi luong that (toi da maxMs mili giay).
 */
function waitForMediaReady(projectItem, maxMs) {
    if (!projectItem) return false;
    var waited = 0, step = 50;
    while (waited <= maxMs) {
        // Doc out point tho: chi can biet media da co thong tin hay chua.
        // Khong dung getProjectItemDuration (co phep do ghi/khoi phuc in-out).
        var d = readCurrentOutPointSeconds(projectItem);
        if (d !== null && d > 0) return true;
        try { $.sleep(step); } catch (e) { return false; }
        waited += step;
    }
    return false;
}

function getOrCreateFootageFolder(folderName) {
    try {
        var projectPath = app.project.path;
        if (!projectPath || trim(projectPath) === "") {
            // Project chưa lưu: dùng thư mục Desktop hoặc Temp
            projectPath = Folder.desktop.fsName + "/UntitledProject.prproj";
        }
        var parentDir = new File(projectPath).parent.fsName;
        var ff = new Folder(parentDir + "/" + (folderName || "Footage"));
        if (!ff.exists && !ff.create()) return null;
        return ff;
    } catch(e) { return null; }
}

// ---- Bao cao tien do copy cho panel qua 1 file JSON tam ----
// Panel (Node.js) doc file nay + do dung luong file dich de tinh % va toc do copy.
var _copyProgressPath = null;

function copyProgressFilePath() {
    if (_copyProgressPath === null) {
        try { _copyProgressPath = Folder.temp.fsName + "/autoimportcut_v2_copy_progress.json"; }
        catch (e) { _copyProgressPath = ""; }
    }
    return _copyProgressPath;
}

function writeCopyProgress(obj) {
    try {
        var p = copyProgressFilePath();
        if (!p) return;
        var f = new File(p);
        f.encoding = "UTF-8";
        if (!f.open("w")) return;
        f.write(toJson(obj));
        f.close();
    } catch (e) {}
}

function beginCopyReport(srcFile, destFile) {
    try {
        writeCopyProgress({
            state: "copying",
            name: fileNameOf(destFile.fsName),
            dest: destFile.fsName,
            total: fileSizeOf(srcFile)
        });
    } catch (e) {}
}

function endCopyReport() {
    writeCopyProgress({ state: "idle" });
}

// LUU Y: giu nguyen 100% logic ban v4.5.2 goc - luong Import & Cat da chay on dinh voi ham nay.
// KHONG them buoc xoa/copy de len file dich o day: file trong Footage/ co the dang duoc
// Timeline su dung, xoa no giua chung se lam clip offline -> cat khong on dinh.
function copyFileToFootage(srcFile, destFolder) {
    try {
        // Use fsName (OS native path) for both source and dest to avoid slash issues
        var destPath = destFolder.fsName + "/" + srcFile.name;
        var destFile = new File(destPath);
        if (destFile.exists) return { file: destFile, isNew: false };
        beginCopyReport(srcFile, destFile);

        // Chi file NHO moi dung File.copy() cua ExtendScript; file lon phai copy bang lenh he dieu hanh.
        var srcLen = fileSizeOf(srcFile);
        var ok = false;
        if (srcLen >= 0 && srcLen <= 314572800) {
            try { ok = srcFile.copy(destFile.fsName); } catch (eC) { ok = false; }
            if (ok) {
                var chkNew = new File(destPath);
                if (!chkNew.exists || fileSizeOf(chkNew) !== srcLen) ok = false;   // copy cut ngang -> lam lai
            }
        }
        if (!ok) {
            // KHONG xoa file dich o day (co the dang duoc Timeline dung) - chi copy khi chua ton tai.
            var os = osCopyFile(srcFile, destFile);
            ok = os.ok;
        }
        endCopyReport();
        if (ok) return { file: new File(destPath), isNew: true };
        return null;
    } catch(e) { endCopyReport(); return null; }
}

/** O "FILE" co the chua luon duong dan day du toi file (UNC \\server\... hoac D:\...) */
function isFullFilePath(code) {
    var c = stripQuotes(code || "");
    if (c.length < 4 || !hasVideoExtension(c)) return false;
    return (c.substring(0, 2) === "\\\\") || /^[a-zA-Z]:[\\\/]/.test(c) || (c.charAt(0) === "/");
}

function resolveAndImport(folderPath, code, fileCache, itemCache, footageFolder, enableCopy) {
    folderPath = stripQuotes(folderPath);
    code = stripQuotes(code);
    var cacheKey = folderPath + "|" + code;
    if (_session.missingSources[sourceCheckKey(folderPath, code)]) return { skip: true, matchedPath: "" };
    var matchedFile = fileCache[cacheKey];
    var isAmbiguous = false;
    if (matchedFile === undefined) {
        var replacementPath = _session.replacements[normalizePath(cacheKey)];
        if (replacementPath) matchedFile = new File(replacementPath);
        if (isFullFilePath(code)) {
            // Duong dan day du -> dung truc tiep, khong quet thu muc
            if (!matchedFile) {
                var directFile = new File(code);
                matchedFile = directFile.exists ? directFile : null;
            }
        } else {
            if (!matchedFile) {
                var folder = new Folder(folderPath), results = [];
                findFilesByCode(folder, code, 0, results);
                if (results.length === 0) matchedFile = null;
                else if (results.length > 1) { isAmbiguous = true; matchedFile = null; }
                else matchedFile = results[0];
            }
        }
        fileCache[cacheKey] = matchedFile;
    }
    if (!matchedFile) return { error: "Kh\u00f4ng t\u00ecm th\u1ea5y file m\u00e3 '" + code + "' trong '" + folderPath + "'" };
    var actualFile = matchedFile, isNewCopy = false;
    if (enableCopy && footageFolder) {
        var cr = copyFileToFootage(matchedFile, footageFolder);
        if (cr && cr.file) { actualFile = cr.file; isNewCopy = cr.isNew; }
    }
    var fsPath = actualFile.fsName;
    var projectItem = itemCache[fsPath];
    if (projectItem === undefined) { projectItem = importAndGetProjectItem(fsPath); itemCache[fsPath] = projectItem; }
    if (!projectItem) return { error: "Import th\u1ea5t b\u1ea1i: " + fsPath };
    return { projectItem: projectItem, isAmbiguous: isAmbiguous, isNewCopy: isNewCopy, matchedPath: actualFile.fsName };
}

function sourceCheckKey(folder, code) { return normalizePath(stripQuotes(folder) + "|" + stripQuotes(code)); }

function validateOneSource(items, rowNumber, kind, folder, code, index) {
    folder = stripQuotes(folder); code = stripQuotes(code);
    if (code === "") return;
    if (/^https?:\/\//i.test(code)) return;
    var id = rowNumber + "-" + kind + "-" + index;
    var replacement = _session.replacements[sourceCheckKey(folder, code)];
    var found = replacement ? new File(replacement) : null;
    if (!found || !found.exists) {
        if (isFullFilePath(code)) {
            var direct = new File(code); found = direct.exists ? direct : null;
        } else {
            var matches = [], folderObj = new Folder(folder);
            findFilesByCode(folderObj, code, 0, matches);
            found = matches.length === 1 ? matches[0] : null;
        }
    }
    var checkKey = sourceCheckKey(folder, code);
    if (!found || !found.exists) _session.missingSources[checkKey] = true;
    var displayFolder = folder;
    var displayFile = code;
    if (isFullFilePath(code)) {
        var fullPathFile = new File(code);
        displayFolder = fullPathFile.parent ? fullPathFile.parent.fsName : "";
        displayFile = fullPathFile.name;
    }
    items.push({ id: id, checkKey: checkKey, rowNumber: rowNumber, kind: kind, folder: folder, code: code,
        requested: folder ? (folder + "\\" + code) : code,
        displayFolder: displayFolder, displayName: displayFile,
        found: !!(found && found.exists), foundPath: found && found.exists ? found.fsName : "" });
}

function validateSourceUrls(items, rowNumber, kind, value, indexStart) {
    var urls = extractUrls(value || "");
    for (var i = 0; i < urls.length; i++) {
        items.push({ id: rowNumber + "-" + kind + "-url-" + (indexStart + i), rowNumber: rowNumber, kind: kind,
            folder: "", code: urls[i], requested: urls[i], found: true, foundPath: urls[i] });
    }
}

function cep_validateSources(payloadJson) {
    var out = { success: false, items: [], error: "" };
    try {
        var payload = parseJson(payloadJson), cols = payload.cols, rows = parseCSV(payload.csvContent || "");
        if (!payload || !cols) { out.error = "Thiếu dữ liệu kịch bản để kiểm tra"; return toJson(out); }
        _session.missingSources = {};
        var lastFolder = "", lastCode = "", lastTramFolder = "";
        var headerIndex = parseInt(cols.headerRowIndex, 10);
        if (isNaN(headerIndex)) headerIndex = -1;
        var first = headerIndex + 1;
        for (var r = first; r < rows.length; r++) {
            var row = rows[r]; if (!row) continue;
            var source = cellAt(row, cols.sourceCol), code = cellAt(row, cols.codeCol), time = cellAt(row, cols.timeCol);
            var tramSource = cellAt(row, cols.tramSourceCol), tramCode = cellAt(row, cols.tramCodeCol);
            if (looksLikeFolderValue(source)) lastFolder = source;
            if (code !== "") lastCode = code;
            if (looksLikeFolderValue(tramSource)) lastTramFolder = tramSource;
            if (code !== "" || source !== "" || time !== "") {
                validateSourceUrls(out.items, r + 1, "V1", source + "\n" + code, 1);
                var codes = (isFullFilePath(lastCode) ? [lastCode] : lastCode.split(/[\r\n,;]+/));
                for (var c = 0; c < codes.length; c++) validateOneSource(out.items, r + 1, "V1", lastFolder, codes[c], c + 1);
            }
            if (payload.enableTram !== false && tramCode !== "") {
                validateSourceUrls(out.items, r + 1, "V2", tramSource + "\n" + tramCode, 1);
                var tramCodes = isFullFilePath(tramCode) ? [tramCode] : tramCode.split(/[\r\n,;]+/);
                for (var t = 0; t < tramCodes.length; t++) validateOneSource(out.items, r + 1, "V2", tramSource || lastTramFolder || lastFolder, tramCodes[t], t + 1);
            }
        }
        out.success = true;
    } catch (e) { out.error = "Lỗi kiểm tra đường dẫn: " + e.toString(); }
    return toJson(out);
}

function cep_setSourceReplacement(folder, code, replacementPath) {
    try {
        var f = new File(stripQuotes(replacementPath));
        if (!f.exists) return toJson({ success: false, error: "File thay thế không tồn tại" });
        var key = sourceCheckKey(folder, code);
        _session.replacements[key] = f.fsName;
        delete _session.missingSources[key];
        return toJson({ success: true, path: f.fsName });
    } catch (e) { return toJson({ success: false, error: e.toString() }); }
}

// ---- Track Helpers ----
function getTrackEndSeconds(track) {
    try {
        if (!track || !track.clips) return 0;
        var n = track.clips.numItems; if (n === 0) return 0;
        var maxEndTicks = 0;
        for (var i = 0; i < n; i++) { try { var et = parseFloat(track.clips[i].end.ticks); if (!isNaN(et) && et > maxEndTicks) maxEndTicks = et; } catch(e1) {} }
        return maxEndTicks / TICKS_PER_SECOND;
    } catch(e) { return 0; }
}

/**
 * Chen clip roi doi ten. Tra ve { error, warning, actualDur }.
 * expectedDurSec: thoi luong dung theo timecode -> dung de KIEM TRA lai sau khi chen,
 * neu Premiere chen ca clip goc thi tu cat lai cho dung.
 */
function insertAndRenameClip(track, projectItem, insertPositionSec, labelText, expectedDurSec, roseLabel) {
    try {
        if (roseLabel && projectItem) {
            try { if (projectItem.setColorLabel) projectItem.setColorLabel(6); } catch (eRoseBefore1) {}
            try { if (projectItem.setLabelColor) projectItem.setLabelColor(6); } catch (eRoseBefore2) {}
        }
        track.overwriteClip(projectItem, insertPositionSec);
        var n = track.clips.numItems; if (n === 0) return { error: null, warning: null, actualDur: 0 };
        var targetTicks = Math.round(insertPositionSec * TICKS_PER_SECOND);
        var bestClip = null, minDiff = Number.MAX_VALUE;
        for (var i = 0; i < n; i++) {
            var clip = track.clips[i];
            try {
                var sTicks = parseFloat(clip.start.ticks), dTicks = parseFloat(clip.duration.ticks);
                if (dTicks > TICKS_PER_SECOND * 0.05) {
                    var diff = Math.abs(sTicks - targetTicks);
                    if (diff < minDiff) { minDiff = diff; bestClip = clip; }
                }
            } catch(e2) {}
        }
        if (!bestClip && n > 0) bestClip = track.clips[n-1];
        if (bestClip && labelText) bestClip.name = labelText;
        if (bestClip && roseLabel) {
            try { if (bestClip.setColorLabel) bestClip.setColorLabel(6); } catch (eRose1) {}
            try { if (bestClip.setLabelColor) bestClip.setLabelColor(6); } catch (eRose3) {}
            try { if (bestClip.projectItem && bestClip.projectItem.setColorLabel) bestClip.projectItem.setColorLabel(6); } catch (eRose2) {}
            try { if (bestClip.projectItem && bestClip.projectItem.setLabelColor) bestClip.projectItem.setLabelColor(6); } catch (eRose4) {}
        }

        var warning = null, actualDur = 0;
        if (bestClip) {
            try { actualDur = parseFloat(bestClip.duration.ticks) / TICKS_PER_SECOND; } catch(eD) { actualDur = 0; }
            if (expectedDurSec && expectedDurSec > 0 && actualDur > expectedDurSec + 0.25) {
                // Premiere da chen nguyen clip goc -> cat lai dung thoi luong timecode
                var fixedOk = false, tooLong = actualDur;
                try {
                    var endTime = new Time();
                    endTime.ticks = String(Math.round(parseFloat(bestClip.start.ticks) + expectedDurSec * TICKS_PER_SECOND));
                    bestClip.end = endTime;
                    var newDur = parseFloat(bestClip.duration.ticks) / TICKS_PER_SECOND;
                    if (newDur <= expectedDurSec + 0.25) { fixedOk = true; actualDur = newDur; }
                } catch(eT) {}
                warning = (labelText ? (labelText + ": ") : "") + "clip d\u00e0i " + tooLong.toFixed(1) +
                          "s so v\u1edbi timecode " + expectedDurSec.toFixed(1) + "s" +
                          (fixedOk ? " \u2192 \u0111\u00e3 t\u1ef1 c\u1eaft l\u1ea1i" : " (kh\u00f4ng t\u1ef1 s\u1eeda \u0111\u01b0\u1ee3c)");
            }
        }
        return { error: null, warning: warning, actualDur: actualDur };
    } catch(e) { return { error: "L\u1ed7i ch\u00e8n clip: " + e.toString(), warning: null, actualDur: 0 }; }
}

// =========================================================================
// PUBLIC CEP API
// =========================================================================

function cep_checkEnvironment() {
    var res = { hasProject: false, projectName: "", projectPath: "", isSaved: false, hasSequence: false, sequenceName: "", numVideoTracks: 0 };
    try {
        if (app.project) {
            res.hasProject = true; res.projectName = app.project.name || ""; res.projectPath = app.project.path || ""; res.isSaved = (res.projectPath !== "");
            var seq = app.project.activeSequence;
            if (seq) { res.hasSequence = true; res.sequenceName = seq.name || ""; res.numVideoTracks = seq.videoTracks.numTracks || 0; }
        }
    } catch(e) { res.error = e.toString(); }
    return toJson(res);
}

function cep_parseCSVContent(csvContent) {
    var res = { success: false, totalRows: 0, dataRowCount: 0, cols: null, rowsPreview: [], error: "" };
    try {
        var rows = parseCSV(csvContent);
        res.totalRows = rows.length;
        var cols = detectColumns(rows);
        if (!cols) { res.error = "Kh\u00f4ng nh\u1eadn di\u1ec7n \u0111\u01b0\u1ee3c \u0111\u1ee7 c\u00e1c c\u1ed9t Source / M\u00e3 File / Timecode."; return toJson(res); }
        res.cols = cols;
        res.dataRowCount = Math.max(0, rows.length - (cols.headerRowIndex + 1));
        res.success = true;
        for (var i = cols.headerRowIndex + 1; i < Math.min(cols.headerRowIndex + 6, rows.length); i++) {
            res.rowsPreview.push({
                rowNumber: i+1, body: cols.bodyCol !== -1 ? trim(rows[i][cols.bodyCol]||"") : "",
                source: trim(rows[i][cols.sourceCol]||""), code: trim(rows[i][cols.codeCol]||""), time: trim(rows[i][cols.timeCol]||""),
                tramSource: cols.tramSourceCol !== -1 ? trim(rows[i][cols.tramSourceCol]||"") : "",
                tramCode: cols.tramCodeCol !== -1 ? trim(rows[i][cols.tramCodeCol]||"") : "",
                tramTime: cols.tramTimeCol !== -1 ? trim(rows[i][cols.tramTimeCol]||"") : ""
            });
        }
    } catch(e) { res.error = "L\u1ed7i \u0111\u1ecdc CSV: " + e.toString(); }
    return toJson(res);
}

/**
 * Nguoi dung tu chon cot (che do thu cong) -> khong co buoc nhan dien header,
 * phai tu tim dong du lieu dau tien: dong dau tien ma o file/thu muc co du lieu that.
 */
function cellAt(row, idx) { return (row && idx !== -1 && idx < row.length) ? trim(row[idx] || "") : ""; }

function findFirstDataRowFor(rows, cols) {
    for (var r = 0; r < Math.min(60, rows.length); r++) {
        var row = rows[r];
        if (!row) continue;
        var codeV = cellAt(row, cols.codeCol), srcV = cellAt(row, cols.sourceCol);
        var tCodeV = cellAt(row, cols.tramCodeCol), tSrcV = cellAt(row, cols.tramSourceCol);
        if (looksLikeCode(codeV) || looksLikeFullFilePath(codeV) || looksLikePath(srcV) ||
            looksLikeCode(tCodeV) || looksLikeFullFilePath(tCodeV) || looksLikePath(tSrcV)) return r;
    }
    return 0;
}

/**
 * Che do THU CONG: dung nguyen bo cot nguoi dung chi dinh (theo ten cot Google Sheet),
 * chi tu dong tim dong du lieu dau tien. Moi ngu canh xu ly con lai giong het che do tu dong.
 */
function cep_parseCSVContentManual(csvContent, colsJsonStr) {
    var res = { success: false, totalRows: 0, dataRowCount: 0, cols: null, rowsPreview: [], error: "" };
    try {
        var man = parseJson(colsJsonStr);
        if (!man) { res.error = "Không đọc được cấu hình cột thủ công"; return toJson(res); }
        function num(v, dflt) { var n = parseInt(v, 10); return isNaN(n) ? dflt : n; }
        var cols = {
            bodyCol: num(man.bodyCol, -1),
            sourceCol: num(man.sourceCol, -1),
            codeCol: num(man.codeCol, -1),
            timeCol: num(man.timeCol, -1),
            tramSourceCol: num(man.tramSourceCol, -1),
            tramCodeCol: num(man.tramCodeCol, -1),
            tramTimeCol: num(man.tramTimeCol, -1),
            headerRowIndex: -1,
            detectedByContent: false, detectedByManual: true
        };
        if (cols.codeCol === -1) { res.error = "Chưa chọn cột Tên file cho Source chính (V1)"; return toJson(res); }

        var rows = parseCSV(csvContent);
        res.totalRows = rows.length;
        // Cot file da la duong dan day du -> khong can cot Folder
        var firstData = findFirstDataRowFor(rows, cols);
        var fullPathCode = false;
        for (var r = firstData; r < Math.min(firstData + 40, rows.length); r++) {
            var rw = rows[r];
            if (rw && cols.codeCol < rw.length && looksLikeFullFilePath(trim(rw[cols.codeCol] || ""))) { fullPathCode = true; break; }
        }
        cols.fullPathCode = fullPathCode;
        cols.headerRowIndex = firstData - 1;

        res.cols = cols;
        res.dataRowCount = Math.max(0, rows.length - (cols.headerRowIndex + 1));
        res.success = true;
    } catch (e) { res.error = "Lỗi áp dụng cột thủ công: " + e.toString(); }
    return toJson(res);
}

/**
 * Dung cho luong Gemini AI: ap dung bo cot do AI tra ve, nhung van dem so hang
 * bang parseCSV that (o nhieu dong trong 1 cell khong bi tinh thanh nhieu hang).
 */
function cep_parseCSVContentWithCols(csvContent, colsJsonStr) {
    var res = { success: false, totalRows: 0, dataRowCount: 0, cols: null, rowsPreview: [], error: "" };
    try {
        var aiCols = parseJson(colsJsonStr);
        if (!aiCols) { res.error = "Không đọc được cấu hình cột từ AI"; return toJson(res); }
        function num(v, dflt) { var n = parseInt(v, 10); return isNaN(n) ? dflt : n; }
        var cols = {
            bodyCol: num(aiCols.bodyCol, -1),
            sourceCol: num(aiCols.sourceCol, -1),
            codeCol: num(aiCols.codeCol, -1),
            timeCol: num(aiCols.timeCol, -1),
            tramSourceCol: num(aiCols.tramSourceCol, -1),
            tramCodeCol: num(aiCols.tramCodeCol, -1),
            tramTimeCol: num(aiCols.tramTimeCol, -1),
            headerRowIndex: num(aiCols.headerRowIndex, -1),
            detectedByContent: false, detectedByAI: true
        };
        // sourceCol = -1 van hop le neu cot file chua san duong dan day du (sheet kieu "Source" = ca duong dan).
        if (cols.codeCol === -1) { res.error = "AI không xác định được cột Mã file / đường dẫn file"; return toJson(res); }

        var rows = parseCSV(csvContent);
        res.totalRows = rows.length;
        res.cols = cols;
        res.dataRowCount = Math.max(0, rows.length - (cols.headerRowIndex + 1));
        res.success = true;
    } catch (e) { res.error = "Lỗi áp dụng cột AI: " + e.toString(); }
    return toJson(res);
}

function cep_initSession(configJsonStr) {
    var config = parseJson(configJsonStr) || {};
    _session.config = config;
    _session.active = true;
    _session.fileCache = {}; _session.itemCache = {}; _session.durationCache = {};
    _session.lastBody = ""; _session.lastSourceFolder = ""; _session.lastFileCode = ""; _session.lastTramFolder = "";
    var footageFolder = null;
    if (config.enableCopyToLocal !== false) footageFolder = getOrCreateFootageFolder(config.footageFolderName || "Footage");
    _session.footageFolder = footageFolder;
    return toJson({ success: true, footageFolderPath: footageFolder ? footageFolder.fsName : null });
}

function cep_clearSourceReplacements() {
    _session.replacements = {};
    _session.missingSources = {};
    return toJson({ success: true });
}

/** Ten ngan de dat cho clip: neu ma file la ca duong dan thi chi lay ten file (bo duoi mo rong). */
function shortCodeLabel(code) {
    var c = stripQuotes(code);
    if (!isFullFilePath(c)) return c;
    return fileNameOf(c).replace(/\.[^.]+$/, "");
}

/**
 * Quet ca HANG NGANG (toan bo o cua hang) de tim duong dan day du toi file video
 * va o timecode thuan. Dung khi bo cot khong duoc nhan dien day du.
 */
function scanRowForFileAndTime(rawRow) {
    var out = { file: "", time: "" };
    if (!rawRow || !rawRow.length) return out;
    var files = [];
    for (var i = 0; i < rawRow.length; i++) {
        var v = trim(rawRow[i] || "");
        if (v === "") continue;
        var lines = String(v).split(/[\r\n]+/);
        for (var L = 0; L < lines.length; L++) {
            var ln = stripQuotes(lines[L]);
            if (ln !== "" && looksLikePath(ln) && hasVideoExtension(ln)) files.push(ln);
        }
        if (out.time === "" && looksLikeTimeRangeCell(v)) out.time = v;
    }
    out.file = files.join("\n");
    return out;
}

function cep_processSingleRow(rowJsonStr) {
    var rowData = parseJson(rowJsonStr);
    if (!rowData || !_session.active) return toJson({ status: "error", errorMsg: "Session ch\u01b0a \u0111\u01b0\u1ee3c kh\u1edfi t\u1ea1o" });
    var seq = app.project.activeSequence;
    if (!seq) return toJson({ status: "error", errorMsg: "Kh\u00f4ng t\u00ecm th\u1ea5y Active Sequence" });

    var mainTrackIndex = _session.config.mainTrackIndex || 0;
    var tramTrackIndex = _session.config.tramTrackIndex || 1;
    var defaultDuration = _session.config.defaultDuration || 5;
    var singleTimeEnabled = _session.config.singleTimeEnabled !== false;
    var singleTimeDuration = _session.config.singleTimeDuration || 5;
    var noTimecodeMode = _session.config.noTimecodeMode || "center";
    var noTimecodeDuration = _session.config.noTimecodeDuration || 5;
    var enableTram = _session.config.enableTram !== false;
    var labelEnabled = _session.config.enableLabel !== false;
    var enableCopy = _session.config.enableCopyToLocal !== false;

    var mainTrack = seq.videoTracks[mainTrackIndex];
    var tramTrack = (enableTram && seq.videoTracks.numTracks > tramTrackIndex) ? seq.videoTracks[tramTrackIndex] : null;

    var rowNumber = rowData.rowNumber;
    var bodyRaw = trim(rowData.body || "");
    var sourceRaw = stripQuotes(rowData.source || "");
    var codeRaw = stripQuotes(rowData.code || "");
    var timeRaw = trim(rowData.time || "");
    var tramSourceRaw = stripQuotes(rowData.tramSource || "");
    var tramCodeRaw = stripQuotes(rowData.tramCode || "");
    var tramTimeRaw = trim(rowData.tramTime || "");
    // AI-generated label override (from Gemini Clip Namer)
    var labelOverride = trim(rowData.labelOverride || "");

    // ---- Smart split: tách mã file khỏi timecode gộp trong cùng 1 ô ----
    // VD: "C5439 - 02:00" -> code="C5439", embeddedTime="02:00"
    var mainSplit = splitCodeAndTimecode(codeRaw);
    if (mainSplit.embeddedTime !== "") {
        // Nếu ô code có timecode gộp vào, tách riêng ra
        codeRaw = mainSplit.codes;   // chỉ giữ phần mã file
        // Dùng timecode từ ô code nếu ô time chưa có timecode thật
        if (timeRaw === "" || parseTimeRange(timeRaw).mode === "auto") {
            timeRaw = mainSplit.embeddedTime;
        }
    }

    // Tương tự cho trám
    var tramSplit = splitCodeAndTimecode(tramCodeRaw);
    if (tramSplit.embeddedTime !== "") {
        tramCodeRaw = tramSplit.codes;
        if (tramTimeRaw === "" || parseTimeRange(tramTimeRaw).mode === "auto") {
            tramTimeRaw = tramSplit.embeddedTime;
        }
    }

    // ---- Du phong "theo HANG NGANG" ----
    // Bang co cau truc la, khong nhan dien du bo cot (source / file / timecode):
    // neu trong ca hang co mot duong dan day du toi file video thi van dung file do
    // cho dung hang nay; khong tim thay timecode thi de trong -> lay 5s giua video.
    if (codeRaw === "" && sourceRaw === "" && timeRaw === "") {
        var rowScan = scanRowForFileAndTime(rowData.rawRow);
        if (rowScan.file !== "") {
            codeRaw = rowScan.file;
            if (rowScan.time !== "") timeRaw = rowScan.time;
        }
    }

    // Carry-forward: chi ghi nho gia tri THAT SU la duong dan.
    // Cot source cua nhieu bang con bi dung de ghi chu ("che mat neu can"...) -> khong duoc
    // de ghi chu do de len thu muc dang dung cho cac hang phia sau.
    if (bodyRaw !== "") _session.lastBody = bodyRaw;
    if (looksLikeFolderValue(sourceRaw)) _session.lastSourceFolder = sourceRaw;
    if (codeRaw !== "") _session.lastFileCode = codeRaw;
    if (looksLikeFolderValue(tramSourceRaw)) _session.lastTramFolder = tramSourceRaw;

    // Parse tất cả time ranges (có thể nhiều dòng, mỗi dòng 1 đoạn)
    var allTimeRanges = parseAllTimeRanges(timeRaw);
    if (allTimeRanges === null) return toJson({ status: "skipped", rowNumber: rowNumber, details: "B\u1ecf qua d\u00f2ng N.A", clipCount: 0, copyCount: 0, downloadCount: 0 });

    var v1StartTime = getTrackEndSeconds(mainTrack);
    var clipsInserted = 0, copiesDone = 0, downloadsDone = 0;
    var warnings = [], actions = [];
    var v1ClipDuration = 0; // Will be set after inserting V1 clip

    // Base label: use AI override if available, else rowNumber
    var baseLabel = labelOverride ? (rowNumber + "_" + labelOverride) : String(rowNumber);

    // =========================================================================
    // 1. SOURCE CHINH (V1)
    // =========================================================================
    // KEY FIX: Nếu hàng không có source, code VÀ timecode V1 (cả 3 đều rỗng)
    // → đây là hàng chỉ có trám (tram-only row), bỏ qua V1 hoàn toàn.
    // Carry-forward chỉ được dùng khi ít nhất có 1 trong: source, code, hoặc timecode V1.
    // Hang chi co THU MUC ma khong co ma file va khong co timecode => khong co gi de chen.
    // (Truoc day van chen, khien clip cua hang tren bi nhan ban them mot lan.)
    // Con hang chi co TIMECODE (khong co ma file) van hop le: do la doan khac cua CHINH file o tren.
    var hasExplicitV1 = (codeRaw !== "" || timeRaw !== "");
    var mainUrls = extractUrls(sourceRaw + "\n" + codeRaw + "\n" + bodyRaw);

    if (!hasExplicitV1 && mainUrls.length === 0) {
        // Hàng chỉ có trám — skip toàn bộ V1, nhảy thẳng xuống xử lý trám
    } else if (mainUrls.length > 0) {
        for (var uIdx = 0; uIdx < mainUrls.length; uIdx++) {
            var currentUrl = mainUrls[uIdx];
            var subSuffix = (mainUrls.length > 1) ? ("." + (uIdx+1)) : "";
            var clipLabel = labelEnabled ? (baseLabel + subSuffix) : null;
            // FIX: truoc day dung bien timeRangeInfo cua nhanh khac (luc nay con undefined)
            // -> moi dong co link YouTube/Envato deu bao loi va khong chen duoc gi.
            var urlRange = (allTimeRanges && allTimeRanges.length > 0) ? allTimeRanges[0] : { mode: "auto" };
            var clipDur = (urlRange.mode === "full") ? (urlRange.outSec - urlRange.inSec) : defaultDuration;

            if (isEnvatoUrl(currentUrl) || isYouTubeUrl(currentUrl)) {
                var blackItem = getOrCreateBlackVideoItem(_session.footageFolder);
                if (!blackItem) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Kh\u00f4ng t\u1ea1o \u0111\u01b0\u1ee3c Black Video" });
                try {
                    blackItem.setInPoint("0", MEDIA_TYPE);
                    blackItem.setOutPoint(Math.round(clipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insertPosB = getTrackEndSeconds(mainTrack);
                    var resB = insertAndRenameClip(mainTrack, blackItem, insertPosB, clipLabel, clipDur, urlRange.mode !== "full");
                    if (resB.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resB.error });
                    if (resB.warning) warnings.push(resB.warning);
                    clipsInserted++; v1ClipDuration = clipDur;
                    actions.push("Black Video " + (clipLabel || rowNumber));
                } catch(eB) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "L\u1ed7i ch\u00e8n Black Video: " + eB.toString() }); }
            } else {
                var ext = getExtensionFromUrl(currentUrl);
                var localFileName = rowNumber + subSuffix + "." + ext;
                var folderFs = _session.footageFolder ? _session.footageFolder.fsName : (new File(app.project.path).parent.fsName);
                var localDestPath = folderFs + "/" + localFileName;
                var downloadedFile = downloadFileFromUrl(currentUrl, localDestPath);
                if (!downloadedFile) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Kh\u00f4ng t\u1ea3i \u0111\u01b0\u1ee3c file t\u1eeb link: " + currentUrl });
                downloadsDone++;
                var mediaItem = importAndGetProjectItem(downloadedFile.fsName);
                if (!mediaItem) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Import th\u1ea5t b\u1ea1i: " + downloadedFile.fsName });
                try {
                    mediaItem.setInPoint("0", MEDIA_TYPE);
                    mediaItem.setOutPoint(Math.round(clipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insertPosM = getTrackEndSeconds(mainTrack);
                    var resM = insertAndRenameClip(mainTrack, mediaItem, insertPosM, clipLabel, clipDur, urlRange.mode !== "full");
                    if (resM.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resM.error });
                    if (resM.warning) warnings.push(resM.warning);
                    clipsInserted++; v1ClipDuration = clipDur;
                    actions.push("\u0110\u00e3 t\u1ea3i " + localFileName + " (" + clipDur + "s)");
                } catch(eM) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "L\u1ed7i ch\u00e8n media: " + eM.toString() }); }
            }
        }
    } else if (hasExplicitV1) {
        // ---- NAS / local file path — carry-forward chỉ khi hàng có ít nhất source/code/time ----
        var sourceToUse = _session.lastSourceFolder;
        var codeToUse = _session.lastFileCode;
        if (codeToUse === "") return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Thi\u1ebfu Source ho\u1eb7c m\u00e3 file" });

        // O file co the la DUONG DAN DAY DU (mot hoac nhieu dong) -> khong tach theo dau phay
        // vi ten thu muc co the chua dau phay; khi do khong can cot thu muc rieng.
        var fileCodes = [], anyFullPath = false, cIdx, sc;
        var codeLines = codeToUse.split(/[\r\n]+/), allLinesAreFiles = true;
        for (cIdx = 0; cIdx < codeLines.length; cIdx++) {
            sc = stripQuotes(codeLines[cIdx]);
            if (sc === "") continue;
            if (!isFullFilePath(sc)) { allLinesAreFiles = false; break; }
        }
        if (allLinesAreFiles) {
            for (cIdx = 0; cIdx < codeLines.length; cIdx++) { sc = stripQuotes(codeLines[cIdx]); if (sc !== "") fileCodes.push(sc); }
            anyFullPath = (fileCodes.length > 0);
        } else {
            var rawCodes = codeToUse.split(/[\r\n,;]+/);
            for (cIdx = 0; cIdx < rawCodes.length; cIdx++) {
                sc = stripQuotes(rawCodes[cIdx]);
                if (sc === "") continue;
                fileCodes.push(sc);
                if (isFullFilePath(sc)) anyFullPath = true;
            }
        }
        if (fileCodes.length === 0) fileCodes = [codeToUse];
        if (sourceToUse === "" && !anyFullPath) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Thi\u1ebfu Source ho\u1eb7c m\u00e3 file" });

        for (var fIdx = 0; fIdx < fileCodes.length; fIdx++) {
            var currentCode = fileCodes[fIdx];
            var mainResult = resolveAndImport(sourceToUse, currentCode, _session.fileCache, _session.itemCache, _session.footageFolder, enableCopy);
            if (mainResult.skip) { warnings.push("Bỏ qua file không tìm thấy: " + currentCode); continue; }
            if (mainResult.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: mainResult.error });
            if (mainResult.isAmbiguous) warnings.push("M\u00e3 '" + currentCode + "' kh\u1edbp nhi\u1ec1u file, \u0111ang d\u00f9ng: " + mainResult.matchedPath);
            if (mainResult.isNewCopy) copiesDone++;

            // --- Lặp qua tất cả time ranges của dòng (hỗ trợ multiline timecode) ---
            var multiFileCount = fileCodes.length;
            for (var rIdx = 0; rIdx < allTimeRanges.length; rIdx++) {
                var timeRangeInfo = allTimeRanges[rIdx];
                // Tạo suffix: nếu chỉ có 1 file và 1 range thì không có suffix
                var needFileIdx = (multiFileCount > 1);
                var needRangeIdx = (allTimeRanges.length > 1);
                var clipSuffix = "";
                if (needFileIdx) clipSuffix += "." + (fIdx + 1);
                if (needRangeIdx) clipSuffix += "-" + (rIdx + 1);
                // O file co the la ca duong dan -> dat ten clip theo TEN FILE, khong lay ca duong dan
                var clipLabel = labelEnabled ? (baseLabel + clipSuffix + "_" + shortCodeLabel(currentCode)) : null;

                var inSec, outSec;
                var mainDuration = getProjectItemDuration(mainResult.projectItem);
                var normalizedRange = resolveNormalizedTimeRange(timeRangeInfo, mainDuration, defaultDuration);
                if (normalizedRange) {
                    inSec = normalizedRange.inSec; outSec = normalizedRange.outSec;
                    if (!normalizedRange.exact) {
                        warnings.push("Mốc 'hết' của " + currentCode + ": không xác định được thời lượng video" +
                            (normalizedRange.knownDuration !== null ? " (đọc được " + normalizedRange.knownDuration.toFixed(1) + "s, ngắn hơn mốc bắt đầu " + inSec.toFixed(1) + "s)" : "") +
                            " → tạm lấy " + defaultDuration + "s");
                    }
                }
                else if (timeRangeInfo.mode === "full") { inSec = timeRangeInfo.inSec; outSec = timeRangeInfo.outSec; }
                else if (timeRangeInfo.mode === "start") {
                    var singleDuration = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                    inSec = Math.max(0, timeRangeInfo.inSec - singleDuration);
                    outSec = timeRangeInfo.inSec;
                }
                else {
                    if (noTimecodeMode === "full" && mainDuration !== null && mainDuration > 0) { inSec = 0; outSec = mainDuration; }
                    else if (mainDuration === null || mainDuration <= 0) { inSec = 0; outSec = noTimecodeDuration; warnings.push("Kh\u00f4ng \u0111\u1ecdc \u0111\u01b0\u1ee3c th\u1eddi l\u01b0\u1ee3ng " + currentCode + ", l\u1ea5y " + noTimecodeDuration + "s"); }
                    else if (mainDuration <= noTimecodeDuration) { inSec = 0; outSec = mainDuration; }
                    else { var mid = mainDuration/2; inSec = mid - noTimecodeDuration/2; outSec = mid + noTimecodeDuration/2; }
                }

                try {
                    // Dam bao media da san sang truoc khi trim, neu khong lenh trim bi bo qua
                    waitForMediaReady(mainResult.projectItem, 6000);
                    mainResult.projectItem.setInPoint(Math.round(inSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    mainResult.projectItem.setOutPoint(Math.round(outSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insertPosV = getTrackEndSeconds(mainTrack);
                    var resV = insertAndRenameClip(mainTrack, mainResult.projectItem, insertPosV, clipLabel, outSec - inSec, timeRangeInfo.mode !== "full");
                    if (resV.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resV.error });
                    if (resV.warning) warnings.push(resV.warning);
                    clipsInserted++; v1ClipDuration += (outSec - inSec);
                    actions.push("V1 " + (clipLabel || currentCode) + " (" + inSec.toFixed(0) + "s~" + outSec.toFixed(0) + "s)");
                } catch(eInsert) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "L\u1ed7i ch\u00e8n clip V1: " + eInsert.toString() }); }
            }
        }
    }

    // =========================================================================
    // 2. SOURCE TRAM (V2)
    //    - Only insert if THIS row has explicit tram code or tram URL
    //    - Duration capped at v1ClipDuration so tram never overflows V1 boundary
    // =========================================================================
    var tramInserted = 0;
    var tramUrls = extractUrls(tramSourceRaw + "\n" + tramCodeRaw);
    var hasTramExplicit = (tramUrls.length > 0) || (tramCodeRaw !== "");

    if (enableTram && tramTrack && hasTramExplicit) {
        var tramTimeInfo = parseTimeRange(tramTimeRaw);

        // Helper to cap tram duration at V1 clip length
        function getTramDur(requestedDur) {
            if (v1ClipDuration > 0 && requestedDur > v1ClipDuration) return v1ClipDuration;
            return requestedDur;
        }

        if (tramUrls.length > 0 && tramTimeInfo !== null) {
            for (var tuIdx = 0; tuIdx < tramUrls.length; tuIdx++) {
                var tUrl = tramUrls[tuIdx];
                var tSubSuffix = (tramUrls.length > 1) ? ("." + (tuIdx+1)) : "";
                var tramClipLabel = labelEnabled ? (rowNumber + "_Tram" + tSubSuffix) : null;
                var tClipDurRaw = (tramTimeInfo.mode === "full") ? (tramTimeInfo.outSec - tramTimeInfo.inSec) : defaultDuration;
                var tClipDur = getTramDur(tClipDurRaw);

                if (isEnvatoUrl(tUrl) || isYouTubeUrl(tUrl)) {
                    var tBlackItem = getOrCreateBlackVideoItem(_session.footageFolder);
                    if (tBlackItem) {
                        try {
                            tBlackItem.setInPoint("0", MEDIA_TYPE);
                            tBlackItem.setOutPoint(Math.round(tClipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            insertAndRenameClip(tramTrack, tBlackItem, v1StartTime, tramClipLabel, tClipDur, tramTimeInfo.mode !== "full");
                            tramInserted++; actions.push("Tr\u00e1m V2 Black (" + tClipDur.toFixed(1) + "s)");
                        } catch(etb) {}
                    }
                } else {
                    var tExt = getExtensionFromUrl(tUrl);
                    var tLocalFileName = rowNumber + "_Tram" + tSubSuffix + "." + tExt;
                    var tFolderFs = _session.footageFolder ? _session.footageFolder.fsName : (new File(app.project.path).parent.fsName);
                    var tDownloadedFile = downloadFileFromUrl(tUrl, tFolderFs + "/" + tLocalFileName);
                    if (tDownloadedFile) {
                        downloadsDone++;
                        var tMediaItem = importAndGetProjectItem(tDownloadedFile.fsName);
                        if (tMediaItem) {
                            try {
                                tMediaItem.setInPoint("0", MEDIA_TYPE);
                                tMediaItem.setOutPoint(Math.round(tClipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                insertAndRenameClip(tramTrack, tMediaItem, v1StartTime, tramClipLabel, tClipDur, tramTimeInfo.mode !== "full");
                                tramInserted++; actions.push("Tr\u00e1m V2 " + tLocalFileName + " (" + tClipDur.toFixed(1) + "s)");
                            } catch(etm) {}
                        }
                    }
                }
            }
        }
        else if (tramCodeRaw !== "" && tramTimeInfo !== null) {
            var tramSourceToUse = (tramSourceRaw !== "") ? tramSourceRaw : (_session.lastTramFolder !== "" ? _session.lastTramFolder : _session.lastSourceFolder);
            var tramFileCodes = [], tcIdx, stc;
            if (isFullFilePath(tramCodeRaw)) {
                tramFileCodes = [stripQuotes(tramCodeRaw)];   // ca duong dan: khong tach theo dau phay
            } else {
                var rawTramCodes = tramCodeRaw.split(/[\r\n,;]+/);
                for (tcIdx = 0; tcIdx < rawTramCodes.length; tcIdx++) { stc = stripQuotes(rawTramCodes[tcIdx]); if (stc !== "") tramFileCodes.push(stc); }
            }
            if (tramFileCodes.length === 0) tramFileCodes = [tramCodeRaw];

            for (var tfIdx = 0; tfIdx < tramFileCodes.length; tfIdx++) {
                var singleTramCode = tramFileCodes[tfIdx];
                var tramSubCodeSuffix = (tramFileCodes.length > 1) ? ("." + (tfIdx+1)) : "";
                var tramLabel = labelEnabled ? (rowNumber + "_Tram" + tramSubCodeSuffix + "_" + shortCodeLabel(singleTramCode)) : null;
                var tramResult = resolveAndImport(tramSourceToUse, singleTramCode, _session.fileCache, _session.itemCache, _session.footageFolder, enableCopy);
                if (tramResult.skip) { warnings.push("Bỏ qua file trám không tìm thấy: " + singleTramCode); continue; }
                if (tramResult.error) { warnings.push("Tr\u00e1m l\u1ed7i: " + tramResult.error); continue; }
                if (tramResult.isNewCopy) copiesDone++;
                var tInSec, tOutSec;
                var tramDuration = getProjectItemDuration(tramResult.projectItem);
                var normalizedTramRange = resolveNormalizedTimeRange(tramTimeInfo, tramDuration, defaultDuration);
                if (normalizedTramRange) {
                    tInSec = normalizedTramRange.inSec; tOutSec = normalizedTramRange.outSec;
                    if (!normalizedTramRange.exact) {
                        warnings.push("Mốc 'hết' của trám " + singleTramCode + ": không xác định được thời lượng video → tạm lấy " + defaultDuration + "s");
                    }
                }
                else if (tramTimeInfo.mode === "full") { tInSec = tramTimeInfo.inSec; tOutSec = tramTimeInfo.outSec; }
                else if (tramTimeInfo.mode === "start") {
                    var tramSingleDuration = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                    tInSec = Math.max(0, tramTimeInfo.inSec - tramSingleDuration);
                    tOutSec = tramTimeInfo.inSec;
                }
                else {
                    if (noTimecodeMode === "full" && tramDuration !== null && tramDuration > 0) { tInSec = 0; tOutSec = tramDuration; }
                    else if (tramDuration === null || tramDuration <= 0) { tInSec = 0; tOutSec = noTimecodeDuration; }
                    else if (tramDuration <= noTimecodeDuration) { tInSec = 0; tOutSec = tramDuration; }
                    else { var tramMid = tramDuration/2; tInSec = tramMid - noTimecodeDuration/2; tOutSec = tramMid + noTimecodeDuration/2; }
                }
                // Cap tram duration at V1 clip duration
                var tDurRequested = tOutSec - tInSec;
                var tDurActual = (v1ClipDuration > 0 && tDurRequested > v1ClipDuration) ? v1ClipDuration : tDurRequested;
                tOutSec = tInSec + tDurActual;
                try {
                    waitForMediaReady(tramResult.projectItem, 6000);
                    tramResult.projectItem.setInPoint(Math.round(tInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    tramResult.projectItem.setOutPoint(Math.round(tOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var resTram = insertAndRenameClip(tramTrack, tramResult.projectItem, v1StartTime, tramLabel, tDurActual, tramTimeInfo.mode !== "full");
                    if (resTram.warning) warnings.push(resTram.warning);
                    if (!resTram.error) { tramInserted++; actions.push("Tr\u00e1m V2 " + (tramLabel || singleTramCode) + " (" + tDurActual.toFixed(1) + "s)"); }
                } catch(eTram) { warnings.push("L\u1ed7i ch\u00e8n tr\u00e1m: " + eTram.toString()); }
            }
        }
    }

    return toJson({
        status: (warnings.length > 0) ? "warning" : "success",
        rowNumber: rowNumber, details: actions.join(" | "),
        clipCount: clipsInserted, tramCount: tramInserted,
        copyCount: copiesDone, downloadCount: downloadsDone, warnings: warnings
    });
}

// =========================================================================
// COPY & RELINK: Copy tat ca source dang dung trong Timeline ve Footage/
// Chay theo tung file (scan -> copy/relink tung file) de panel khong bi treo
// =========================================================================

var _relink = { files: [], footagePath: "" };

function isWindowsOS() {
    try { return String($.os).toLowerCase().indexOf("win") !== -1; } catch (e) { return true; }
}

// Luu y: ExtendScript chi hieu chac chan dau "/" trong duong dan truyen vao File()/Folder().
// Duong dan toan backslash co the bi hieu sai -> File.exists = false du file co that.
function joinPath(dir, name) {
    var d = String(dir).replace(/[\\\/]+$/, "");
    return d + "/" + name;
}

function fileSizeOf(f) {
    try { var L = f.length; if (typeof L === "number" && L >= 0) return L; } catch (e) {}
    return -1;
}

/**
 * Chay 1 lenh he thong.
 * LUU Y: Premiere Pro KHONG co system.callSystem() (do la API cua After Effects) -> phai dung app.system().
 */
function runShell(cmd) {
    try {
        if (typeof system !== "undefined" && system && system.callSystem) {
            return { ok: true, out: String(system.callSystem(cmd)) };
        }
    } catch (e1) {}
    try {
        if (typeof app !== "undefined" && app && app.system) {
            var rc = app.system(cmd);
            return { ok: true, out: "app.system exit=" + rc };
        }
    } catch (e2) { return { ok: false, out: "app.system: " + e2.toString() }; }
    return { ok: false, out: "khong goi duoc lenh he thong" };
}

function readTextFile(path) {
    try {
        var f = new File(path);
        if (!f.exists) return null;
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var s = f.read();
        f.close();
        return s;
    } catch (e) { return null; }
}

/**
 * Cho script PowerShell copy xong.
 * KHONG bao gio doan theo "file dich da hien ra chua" nua - copy file 20 GB qua mang
 * co the mat rat lau moi thay file, va bo cuoc som se lam mat buoc relink trong khi
 * robocopy van dang chay nen.
 * Can cu duy nhat:
 *   - file co (flag) do script ghi ra khi ket thuc: "OK <bytes>" hoac "FAIL ..."
 *   - nhip tim: script cap nhat so byte da copy vao file tien do moi ~0.7s
 */
function waitForScriptCopy(flagPath, progressPath, maxMs) {
    var waited = 0, step = 500, startWaitMs = 0, stallMs = 0, lastCopied = -1;
    while (waited < maxMs) {
        var flagTxt = readTextFile(flagPath);
        if (flagTxt !== null) {
            var t = trim(flagTxt);
            return { done: (t.indexOf("OK") === 0), info: t };
        }

        var prog = parseJson(readTextFile(progressPath) || "");
        if (prog && prog.byScript) {
            var cur = (typeof prog.copied === "number") ? prog.copied : -1;
            if (cur === lastCopied) {
                stallMs += step;
                if (stallMs >= 600000) return { done: false, info: "script copy đứng yên 10 phút" };
            } else { stallMs = 0; lastCopied = cur; }
        } else {
            startWaitMs += step;
            if (startWaitMs >= 180000) return { done: false, info: "script copy không khởi động được (chờ 3 phút)" };
        }

        try { $.sleep(step); } catch (e) { return { done: false, info: "lỗi chờ: " + e.toString() }; }
        waited += step;
    }
    return { done: false, info: "quá thời gian chờ tối đa" };
}

/** Ghi file text (khong BOM neu khong yeu cau) - dung de sinh script tam. */
function writeTextFile(path, content, withBom) {
    try {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("w")) return null;
        if (withBom) f.write("\uFEFF");   // PowerShell 5.1 can BOM moi doc dung duong dan tieng Viet
        f.write(content);
        f.close();
        return f;
    } catch (e) { return null; }
}

/**
 * Copy qua PowerShell: sinh 1 file .ps1 + 1 file .bat roi File.execute() file .bat.
 * Day la cach DUY NHAT chay duoc lenh he thong tu ExtendScript cua Premiere Pro
 * (Premiere khong co system.callSystem() cua After Effects, cung khong co app.system()).
 * .ps1 ghi kem BOM de PowerShell doc dung duong dan tieng Viet.
 */
function copyViaScriptFile(srcPath, destPath, srcLen, destFile) {
    var stamp = String(new Date().getTime());
    var tmp = Folder.temp.fsName;
    var ps1Path = tmp + "/autoimportcut_v2_copy_" + stamp + ".ps1";
    var batPath = tmp + "/autoimportcut_v2_copy_" + stamp + ".bat";
    var flagPath = tmp + "/autoimportcut_v2_copy_" + stamp + ".done";
    var progPath = copyProgressFilePath();

    function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

    // PowerShell lam chu toan bo: copy, bao tien do that (panel doc file nay), va tu XAC MINH
    // dung luong. ExtendScript chi doc ket qua cuoi cung -> khong con phu thuoc File.length.
    var ps = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$src = " + q(srcPath),
        "$dst = " + q(destPath),
        "$flag = " + q(flagPath),
        "$prog = " + q(String(progPath).replace(/\//g, "\\")),
        "$enc = New-Object System.Text.UTF8Encoding($false)",
        "$name = Split-Path -Leaf $dst",
        "$total = 0",
        "if (Test-Path -LiteralPath $src) { $total = (Get-Item -LiteralPath $src).Length }",
        "$dir = Split-Path -LiteralPath $dst",
        "if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
        "function Save-Prog($copied, $state) {",
        "  $o = [ordered]@{ state = $state; name = $name; dest = $dst; total = $total; copied = $copied; byScript = $true }",
        "  try { [System.IO.File]::WriteAllText($prog, ($o | ConvertTo-Json -Compress), $enc) } catch {}",
        "}",
        "Save-Prog 0 'copying'",
        // Copy theo tung khoi 8 MB de bao duoc so byte CHINH XAC theo thoi gian thuc.
        // (robocopy nhanh nhung Windows cap nhat dung luong file dich rat tre -> % bi giat 0 roi nhay 100.)
        "$part = $dst + '.importcut.part'",
        "$streamOk = $false",
        "$fsIn = $null; $fsOut = $null",
        "try {",
        "  if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }",
        "  $fsIn = [System.IO.File]::OpenRead($src)",
        "  $fsOut = [System.IO.File]::Create($part)",
        "  $buf = New-Object byte[] 8388608",
        "  $copied = 0",
        "  $sw = [System.Diagnostics.Stopwatch]::StartNew()",
        "  $lastMs = 0",
        "  while (($n = $fsIn.Read($buf, 0, $buf.Length)) -gt 0) {",
        "    $fsOut.Write($buf, 0, $n)",
        "    $copied += $n",
        "    if (($sw.ElapsedMilliseconds - $lastMs) -ge 300) { Save-Prog $copied 'copying'; $lastMs = $sw.ElapsedMilliseconds }",
        "  }",
        "  $fsOut.Close(); $fsOut = $null",
        "  $fsIn.Close(); $fsIn = $null",
        "  if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }",
        "  Move-Item -LiteralPath $part -Destination $dst -Force",
        "  $streamOk = $true",
        "} catch {",
        "  if ($fsOut -ne $null) { $fsOut.Close() }",
        "  if ($fsIn -ne $null) { $fsIn.Close() }",
        "  if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }",
        "}",
        // Du phong: robocopy (chiu duoc file dang bi khoa, o dia mang chap chon)
        "if (-not $streamOk) {",
        "  $srcDir = Split-Path -LiteralPath $src",
        "  $srcName = Split-Path -Leaf $src",
        "  if ($srcName -eq $name) {",
        "    $argStr = '\"{0}\" \"{1}\" \"{2}\" /NJH /NJS /NP /NDL /R:1 /W:2 /J' -f $srcDir, $dir, $srcName",
        "    $proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argStr -PassThru -WindowStyle Hidden",
        "    while (-not $proc.HasExited) {",
        "      $cur = 0",
        "      if (Test-Path -LiteralPath $dst) { $cur = (Get-Item -LiteralPath $dst).Length }",
        "      Save-Prog $cur 'copying'",
        "      Start-Sleep -Milliseconds 700",
        "    }",
        "  }",
        "}",
        "$dstLen = 0",
        "if (Test-Path -LiteralPath $dst) { $dstLen = (Get-Item -LiteralPath $dst).Length }",
        "if ($dstLen -ne $total) {",
        "  Copy-Item -LiteralPath $src -Destination $dst -Force",
        "  $dstLen = 0",
        "  if (Test-Path -LiteralPath $dst) { $dstLen = (Get-Item -LiteralPath $dst).Length }",
        "}",
        "Save-Prog $dstLen 'idle'",
        "if ($total -gt 0 -and $dstLen -eq $total) { \"OK $dstLen\" | Out-File -LiteralPath $flag -Encoding ascii }",
        "else { \"FAIL nguon=$total dich=$dstLen\" | Out-File -LiteralPath $flag -Encoding ascii }",
        ""
    ].join("\r\n");

    var bat = [
        "@echo off",
        "chcp 65001 >nul",
        'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps1Path.replace(/\//g, "\\") + '"',
        "exit",
        ""
    ].join("\r\n");

    if (!writeTextFile(ps1Path, ps, true)) return { ok: false, error: "không ghi được file .ps1 tạm" };
    if (!writeTextFile(batPath, bat, false)) return { ok: false, error: "không ghi được file .bat tạm" };

    var launched = false;
    try { launched = new File(batPath).execute(); } catch (eX) { launched = false; }
    if (!launched) return { ok: false, error: "File.execute() không chạy được script copy" };

    var res = waitForScriptCopy(flagPath, progPath, 14400000);

    try { new File(ps1Path).remove(); } catch (e1) {}
    try { new File(batPath).remove(); } catch (e2) {}
    try { new File(flagPath).remove(); } catch (e3) {}

    return res.done ? { ok: true, how: "PowerShell/robocopy" } : { ok: false, error: res.info };
}

/**
 * Copy bang lenh cua HE DIEU HANH - khong gioi han dung luong.
 * (File.copy() cua ExtendScript that bai voi file lon, vd file quay drone 20 GB.)
 */
function osCopyFile(srcFile, destFile) {
    var srcLen = fileSizeOf(srcFile), tried = [];
    var srcPath = srcFile.fsName, destPath = destFile.fsName;
    if (isWindowsOS()) { srcPath = srcPath.replace(/\//g, "\\"); destPath = destPath.replace(/\//g, "\\"); }

    try { if (destFile.parent && !destFile.parent.exists) destFile.parent.create(); } catch (eDir) {}

    // 1) Host co san API chay lenh (After Effects: system.callSystem) -> dung truc tiep cho nhanh.
    if (isWindowsOS()) {
        var probe = runShell('cmd.exe /c robocopy "' + srcPath.substring(0, srcPath.lastIndexOf("\\")) + '" "' +
                             destPath.substring(0, destPath.lastIndexOf("\\")) + '" "' +
                             srcPath.substring(srcPath.lastIndexOf("\\") + 1) + '" /NJH /NJS /NP /NDL /R:1 /W:2 /J');
        if (probe.ok) {
            tried.push("robocopy: " + probe.out);
            if (waitForCopyDone(destFile, srcLen, null, 14400000)) return { ok: true, how: "robocopy" };
        } else {
            tried.push(probe.out);
        }
    }

    // 2) Premiere Pro: khong co API chay lenh -> sinh script tam roi File.execute()
    var viaScript = copyViaScriptFile(srcPath, destPath, srcLen, destFile);
    if (viaScript.ok) return viaScript;
    tried.push("script: " + viaScript.error);

    return { ok: false, error: tried.join(" | ") };
}

/**
 * Copy 1 file mot cach chac chan, tra ve { ok, how, error }.
 * File.copy() cua ExtendScript co the that bai hoac tao file cut ngang (vd file 1 byte)
 * voi file lon / o dia mang / file dang bi Premiere khoa -> fallback sang lenh copy cua he dieu hanh.
 */
function robustCopy(srcFile, destFile) {
    var lastErr = "";
    var srcLen = fileSizeOf(srcFile);

    // An toan: khong bao gio copy de len chinh no
    try {
        if (normalizePath(srcFile.fsName) === normalizePath(destFile.fsName)) return { ok: true, how: "same-file" };
    } catch (eSame) {}

    beginCopyReport(srcFile, destFile);

    // File.copy() cua ExtendScript chi dung cho file NHO (< 300 MB): voi file lon no
    // that bai hoac tao ra file cut ngang ma van bao thanh cong.
    var tooBigForExtendScript = (srcLen < 0 || srcLen > 314572800);

    // 1) File.copy() cua ExtendScript (dich phai chua ton tai)
    if (!tooBigForExtendScript) {
        try {
            if (destFile.exists) { try { destFile.remove(); } catch (eR) {} }
            if (srcFile.copy(destFile.fsName)) {
                var chk = new File(destFile.absoluteURI);
                if (chk.exists && (srcLen < 0 || fileSizeOf(chk) === srcLen)) { endCopyReport(); return { ok: true, how: "File.copy" }; }
                lastErr = "File.copy() tạo ra file không đầy đủ";
            } else {
                lastErr = "File.copy() trả về false";
            }
        } catch (e1) { lastErr = "File.copy(): " + e1.toString(); }
    } else {
        lastErr = "File " + Math.round(srcLen / 1048576) + " MB - quá lớn cho File.copy()";
    }

    // 2) Fallback: lenh copy cua he dieu hanh (robocopy / copy / PowerShell)
    try {
        try { var d0 = new File(destFile.absoluteURI); if (d0.exists) d0.remove(); } catch (eR2) {}
        var os = osCopyFile(srcFile, destFile);
        if (os.ok) { endCopyReport(); return { ok: true, how: os.how }; }
        lastErr += " | " + os.error;
    } catch (e2) { lastErr += " | " + e2.toString(); }

    endCopyReport();
    return { ok: false, error: lastErr };
}

/** Ten file that su (da giai ma %20... vi File.name tra ve dang URI) */
function fileNameOf(pathStr) {
    var s = String(pathStr || "");
    try {
        var n = new File(s).name;
        try { n = decodeURI(n); } catch (eDec) {}
        if (n && n !== "") return n;
    } catch (e) {}
    var flat = s.replace(/\\/g, "/");
    var idx = flat.lastIndexOf("/");
    return (idx === -1) ? flat : flat.substring(idx + 1);
}

function parentDirNorm(pathStr) {
    var flat = normalizePath(pathStr);
    var idx = flat.lastIndexOf("/");
    return (idx === -1) ? "" : flat.substring(0, idx);
}

/** Tim TAT CA project item dang tro toi 1 duong dan (file co the import nhieu lan) */
function findAllProjectItemsByPath(rootItem, targetNorm, results) {
    try {
        for (var i = 0; i < rootItem.children.numItems; i++) {
            var item = rootItem.children[i];
            var isBin = false;
            try { isBin = (item.type === ProjectItemType.BIN); } catch (eT) { isBin = false; }
            if (isBin) { findAllProjectItemsByPath(item, targetNorm, results); }
            else {
                try { var mp = item.getMediaPath(); if (mp && normalizePath(mp) === targetNorm) results.push(item); } catch (e1) {}
            }
        }
    } catch (e2) {}
    return results;
}

/**
 * BUOC 1 - Quet toan bo source dang dung tren Timeline.
 * Tra ve danh sach file can copy (chua copy gi ca).
 */
function cep_scanTimelineSources(configJsonStr) {
    try {
        var config = parseJson(configJsonStr) || {};
        var footageFolderName = config.footageFolderName || "Footage";

        if (!app.project) return toJson({ success: false, error: "Ch\u01b0a m\u1edf Project" });
        var seq = app.project.activeSequence;
        if (!seq) return toJson({ success: false, error: "Kh\u00f4ng c\u00f3 Sequence \u0111ang active" });

        var footageFolder = getOrCreateFootageFolder(footageFolderName);
        if (!footageFolder) return toJson({ success: false, error: "Kh\u00f4ng t\u1ea1o \u0111\u01b0\u1ee3c th\u01b0 m\u1ee5c Footage" });
        var footageNorm = normalizePath(footageFolder.fsName);

        _relink = { files: [], footagePath: footageFolder.fsName };

        var seen = {}, skipCount = 0, clipCount = 0;
        var warnings = [], list = [];
        var numTracks = seq.videoTracks.numTracks;

        for (var t = 0; t < numTracks; t++) {
            var track = null;
            try { track = seq.videoTracks[t]; } catch (eTr) { continue; }
            if (!track || !track.clips) continue;
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                try {
                    var clip = track.clips[ci];
                    if (!clip) continue;
                    var pi = null;
                    try { pi = clip.projectItem; } catch (ePi) { pi = null; }
                    if (!pi) continue;
                    var mp = "";
                    try { mp = pi.getMediaPath ? pi.getMediaPath() : ""; } catch (eMp) { mp = ""; }
                    if (!mp || trim(mp) === "") continue;   // title / black video / synthetic
                    clipCount++;

                    var srcNorm = normalizePath(mp);
                    if (seen[srcNorm]) continue;
                    seen[srcNorm] = true;

                    if (parentDirNorm(mp) === footageNorm) { skipCount++; continue; } // da nam trong Footage/

                    var name = fileNameOf(mp);
                    var sizeMB = 0, sizeBytes = 0;
                    try {
                        var sf = new File(mp);
                        if (sf.exists) { sizeBytes = fileSizeOf(sf); if (sizeBytes < 0) sizeBytes = 0; sizeMB = Math.round((sizeBytes / 1048576) * 10) / 10; }
                    } catch (eSz) {}

                    _relink.files.push({ mediaPath: mp, normSrc: srcNorm, destPath: joinPath(footageFolder.fsName, name), name: name });
                    list.push({ name: name, sizeMB: sizeMB, sizeBytes: sizeBytes, mediaPath: mp });
                } catch (eClip) {
                    warnings.push("Kh\u00f4ng \u0111\u1ecdc \u0111\u01b0\u1ee3c 1 clip: " + eClip.toString());
                }
            }
        }

        return toJson({
            success: true,
            footagePath: footageFolder.fsName,
            files: list,
            skipCount: skipCount,
            clipCount: clipCount,
            trackCount: numTracks,
            warnings: warnings
        });
    } catch (e) {
        return toJson({ success: false, error: "L\u1ed7i qu\u00e9t Timeline: " + e.toString() + " (d\u00f2ng " + e.line + ")" });
    }
}

/**
 * BUOC 2 - Copy + relink DUNG 1 file theo index tu danh sach da quet.
 */
function cep_copyRelinkOne(idxStr) {
    var job = null;
    try {
        var i = parseInt(idxStr, 10);
        job = _relink.files[i];
        if (!job) return toJson({ success: false, name: "", error: "Kh\u00f4ng t\u00ecm th\u1ea5y job #" + idxStr + " (h\u00e3y qu\u00e9t l\u1ea1i)" });

        var srcFile = new File(job.mediaPath);
        if (!srcFile.exists) return toJson({ success: false, name: job.name, error: "Kh\u00f4ng t\u00ecm th\u1ea5y file ngu\u1ed3n: " + job.mediaPath });

        var destFile = new File(job.destPath);
        var srcLen = fileSizeOf(srcFile);
        var copied = false, note = "";

        var needCopy = true;
        if (destFile.exists) {
            var dLen = fileSizeOf(destFile);
            if (srcLen < 0 || dLen === srcLen) {
                needCopy = false;   // da co san va dung dung luong
            } else {
                note = "File trong Footage/ b\u1ecb l\u1ed7i/thi\u1ebfu (" + dLen + " byte so v\u1edbi " + srcLen + " byte) \u2192 copy l\u1ea1i";
            }
        }

        if (needCopy) {
            var cr = robustCopy(srcFile, destFile);
            if (!cr.ok) {
                var sizeTxt = (srcLen > 0) ? (" [" + (Math.round(srcLen / 1048576 * 10) / 10) + " MB]") : "";
                return toJson({ success: false, name: job.name, error: "Copy th\u1ea5t b\u1ea1i: " + job.name + sizeTxt + " \u2192 " + job.destPath + " | " + cr.error });
            }
            copied = true;
            // "how" chi de xem lai khi can, khong phai canh bao -> chi ghi kem khi da co ghi chu that
            if (note !== "" && cr.how) note = trim(note + " (" + cr.how + ")");
        }

        // Relink toan bo project item dang tro toi file cu
        var newPath = destFile.fsName;
        if (isWindowsOS()) newPath = newPath.replace(/\//g, "\\");
        var items = findAllProjectItemsByPath(app.project.rootItem, job.normSrc, []);
        var relinked = 0, relinkErr = "";

        for (var k = 0; k < items.length; k++) {
            var pi = items[k];
            if (!pi.changeMediaPath) { relinkErr = "Phi\u00ean b\u1ea3n Premiere n\u00e0y kh\u00f4ng h\u1ed7 tr\u1ee3 changeMediaPath()"; break; }
            try { pi.changeMediaPath(newPath, false); }
            catch (e1) { try { pi.changeMediaPath(newPath, true); } catch (e2) { relinkErr = e2.toString(); } }
            var after = "";
            try { after = pi.getMediaPath(); } catch (e3) {}
            if (normalizePath(after) === normalizePath(newPath)) relinked++;
            else if (!relinkErr) relinkErr = "Premiere kh\u00f4ng \u0111\u1ed5i \u0111\u01b0\u1ee3c \u0111\u01b0\u1eddng d\u1eabn (v\u1eabn l\u00e0: " + after + ")";
        }

        if (items.length === 0) relinkErr = "Kh\u00f4ng t\u00ecm th\u1ea5y Project Item cho file n\u00e0y trong Project panel";

        return toJson({
            success: true,
            name: job.name,
            copied: copied,
            relinked: relinked,
            itemCount: items.length,
            destPath: newPath,
            note: note,
            error: relinkErr
        });
    } catch (e) {
        return toJson({ success: false, name: (job ? job.name : ""), error: e.toString() + " (d\u00f2ng " + e.line + ")" });
    }
}

/** Giu lai ten ham cu de tuong thich nguoc (chay tuan tu 1 lan) */
function cep_copyAndRelinkFootage(configJsonStr) {
    var scanStr = cep_scanTimelineSources(configJsonStr);
    var scan = parseJson(scanStr);
    if (!scan || !scan.success) return scanStr;
    var copiedCount = 0, relinkCount = 0, errors = [];
    for (var i = 0; i < _relink.files.length; i++) {
        var r = parseJson(cep_copyRelinkOne(String(i)));
        if (!r) { errors.push("L\u1ed7i kh\u00f4ng x\u00e1c \u0111\u1ecbnh t\u1ea1i file #" + (i + 1)); continue; }
        if (!r.success) { errors.push(r.error); continue; }
        if (r.copied) copiedCount++;
        if (r.relinked) relinkCount += r.relinked;
        if (r.error) errors.push(r.name + ": " + r.error);
    }
    return toJson({
        success: true, copiedCount: copiedCount, relinkCount: relinkCount,
        skipCount: scan.skipCount, errors: errors, warnings: scan.warnings || [],
        footagePath: scan.footagePath
    });
}

function cep_finishSession() {
    _session.active = false;
    _session.fileCache = {}; _session.itemCache = {}; _session.durationCache = {};
    return toJson({ success: true });
}
