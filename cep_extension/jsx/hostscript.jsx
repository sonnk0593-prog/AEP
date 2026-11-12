$.global.AIC_V3 = (function () {
/*
    hostscript.jsx - Backend ExtendScript for Premiere Pro CEP Extension
    Auto Import & Cut V2
*/

// KHONG dat "#target premierepro" o day.
// CEP da tu nap file nay vao dung Premiere qua the <ScriptPath> trong manifest,
// nen dong do la thua. Tai hai hon: khi panel goi $.evalFile() de nap lai script
// sau khi cap nhat, chi thi #target khien ExtendScript chuyen file sang chay o
// mot ngu canh KHAC (engine chinh cua Premiere) thay vi ngu canh cua panel.
// Ket qua: khong bao loi gi, nhung bien trong panel van la ban cu -> lan nao
// cung phai khoi dong lai Premiere.

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
var IMPORTCUT_VERSION = "3.1.3";

var TICKS_PER_SECOND = 254016000000;
var MEDIA_TYPE = 4;
var MAX_SEARCH_DEPTH = 5;
var VIDEO_EXTENSIONS = ["mp4", "mov", "mxf", "mts", "m4v", "avi", "wmv", "webm", "mkv", "flv", "ts", "m2ts", "mpg", "mpeg"];
var IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "webp"];
var HEADER_SCAN_ROWS = 20;

var _session = {
    active: false,
    fileCache: {},
    itemCache: {},
    durationCache: {},
    folderPickCache: {},
    csvRows: null,
    footageFolder: null,
    downloadFolder: null,
    envatoFiles: {},
    convertedFiles: {},
    trimmedFiles: {},
    failedImportPath: "",
    lastBody: "",
    lastSourceFolder: "",
    lastFileCode: "",
    lastTramFolder: "",
    replacements: {},
    missingSources: {},
    timelineCursorSec: null,
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
                if (col !== undefined && col !== null && parseInt(col, 10) >= 0 && edit[field] !== undefined) {
                    var newVal = String(edit[field]);
                    if (/^https?:[\\\/]{2}/i.test(trim(newVal))) newVal = newVal.replace(/\\/g, "/");
                    rows[rowIndex][parseInt(col, 10)] = newVal;
                }
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
        if (codeC.length === 0 && srcC.length > 0 && content.path[srcC[0]] >= 1) {
            var singleMediaCol = srcC[0];
            codeC.push(singleMediaCol);
            content.full[singleMediaCol] = Math.max(content.full[singleMediaCol] || 0, 1);
            srcC.splice(0, 1);
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
    while ((match = regex.exec(text)) !== null) {
        var u = trim(match[1]);
        // Loại bỏ các dấu câu, ngoặc, nháy dính ở đuôi URL (ví dụ ghi chú "link (lấy từ...)" hoặc "link,")
        u = u.replace(/[.,;:!?)\"'>\]]+$/, "");
        // Nếu có chữ tiếng Việt dính liền vào đuôi link mà không có dấu cách (ký tự unicode > 127)
        var firstNonAscii = -1;
        for (var i = 0; i < u.length; i++) {
            if (u.charCodeAt(i) > 127) { firstNonAscii = i; break; }
        }
        if (firstNonAscii !== -1) {
            u = u.substring(0, firstNonAscii).replace(/[.,;:!?)\"'>\]]+$/, "");
        }
        if (u !== "") urls.push(u);
    }
    return urls;
}
function isEnvatoUrl(url) { return !!(url && url.toLowerCase().indexOf("envato.com") !== -1); }

function getEnvatoItemKey(url) {
    if (!url) return "item";
    var clean = trim(url).split("?")[0].split("#")[0].replace(/\/+$/, "");
    var mUuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(clean);
    if (mUuid) return mUuid[1].toLowerCase();
    var mCode = /-([A-Z0-9]{6,12})$/i.exec(clean);
    if (mCode) return mCode[1].toUpperCase();
    var lastSeg = clean.substring(clean.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9_-]/g, "_");
    return lastSeg || "item";
}

function findCachedEnvatoFile(folderObj, url) {
    if (!url) return null;
    var key = getEnvatoItemKey(url);
    if (_session.envatoFiles) {
        var mappedPath = _session.envatoFiles[url] || _session.envatoFiles[key];
        if (mappedPath) {
            var mf = new File(mappedPath);
            if (mf.exists && mf.length > 0) return mf;
        }
    }
    var dir = folderObj || _session.downloadFolder || _session.footageFolder;
    if (!dir || !dir.exists) return null;
    try {
        var cacheJsonFile = new File(dir.fsName + "/.envato_cache.json");
        if (cacheJsonFile.exists) {
            var rawCache = readTextFile(cacheJsonFile.fsName);
            var cacheObj = rawCache ? parseJson(rawCache) : null;
            if (cacheObj) {
                var relName = cacheObj[url] || cacheObj[key] || cacheObj[key.toLowerCase()];
                if (relName) {
                    var cf = new File(dir.fsName + "/" + relName);
                    if (cf.exists && cf.length > 0) return cf;
                }
            }
        }
    } catch (eCache) {}
    var exts = ["mp4", "mov", "m4v", "webm", "mkv"];
    for (var i = 0; i < exts.length; i++) {
        var cand = new File(dir.fsName + "/envato_" + key + "." + exts[i]);
        if (cand.exists && cand.length > 0) return cand;
    }
    try {
        var files = dir.getFiles("envato_" + key + ".*");
        if (files) {
            for (var fi = 0; fi < files.length; fi++) {
                if (files[fi] instanceof File && files[fi].length > 0) {
                    var nm = files[fi].name.toLowerCase();
                    if (nm.indexOf(".crdownload") === -1 && nm.indexOf(".part") === -1 && nm.indexOf(".tmp") === -1) {
                        return files[fi];
                    }
                }
            }
        }
    } catch (eFiles) {}
    return null;
}
function isYouTubeUrl(url) { var l = url.toLowerCase(); return l.indexOf("youtube.com") !== -1 || l.indexOf("youtu.be") !== -1; }
function getYouTubeVideoId(url) {
    if (!url) return "";
    var m1 = /[?&]v=([A-Za-z0-9_-]{6,20})/i.exec(url);
    if (m1) return m1[1];
    var m2 = /youtu\.be\/([A-Za-z0-9_-]{6,20})/i.exec(url);
    if (m2) return m2[1];
    var m3 = /youtube\.com\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})/i.exec(url);
    if (m3) return m3[1];
    return "";
}
function getExtensionFromUrl(url) {
    var clean = url.split("?")[0].split("#")[0], ld = clean.lastIndexOf(".");
    if (ld !== -1 && ld > clean.lastIndexOf("/")) { var ext = clean.substring(ld+1).toLowerCase(); if (ext.length >= 2 && ext.length <= 4) return ext; }
    return "jpg";
}

function isImageExtension(filename) {
    var lower = filename.toLowerCase();
    for (var i = 0; i < IMAGE_EXTENSIONS.length; i++) { var ext = "." + IMAGE_EXTENSIONS[i]; if (lower.indexOf(ext) === lower.length - ext.length) return true; }
    return false;
}

/** Link URL tro toi 1 file anh (khong phai video, khong phai YouTube/Envato). */
function isImageUrl(url) {
    if (!url) return false;
    var l = url.toLowerCase();
    if (isYouTubeUrl(url) || isEnvatoUrl(url)) return false;
    var ext = getExtensionFromUrl(url);
    for (var i = 0; i < IMAGE_EXTENSIONS.length; i++) { if (ext === IMAGE_EXTENSIONS[i]) return true; }
    // Nhan dien anh tu Google Drive, Imgur, ...
    if (l.indexOf("googleusercontent.com") !== -1) return true;
    if (l.indexOf("imgur.com") !== -1) return true;
    if (l.indexOf("i.ibb.co") !== -1) return true;
    return false;
}

/**
 * Chay mot doan PowerShell roi CHO den khi no xong.
 * Premiere KHONG co app.system() cung nhu system.callSystem(), nen cach duy nhat
 * la ghi file .ps1 + .bat roi File.execute(), va cho script tu bao xong bang mot
 * file co. Script luon ghi file co ke ca khi loi -> khong bao gio treo het gio.
 */
function runPowerShellAndWait(psBody, timeoutMs) {
    var stamp = String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 100000));
    var tmp = Folder.temp.fsName;
    var ps1Path  = tmp + "/autoimportcut_v2_run_" + stamp + ".ps1";
    var batPath  = tmp + "/autoimportcut_v2_run_" + stamp + ".bat";
    var flagPath = tmp + "/autoimportcut_v2_run_" + stamp + ".done";

    var flagQ = "'" + flagPath.replace(/'/g, "''") + "'";
    var ps = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "try {",
        psBody,
        "} catch {}",
        '"DONE" | Out-File -LiteralPath ' + flagQ + " -Encoding ascii",
        ""
    ].join("\r\n");

    var bat = [
        "@echo off",
        "chcp 65001 >nul",
        'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps1Path.replace(/\//g, "\\") + '"',
        "exit",
        ""
    ].join("\r\n");

    var ok = false;
    try {
        if (writeTextFile(ps1Path, ps, true) && writeTextFile(batPath, bat, false)) {
            var launched = false;
            try { launched = new File(batPath).execute(); } catch (eX) { launched = false; }
            if (launched) {
                var waited = 0, step = 150;
                while (waited < timeoutMs) {
                    if (new File(flagPath).exists) { ok = true; break; }
                    $.sleep(step);
                    waited += step;
                }
            }
        }
    } catch (eRun) { ok = false; }

    try { new File(ps1Path).remove(); } catch (e1) {}
    try { new File(batPath).remove(); } catch (e2) {}
    try { new File(flagPath).remove(); } catch (e3) {}
    return ok;
}

function downloadFileFromUrl(url, destPath) {
    try {
        url = trim(url); if (url === "") return null;
        var destFile = new File(destPath);
        if (!destFile.parent.exists) destFile.parent.create();
        if (destFile.exists && destFile.length > 0) return destFile;

        function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
        var ps = [
            "  $u = " + q(url),
            "  $o = " + q(destPath.replace(/\//g, "\\")),
            "  $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'",
            "  if (Test-Path -LiteralPath $curl) { & $curl -L -k -s -A 'Mozilla/5.0' -o $o $u }",
            // Du phong khi may khong co curl hoac curl that bai
            "  if (-not (Test-Path -LiteralPath $o) -or (Get-Item -LiteralPath $o).Length -eq 0) {",
            "    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
            "    $ProgressPreference = 'SilentlyContinue'",
            "    (New-Object Net.WebClient).DownloadFile($u, $o)",
            "  }"
        ].join("\r\n");

        runPowerShellAndWait(ps, 600000);
        var c = new File(destPath);
        return (c.exists && c.length > 0) ? c : null;
    } catch(e) { return null; }
}

/**
 * Tai video YouTube bang yt-dlp qua PowerShell.
 * yt-dlp duoc tim trong PATH hoac thu muc Footage.
 * Neu chua cai -> tu dong tai yt-dlp.exe portable ve thu muc Footage.
 * Tra ve File object neu thanh cong, null neu that bai.
 * result.warning chua thong bao can hien (vd: dang tai yt-dlp...).
 */
function downloadYouTubeVideo(url, destPath) {
    try {
        url = trim(url); if (url === "") return null;
        var destFile = new File(destPath);
        if (!destFile.parent.exists) destFile.parent.create();
        if (destFile.exists && destFile.length > 0) return destFile;

        function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
        var destWin = destPath.replace(/\//g, "\\");
        var destDir = destFile.parent.fsName.replace(/\//g, "\\");

        // Tim yt-dlp: trong PATH, Footage, hoac cac thu muc he thong/ung dung co san
        var ps = [
            "$ErrorActionPreference = 'Continue'",
            "$outPath = " + q(destWin),
            "$outDir = " + q(destDir),
            "$url = " + q(url),
            "",
            "# Tim yt-dlp",
            "$ytdlp = $null",
            "$inPath = Get-Command yt-dlp -ErrorAction SilentlyContinue",
            "if ($inPath) { $ytdlp = $inPath.Source }",
            "if (-not $ytdlp) {",
            "  $candidates = @(",
            "    (Join-Path $outDir 'yt-dlp.exe'),",
            "    (Join-Path $env:LOCALAPPDATA 'Meowgic\\binaries\\yt-dlp.exe'),",
            "    (Join-Path $env:LOCALAPPDATA 'Meowgic\\binaries\\yt-dlp.exe'),",
            "    (Join-Path $env:APPDATA 'blinkl.io\\resources\\io.any-paste.blinkl\\yt-dlp\\yt-dlp.exe'),",
            "    (Join-Path $env:LOCALAPPDATA 'yt-dlp\\yt-dlp.exe')",
            "  )",
            "  foreach ($c in $candidates) {",
            "    if (Test-Path -LiteralPath $c) { $ytdlp = $c; break }",
            "  }",
            "}",
            "",
            "# Tu dong tai yt-dlp.exe neu chua co",
            "if (-not $ytdlp) {",
            "  $local = Join-Path $outDir 'yt-dlp.exe'",
            "  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
            "  $ProgressPreference = 'SilentlyContinue'",
            "  $dlUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'",
            "  try {",
            "    $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'",
            "    if (Test-Path -LiteralPath $curl) { & $curl -L -k -s -o $local $dlUrl }",
            "    if (-not (Test-Path -LiteralPath $local) -or (Get-Item -LiteralPath $local).Length -lt 1000) {",
            "      (New-Object Net.WebClient).DownloadFile($dlUrl, $local)",
            "    }",
            "    if (Test-Path -LiteralPath $local) { $ytdlp = $local }",
            "  } catch {}",
            "}",
            "",
            "if (-not $ytdlp) { exit 1 }",
            "",
            "# Tim ffmpeg de hop nhat video chat luong cao nhat",
            "$ffmpeg = $null",
            "$inFf = Get-Command ffmpeg -ErrorAction SilentlyContinue",
            "if ($inFf) { $ffmpeg = $inFf.Source }",
            "if (-not $ffmpeg) {",
            "  $ffCandidates = @(",
            "    (Join-Path $outDir 'ffmpeg.exe'),",
            "    (Join-Path $env:LOCALAPPDATA 'Programs\\Meowgic\\resources\\backend\\binaries\\win\\ffmpeg.exe'),",
            "    (Join-Path $env:LOCALAPPDATA 'QuickMediaConverter\\ffmpeg.exe'),",
            "    (Join-Path $env:APPDATA 'blinkl.io\\resources\\ffmpeg\\ffmpeg.exe')",
            "  )",
            "  foreach ($f in $ffCandidates) {",
            "    if (Test-Path -LiteralPath $f) { $ffmpeg = $f; break }",
            "  }",
            "}",
            "",
            "# 1. Thu merge voi chat luong tot nhat (can ffmpeg)",
            "if ($ffmpeg) {",
            "  & $ytdlp --no-update --no-warnings --no-playlist --ffmpeg-location $ffmpeg -S 'vcodec:h264,res,acodec:m4a' -f 'bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][ext=mp4]/bv*[vcodec^=avc1]+ba/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b' --merge-output-format mp4 -o $outPath $url",
            "  if (Test-Path -LiteralPath $outPath) { exit 0 }",
            "}",
            "",
            "# 2. Fallback: single stream mp4 (khong can ffmpeg)",
            "& $ytdlp --no-update --no-warnings --no-playlist -S 'vcodec:h264,res,acodec:m4a' -f 'b[vcodec^=avc1][ext=mp4]/b[ext=mp4]/bv*[vcodec^=avc1][ext=mp4]/b' -o $outPath $url",
            "if (Test-Path -LiteralPath $outPath) { exit 0 }",
            "",
            "# 3. Last resort: bat ky format nao",
            "$outTemplate = $outPath -replace '\\.[^.]+$', '.%(ext)s'",
            "& $ytdlp --no-update --no-warnings --no-playlist -f 'b' -o $outTemplate $url",
            ""
        ].join("\r\n");

        var ok = runPowerShellAndWait(ps, 1800000);  // timeout 30 phut cho video dai
        // Kiem tra file output: co the la .mp4, .webm, .mkv tuy format YouTube
        var c = new File(destPath);
        if (c.exists && c.length > 0) return c;
        // Tim file co ten tuong tu nhung khac duoi mo rong hop le (khong lay .part, .ytdl...)
        var validMedia = { "mp4": 1, "mkv": 1, "webm": 1, "mov": 1, "m4v": 1, "ts": 1 };
        var baseName = destFile.name.replace(/\.[^.]+$/, "");
        var parentFiles = destFile.parent.getFiles(baseName + ".*");
        if (parentFiles) {
            for (var fi = 0; fi < parentFiles.length; fi++) {
                if (parentFiles[fi] instanceof File && parentFiles[fi].length > 0) {
                    var fExt = getExtensionFromUrl(parentFiles[fi].name);
                    if (validMedia[fExt]) return parentFiles[fi];
                }
            }
        }
        return null;
    } catch (e) { return null; }
}

// ---- Ghi file nhi phan bang chinh ExtendScript (khong can PowerShell) ----
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBinaryString(b64) {
    b64 = String(b64).replace(/[^A-Za-z0-9+\/=]/g, "");
    var out = "", i = 0;
    while (i < b64.length) {
        var e1 = B64_CHARS.indexOf(b64.charAt(i++));
        var e2 = B64_CHARS.indexOf(b64.charAt(i++));
        var e3 = B64_CHARS.indexOf(b64.charAt(i++));   // -1 neu la dau '=' (dem)
        var e4 = B64_CHARS.indexOf(b64.charAt(i++));
        if (e1 < 0 || e2 < 0) break;
        out += String.fromCharCode((e1 << 2) | (e2 >> 4));
        if (e3 >= 0) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
        if (e4 >= 0) out += String.fromCharCode(((e3 & 3) << 6) | e4);
    }
    return out;
}

function writeBinaryFile(path, binStr) {
    try {
        var f = new File(path);
        if (!f.parent.exists) f.parent.create();
        f.encoding = "BINARY";
        if (!f.open("w")) return false;
        f.write(binStr);
        f.close();
        var chk = new File(path);
        return chk.exists && chk.length > 0;
    } catch (e) { return false; }
}

function getOrCreateBlackVideoItem(footageFolder) {
    try {
        var folderPath = footageFolder ? footageFolder.fsName : (app.project.path ? new File(app.project.path).parent.fsName : Folder.temp.fsName);
        var blackPath = folderPath + "/Black_Video.png";
        var blackFile = new File(blackPath);
        if (!blackFile.exists || blackFile.length === 0) {
            // Truoc day goi app.system('powershell ... WriteAllBytes') -> Premiere khong co
            // app.system() nen dong nao co link YouTube/Envato deu lam hong ca dong.
            // ExtendScript ghi thang duoc file nhi phan, khong can goi lenh he thong.
            var b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
            if (!writeBinaryFile(blackPath, base64ToBinaryString(b64))) return null;
        }
        return importAndGetProjectItem(blackPath);
    } catch (e) { return null; }
}

// ---- Timecode Helpers ----
function parseTimeToSeconds(str) {
    if (!str) return null;
    str = trim(str).replace(/\s+/g, "");
    // Dạng 1p22, 1p22s, 1m22, 1m22s (phút & giây tiếng Việt)
    var mMinSec = /^(\d{1,2})[pm](\d{1,2})s?$/i.exec(str);
    if (mMinSec) {
        return parseInt(mMinSec[1], 10) * 60 + parseInt(mMinSec[2], 10);
    }
    // Dạng 26s hoặc t=26s
    var mSec = /^(?:t=)?(\d+)s$/i.exec(str);
    if (mSec) return parseInt(mSec[1], 10);
    // Dạng 1p hoặc 1m
    var mMin = /^(\d+)[pm]$/i.exec(str);
    if (mMin) return parseInt(mMin[1], 10) * 60;
    // Dạng HH:MM:SS hoặc MM:SS
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

        // Extract all timecodes from this line (hỗ trợ cả HH:MM:SS, MM:SS, 1p22, 26s)
        var timeRegex = /(\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?|\b\d{1,2}\s*[pm]\s*\d{1,2}s?\b|\b\d+\s*s\b)/gi;
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
            } else if (inSec !== null && outSec !== null && inSec > outSec) {
                // Timecode bị nhập ngược (vd: "3:29 - 3:26") -> hoán đổi IN/OUT để cắt đúng, nhưng vẫn báo rose
                results.push({ mode: "reversed", inSec: outSec, outSec: inSec });
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
    // Nếu là đường dẫn file đầy đủ thì giữ nguyên, không tách timecode
    if (isFullFilePath(raw)) return { codes: stripQuotes(raw), embeddedTime: "" };
    var urlsInRaw = extractUrls(raw);
    if (urlsInRaw.length > 0) {
        var remUrlText = raw;
        for (var ui = 0; ui < urlsInRaw.length; ui++) {
            remUrlText = remUrlText.replace(urlsInRaw[ui], " ");
        }
        var urlTimeRegex = /(\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?)/g;
        var urlTimeMatches = [], uMatch;
        while ((uMatch = urlTimeRegex.exec(remUrlText)) !== null) {
            urlTimeMatches.push(uMatch[1]);
        }
        return { codes: urlsInRaw.join("\n"), embeddedTime: urlTimeMatches.join(" - ") };
    }

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

/** Quét tất cả file video/ảnh trong thư mục (đệ quy) */
function getAllMediaFilesInFolder(folder, depth, results) {
    if (depth > MAX_SEARCH_DEPTH || !folder.exists) return;
    var items; try { items = folder.getFiles(); } catch(e) { return; }
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item instanceof Folder) {
            getAllMediaFilesInFolder(item, depth + 1, results);
        } else if (item instanceof File && (hasVideoExtension(item.name) || isImageExtension(item.name))) {
            results.push(item);
        }
    }
}

/** Chọn ngẫu nhiên X file từ danh sách file (không trùng lặp) */
function pickRandomFiles(files, count) {
    if (!files || files.length === 0) return [];
    if (files.length <= count) return files.slice(0);
    var pool = files.slice(0);
    for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, count);
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
    if (_session.convertedFiles && _session.convertedFiles[normalizePath(fsPath)]) {
        fsPath = _session.convertedFiles[normalizePath(fsPath)];
    }
    var normPath = normalizePath(fsPath);
    var existing = findProjectItemByPath(app.project.rootItem, normPath);
    if (existing) return existing;
    // ExtendScript importFiles requires Windows backslash path on Windows
    var winPath = fsPath.replace(/\//g, "\\");
    var ok = app.project.importFiles([winPath], true, app.project.rootItem, false);
    if (!ok) { _session.failedImportPath = fsPath; return null; }
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
        var projFile = new File(projectPath);
        var cur = projFile.parent;
        var rootDir = cur;
        var nameToUse = folderName || "Footage";

        // 1. Nếu project nằm trong thư mục _PRJ (hoặc thư mục con của _PRJ), thư mục gốc là cha của _PRJ
        var p = cur;
        while (p && p.parent && p.fsName !== p.parent.fsName) {
            if (p.name.toLowerCase() === "_prj") {
                rootDir = p.parent;
                break;
            }
            p = p.parent;
        }

        // 2. Nếu chưa tìm thấy _PRJ ở tổ tiên, kiểm tra thư mục cha có phải là order root không
        // (order root thường chứa _PRJ hoặc Footage cùng cấp)
        if (rootDir === cur && cur && cur.parent && cur.fsName !== cur.parent.fsName) {
            var checkPrj = new Folder(cur.parent.fsName + "/_PRJ");
            var checkFootage = new Folder(cur.parent.fsName + "/" + nameToUse);
            if (checkPrj.exists || checkFootage.exists) {
                rootDir = cur.parent;
            }
        }

        var ff = new Folder(rootDir.fsName + "/" + nameToUse);
        if (!ff.exists && !ff.create()) {
            // Fallback: nếu không tạo được ở rootDir thì thử tạo tại thư mục cạnh file project
            ff = new Folder(cur.fsName + "/" + nameToUse);
            if (!ff.exists && !ff.create()) return null;
        }
        return ff;
    } catch(e) { return null; }
}

// ---- Bao cao tien do copy cho panel qua 1 file JSON tam ----
// Panel (Node.js) doc file nay + do dung luong file dich de tinh % va toc do copy.
var _copyProgressPath = null;

function copyProgressFilePath() {
    if (_copyProgressPath === null) {
        try { _copyProgressPath = Folder.temp.fsName + "/autoimportcut_v3_copy_progress.json"; }
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

function beginCopyReport(srcFile, destFile, roboLogPath) {
    try {
        writeCopyProgress({
            state: "copying",
            name: fileNameOf(destFile.fsName),
            dest: destFile.fsName,
            total: fileSizeOf(srcFile),
            roboLog: roboLogPath || ""
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
        var srcLen = fileSizeOf(srcFile);
        if (destFile.exists && (srcLen <= 0 || fileSizeOf(destFile) === srcLen)) {
            return { file: destFile, isNew: false };
        }
        beginCopyReport(srcFile, destFile);

        // Chi file RẤT NHỎ (<= 256 KB) moi dung File.copy() cua ExtendScript;
        // moi file media lon hon phai copy bang lenh he dieu hanh (robocopy) de dat toc do Windows Explorer.
        var ok = false;
        if (srcLen >= 0 && srcLen <= 262144 && !destFile.exists) {
            try { ok = srcFile.copy(destFile.fsName); } catch (eC) { ok = false; }
            if (ok) {
                var chkNew = new File(destPath);
                if (!chkNew.exists || fileSizeOf(chkNew) !== srcLen) ok = false;   // copy cut ngang -> lam lai
            }
        }
        if (!ok) {
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
    if (c.length < 4 || (!hasVideoExtension(c) && !isImageExtension(c))) return false;
    return (c.substring(0, 2) === "\\\\") || /^[a-zA-Z]:[\\\/]/.test(c) || (c.charAt(0) === "/");
}

/** O chua DUONG DAN THU MUC (UNC \\server\... hoac D:\..., khong co duoi mo rong video/anh, khong phai URL) */
function isFolderPath(str) {
    if (!str) return false;
    var s = stripQuotes(str);
    if (s === "") return false;
    if (extractUrls(s).length > 0) return false;
    if (isFullFilePath(s)) return false;
    return looksLikeFolderValue(s);
}

function resolveSourceFileOnly(folderPath, code, fileCache) {
    folderPath = stripQuotes(folderPath);
    code = stripQuotes(code);
    var cacheKey = folderPath + "|" + code;
    if (_session.missingSources[sourceCheckKey(folderPath, code)]) return { skip: true, matchedFile: null, isAmbiguous: false };
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
    return { skip: false, matchedFile: matchedFile, isAmbiguous: isAmbiguous };
}

function resolveAndImport(folderPath, code, fileCache, itemCache, footageFolder, enableCopy) {
    var r = resolveSourceFileOnly(folderPath, code, fileCache);
    if (r.skip) return { skip: true, matchedPath: "" };
    var matchedFile = r.matchedFile;
    var isAmbiguous = r.isAmbiguous;
    if (!matchedFile) return { error: "Kh\u00f4ng t\u00ecm th\u1ea5y file m\u00e3 '" + stripQuotes(code) + "' trong '" + stripQuotes(folderPath) + "'" };
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
        found: !!(found && found.exists), foundPath: found && found.exists ? found.fsName : "", mediaType: "nas" });
}

function validateSourceUrls(items, rowNumber, kind, value, indexStart) {
    var urls = extractUrls(value || "");
    for (var i = 0; i < urls.length; i++) {
        var u = urls[i];
        if (isEnvatoUrl(u)) {
            var envKey = getEnvatoItemKey(u);
            var envCached = findCachedEnvatoFile(_session.validateFootageFolder, u);
            items.push({
                id: rowNumber + "-" + kind + "-envato-" + (indexStart + i),
                checkKey: "envato|" + envKey.toLowerCase(),
                rowNumber: rowNumber,
                kind: kind,
                folder: envCached ? envCached.parent.fsName : "Envato Stock Video",
                code: u,
                requested: u,
                displayFolder: envCached ? (envCached.parent.fsName + " (Đã tải sẵn trong Footage/)") : "Envato (Sẽ tải chất lượng cao nhất về Footage/)",
                displayName: envCached ? envCached.name : ("envato_" + envKey + " ← " + u),
                found: true,
                foundPath: envCached ? envCached.fsName : u,
                isEnvato: true,
                mediaType: "envato",
                envatoKey: envKey,
                envatoCached: !!envCached
            });
        } else {
            if (isYouTubeUrl(u)) { var ytId = getYouTubeVideoId(u) || u; var ytCf = (_session.validateFootageFolder && getYouTubeVideoId(u)) ? new File(_session.validateFootageFolder.fsName + "/yt_" + ytId + ".mp4") : null; var ytHas = !!(ytCf && ytCf.exists && ytCf.length > 0); items.push({ id: rowNumber + "-" + kind + "-yt-" + (indexStart + i), checkKey: "youtube|" + ytId, rowNumber: rowNumber, kind: kind, mediaType: "youtube", isYouTube: true, ytKey: ytId, ytCached: ytHas, folder: ytHas ? ytCf.parent.fsName : "YouTube Video", code: u, requested: u, displayFolder: ytHas ? (ytCf.parent.fsName + " (Đã tải sẵn trong Footage/)") : "YouTube (Tự động tải H.264 MP4 về Footage/)", displayName: ytHas ? ytCf.name : ("yt_" + ytId + ".mp4 ← " + u), found: true, foundPath: ytHas ? ytCf.fsName : u }); continue; }
            items.push({ id: rowNumber + "-" + kind + "-url-" + (indexStart + i), rowNumber: rowNumber, kind: kind, mediaType: "nas",
                folder: "", code: u, requested: u, displayFolder: "URL trực tiếp", displayName: u, found: true, foundPath: u });
        }

    }
}

function cep_validateSources(payloadJson) {
    var out = { success: false, items: [], error: "" };
    try {
        var payload = parseJson(payloadJson), cols = payload.cols, rows = parseCSV(payload.csvContent || "");
        if (!payload || !cols) { out.error = "Thiếu dữ liệu kịch bản để kiểm tra"; return toJson(out); }
        _session.missingSources = {};
        _session.validateFootageFolder = getOrCreateFootageFolder("Footage");
        out.footageFolderPath = _session.validateFootageFolder ? _session.validateFootageFolder.fsName : "";
        var lastFolder = "", lastCode = "", lastTramFolder = "";
        var headerIndex = parseInt(cols.headerRowIndex, 10);
        if (isNaN(headerIndex)) headerIndex = -1;
        var first = headerIndex + 1;
        for (var r = first; r < rows.length; r++) {
            var row = rows[r]; if (!row) continue;
            var source = cellAt(row, cols.sourceCol), code = cellAt(row, cols.codeCol), time = cellAt(row, cols.timeCol), body = cellAt(row, cols.bodyCol);
            var tramSource = cellAt(row, cols.tramSourceCol), tramCode = cellAt(row, cols.tramCodeCol);

            // Chuyển folder về cột source nếu bị xếp vào code (do sheet chỉ có 1 cột Media)
            if (isFolderPath(code) && (source === "" || isFolderPath(source))) {
                source = code;
                code = "";
            }
            if (isFolderPath(tramCode) && (tramSource === "" || isFolderPath(tramSource))) {
                tramSource = tramCode;
                tramCode = "";
            }

            // Gộp cột: nếu ô source/tramSource chứa đường dẫn file đầy đủ mà không có mã file riêng
            if (code === "" && isFullFilePath(source)) code = source;
            if (tramCode === "" && isFullFilePath(tramSource)) tramCode = tramSource;

            if (looksLikeFolderValue(source)) lastFolder = source;
            if (code !== "" && extractUrls(code).length === 0) lastCode = code;
            if (looksLikeFolderValue(tramSource)) lastTramFolder = tramSource;

            // Kiểm tra dòng chỉ có link folder (không có mã file, không có URL) -> lấy ngẫu nhiên
            var v1Urls = extractUrls(source + "\n" + code + "\n" + body);
            var isFolderOnlyV1 = (code === "" && v1Urls.length === 0 && isFolderPath(source));

            if (isFolderOnlyV1) {
                var fObj = new Folder(stripQuotes(source));
                var checkKey = sourceCheckKey(source, "[Folder]");
                var fExists = _session.replacements[checkKey] ? new Folder(_session.replacements[checkKey]).exists : fObj.exists;
                var randCount = payload.folderRandomCount || 3;
                if (!fExists) _session.missingSources[checkKey] = true;
                out.items.push({
                    id: (r + 1) + "-V1-folder",
                    checkKey: checkKey,
                    rowNumber: r + 1,
                    kind: "V1",
                    folder: source,
                    code: "[Folder ngẫu nhiên]",
                    requested: source,
                    displayFolder: source,
                    displayName: "[Lấy ngẫu nhiên " + randCount + " file]",
                    found: fExists,
                    foundPath: fExists ? fObj.fsName : "", mediaType: "nas"
                });
            } else if (v1Urls.length > 0 || code !== "" || source !== "" || time !== "") {
                validateSourceUrls(out.items, r + 1, "V1", source + "\n" + code + "\n" + body, 1);
                var codes = (v1Urls.length > 0 && (code === "" || extractUrls(code).length > 0)) ? [] : (isFullFilePath(lastCode) ? [lastCode] : lastCode.split(/[\r\n,;]+/));
                for (var c = 0; c < codes.length; c++) validateOneSource(out.items, r + 1, "V1", lastFolder, codes[c], c + 1);
            }

            var tramUrls = extractUrls(tramSource + "\n" + tramCode);
            var isFolderOnlyV2 = (payload.enableTram !== false && tramCode === "" && tramUrls.length === 0 && isFolderPath(tramSource));
            if (isFolderOnlyV2) {
                var tfObj = new Folder(stripQuotes(tramSource));
                var tCheckKey = sourceCheckKey(tramSource, "[Folder]");
                var tfExists = _session.replacements[tCheckKey] ? new Folder(_session.replacements[tCheckKey]).exists : tfObj.exists;
                if (!tfExists) _session.missingSources[tCheckKey] = true;
                out.items.push({
                    id: (r + 1) + "-V2-folder",
                    checkKey: tCheckKey,
                    rowNumber: r + 1,
                    kind: "V2",
                    folder: tramSource,
                    code: "[Folder ngẫu nhiên]",
                    requested: tramSource,
                    displayFolder: tramSource,
                    displayName: "[Lấy ngẫu nhiên file trám]",
                    found: tfExists,
                    foundPath: tfExists ? tfObj.fsName : "", mediaType: "nas"
                });
            } else if (payload.enableTram !== false && tramCode !== "") {
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
        if (!f.exists) {
            var fld = new Folder(stripQuotes(replacementPath));
            if (fld.exists) f = fld;
            else return toJson({ success: false, error: "File hoặc thư mục thay thế không tồn tại" });
        }
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
        } else if (!roseLabel && projectItem) {
            // Reset màu ProjectItem về mặc định để clip mới không kế thừa màu rose
            // từ lần xử lý trước (carry-forward cùng file)
            try { if (projectItem.setColorLabel) projectItem.setColorLabel(0); } catch (eResetBefore1) {}
            try { if (projectItem.setLabelColor) projectItem.setLabelColor(0); } catch (eResetBefore2) {}
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
        } else if (bestClip && !roseLabel) {
            // Đảm bảo clip có màu mặc định, không bị nhiễm màu rose từ clip trước
            try { if (bestClip.setColorLabel) bestClip.setColorLabel(0); } catch (eReset1) {}
            try { if (bestClip.setLabelColor) bestClip.setLabelColor(0); } catch (eReset3) {}
            try { if (bestClip.projectItem && bestClip.projectItem.setColorLabel) bestClip.projectItem.setColorLabel(0); } catch (eReset2) {}
            try { if (bestClip.projectItem && bestClip.projectItem.setLabelColor) bestClip.projectItem.setLabelColor(0); } catch (eReset4) {}
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

/**
 * Dem so the <sequence ...> co trong file XML vua xuat.
 *
 * VI SAO CAN: app.project.exportFinalCutProXML() co the tao ra file XML "rong
 * ruot" - chi co danh sach file media, khong co timeline nao. Import nguoc lai
 * vao Premiere thi chi thay cac clip roi trong bin, khong co sequence. Neu chi
 * kiem tra "file co ton tai khong" thi loi nay im lang di qua.
 *
 * Doc theo tung khoi 1MB thay vi nuot ca file: project lon co the ra XML vai
 * chuc MB, ExtendScript doc mot phat rat de treo.
 * Giu lai 20 ky tu cuoi moi khoi (tail) va KHONG dem trong phan tail cho toi
 * luot sau, de the <sequence bi cat doi giua hai khoi van duoc dem dung 1 lan.
 *
 * Tra ve -1 neu khong doc duoc file.
 */
function countSequencesInXml(path) {
    var f = new File(path);
    var count = 0;
    try {
        f.encoding = "UTF-8";
        if (!f.open("r")) return -1;
        var tail = "";
        var OVERLAP = 20;
        while (!f.eof) {
            var chunk = f.read(1048576);
            if (chunk === null || chunk === "") break;
            var buf = tail + chunk;
            var head, m;
            if (buf.length > OVERLAP) {
                head = buf.substr(0, buf.length - OVERLAP);
                tail = buf.substr(buf.length - OVERLAP);
            } else {
                head = ""; tail = buf;
            }
            m = head.match(/<sequence[\s>]/g);
            if (m) count += m.length;
        }
        m = tail.match(/<sequence[\s>]/g);
        if (m) count += m.length;
        f.close();
    } catch (e) {
        try { f.close(); } catch (e2) {}
        return -1;
    }
    return count;
}

/**
 * Xuat project dang mo ra file XML (Final Cut Pro 7 XML - xmeml), DAT CANH file
 * project va TRUNG TEN project.
 * Lay duong dan tu app.project.path roi chi thay duoi mo rong -> chac chan cung
 * thu muc, cung ten, khong phai ghep chuoi thu cong (ten co dau van dung).
 *
 * forceOverwrite = 0 va file da ton tai -> tra ve needConfirm, KHONG ghi de,
 * de panel hoi nguoi dung truoc.
 *
 * HAI DUONG XUAT, thu theo thu tu:
 *   1. sequence.exportAsFinalCutProXML()   -> rieng sequence dang mo.
 *   2. app.project.exportFinalCutProXML()  -> ca project (nhieu sequence + bin).
 *
 * VI SAO DUONG 1 DI TRUOC: hai lenh nay de ra HAI CAU TRUC XML khac nhau.
 *   Duong 1 -> <xmeml><sequence>                        (timeline nam ngay duoi goc)
 *   Duong 2 -> <xmeml><project><children><sequence>     (timeline bi boc 2 lop)
 * Duong 1 chinh la thu Premiere tao ra khi nguoi dung vao File > Export >
 * Final Cut Pro XML. Nhieu tool doc XMEML ben ngoai (vi du tool chuyen sang
 * CapCut) chi tim the <sequence> NGAY DUOI <xmeml>, gap cau truc duong 2 la bao
 * "khong tim thay <sequence>" du file van co timeline day du. Vi vay uu tien
 * duong 1 de file xuat ra dung dang pho thong nhat.
 * Duong 2 doi lai duoc ca project (moi sequence + cau truc bin) nen van giu lam
 * phuong an du phong khi khong co sequence nao dang mo, hoac khi duong 1 hong.
 *
 * Sau moi lan xuat deu dem the <sequence trong file; het sequence thi xoa file
 * do va chuyen sang duong con lai.
 */
function cep_exportProjectXml(forceOverwrite) {
    var res = { success: false, path: "", needConfirm: false, size: 0, method: "", seqCount: 0, warning: null };
    try {
        if (!app.project) { res.error = "Chưa mở project nào."; return toJson(res); }

        var projPath = app.project.path;
        if (!projPath || trim(projPath) === "") {
            res.error = "Project chưa được lưu nên chưa biết đặt file XML ở đâu. Hãy lưu project (Ctrl+S) rồi thử lại.";
            return toJson(res);
        }

        var projFile = new File(projPath);
        var full = projFile.fsName;                       // vd: D:\Du an\FANPAGE.prproj
        var outPath = full.replace(/\.[^.\\\/]+$/, "") + ".xml";
        res.path = outPath;

        var outFile = new File(outPath);
        if (outFile.exists && !forceOverwrite) { res.needConfirm = true; return toJson(res); }

        var activeSeq = null;
        try { activeSeq = app.project.activeSequence; } catch (eSeq) { activeSeq = null; }

        var numSeq = 0;
        try { numSeq = app.project.sequences.numSequences || 0; } catch (eNum) { numSeq = 0; }
        if (numSeq === 0 && !activeSeq) {
            res.error = "Project này không có sequence nào để xuất.\nHãy mở (hoặc tạo) một sequence trên timeline rồi thử lại.";
            return toJson(res);
        }

        var attempted = false;   // da goi duoc it nhat 1 ham xuat cua Premiere chua
        var lastErr = "";        // loi cua lan goi gan nhat, de bao khi ca hai duong deu hong

        // ---- Duong 1: xuat rieng sequence dang mo --------------------------
        if (activeSeq) {
            try { activeSeq.exportAsFinalCutProXML(outPath); attempted = true; } catch (e1) { lastErr = e1.toString(); }

            var check1 = new File(outPath);
            if (attempted && check1.exists && check1.length > 0) {
                var n1 = countSequencesInXml(outPath);
                // n1 < 0 = khong doc lai duoc file de dem; van coi la xuat duoc 1 sequence.
                if (n1 !== 0) {
                    res.success = true;
                    res.size = check1.length;
                    res.seqCount = (n1 < 0 ? 1 : n1);
                    res.method = "sequence";
                    if (numSeq > 1) {
                        res.warning = "File XML chỉ chứa sequence đang mở: \"" + (activeSeq.name || "") + "\" " +
                                      "(project có " + numSeq + " sequence, " + (numSeq - 1) + " cái còn lại không nằm trong file này). " +
                                      "Muốn xuất sequence khác thì mở nó trên timeline rồi bấm Xuất XML lại.";
                    }
                    return toJson(res);
                }
                // File co, nhung rong sequence -> bo di de khong de lai file loi.
                try { check1.remove(); } catch (eDel1) {}
            }
        }

        // ---- Duong 2: xuat ca project --------------------------------------
        try { app.project.exportFinalCutProXML(outPath, 1); attempted = true; } catch (e2) {
            lastErr = e2.toString();
            try { app.project.exportFinalCutProXML(outPath); attempted = true; } catch (e3) { lastErr = e3.toString(); }
        }

        if (!attempted) {
            res.error = "Bản Premiere này không hỗ trợ lệnh xuất XML (exportFinalCutProXML)" +
                        (lastErr ? ": " + lastErr : ".");
            return toJson(res);
        }

        var check = new File(outPath);
        if (!check.exists || check.length === 0) {
            res.error = "Premiere không tạo được file XML tại:\n" + outPath;
            return toJson(res);
        }

        var n2 = countSequencesInXml(outPath);
        if (n2 === 0) {
            res.error = "File XML đã tạo ra nhưng bên trong không có timeline nào, import lại sẽ chỉ thấy các file rời.\n" +
                        "Thường do sequence chứa thứ mà định dạng Final Cut XML không mô tả được (Motion Graphics/.mogrt, nested sequence, hiệu ứng đặc biệt).\n" +
                        "Thử tạo một sequence chỉ gồm các clip video/audio thường rồi xuất lại.";
            return toJson(res);
        }

        res.success = true;
        res.size = check.length;
        res.seqCount = (n2 < 0 ? 1 : n2);
        res.method = "project";
        // Canh bao that: file duong 2 co lop boc <project><children> nen mot so tool
        // ben ngoai (chuyen sang CapCut) se khong tim thay <sequence>.
        res.warning = (activeSeq
                        ? "Không xuất riêng được sequence \"" + (activeSeq.name || "") + "\" nên đã xuất cả project."
                        : "Hiện không có sequence nào đang mở nên đã xuất cả project. Mở sequence trên timeline rồi xuất lại sẽ ra file gọn hơn.") +
                      "\nFile này có thêm lớp bọc <project>; một số phần mềm chuyển XML sang CapCut sẽ báo \"không tìm thấy <sequence>\".";
    } catch (e) {
        res.error = "Lỗi xuất XML: " + e.toString();
    }
    return toJson(res);
}

/**
 * Mo thu muc chua file bang Explorer.
 * KHONG dung app.system(): Premiere Pro khong co ham do (xem ghi chu o
 * copyViaScriptFile). Folder.execute() la API san co cua ExtendScript, mo thang
 * thu muc bang trinh quan ly file mac dinh, khong can goi lenh he thong.
 */
function cep_revealInExplorer(path) {
    var res = { success: false };
    try {
        if (!path || trim(path) === "") { res.error = "Thiếu đường dẫn."; return toJson(res); }
        var f = new File(path);
        if (!f.exists) {
            res.error = "Không còn thấy file:\n" + path + "\n(có thể đã bị di chuyển hoặc xoá)";
            return toJson(res);
        }
        var folder = f.parent;
        if (!folder || !folder.exists) {
            res.error = "Không còn thấy thư mục chứa file:\n" + path;
            return toJson(res);
        }
        if (folder.execute()) {
            res.success = true;
            res.folder = folder.fsName;
        } else {
            res.error = "Windows từ chối mở thư mục:\n" + folder.fsName;
        }
    } catch (e) {
        res.error = "Không mở được thư mục: " + e.toString();
    }
    return toJson(res);
}

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
        if (looksLikeCode(codeV) || looksLikeFullFilePath(codeV) || looksLikePath(codeV) || looksLikePath(srcV) ||
            looksLikeCode(tCodeV) || looksLikeFullFilePath(tCodeV) || looksLikePath(tCodeV) || looksLikePath(tSrcV)) return r;
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
    _session.fileCache = {}; _session.itemCache = {}; _session.durationCache = {}; _session.folderPickCache = {};
    _session.csvRows = config.csvContent ? parseCSV(config.csvContent) : null;
    _session.lastBody = ""; _session.lastSourceFolder = ""; _session.lastFileCode = ""; _session.lastTramFolder = "";
    _session.timelineCursorSec = null;
    var footageFolder = null;
    if (config.enableCopyToLocal !== false) footageFolder = getOrCreateFootageFolder(config.footageFolderName || "Footage");
    _session.footageFolder = footageFolder;
    _session.downloadFolder = footageFolder || getOrCreateFootageFolder(config.footageFolderName || "Footage");
    _session.envatoFiles = {};
    _session.trimmedFiles = {};
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

function getPickedFolderFiles(cacheKey, folderPathStr, randCount) {
    if (_session.folderPickCache[cacheKey] !== undefined) return _session.folderPickCache[cacheKey];
    var fObj = new Folder(stripQuotes(folderPathStr));
    var chkKey = sourceCheckKey(folderPathStr, "[Folder]");
    if (_session.replacements[chkKey]) fObj = new Folder(_session.replacements[chkKey]);
    var allMedia = [];
    getAllMediaFilesInFolder(fObj, 0, allMedia);
    var chosen = (allMedia.length > 0) ? pickRandomFiles(allMedia, randCount) : [];
    _session.folderPickCache[cacheKey] = chosen;
    return chosen;
}

function parseRowFileCodes(codeToUse) {
    var fileCodes = [], anyFullPath = false, cIdx, sc;
    var codeLines = String(codeToUse || "").split(/[\r\n]+/), allLinesAreFiles = true;
    for (cIdx = 0; cIdx < codeLines.length; cIdx++) {
        sc = stripQuotes(codeLines[cIdx]);
        if (sc === "") continue;
        if (!isFullFilePath(sc)) { allLinesAreFiles = false; break; }
    }
    if (allLinesAreFiles) {
        for (cIdx = 0; cIdx < codeLines.length; cIdx++) { sc = stripQuotes(codeLines[cIdx]); if (sc !== "") fileCodes.push(sc); }
        anyFullPath = (fileCodes.length > 0);
    } else {
        var rawCodes = String(codeToUse || "").split(/[\r\n,;]+/);
        for (cIdx = 0; cIdx < rawCodes.length; cIdx++) {
            sc = stripQuotes(rawCodes[cIdx]);
            if (sc === "") continue;
            fileCodes.push(sc);
            if (isFullFilePath(sc)) anyFullPath = true;
        }
    }
    if (fileCodes.length === 0 && codeToUse !== "") fileCodes = [codeToUse];
    return { fileCodes: fileCodes, anyFullPath: anyFullPath };
}

function buildTrimKey(fsPath, rangeInfo, cfg, padSec, extraTag) {
    var norm = normalizePath(fsPath);
    var p = Math.round((Number(padSec) || 0) * 10);
    var m = (rangeInfo && rangeInfo.mode) ? rangeInfo.mode : "auto";
    if (extraTag) return norm + "|tag_" + extraTag + "|pad" + p;
    if (rangeInfo && rangeInfo.openEnd) {
        return norm + "|end_" + Math.round((rangeInfo.inSec || 0) * 100) + "|pad" + p;
    }
    if (m === "full" || m === "reversed") {
        return norm + "|full_" + Math.round((rangeInfo.inSec || 0) * 100) + "_" + Math.round((rangeInfo.outSec || 0) * 100) + "|pad" + p;
    }
    if (m === "start") {
        var sMode = (cfg && cfg.singleTimeMode) || "after";
        var sDur = (cfg && cfg.singleTimeEnabled !== false) ? (cfg.singleTimeDuration || 5) : ((cfg && cfg.defaultDuration) || 5);
        return norm + "|start_" + sMode + "_" + Math.round((rangeInfo.inSec || 0) * 100) + "_" + Math.round(sDur * 100) + "|pad" + p;
    }
    var noDur = (cfg && cfg.noTimecodeDuration) || 5;
    return norm + "|auto_center_" + Math.round(noDur * 100) + "|pad" + p;
}

function buildTrimRangeSpec(rangeInfo, cfg, randomDur) {
    var m = (rangeInfo && rangeInfo.mode) ? rangeInfo.mode : "auto";
    if (randomDur && randomDur > 0) {
        return {
            mode: "random",
            randomDur: randomDur,
            defaultDuration: (cfg && cfg.defaultDuration) || 5
        };
    }
    if (rangeInfo && rangeInfo.openEnd) {
        return {
            mode: "end",
            inSec: rangeInfo.inSec || 0,
            openEnd: true,
            defaultDuration: (cfg && cfg.defaultDuration) || 5
        };
    }
    return {
        mode: m,
        inSec: (rangeInfo && typeof rangeInfo.inSec === "number") ? rangeInfo.inSec : 0,
        outSec: (rangeInfo && typeof rangeInfo.outSec === "number") ? rangeInfo.outSec : 0,
        openEnd: !!(rangeInfo && rangeInfo.openEnd),
        defaultDuration: (cfg && cfg.defaultDuration) || 5,
        singleTimeMode: (cfg && cfg.singleTimeMode) || "after",
        singleTimeDuration: (cfg && cfg.singleTimeEnabled !== false) ? (cfg.singleTimeDuration || 5) : ((cfg && cfg.defaultDuration) || 5),
        noTimecodeMode: (cfg && cfg.noTimecodeMode) || "center",
        noTimecodeDuration: (cfg && cfg.noTimecodeDuration) || 5
    };
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
    var singleTimeMode = _session.config.singleTimeMode || "after";
    var singleTimeDuration = _session.config.singleTimeDuration || 5;
    var noTimecodeMode = _session.config.noTimecodeMode || "center";
    var noTimecodeDuration = _session.config.noTimecodeDuration || 5;
    var enableTram = _session.config.enableTram !== false;
    var labelEnabled = _session.config.enableLabel !== false;
    var enableCopy = _session.config.enableCopyToLocal !== false;
    var enableNas = _session.config.enableNas !== false;
    var enableEnvato = _session.config.enableEnvato !== false;
    var enableYouTube = _session.config.enableYouTube !== false;
    var skippedTypes = [];

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

    // Chuyển folder về sourceRaw nếu ô codeRaw thực chất là đường dẫn FOLDER (do sheet chỉ có 1 cột Media)
    if (isFolderPath(codeRaw) && (sourceRaw === "" || isFolderPath(sourceRaw))) {
        sourceRaw = codeRaw;
        codeRaw = "";
    }
    if (isFolderPath(tramCodeRaw) && (tramSourceRaw === "" || isFolderPath(tramSourceRaw))) {
        tramSourceRaw = tramCodeRaw;
        tramCodeRaw = "";
    }

    // Gộp cột: nếu ô source/tramSource chứa đường dẫn file đầy đủ mà không có mã file riêng
    if (codeRaw === "" && sourceRaw !== "") {
        var sLines = sourceRaw.split(/[\r\n]+/);
        var allSFull = true;
        for (var sli = 0; sli < sLines.length; sli++) {
            var slStr = stripQuotes(sLines[sli]);
            if (slStr === "") continue;
            if (!isFullFilePath(slStr)) { allSFull = false; break; }
        }
        if (allSFull && sLines.length > 0) {
            codeRaw = sourceRaw;
        }
    }
    if (tramCodeRaw === "" && tramSourceRaw !== "") {
        var tsLines = tramSourceRaw.split(/[\r\n]+/);
        var allTsFull = true;
        for (var tsli = 0; tsli < tsLines.length; tsli++) {
            var tslStr = stripQuotes(tsLines[tsli]);
            if (tslStr === "") continue;
            if (!isFullFilePath(tslStr)) { allTsFull = false; break; }
        }
        if (allTsFull && tsLines.length > 0) {
            tramCodeRaw = tramSourceRaw;
        }
    }

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

    var prevLastBody = _session.lastBody;
    var prevLastSourceFolder = _session.lastSourceFolder;
    var prevLastFileCode = _session.lastFileCode;
    var prevLastTramFolder = _session.lastTramFolder;

    // Carry-forward: chi ghi nho gia tri THAT SU la duong dan.
    // Cot source cua nhieu bang con bi dung de ghi chu ("che mat neu can"...) -> khong duoc
    // de ghi chu do de len thu muc dang dung cho cac hang phia sau.
    if (bodyRaw !== "") _session.lastBody = bodyRaw;
    if (looksLikeFolderValue(sourceRaw)) _session.lastSourceFolder = sourceRaw;
    if (codeRaw !== "" && extractUrls(codeRaw).length === 0) _session.lastFileCode = codeRaw;
    if (looksLikeFolderValue(tramSourceRaw)) _session.lastTramFolder = tramSourceRaw;

    // Parse tất cả time ranges (có thể nhiều dòng, mỗi dòng 1 đoạn)
    var allTimeRanges = parseAllTimeRanges(timeRaw);
    if (allTimeRanges === null) return toJson({ status: "skipped", rowNumber: rowNumber, details: "B\u1ecf qua d\u00f2ng N.A", clipCount: 0, copyCount: 0, downloadCount: 0 });

    var mainUrls = extractUrls(sourceRaw + "\n" + codeRaw + "\n" + bodyRaw);
    var isFolderOnlyV1 = (codeRaw === "" && mainUrls.length === 0 && isFolderPath(sourceRaw));
    var hasExplicitV1 = (codeRaw !== "" || timeRaw !== "");

    var tramUrls = extractUrls(tramSourceRaw + "\n" + tramCodeRaw);
    var isFolderOnlyV2 = (tramCodeRaw === "" && tramUrls.length === 0 && isFolderPath(tramSourceRaw));
    var hasTramExplicit = (tramUrls.length > 0) || (tramCodeRaw !== "") || isFolderOnlyV2;
    var dlFolder = _session.downloadFolder || _session.footageFolder || getOrCreateFootageFolder("Footage");
    if (rowData.envatoFiles && typeof rowData.envatoFiles === "object") {
        if (!_session.envatoFiles) _session.envatoFiles = {};
        for (var efKey in rowData.envatoFiles) {
            if (rowData.envatoFiles.hasOwnProperty(efKey)) _session.envatoFiles[efKey] = rowData.envatoFiles[efKey];
        }
    }
    if (rowData.convertedFiles && typeof rowData.convertedFiles === "object") {
        if (!_session.convertedFiles) _session.convertedFiles = {};
        for (var cfKey in rowData.convertedFiles) {
            if (rowData.convertedFiles.hasOwnProperty(cfKey)) _session.convertedFiles[normalizePath(cfKey)] = rowData.convertedFiles[cfKey];
        }
    }
    if (rowData.trimmedFiles && typeof rowData.trimmedFiles === "object") {
        if (!_session.trimmedFiles) _session.trimmedFiles = {};
        for (var tfKey in rowData.trimmedFiles) {
            if (rowData.trimmedFiles.hasOwnProperty(tfKey)) _session.trimmedFiles[tfKey] = rowData.trimmedFiles[tfKey];
        }
    }
    _session.failedImportPath = "";

    // ---- Uu tien tai video Envato o tang Node.js (EnvatoDownloader) truoc khi cat ----
    if (rowData.deferEnvato && enableEnvato) {
        var pendingEnvato = [], seenEnvKey = {}, ei;
        for (ei = 0; ei < mainUrls.length; ei++) {
            if (isEnvatoUrl(mainUrls[ei])) {
                var eKey1 = getEnvatoItemKey(mainUrls[ei]);
                if (!seenEnvKey[eKey1] && !findCachedEnvatoFile(dlFolder, mainUrls[ei])) {
                    seenEnvKey[eKey1] = true;
                    pendingEnvato.push({ url: mainUrls[ei], key: eKey1, kind: "V1" });
                }
            }
        }
        if (enableTram && tramTrack && hasTramExplicit && parseTimeRange(tramTimeRaw) !== null) {
            for (ei = 0; ei < tramUrls.length; ei++) {
                if (isEnvatoUrl(tramUrls[ei])) {
                    var eKey2 = getEnvatoItemKey(tramUrls[ei]);
                    if (!seenEnvKey[eKey2] && !findCachedEnvatoFile(dlFolder, tramUrls[ei])) {
                        seenEnvKey[eKey2] = true;
                        pendingEnvato.push({ url: tramUrls[ei], key: eKey2, kind: "V2" });
                    }
                }
            }
        }
        if (pendingEnvato.length > 0) {
            _session.lastBody = prevLastBody;
            _session.lastSourceFolder = prevLastSourceFolder;
            _session.lastFileCode = prevLastFileCode;
            _session.lastTramFolder = prevLastTramFolder;
            return toJson({
                status: "need_envato_download",
                rowNumber: rowNumber,
                footageDir: dlFolder ? dlFolder.fsName : "",
                downloads: pendingEnvato
            });
        }
    }

    // ---- Uu tien tai video YouTube + tu dong convert codec qua Sidecar Backend (V3) ----
    if (rowData.deferYouTube && enableYouTube) {
        var pendingYT = [], seenYTKey = {}, yti;
        var ytFolderFsPre = _session.footageFolder ? _session.footageFolder.fsName : (dlFolder ? dlFolder.fsName : "");
        for (yti = 0; yti < mainUrls.length; yti++) {
            if (isYouTubeUrl(mainUrls[yti])) {
                var yId1 = getYouTubeVideoId(mainUrls[yti]) || ("row_" + rowNumber + "_" + (yti + 1));
                var yDest1 = ytFolderFsPre + "/yt_" + yId1 + ".mp4";
                var yFile1 = new File(yDest1);
                if (!seenYTKey[yId1] && (!yFile1.exists || yFile1.length === 0)) {
                    seenYTKey[yId1] = true;
                    pendingYT.push({ url: mainUrls[yti], id: yId1, destPath: yFile1.fsName, kind: "V1" });
                }
            }
        }
        if (enableTram && tramTrack && hasTramExplicit && parseTimeRange(tramTimeRaw) !== null) {
            for (yti = 0; yti < tramUrls.length; yti++) {
                if (isYouTubeUrl(tramUrls[yti])) {
                    var yId2 = getYouTubeVideoId(tramUrls[yti]) || ("row_" + rowNumber + "_tram_" + (yti + 1));
                    var yDest2 = ytFolderFsPre + "/yt_" + yId2 + ".mp4";
                    var yFile2 = new File(yDest2);
                    if (!seenYTKey[yId2] && (!yFile2.exists || yFile2.length === 0)) {
                        seenYTKey[yId2] = true;
                        pendingYT.push({ url: tramUrls[yti], id: yId2, destPath: yFile2.fsName, kind: "V2" });
                    }
                }
            }
        }
        if (pendingYT.length > 0) {
            _session.lastBody = prevLastBody;
            _session.lastSourceFolder = prevLastSourceFolder;
            _session.lastFileCode = prevLastFileCode;
            _session.lastTramFolder = prevLastTramFolder;
            return toJson({
                status: "need_youtube_download",
                rowNumber: rowNumber,
                footageDir: ytFolderFsPre,
                downloads: pendingYT
            });
        }
    }

    var smartTrimCopy = (_session.config.smartTrimCopy !== false);
    var trimThresholdGB = parseFloat(_session.config.trimThresholdGB);
    if (isNaN(trimThresholdGB) || trimThresholdGB <= 0) trimThresholdGB = 1;
    var trimThresholdBytes = Math.round(trimThresholdGB * 1073741824);
    var trimPadSec = parseFloat(_session.config.trimPadSec);
    if (isNaN(trimPadSec) || trimPadSec < 0) trimPadSec = 10;

    // ---- Uu tien giao viec copy file cho Node.js (FastCopy) & Sidecar Smart Trim (> X GB) ----
    if (enableCopy && enableNas && _session.footageFolder && (rowData.deferCopy || rowData.deferTrimCopy)) {
        var candidates = [], pendingTrims = [], seenTrimKey = {}, ci, rPreIdx;
        var footageNormPre = normalizePath(_session.footageFolder.fsName);

        function queueFileOrTrim(candFile, rangeInfoObj, randomDurSec, extraSlotTag) {
            if (!candFile || !candFile.exists) return;
            if (parentDirNorm(candFile.fsName) === footageNormPre) return;
            var sLenCand = fileSizeOf(candFile);
            var isFullAuto = (!randomDurSec && rangeInfoObj && rangeInfoObj.mode === "auto" && noTimecodeMode === "full");
            if (smartTrimCopy && sLenCand > trimThresholdBytes && !isImageExtension(candFile.name) && !isFullAuto) {
                var tKey = buildTrimKey(candFile.fsName, rangeInfoObj, _session.config, trimPadSec, extraSlotTag || "");
                if (rowData.deferTrimCopy !== false && !seenTrimKey[tKey] && (!_session.trimmedFiles || !_session.trimmedFiles[tKey])) {
                    seenTrimKey[tKey] = true;
                    pendingTrims.push({
                        trimKey: tKey,
                        srcPath: candFile.fsName,
                        name: candFile.name,
                        sizeBytes: sLenCand,
                        padSec: trimPadSec,
                        rangeSpec: buildTrimRangeSpec(rangeInfoObj, _session.config, randomDurSec || 0)
                    });
                }
            } else {
                candidates.push(candFile);
            }
        }

        if (mainUrls.length === 0) {
            if (isFolderOnlyV1) {
                var preChosenV1 = getPickedFolderFiles("V1_" + rowNumber, sourceRaw, _session.config.folderRandomCount || 3);
                var preRandDur1 = _session.config.folderRandomDuration || 2;
                for (ci = 0; ci < preChosenV1.length; ci++) {
                    queueFileOrTrim(preChosenV1[ci], { mode: "auto" }, preRandDur1, "V1_" + rowNumber + "_" + ci);
                }
            } else if (hasExplicitV1) {
                var preSrc1 = _session.lastSourceFolder, preCode1 = _session.lastFileCode;
                var preParsed1 = parseRowFileCodes(preCode1);
                if (preCode1 !== "" && (preSrc1 !== "" || preParsed1.anyFullPath)) {
                    for (ci = 0; ci < preParsed1.fileCodes.length; ci++) {
                        var rf1 = resolveSourceFileOnly(preSrc1, preParsed1.fileCodes[ci], _session.fileCache);
                        if (rf1.matchedFile) {
                            for (rPreIdx = 0; rPreIdx < allTimeRanges.length; rPreIdx++) {
                                queueFileOrTrim(rf1.matchedFile, allTimeRanges[rPreIdx], 0, "");
                            }
                        }
                    }
                }
            }
        }
        if (enableTram && tramTrack && hasTramExplicit && tramUrls.length === 0) {
            if (isFolderOnlyV2) {
                var preChosenV2 = getPickedFolderFiles("V2_" + rowNumber, tramSourceRaw, _session.config.folderRandomCount || 3);
                var preRandDur2 = _session.config.folderRandomDuration || 2;
                for (ci = 0; ci < preChosenV2.length; ci++) {
                    queueFileOrTrim(preChosenV2[ci], { mode: "auto" }, preRandDur2, "V2_" + rowNumber + "_" + ci);
                }
            } else if (tramCodeRaw !== "" && parseTimeRange(tramTimeRaw) !== null) {
                var preTramTime = parseTimeRange(tramTimeRaw);
                var preSrc2 = (tramSourceRaw !== "") ? tramSourceRaw : (_session.lastTramFolder !== "" ? _session.lastTramFolder : _session.lastSourceFolder);
                var preParsed2 = parseRowFileCodes(tramCodeRaw);
                for (ci = 0; ci < preParsed2.fileCodes.length; ci++) {
                    var rf2 = resolveSourceFileOnly(preSrc2, preParsed2.fileCodes[ci], _session.fileCache);
                    if (rf2.matchedFile) {
                        queueFileOrTrim(rf2.matchedFile, preTramTime, 0, "");
                    }
                }
            }
        }

        if (pendingTrims.length > 0 && rowData.deferTrimCopy !== false) {
            _session.lastBody = prevLastBody;
            _session.lastSourceFolder = prevLastSourceFolder;
            _session.lastFileCode = prevLastFileCode;
            _session.lastTramFolder = prevLastTramFolder;
            return toJson({
                status: "need_trim_copy",
                rowNumber: rowNumber,
                footageDir: _session.footageFolder.fsName,
                trims: pendingTrims
            });
        }

        if (rowData.deferCopy) {
            var pendingCopies = [], seenDest = {};
            for (ci = 0; ci < candidates.length; ci++) {
                var cand = candidates[ci];
                if (!cand || !cand.exists) continue;
                var dPath = _session.footageFolder.fsName + "/" + cand.name;
                var dNorm = normalizePath(dPath);
                if (seenDest[dNorm]) continue;
                seenDest[dNorm] = true;
                var dFile = new File(dPath);
                var sLen = fileSizeOf(cand);
                if (!dFile.exists || (sLen > 0 && fileSizeOf(dFile) !== sLen)) {
                    pendingCopies.push({
                        srcPath: cand.fsName,
                        destPath: dFile.fsName,
                        name: cand.name,
                        sizeBytes: (sLen > 0 ? sLen : 0)
                    });
                }
            }
            if (pendingCopies.length > 0) {
                _session.lastBody = prevLastBody;
                _session.lastSourceFolder = prevLastSourceFolder;
                _session.lastFileCode = prevLastFileCode;
                _session.lastTramFolder = prevLastTramFolder;
                return toJson({ status: "need_copy", rowNumber: rowNumber, copies: pendingCopies });
            }
        }
    }

    var currentMainEnd = getTrackEndSeconds(mainTrack);
    var currentTramEnd = (tramTrack ? getTrackEndSeconds(tramTrack) : 0);
    if (_session.timelineCursorSec === null) {
        _session.timelineCursorSec = Math.max(currentMainEnd, currentTramEnd);
    } else {
        _session.timelineCursorSec = Math.max(_session.timelineCursorSec, Math.max(currentMainEnd, currentTramEnd));
    }
    var rowStartTime = _session.timelineCursorSec;

    var clipsInserted = 0, copiesDone = parseInt(rowData.preCopiedCount, 10) || 0, downloadsDone = parseInt(rowData.preDownloadedCount, 10) || 0;
    var warnings = [], actions = [];
    var v1ClipDuration = 0; // Will be set after inserting V1 clip

    // Base label: use AI override if available, else rowNumber
    var baseLabel = labelOverride ? (rowNumber + "_" + labelOverride) : String(rowNumber);

    // =========================================================================
    // 1. SOURCE CHINH (V1)
    // =========================================================================
    if (!hasExplicitV1 && mainUrls.length === 0 && !isFolderOnlyV1) {
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

            if (isYouTubeUrl(currentUrl)) {
                if (!enableYouTube) { skippedTypes.push("YouTube"); continue; }
                // === YOUTUBE: tai video bang yt-dlp ===
                var ytVidId = getYouTubeVideoId(currentUrl); var ytFileName = ytVidId ? ("yt_" + ytVidId + ".mp4") : (rowNumber + subSuffix + ".mp4");
                var ytFolderFs = _session.footageFolder ? _session.footageFolder.fsName : (new File(app.project.path).parent.fsName);
                var ytDestPath = ytFolderFs + "/" + ytFileName;
                var ytExistedBefore = (new File(ytDestPath)).exists; var ytDownloaded = downloadYouTubeVideo(currentUrl, ytDestPath);
                if (ytDownloaded) {
                    if (!ytExistedBefore) downloadsDone++;
                    var ytFsPath = ytDownloaded.fsName; var ytMediaItem = _session.itemCache[ytFsPath]; if (ytMediaItem === undefined) { ytMediaItem = importAndGetProjectItem(ytFsPath); _session.itemCache[ytFsPath] = ytMediaItem; }
                    if (_session.failedImportPath && rowData.allowConvertRetry !== false) { _session.lastBody = prevLastBody; _session.lastSourceFolder = prevLastSourceFolder; _session.lastFileCode = prevLastFileCode; _session.lastTramFolder = prevLastTramFolder; return toJson({ status: "need_codec_convert", rowNumber: rowNumber, filePath: _session.failedImportPath, footageDir: dlFolder ? dlFolder.fsName : "" }); }
                    if (!ytMediaItem) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Import YouTube thất bại: " + ytDownloaded.fsName });
                    try {
                        waitForMediaReady(ytMediaItem, 10000);
                        var ytTotalDur = getProjectItemDuration(ytMediaItem);
                        var ytInSec = 0, ytOutSec;
                        var ytNorm = resolveNormalizedTimeRange(urlRange, ytTotalDur, defaultDuration); if (ytNorm) { ytInSec = ytNorm.inSec; ytOutSec = ytNorm.outSec; } else if (urlRange.mode === "full" || urlRange.mode === "reversed") { ytInSec = urlRange.inSec; ytOutSec = urlRange.outSec; }
                        else if (urlRange.mode === "start") {
                            var ytSingleDur = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                            if (singleTimeMode === "before") { ytInSec = Math.max(0, urlRange.inSec - ytSingleDur); ytOutSec = urlRange.inSec; }
                            else { ytInSec = Math.max(0, urlRange.inSec); ytOutSec = ytInSec + ytSingleDur; if (ytTotalDur !== null && ytTotalDur > ytInSec) ytOutSec = Math.min(ytOutSec, ytTotalDur); }
                        }
                        else if (ytTotalDur !== null && ytTotalDur > 0) { ytOutSec = ytTotalDur; }
                        else { ytOutSec = clipDur; }
                        ytMediaItem.setInPoint(Math.round(ytInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                        ytMediaItem.setOutPoint(Math.round(ytOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                        var insertPosYT = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                        var resYT = insertAndRenameClip(mainTrack, ytMediaItem, insertPosYT, clipLabel, ytOutSec - ytInSec, false);
                        if (resYT.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resYT.error });
                        if (resYT.warning) warnings.push(resYT.warning);
                        clipsInserted++; v1ClipDuration += (ytOutSec - ytInSec);
                        actions.push("YouTube V1 " + (clipLabel || ytFileName) + " (" + (ytOutSec - ytInSec).toFixed(1) + "s)");
                    } catch(eYT) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Lỗi chèn YouTube: " + eYT.toString() }); }
                } else {
                    // Fallback: yt-dlp that bai -> chen Black Video placeholder
                    warnings.push("Không tải được YouTube (cần cài yt-dlp): " + currentUrl + " → dùng Black Video");
                    var blackItem = getOrCreateBlackVideoItem(_session.footageFolder);
                    if (blackItem) {
                        try {
                            blackItem.setInPoint("0", MEDIA_TYPE);
                            blackItem.setOutPoint(Math.round(clipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            var insertPosB = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                            var resB = insertAndRenameClip(mainTrack, blackItem, insertPosB, clipLabel, clipDur, true);
                            if (!resB.error) { clipsInserted++; v1ClipDuration = clipDur; }
                        } catch(eB) {}
                    }
                }
            } else if (isEnvatoUrl(currentUrl)) {
                if (!enableEnvato) { skippedTypes.push("Envato"); continue; }
                // === ENVATO: tai video chat luong cao nhat ve Footage/ va cat theo timecode ===
                var envKeyV1 = getEnvatoItemKey(currentUrl);
                var envFileV1 = findCachedEnvatoFile(dlFolder, currentUrl);
                if (envFileV1 && envFileV1.exists) {
                    var envFsPath = envFileV1.fsName;
                    var envProjectItem = _session.itemCache[envFsPath];
                    if (envProjectItem === undefined) {
                        envProjectItem = importAndGetProjectItem(envFsPath);
                        _session.itemCache[envFsPath] = envProjectItem;
                    }
                    if (_session.failedImportPath && rowData.allowConvertRetry !== false) { _session.lastBody = prevLastBody; _session.lastSourceFolder = prevLastSourceFolder; _session.lastFileCode = prevLastFileCode; _session.lastTramFolder = prevLastTramFolder; return toJson({ status: "need_codec_convert", rowNumber: rowNumber, filePath: _session.failedImportPath, footageDir: dlFolder ? dlFolder.fsName : "" }); }
                    if (!envProjectItem) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Import Envato thất bại: " + envFsPath });
                    try {
                        waitForMediaReady(envProjectItem, 10000);
                        var envDuration = getProjectItemDuration(envProjectItem);
                        for (var erIdx = 0; erIdx < allTimeRanges.length; erIdx++) {
                            var envRangeInfo = allTimeRanges[erIdx];
                            var envRangeSuffix = (allTimeRanges.length > 1) ? ("-" + (erIdx + 1)) : "";
                            var envClipLabel = labelEnabled ? (baseLabel + subSuffix + envRangeSuffix + "_Envato_" + envKeyV1.substring(0, 8)) : null;
                            var envInSec, envOutSec;
                            var envNormRange = resolveNormalizedTimeRange(envRangeInfo, envDuration, defaultDuration);
                            if (envNormRange) {
                                envInSec = envNormRange.inSec; envOutSec = envNormRange.outSec;
                                if (!envNormRange.exact) {
                                    warnings.push("Mốc 'hết' của Envato " + envKeyV1 + ": không xác định được thời lượng → tạm lấy " + defaultDuration + "s");
                                }
                            } else if (envRangeInfo.mode === "full") {
                                envInSec = envRangeInfo.inSec; envOutSec = envRangeInfo.outSec;
                            } else if (envRangeInfo.mode === "reversed") {
                                envInSec = envRangeInfo.inSec; envOutSec = envRangeInfo.outSec;
                                warnings.push("Timecode Envato bị nhập ngược tại dòng " + rowNumber + ": đã tự sửa");
                            } else if (envRangeInfo.mode === "start") {
                                var envSingleDur = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                                if (singleTimeMode === "before") { envInSec = Math.max(0, envRangeInfo.inSec - envSingleDur); envOutSec = envRangeInfo.inSec; }
                                else { envInSec = Math.max(0, envRangeInfo.inSec); envOutSec = envInSec + envSingleDur; if (envDuration !== null && envDuration > envInSec) envOutSec = Math.min(envOutSec, envDuration); }
                            } else {
                                if (noTimecodeMode === "full" && envDuration !== null && envDuration > 0) { envInSec = 0; envOutSec = envDuration; }
                                else if (envDuration === null || envDuration <= 0) { envInSec = 0; envOutSec = noTimecodeDuration; }
                                else if (envDuration <= noTimecodeDuration) { envInSec = 0; envOutSec = envDuration; }
                                else { var envMid = envDuration / 2; envInSec = envMid - noTimecodeDuration / 2; envOutSec = envMid + noTimecodeDuration / 2; }
                            }
                            envProjectItem.setInPoint(Math.round(envInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            envProjectItem.setOutPoint(Math.round(envOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            var insertPosEnvReal = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                            var roseEnv = (envRangeInfo.mode === "auto" || envRangeInfo.mode === "start" || envRangeInfo.mode === "reversed");
                            var resEnvReal = insertAndRenameClip(mainTrack, envProjectItem, insertPosEnvReal, envClipLabel, envOutSec - envInSec, roseEnv);
                            if (resEnvReal.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resEnvReal.error });
                            if (resEnvReal.warning) warnings.push(resEnvReal.warning);
                            clipsInserted++; v1ClipDuration += (envOutSec - envInSec);
                            actions.push("Envato V1 " + (envClipLabel || envFileV1.name) + " (" + envInSec.toFixed(0) + "s~" + envOutSec.toFixed(0) + "s)");
                        }
                    } catch (eEnvReal) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Lỗi chèn Envato V1: " + eEnvReal.toString() }); }
                } else {
                    warnings.push("Không tải được Envato (" + envKeyV1 + ") → dùng Black Video tạm");
                    var blackItemEnv = getOrCreateBlackVideoItem(_session.footageFolder);
                    if (!blackItemEnv) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Không tạo được Black Video" });
                    try {
                        blackItemEnv.setInPoint("0", MEDIA_TYPE);
                        blackItemEnv.setOutPoint(Math.round(clipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                        var insertPosEnv = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                        var resEnv = insertAndRenameClip(mainTrack, blackItemEnv, insertPosEnv, clipLabel, clipDur, urlRange.mode !== "full");
                        if (resEnv.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resEnv.error });
                        if (resEnv.warning) warnings.push(resEnv.warning);
                        clipsInserted++; v1ClipDuration = clipDur;
                        actions.push("Black Video (Envato) " + (clipLabel || rowNumber));
                    } catch(eEnv) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Lỗi chèn Black Video: " + eEnv.toString() }); }
                }
                if (false) {
                var blackItemEnv = getOrCreateBlackVideoItem(_session.footageFolder);
                if (!blackItemEnv) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Không tạo được Black Video" });
                try {
                    blackItemEnv.setInPoint("0", MEDIA_TYPE);
                    blackItemEnv.setOutPoint(Math.round(clipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insertPosEnv = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                    var resEnv = insertAndRenameClip(mainTrack, blackItemEnv, insertPosEnv, clipLabel, clipDur, urlRange.mode !== "full");
                    if (resEnv.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resEnv.error });
                    if (resEnv.warning) warnings.push(resEnv.warning);
                    clipsInserted++; v1ClipDuration = clipDur;
                    actions.push("Black Video (Envato) " + (clipLabel || rowNumber));
                } catch(eEnv) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Lỗi chèn Black Video: " + eEnv.toString() }); } }
            } else {
                var ext = getExtensionFromUrl(currentUrl);
                var localFileName = rowNumber + subSuffix + "." + ext;
                var folderFs = _session.footageFolder ? _session.footageFolder.fsName : (new File(app.project.path).parent.fsName);
                var localDestPath = folderFs + "/" + localFileName;
                var downloadedFile = downloadFileFromUrl(currentUrl, localDestPath);
                if (!downloadedFile) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Không tải được file từ link: " + currentUrl });
                downloadsDone++;
                var mediaItem = importAndGetProjectItem(downloadedFile.fsName);
                if (!mediaItem) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Import thất bại: " + downloadedFile.fsName });
                try {
                    mediaItem.setInPoint("0", MEDIA_TYPE);
                    mediaItem.setOutPoint(Math.round(clipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insertPosM = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                    var resM = insertAndRenameClip(mainTrack, mediaItem, insertPosM, clipLabel, clipDur, urlRange.mode !== "full");
                    if (resM.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resM.error });
                    if (resM.warning) warnings.push(resM.warning);
                    clipsInserted++; v1ClipDuration = clipDur;
                    actions.push("Đã tải " + localFileName + " (" + clipDur + "s)");
                } catch(eM) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Lỗi chèn media: " + eM.toString() }); }
            }
        }
            } else if (isFolderOnlyV1 && !enableNas) {
                skippedTypes.push("File NAS");
            } else if (isFolderOnlyV1) {
        // === FOLDER-ONLY: quét folder lấy ngẫu nhiên X file, mỗi file 2s (hoặc theo cấu hình) ===
        var randCountV1 = _session.config.folderRandomCount || 3;
        var randDurV1 = _session.config.folderRandomDuration || 2;
        var chosenV1 = getPickedFolderFiles("V1_" + rowNumber, sourceRaw, randCountV1);
        if (chosenV1.length === 0) {
            warnings.push("Thư mục trống hoặc không có file media hợp lệ: " + sourceRaw);
        } else {
            for (var rfi = 0; rfi < chosenV1.length; rfi++) {
                var cFile = chosenV1[rfi];
                var actualCFile = cFile;
                var v1RandTrimKey = buildTrimKey(cFile.fsName, { mode: "auto" }, _session.config, trimPadSec, "V1_" + rowNumber + "_" + rfi);
                var v1RandTrimInfo = (_session.trimmedFiles && _session.trimmedFiles[v1RandTrimKey]) ? _session.trimmedFiles[v1RandTrimKey] : null;
                if (v1RandTrimInfo && v1RandTrimInfo.filePath) {
                    actualCFile = new File(v1RandTrimInfo.filePath);
                } else if (enableCopy && _session.footageFolder) {
                    var crV1 = copyFileToFootage(cFile, _session.footageFolder);
                    if (crV1 && crV1.file) { actualCFile = crV1.file; if (crV1.isNew) copiesDone++; }
                }
                var pItemV1 = importAndGetProjectItem(actualCFile.fsName);
                if (!pItemV1) { warnings.push("Import thất bại: " + actualCFile.fsName); continue; }
                try {
                    waitForMediaReady(pItemV1, 6000);
                    var inSecV1 = 0, outSecV1 = randDurV1;
                    if (v1RandTrimInfo && typeof v1RandTrimInfo.localInSec === "number" && typeof v1RandTrimInfo.localOutSec === "number") {
                        inSecV1 = v1RandTrimInfo.localInSec;
                        outSecV1 = v1RandTrimInfo.localOutSec;
                    } else {
                        var totDurV1 = getProjectItemDuration(pItemV1);
                        if (totDurV1 && totDurV1 > randDurV1) {
                            var maxStV1 = Math.max(0, totDurV1 - randDurV1);
                            inSecV1 = Math.floor(Math.random() * maxStV1);
                            outSecV1 = inSecV1 + randDurV1;
                        }
                    }
                    pItemV1.setInPoint(Math.round(inSecV1 * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    pItemV1.setOutPoint(Math.round(outSecV1 * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insPosV1 = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                    var cSuffixV1 = (chosenV1.length > 1) ? ("." + (rfi + 1)) : "";
                    var cLabelV1 = labelEnabled ? (baseLabel + cSuffixV1 + "_" + shortCodeLabel(cFile.name)) : null;
                    var resV1Rand = insertAndRenameClip(mainTrack, pItemV1, insPosV1, cLabelV1, randDurV1, false);
                    if (!resV1Rand.error) {
                        clipsInserted++;
                        v1ClipDuration += randDurV1;
                        actions.push("Folder V1 " + (cLabelV1 || cFile.name) + " (" + randDurV1 + "s)");
                    }
                } catch(eRandV1) { warnings.push("Lỗi chèn file ngẫu nhiên: " + eRandV1.toString()); }
            }
        }
    } else if (hasExplicitV1 && !enableNas) {
        skippedTypes.push("File NAS");
    } else if (hasExplicitV1) {
        // ---- NAS / local file path — carry-forward chỉ khi hàng có ít nhất source/code/time ----
        var sourceToUse = _session.lastSourceFolder;
        var codeToUse = _session.lastFileCode;
        if (codeToUse === "") return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Thiếu Source hoặc mã file" });

        var parsedV1Codes = parseRowFileCodes(codeToUse);
        var fileCodes = parsedV1Codes.fileCodes;
        var anyFullPath = parsedV1Codes.anyFullPath;
        if (sourceToUse === "" && !anyFullPath) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Thiếu Source hoặc mã file" });

        for (var fIdx = 0; fIdx < fileCodes.length; fIdx++) {
            var currentCode = fileCodes[fIdx];
            var srcResolvedV1 = resolveSourceFileOnly(sourceToUse, currentCode, _session.fileCache);
            if (srcResolvedV1.skip) { warnings.push("Bỏ qua file không tìm thấy: " + currentCode); continue; }
            if (!srcResolvedV1.matchedFile) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Kh\u00f4ng t\u00ecm th\u1ea5y file m\u00e3 '" + stripQuotes(currentCode) + "' trong '" + stripQuotes(sourceToUse) + "'" });
            if (srcResolvedV1.isAmbiguous) warnings.push("Mã '" + currentCode + "' khớp nhiều file, đang dùng: " + srcResolvedV1.matchedFile.fsName);

            var fullMainResult = null;
            var multiFileCount = fileCodes.length;
            for (var rIdx = 0; rIdx < allTimeRanges.length; rIdx++) {
                var timeRangeInfo = allTimeRanges[rIdx];
                var needFileIdx = (multiFileCount > 1);
                var needRangeIdx = (allTimeRanges.length > 1);
                var clipSuffix = "";
                if (needFileIdx) clipSuffix += "." + (fIdx + 1);
                if (needRangeIdx) clipSuffix += "-" + (rIdx + 1);
                var clipLabel = labelEnabled ? (baseLabel + clipSuffix + "_" + shortCodeLabel(currentCode)) : null;

                var v1TrimKey = buildTrimKey(srcResolvedV1.matchedFile.fsName, timeRangeInfo, _session.config, trimPadSec, "");
                var v1TrimInfo = (_session.trimmedFiles && _session.trimmedFiles[v1TrimKey]) ? _session.trimmedFiles[v1TrimKey] : null;
                var activeProjectItem = null;
                var inSec, outSec, dispInSec, dispOutSec;

                if (v1TrimInfo && v1TrimInfo.filePath && (new File(v1TrimInfo.filePath)).exists) {
                    var trimFsV1 = v1TrimInfo.filePath;
                    activeProjectItem = _session.itemCache[trimFsV1];
                    if (activeProjectItem === undefined) {
                        activeProjectItem = importAndGetProjectItem(trimFsV1);
                        _session.itemCache[trimFsV1] = activeProjectItem;
                    }
                    if (_session.failedImportPath && rowData.allowConvertRetry !== false) { _session.lastBody = prevLastBody; _session.lastSourceFolder = prevLastSourceFolder; _session.lastFileCode = prevLastFileCode; _session.lastTramFolder = prevLastTramFolder; return toJson({ status: "need_codec_convert", rowNumber: rowNumber, filePath: _session.failedImportPath, footageDir: dlFolder ? dlFolder.fsName : "" }); }
                    if (!activeProjectItem) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Import file cắt gọn thất bại: " + trimFsV1 });
                    inSec = v1TrimInfo.localInSec;
                    outSec = v1TrimInfo.localOutSec;
                    dispInSec = (typeof v1TrimInfo.reqInSec === "number") ? v1TrimInfo.reqInSec : inSec;
                    dispOutSec = (typeof v1TrimInfo.reqOutSec === "number") ? v1TrimInfo.reqOutSec : outSec;
                    if (timeRangeInfo.mode === "reversed") {
                        warnings.push("Timecode bị nhập ngược tại dòng " + rowNumber + ": đã tự sửa để cắt đúng");
                    }
                } else {
                    if (!fullMainResult) {
                        fullMainResult = resolveAndImport(sourceToUse, currentCode, _session.fileCache, _session.itemCache, _session.footageFolder, enableCopy);
                        if (_session.failedImportPath && rowData.allowConvertRetry !== false) { _session.lastBody = prevLastBody; _session.lastSourceFolder = prevLastSourceFolder; _session.lastFileCode = prevLastFileCode; _session.lastTramFolder = prevLastTramFolder; return toJson({ status: "need_codec_convert", rowNumber: rowNumber, filePath: _session.failedImportPath, footageDir: dlFolder ? dlFolder.fsName : "" }); }
                        if (fullMainResult.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: fullMainResult.error });
                        if (fullMainResult.isNewCopy) copiesDone++;
                    }
                    activeProjectItem = fullMainResult.projectItem;
                    var mainDuration = getProjectItemDuration(activeProjectItem);
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
                    else if (timeRangeInfo.mode === "reversed") {
                        inSec = timeRangeInfo.inSec; outSec = timeRangeInfo.outSec;
                        warnings.push("Timecode bị nhập ngược tại dòng " + rowNumber + ": đã tự sửa để cắt đúng");
                    }
                    else if (timeRangeInfo.mode === "start") {
                        var singleDuration = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                        if (singleTimeMode === "before") { inSec = Math.max(0, timeRangeInfo.inSec - singleDuration); outSec = timeRangeInfo.inSec; }
                        else { inSec = Math.max(0, timeRangeInfo.inSec); outSec = inSec + singleDuration; if (mainDuration !== null && mainDuration > inSec) outSec = Math.min(outSec, mainDuration); }
                    }
                    else {
                        if (noTimecodeMode === "full" && mainDuration !== null && mainDuration > 0) { inSec = 0; outSec = mainDuration; }
                        else if (mainDuration === null || mainDuration <= 0) { inSec = 0; outSec = noTimecodeDuration; warnings.push("Không đọc được thời lượng " + currentCode + ", lấy " + noTimecodeDuration + "s"); }
                        else if (mainDuration <= noTimecodeDuration) { inSec = 0; outSec = mainDuration; }
                        else { var mid = mainDuration/2; inSec = mid - noTimecodeDuration/2; outSec = mid + noTimecodeDuration/2; }
                    }
                    dispInSec = inSec;
                    dispOutSec = outSec;
                }

                try {
                    waitForMediaReady(activeProjectItem, 6000);
                    activeProjectItem.setInPoint(Math.round(inSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    activeProjectItem.setOutPoint(Math.round(outSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var insertPosV = (clipsInserted === 0) ? rowStartTime : Math.max(rowStartTime, getTrackEndSeconds(mainTrack));
                    var roseV = (timeRangeInfo.mode === "auto" || timeRangeInfo.mode === "start" || timeRangeInfo.mode === "reversed");
                    var resV = insertAndRenameClip(mainTrack, activeProjectItem, insertPosV, clipLabel, outSec - inSec, roseV);
                    if (resV.error) return toJson({ status: "error", rowNumber: rowNumber, errorMsg: resV.error });
                    if (resV.warning) warnings.push(resV.warning);
                    clipsInserted++; v1ClipDuration += (outSec - inSec);
                    actions.push("V1 " + (clipLabel || currentCode) + " (" + dispInSec.toFixed(0) + "s~" + dispOutSec.toFixed(0) + "s" + (v1TrimInfo ? " [Trim ±" + trimPadSec + "s]" : "") + ")");
                } catch(eInsert) { return toJson({ status: "error", rowNumber: rowNumber, errorMsg: "Lỗi chèn clip V1: " + eInsert.toString() }); }
            }
        }
    }

    // =========================================================================
    // 2. SOURCE TRAM (V2)
    //    - Only insert if THIS row has explicit tram code or tram URL
    //    - If V1 exists in this row, tram duration capped at remaining V1 boundary
    //    - If V1 is empty (tram-only row), tram inserts sequentially and advances timeline cursor
    // =========================================================================
    var tramInserted = 0;

    if (enableTram && tramTrack && hasTramExplicit) {
        var tramTimeInfo = parseTimeRange(tramTimeRaw);
        var tramInsertPos = rowStartTime;

        // Helper to cap tram duration at V1 clip length IF V1 exists in this row
        function getTramDur(requestedDur) {
            if (v1ClipDuration > 0) {
                var remainingV1 = Math.max(0, (rowStartTime + v1ClipDuration) - tramInsertPos);
                return Math.min(requestedDur, remainingV1);
            }
            return requestedDur;
        }

        if (tramUrls.length > 0 && tramTimeInfo !== null) {
            for (var tuIdx = 0; tuIdx < tramUrls.length; tuIdx++) {
                var tUrl = tramUrls[tuIdx];
                var tSubSuffix = (tramUrls.length > 1) ? ("." + (tuIdx+1)) : "";
                var tramClipLabel = labelEnabled ? (rowNumber + "_Tram" + tSubSuffix) : null;
                var tClipDurRaw = (tramTimeInfo.mode === "full") ? (tramTimeInfo.outSec - tramTimeInfo.inSec) : defaultDuration;
                var tClipDur = getTramDur(tClipDurRaw);

                if (v1ClipDuration > 0 && tClipDur <= 0.05) {
                    warnings.push("Trám link " + tUrl + ": vượt quá độ dài V1 nên bỏ qua");
                    continue;
                }

                if (isYouTubeUrl(tUrl)) {
                    if (!enableYouTube) { skippedTypes.push("YouTube Trám"); continue; }
                    // === YOUTUBE TRAM: tai video bang yt-dlp ===
                    var ytTramVidId = getYouTubeVideoId(tUrl); var ytTramName = ytTramVidId ? ("yt_" + ytTramVidId + ".mp4") : (rowNumber + "_Tram" + tSubSuffix + ".mp4");
                    var ytTramDir = _session.footageFolder ? _session.footageFolder.fsName : (new File(app.project.path).parent.fsName);
                    var ytTramDest = ytTramDir + "/" + ytTramName;
                    var ytTramExisted = (new File(ytTramDest)).exists; var ytTramFile = downloadYouTubeVideo(tUrl, ytTramDest);
                    if (ytTramFile) {
                        if (typeof ytTramExisted === "undefined" || !ytTramExisted) downloadsDone++;
                        var ytTramFs = ytTramFile.fsName; var ytTramMedia = _session.itemCache[ytTramFs]; if (ytTramMedia === undefined) { ytTramMedia = importAndGetProjectItem(ytTramFs); _session.itemCache[ytTramFs] = ytTramMedia; }
                        if (ytTramMedia) {
                            try {
                                waitForMediaReady(ytTramMedia, 10000);
                                var ytTramTotalDur = getProjectItemDuration(ytTramMedia);
                                var ytTramInSec = 0, ytTramOutSec;
                        var ytTramNorm = resolveNormalizedTimeRange(tramTimeInfo, ytTramTotalDur, defaultDuration); if (ytTramNorm) { ytTramInSec = ytTramNorm.inSec; ytTramOutSec = ytTramNorm.outSec; } else if (tramTimeInfo.mode === "full" || tramTimeInfo.mode === "reversed") { ytTramInSec = tramTimeInfo.inSec; ytTramOutSec = tramTimeInfo.outSec; }
                                else if (tramTimeInfo.mode === "start") {
                                    var ytTramSingleDur = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                                    if (singleTimeMode === "before") { ytTramInSec = Math.max(0, tramTimeInfo.inSec - ytTramSingleDur); ytTramOutSec = tramTimeInfo.inSec; }
                                    else { ytTramInSec = Math.max(0, tramTimeInfo.inSec); ytTramOutSec = ytTramInSec + ytTramSingleDur; if (ytTramTotalDur !== null && ytTramTotalDur > ytTramInSec) ytTramOutSec = Math.min(ytTramOutSec, ytTramTotalDur); }
                                }
                                else if (ytTramTotalDur !== null && ytTramTotalDur > 0) { ytTramOutSec = Math.min(ytTramTotalDur, tClipDur); }
                                else { ytTramOutSec = tClipDur; }
                                var ytTramActualDur = ytTramOutSec - ytTramInSec;
                                if (v1ClipDuration > 0) {
                                    var remV1 = Math.max(0, (rowStartTime + v1ClipDuration) - tramInsertPos);
                                    ytTramActualDur = Math.min(ytTramActualDur, remV1);
                                    if (ytTramActualDur <= 0.05) { warnings.push("Tr\u00e1m YouTube " + tUrl + ": v\u01b0\u1ee3t qu\u00e1 \u0111\u1ed9 d\u00e0i V1 n\u00ean b\u1ecf qua"); continue; }
                                    ytTramOutSec = ytTramInSec + ytTramActualDur;
                                }
                                ytTramMedia.setInPoint(Math.round(ytTramInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                ytTramMedia.setOutPoint(Math.round(ytTramOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                var resYTT = insertAndRenameClip(tramTrack, ytTramMedia, tramInsertPos, tramClipLabel, ytTramActualDur, false);
                                if (!resYTT.error) {
                                    tramInserted++;
                                    tramInsertPos += (resYTT.actualDur > 0 ? resYTT.actualDur : ytTramActualDur);
                                    actions.push("Tr\u00e1m V2 YouTube " + ytTramName + " (" + ytTramActualDur.toFixed(1) + "s)");
                                }
                            } catch(eYTT) { warnings.push("L\u1ed7i ch\u00e8n YouTube tr\u00e1m: " + eYTT.toString()); }
                        }
                    } else {
                        // Fallback: Black Video
                        warnings.push("Kh\u00f4ng t\u1ea3i \u0111\u01b0\u1ee3c YouTube tr\u00e1m (c\u1ea7n yt-dlp): " + tUrl + " \u2192 d\u00f9ng Black Video");
                        var tBlackItemFB = getOrCreateBlackVideoItem(_session.footageFolder);
                        if (tBlackItemFB) {
                            try {
                                tBlackItemFB.setInPoint("0", MEDIA_TYPE);
                                tBlackItemFB.setOutPoint(Math.round(tClipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                var resTBFB = insertAndRenameClip(tramTrack, tBlackItemFB, tramInsertPos, tramClipLabel, tClipDur, true);
                                if (!resTBFB.error) { tramInserted++; tramInsertPos += tClipDur; }
                            } catch(etbfb) {}
                        }
                    }
                } else if (isEnvatoUrl(tUrl)) {
                    if (!enableEnvato) { skippedTypes.push("Envato Trám"); continue; }
                    // === ENVATO TRAM: tai video chat luong cao nhat ve Footage/ va cat tram V2 ===
                    var tEnvKey = getEnvatoItemKey(tUrl);
                    var tEnvFile = findCachedEnvatoFile(dlFolder, tUrl);
                    if (tEnvFile && tEnvFile.exists) {
                        var tEnvFs = tEnvFile.fsName;
                        var tEnvMedia = _session.itemCache[tEnvFs];
                        if (tEnvMedia === undefined) {
                            tEnvMedia = importAndGetProjectItem(tEnvFs);
                            _session.itemCache[tEnvFs] = tEnvMedia;
                        }
                        if (tEnvMedia) {
                            try {
                                waitForMediaReady(tEnvMedia, 10000);
                                var tEnvDur = getProjectItemDuration(tEnvMedia);
                                var tEnvInSec, tEnvOutSec;
                                var tEnvNorm = resolveNormalizedTimeRange(tramTimeInfo, tEnvDur, defaultDuration);
                                if (tEnvNorm) {
                                    tEnvInSec = tEnvNorm.inSec; tEnvOutSec = tEnvNorm.outSec;
                                } else if (tramTimeInfo.mode === "full") {
                                    tEnvInSec = tramTimeInfo.inSec; tEnvOutSec = tramTimeInfo.outSec;
                                } else if (tramTimeInfo.mode === "reversed") {
                                    tEnvInSec = tramTimeInfo.inSec; tEnvOutSec = tramTimeInfo.outSec;
                                } else if (tramTimeInfo.mode === "start") {
                                    var tEnvSingleDur = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                                    if (singleTimeMode === "before") { tEnvInSec = Math.max(0, tramTimeInfo.inSec - tEnvSingleDur); tEnvOutSec = tramTimeInfo.inSec; }
                                    else { tEnvInSec = Math.max(0, tramTimeInfo.inSec); tEnvOutSec = tEnvInSec + tEnvSingleDur; if (tEnvDur !== null && tEnvDur > tEnvInSec) tEnvOutSec = Math.min(tEnvOutSec, tEnvDur); }
                                } else {
                                    if (noTimecodeMode === "full" && tEnvDur !== null && tEnvDur > 0) { tEnvInSec = 0; tEnvOutSec = tEnvDur; }
                                    else if (tEnvDur === null || tEnvDur <= 0) { tEnvInSec = 0; tEnvOutSec = noTimecodeDuration; }
                                    else if (tEnvDur <= noTimecodeDuration) { tEnvInSec = 0; tEnvOutSec = tEnvDur; }
                                    else { var tEnvMid = tEnvDur / 2; tEnvInSec = tEnvMid - noTimecodeDuration / 2; tEnvOutSec = tEnvMid + noTimecodeDuration / 2; }
                                }
                                var tEnvActualDur = tEnvOutSec - tEnvInSec;
                                if (v1ClipDuration > 0) {
                                    var remV1Env = Math.max(0, (rowStartTime + v1ClipDuration) - tramInsertPos);
                                    tEnvActualDur = Math.min(tEnvActualDur, remV1Env);
                                    if (tEnvActualDur <= 0.05) {
                                        warnings.push("Trám Envato " + tEnvKey + ": vượt quá độ dài V1 nên bỏ qua");
                                        continue;
                                    }
                                    tEnvOutSec = tEnvInSec + tEnvActualDur;
                                }
                                tEnvMedia.setInPoint(Math.round(tEnvInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                tEnvMedia.setOutPoint(Math.round(tEnvOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                var roseTramEnv = (tramTimeInfo.mode === "auto" || tramTimeInfo.mode === "start" || tramTimeInfo.mode === "reversed");
                                var tEnvLabel = labelEnabled ? (rowNumber + "_Tram" + tSubSuffix + "_Envato_" + tEnvKey.substring(0, 8)) : null;
                                var resTEnv = insertAndRenameClip(tramTrack, tEnvMedia, tramInsertPos, tEnvLabel, tEnvActualDur, roseTramEnv);
                                if (!resTEnv.error) {
                                    tramInserted++;
                                    tramInsertPos += (resTEnv.actualDur > 0 ? resTEnv.actualDur : tEnvActualDur);
                                    actions.push("Trám V2 Envato " + (tEnvLabel || tEnvFile.name) + " (" + tEnvActualDur.toFixed(1) + "s)");
                                }
                            } catch (eTEnv) { warnings.push("Lỗi chèn Envato trám: " + eTEnv.toString()); }
                        }
                    } else {
                        warnings.push("Không tải được Envato trám (" + tEnvKey + ") → dùng Black Video tạm");
                        var tBlackItem = getOrCreateBlackVideoItem(_session.footageFolder);
                        if (tBlackItem) {
                            try {
                                tBlackItem.setInPoint("0", MEDIA_TYPE);
                                tBlackItem.setOutPoint(Math.round(tClipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                var resTB = insertAndRenameClip(tramTrack, tBlackItem, tramInsertPos, tramClipLabel, tClipDur, tramTimeInfo.mode !== "full");
                                if (!resTB.error) {
                                    tramInserted++;
                                    tramInsertPos += (resTB.actualDur > 0 ? resTB.actualDur : tClipDur);
                                    actions.push("Tr\u00e1m V2 Black Envato (" + tClipDur.toFixed(1) + "s)");
                                }
                            } catch(etb) {}
                        }
                    }
                    if (false) {
                    var tBlackItem = getOrCreateBlackVideoItem(_session.footageFolder);
                    if (tBlackItem) {
                        try {
                            tBlackItem.setInPoint("0", MEDIA_TYPE);
                            tBlackItem.setOutPoint(Math.round(tClipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            var resTB = insertAndRenameClip(tramTrack, tBlackItem, tramInsertPos, tramClipLabel, tClipDur, tramTimeInfo.mode !== "full");
                            if (!resTB.error) {
                                tramInserted++;
                                tramInsertPos += (resTB.actualDur > 0 ? resTB.actualDur : tClipDur);
                                actions.push("Tr\u00e1m V2 Black Envato (" + tClipDur.toFixed(1) + "s)");
                            }
                        } catch(etb) {}
                    }
                    }
                } else {
                    var tExt = getExtensionFromUrl(tUrl);
                    var tLocalFileName = rowNumber + "_Tram" + tSubSuffix + "." + tExt;
                    var tFolderFs = _session.footageFolder ? _session.footageFolder.fsName : (new File(app.project.path).parent.fsName);
                    var tDownloadedFile = downloadFileFromUrl(tUrl, tFolderFs + "/" + tLocalFileName);
                    if (tDownloadedFile) {
                        if (typeof ytTramExisted === "undefined" || !ytTramExisted) downloadsDone++;
                        var tMediaItem = importAndGetProjectItem(tDownloadedFile.fsName);
                        if (tMediaItem) {
                            try {
                                tMediaItem.setInPoint("0", MEDIA_TYPE);
                                tMediaItem.setOutPoint(Math.round(tClipDur * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                                var resTM = insertAndRenameClip(tramTrack, tMediaItem, tramInsertPos, tramClipLabel, tClipDur, tramTimeInfo.mode !== "full");
                                if (!resTM.error) {
                                    tramInserted++;
                                    tramInsertPos += (resTM.actualDur > 0 ? resTM.actualDur : tClipDur);
                                    actions.push("Trám V2 " + tLocalFileName + " (" + tClipDur.toFixed(1) + "s)");
                                }
                            } catch(etm) {}
                        }
                    }
                }
            }
        }
        else if (isFolderOnlyV2 && !enableNas) {
            skippedTypes.push("File NAS Trám");
        } else if (isFolderOnlyV2) {
            // === FOLDER-ONLY TRAM: quét folder lấy ngẫu nhiên file trám ===
            var randCountV2 = _session.config.folderRandomCount || 3;
            var randDurV2 = _session.config.folderRandomDuration || 2;
            var chosenTram = getPickedFolderFiles("V2_" + rowNumber, tramSourceRaw, randCountV2);
            if (chosenTram.length > 0) {
                for (var trfi = 0; trfi < chosenTram.length; trfi++) {
                    var tcFile = chosenTram[trfi];
                    var tClipDur = getTramDur(randDurV2);
                    if (v1ClipDuration > 0 && tClipDur <= 0.05) break;

                    var actualTcFile = tcFile;
                    var v2RandTrimKey = buildTrimKey(tcFile.fsName, { mode: "auto" }, _session.config, trimPadSec, "V2_" + rowNumber + "_" + trfi);
                    var v2RandTrimInfo = (_session.trimmedFiles && _session.trimmedFiles[v2RandTrimKey]) ? _session.trimmedFiles[v2RandTrimKey] : null;
                    if (v2RandTrimInfo && v2RandTrimInfo.filePath) {
                        actualTcFile = new File(v2RandTrimInfo.filePath);
                    } else if (enableCopy && _session.footageFolder) {
                        var tcr = copyFileToFootage(tcFile, _session.footageFolder);
                        if (tcr && tcr.file) { actualTcFile = tcr.file; if (tcr.isNew) copiesDone++; }
                    }
                    var tMediaItem = importAndGetProjectItem(actualTcFile.fsName);
                    if (tMediaItem) {
                        try {
                            waitForMediaReady(tMediaItem, 6000);
                            var tInSec = 0, tOutSec = tClipDur;
                            if (v2RandTrimInfo && typeof v2RandTrimInfo.localInSec === "number") {
                                tInSec = v2RandTrimInfo.localInSec;
                                tOutSec = tInSec + tClipDur;
                            } else {
                                var tTotDur = getProjectItemDuration(tMediaItem);
                                if (tTotDur && tTotDur > tClipDur) {
                                    var tMaxSt = Math.max(0, tTotDur - tClipDur);
                                    tInSec = Math.floor(Math.random() * tMaxSt);
                                    tOutSec = tInSec + tClipDur;
                                }
                            }
                            tMediaItem.setInPoint(Math.round(tInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            tMediaItem.setOutPoint(Math.round(tOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                            var tSubSuff = (chosenTram.length > 1) ? ("." + (trfi + 1)) : "";
                            var tLabel = labelEnabled ? (rowNumber + "_Tram" + tSubSuff + "_" + shortCodeLabel(tcFile.name)) : null;
                            var resTRand = insertAndRenameClip(tramTrack, tMediaItem, tramInsertPos, tLabel, tClipDur, false);
                            if (!resTRand.error) {
                                tramInserted++;
                                tramInsertPos += (resTRand.actualDur > 0 ? resTRand.actualDur : tClipDur);
                                actions.push("Folder V2 " + (tLabel || tcFile.name) + " (" + tClipDur + "s)");
                            }
                        } catch(eTRand) { warnings.push("Lỗi chèn trám ngẫu nhiên: " + eTRand.toString()); }
                    }
                }
            }
        }
        else if (tramCodeRaw !== "" && tramTimeInfo !== null && !enableNas) {
            skippedTypes.push("File NAS Trám");
        } else if (tramCodeRaw !== "" && tramTimeInfo !== null) {
            var tramSourceToUse = (tramSourceRaw !== "") ? tramSourceRaw : (_session.lastTramFolder !== "" ? _session.lastTramFolder : _session.lastSourceFolder);
            var tramFileCodes = parseRowFileCodes(tramCodeRaw).fileCodes;

            for (var tfIdx = 0; tfIdx < tramFileCodes.length; tfIdx++) {
                var singleTramCode = tramFileCodes[tfIdx];
                var tramSubCodeSuffix = (tramFileCodes.length > 1) ? ("." + (tfIdx+1)) : "";
                var tramLabel = labelEnabled ? (rowNumber + "_Tram" + tramSubCodeSuffix + "_" + shortCodeLabel(singleTramCode)) : null;

                var srcResolvedV2 = resolveSourceFileOnly(tramSourceToUse, singleTramCode, _session.fileCache);
                if (srcResolvedV2.skip) { warnings.push("Bỏ qua file trám không tìm thấy: " + singleTramCode); continue; }
                if (!srcResolvedV2.matchedFile) { warnings.push("Trám lỗi: Không tìm thấy file '" + singleTramCode + "'"); continue; }

                var v2TrimKey = buildTrimKey(srcResolvedV2.matchedFile.fsName, tramTimeInfo, _session.config, trimPadSec, "");
                var v2TrimInfo = (_session.trimmedFiles && _session.trimmedFiles[v2TrimKey]) ? _session.trimmedFiles[v2TrimKey] : null;
                var activeTramItem = null;
                var tInSec, tOutSec;

                if (v2TrimInfo && v2TrimInfo.filePath && (new File(v2TrimInfo.filePath)).exists) {
                    var trimFsV2 = v2TrimInfo.filePath;
                    activeTramItem = _session.itemCache[trimFsV2];
                    if (activeTramItem === undefined) {
                        activeTramItem = importAndGetProjectItem(trimFsV2);
                        _session.itemCache[trimFsV2] = activeTramItem;
                    }
                    if (!activeTramItem) { warnings.push("Import file trám cắt gọn thất bại: " + trimFsV2); continue; }
                    tInSec = v2TrimInfo.localInSec;
                    tOutSec = v2TrimInfo.localOutSec;
                    if (tramTimeInfo.mode === "reversed") {
                        warnings.push("Timecode trám bị nhập ngược tại dòng " + rowNumber + ": đã tự sửa");
                    }
                } else {
                    var tramResult = resolveAndImport(tramSourceToUse, singleTramCode, _session.fileCache, _session.itemCache, _session.footageFolder, enableCopy);
                    if (tramResult.skip) { warnings.push("Bỏ qua file trám không tìm thấy: " + singleTramCode); continue; }
                    if (tramResult.error) { warnings.push("Trám lỗi: " + tramResult.error); continue; }
                    if (tramResult.isNewCopy) copiesDone++;
                    activeTramItem = tramResult.projectItem;
                    var tramDuration = getProjectItemDuration(activeTramItem);
                    var normalizedTramRange = resolveNormalizedTimeRange(tramTimeInfo, tramDuration, defaultDuration);
                    if (normalizedTramRange) {
                        tInSec = normalizedTramRange.inSec; tOutSec = normalizedTramRange.outSec;
                        if (!normalizedTramRange.exact) {
                            warnings.push("Mốc 'hết' của trám " + singleTramCode + ": không xác định được thời lượng video → tạm lấy " + defaultDuration + "s");
                        }
                    }
                    else if (tramTimeInfo.mode === "full") { tInSec = tramTimeInfo.inSec; tOutSec = tramTimeInfo.outSec; }
                    else if (tramTimeInfo.mode === "reversed") {
                        tInSec = tramTimeInfo.inSec; tOutSec = tramTimeInfo.outSec;
                        warnings.push("Timecode trám bị nhập ngược tại dòng " + rowNumber + ": đã tự sửa");
                    }
                    else if (tramTimeInfo.mode === "start") {
                        var tramSingleDuration = singleTimeEnabled ? singleTimeDuration : defaultDuration;
                        if (singleTimeMode === "before") { tInSec = Math.max(0, tramTimeInfo.inSec - tramSingleDuration); tOutSec = tramTimeInfo.inSec; }
                        else { tInSec = Math.max(0, tramTimeInfo.inSec); tOutSec = tInSec + tramSingleDuration; if (tramDuration !== null && tramDuration > tInSec) tOutSec = Math.min(tOutSec, tramDuration); }
                    }
                    else {
                        if (noTimecodeMode === "full" && tramDuration !== null && tramDuration > 0) { tInSec = 0; tOutSec = tramDuration; }
                        else if (tramDuration === null || tramDuration <= 0) { tInSec = 0; tOutSec = noTimecodeDuration; }
                        else if (tramDuration <= noTimecodeDuration) { tInSec = 0; tOutSec = tramDuration; }
                        else { var tramMid = tramDuration/2; tInSec = tramMid - noTimecodeDuration/2; tOutSec = tramMid + noTimecodeDuration/2; }
                    }
                }

                // Cap tram duration at V1 clip duration only if V1 exists in this row
                var tDurRequested = tOutSec - tInSec;
                var tDurActual = tDurRequested;
                if (v1ClipDuration > 0) {
                    var remainingV1 = Math.max(0, (rowStartTime + v1ClipDuration) - tramInsertPos);
                    tDurActual = Math.min(tDurRequested, remainingV1);
                    if (tDurActual <= 0.05) {
                        warnings.push("Trám " + singleTramCode + ": vượt quá độ dài V1 (" + v1ClipDuration.toFixed(1) + "s) nên bỏ qua");
                        continue;
                    }
                }
                tOutSec = tInSec + tDurActual;
                try {
                    waitForMediaReady(activeTramItem, 6000);
                    activeTramItem.setInPoint(Math.round(tInSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    activeTramItem.setOutPoint(Math.round(tOutSec * TICKS_PER_SECOND).toString(), MEDIA_TYPE);
                    var roseTram = (tramTimeInfo.mode === "auto" || tramTimeInfo.mode === "start" || tramTimeInfo.mode === "reversed");
                    var resTram = insertAndRenameClip(tramTrack, activeTramItem, tramInsertPos, tramLabel, tDurActual, roseTram);
                    if (resTram.warning) warnings.push(resTram.warning);
                    if (!resTram.error) {
                        tramInserted++;
                        tramInsertPos += (resTram.actualDur > 0 ? resTram.actualDur : tDurActual);
                        actions.push("Trám V2 " + (tramLabel || singleTramCode) + " (" + tDurActual.toFixed(1) + "s" + (v2TrimInfo ? " [Trim ±" + trimPadSec + "s]" : "") + ")");
                    }
                } catch(eTram) { warnings.push("Lỗi chèn trám: " + eTram.toString()); }
            }
        }
    }

    var rowEndTimeV1 = (clipsInserted > 0) ? getTrackEndSeconds(mainTrack) : rowStartTime;
    var rowEndTimeTram = (tramInserted > 0) ? tramInsertPos : rowStartTime;
    _session.timelineCursorSec = Math.max(rowEndTimeV1, rowEndTimeTram);
    if (clipsInserted === 0 && tramInserted === 0 && warnings.length === 0 && skippedTypes.length > 0) return toJson({ status: "skipped", rowNumber: rowNumber, details: "Bỏ qua (" + skippedTypes.join(", ") + " đang tắt)", clipCount: 0, tramCount: 0, copyCount: 0, downloadCount: 0 });

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
 * Chay 1 lenh he thong - CHI dung de THAM DO, khong dua vao ket qua.
 * LUU Y: Premiere Pro khong co system.callSystem() (API cua After Effects) VA
 * cung khong co app.system() -> tren Premiere ham nay luon tra ve ok:false.
 * Can chay lenh that su thi dung runPowerShellAndWait().
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
function waitForScriptCopy(flagPath, destFile, srcLen, maxMs) {
    var waited = 0, step = 100;
    while (waited < maxMs) {
        var flagFile = new File(flagPath);
        if (flagFile.exists) {
            var flagTxt = readTextFile(flagPath);
            if (flagTxt !== null) {
                var t = trim(flagTxt);
                var ok = (t.indexOf("OK") === 0);
                if (ok && srcLen > 0) {
                    var df = new File(destFile.absoluteURI);
                    if (!df.exists || fileSizeOf(df) !== srcLen) ok = false;
                }
                return { done: ok, info: t };
            }
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
 * Copy truc tiep qua robocopy.exe trong .bat (KHONG khoi dong PowerShell de tranh 1.5-2s cold start
 * tren moi file, KHONG dung /J unbuffered I/O lam cham cache Windows, va ghi log tien do % that
 * cua robocopy de thanh tien do hien thi dung MB/s).
 */
function copyViaScriptFile(srcPath, destPath, srcLen, destFile) {
    var stamp = String(new Date().getTime()) + "_" + Math.floor(Math.random() * 10000);
    var tmp = Folder.temp.fsName;
    var batPath = tmp + "/autoimportcut_v2_copy_" + stamp + ".bat";
    var flagPath = tmp + "/autoimportcut_v2_copy_" + stamp + ".done";
    var roboLogPath = tmp + "/autoimportcut_v2_copy_" + stamp + ".robolog";
    var progPath = copyProgressFilePath();

    var srcWin = String(srcPath).replace(/\//g, "\\");
    var dstWin = String(destPath).replace(/\//g, "\\");
    var flagWin = String(flagPath).replace(/\//g, "\\");
    var roboLogWin = String(roboLogPath).replace(/\//g, "\\");

    var lastSlashSrc = srcWin.lastIndexOf("\\");
    var srcDir = (lastSlashSrc >= 0) ? srcWin.substring(0, lastSlashSrc) : srcWin;
    var srcName = (lastSlashSrc >= 0) ? srcWin.substring(lastSlashSrc + 1) : srcWin;

    var lastSlashDst = dstWin.lastIndexOf("\\");
    var dstDir = (lastSlashDst >= 0) ? dstWin.substring(0, lastSlashDst) : dstWin;
    var dstName = (lastSlashDst >= 0) ? dstWin.substring(lastSlashDst + 1) : dstWin;

    // Tranh loi robocopy khi duong dan ket thuc bang dau \ (vd "D:\") làm hỏng dấu ngoặc kép \"
    function cleanRoboDir(d) {
        var s = String(d).replace(/\\+$/, "");
        if (/^[A-Za-z]:$/.test(s)) return s + "\\.";
        return s;
    }

    try {
        writeTextFile(progPath, toJson({
            state: "copying",
            name: dstName,
            dest: destFile.fsName,
            total: (srcLen > 0 ? srcLen : 0),
            copied: 0,
            roboLog: roboLogPath,
            byScript: true,
            startedAt: (new Date()).getTime()
        }));
    } catch (eP) {}

    var batLines = [
        "@echo off",
        "chcp 65001 >nul",
        'if not exist "' + dstDir + '" mkdir "' + dstDir + '" >nul 2>&1'
    ];

    if (srcName.toLowerCase() === dstName.toLowerCase()) {
        batLines.push(
            'robocopy "' + cleanRoboDir(srcDir) + '" "' + cleanRoboDir(dstDir) + '" "' + srcName + '" /NJH /NJS /NDL /NC /NS /R:1 /W:1 > "' + roboLogWin + '" 2>&1',
            "if %ERRORLEVEL% LSS 8 (",
            '  echo OK> "' + flagWin + '"',
            ") else (",
            '  copy /Y /B "' + srcWin + '" "' + dstWin + '" >nul 2>&1',
            '  if exist "' + dstWin + '" (echo OK> "' + flagWin + '") else (echo FAIL robocopy exit=%ERRORLEVEL%> "' + flagWin + '")',
            ")"
        );
    } else {
        batLines.push(
            'copy /Y /B "' + srcWin + '" "' + dstWin + '" >nul 2>&1',
            'if exist "' + dstWin + '" (echo OK> "' + flagWin + '") else (echo FAIL copy exit=%ERRORLEVEL%> "' + flagWin + '")'
        );
    }
    batLines.push("exit", "");

    if (!writeTextFile(batPath, batLines.join("\r\n"), false)) {
        return { ok: false, error: "không ghi được file .bat tạm" };
    }

    var launched = false;
    try { launched = new File(batPath).execute(); } catch (eX) { launched = false; }
    if (!launched) {
        try { new File(batPath).remove(); } catch (e0) {}
        return { ok: false, error: "File.execute() không chạy được script copy" };
    }

    var res = waitForScriptCopy(flagPath, destFile, srcLen, 14400000);

    try { new File(batPath).remove(); } catch (e1) {}
    try { new File(flagPath).remove(); } catch (e2) {}
    try { new File(roboLogPath).remove(); } catch (e3) {}

    return res.done ? { ok: true, how: "robocopy" } : { ok: false, error: res.info };
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
        var sDir = srcPath.substring(0, srcPath.lastIndexOf("\\")).replace(/\\+$/, "");
        var dDir = destPath.substring(0, destPath.lastIndexOf("\\")).replace(/\\+$/, "");
        if (/^[A-Za-z]:$/.test(sDir)) sDir += "\\.";
        if (/^[A-Za-z]:$/.test(dDir)) dDir += "\\.";
        var probe = runShell('cmd.exe /c robocopy "' + sDir + '" "' + dDir + '" "' +
                             srcPath.substring(srcPath.lastIndexOf("\\") + 1) + '" /NJH /NJS /NP /NDL /R:1 /W:1');
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
 * File.copy() cua ExtendScript rat cham voi file video va treo UI Premiere Pro -> chi dung cho file < 256 KB.
 */
function robustCopy(srcFile, destFile) {
    var lastErr = "";
    var srcLen = fileSizeOf(srcFile);

    // An toan: khong bao gio copy de len chinh no
    try {
        if (normalizePath(srcFile.fsName) === normalizePath(destFile.fsName)) return { ok: true, how: "same-file" };
    } catch (eSame) {}

    beginCopyReport(srcFile, destFile);

    // Chi dung File.copy() cua ExtendScript cho file cuc nho (< 256 KB).
    // Voi file video, dung robocopy cua Windows de dat toc do toi da.
    var tooBigForExtendScript = (srcLen < 0 || srcLen > 262144);

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
        lastErr = "File " + Math.round(srcLen / 1048576) + " MB - dùng OS copy";
    }

    // 2) Lenh copy cua he dieu hanh (robocopy / copy)
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

        var smartTrimRelink = (config.smartTrimCopy !== false);
        var relinkThresholdGB = parseFloat(config.trimThresholdGB);
        if (isNaN(relinkThresholdGB) || relinkThresholdGB <= 0) relinkThresholdGB = 1;
        var relinkThresholdBytes = Math.round(relinkThresholdGB * 1073741824);
        var relinkPadSec = parseFloat(config.trimPadSec);
        if (isNaN(relinkPadSec) || relinkPadSec < 0) relinkPadSec = 10;

        var seen = {}, sizeCache = {}, skipCount = 0, clipCount = 0;
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
                    if (parentDirNorm(mp) === footageNorm) {
                        if (!seen[srcNorm]) { seen[srcNorm] = true; skipCount++; }
                        continue;
                    }

                    var name = fileNameOf(mp);
                    var sizeBytes = sizeCache[srcNorm];
                    if (sizeBytes === undefined) {
                        sizeBytes = 0;
                        try {
                            var sf = new File(mp);
                            if (sf.exists) { sizeBytes = fileSizeOf(sf); if (sizeBytes < 0) sizeBytes = 0; }
                        } catch (eSz) {}
                        sizeCache[srcNorm] = sizeBytes;
                    }
                    var sizeMB = Math.round((sizeBytes / 1048576) * 10) / 10;

                    if (smartTrimRelink && sizeBytes > relinkThresholdBytes && !isImageExtension(name)) {
                        var inTicks = 0, outTicks = 0, startTicks = 0, durTicks = 0;
                        try { inTicks = parseFloat(clip.inPoint.ticks) || 0; } catch (eIn) {}
                        try { outTicks = parseFloat(clip.outPoint.ticks) || 0; } catch (eOut) {}
                        try { startTicks = parseFloat(clip.start.ticks) || 0; } catch (eSt) {}
                        try { durTicks = parseFloat(clip.duration.ticks) || 0; } catch (eDr) {}
                        var reqInSec = inTicks / TICKS_PER_SECOND;
                        var clipDurSec = durTicks / TICKS_PER_SECOND;
                        var reqOutSec = outTicks / TICKS_PER_SECOND;
                        if (reqOutSec <= reqInSec && clipDurSec > 0) reqOutSec = reqInSec + clipDurSec;
                        var trimKeyRelink = buildTrimKey(mp, { mode: "full", inSec: reqInSec, outSec: reqOutSec }, {}, relinkPadSec, "");
                        var destFullTrim = joinPath(footageFolder.fsName, name);
                        var jobEntry = {
                            isTrim: true,
                            trimKey: trimKeyRelink,
                            mediaPath: mp,
                            normSrc: srcNorm,
                            destPath: destFullTrim,
                            name: name,
                            sizeMB: sizeMB,
                            sizeBytes: sizeBytes,
                            reqInSec: reqInSec,
                            reqOutSec: reqOutSec,
                            padSec: relinkPadSec,
                            trackIndex: t,
                            insertPosSec: startTicks / TICKS_PER_SECOND,
                            clipDurSec: clipDurSec,
                            clipName: clip.name || ""
                        };
                        _relink.files.push(jobEntry);
                        list.push(jobEntry);
                        continue;
                    }

                    if (seen[srcNorm]) continue;
                    seen[srcNorm] = true;

                    var destFull = joinPath(footageFolder.fsName, name);
                    _relink.files.push({ isTrim: false, mediaPath: mp, normSrc: srcNorm, destPath: destFull, name: name });
                    list.push({ isTrim: false, name: name, sizeMB: sizeMB, sizeBytes: sizeBytes, mediaPath: mp, destPath: destFull });
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
function cep_copyRelinkOne(idxStr, preCopiedFlag, trimResJsonStr) {
    var job = null;
    try {
        var i = parseInt(idxStr, 10);
        job = _relink.files[i];
        if (!job) return toJson({ success: false, name: "", error: "Kh\u00f4ng t\u00ecm th\u1ea5y job #" + idxStr + " (h\u00e3y qu\u00e9t l\u1ea1i)" });

        if (job.isTrim && trimResJsonStr) {
            var trimRes = parseJson(trimResJsonStr);
            if (trimRes && trimRes.ok && trimRes.filePath) {
                var seq = app.project ? app.project.activeSequence : null;
                if (!seq) return toJson({ success: false, name: job.name, error: "Kh\u00f4ng t\u00ecm th\u1ea5y Sequence \u0111ang m\u1edf" });
                var trk = seq.videoTracks[job.trackIndex || 0];
                var trimPi = _session.itemCache ? _session.itemCache[trimRes.filePath] : undefined;
                if (!trimPi) {
                    trimPi = importAndGetProjectItem(trimRes.filePath);
                    if (_session.itemCache) _session.itemCache[trimRes.filePath] = trimPi;
                }
                if (!trimPi) return toJson({ success: false, name: job.name, error: "Import file c\u1eaft g\u1ecdn th\u1ea5t b\u1ea1i: " + trimRes.filePath });
                waitForMediaReady(trimPi, 6000);
                var locIn = (typeof trimRes.localInSec === "number") ? trimRes.localInSec : 0;
                var locOut = (typeof trimRes.localOutSec === "number") ? trimRes.localOutSec : (locIn + (job.clipDurSec || 5));
                if (job.clipDurSec && job.clipDurSec > 0) locOut = locIn + job.clipDurSec;
                var inTicksStr = Math.round(locIn * TICKS_PER_SECOND).toString();
                var outTicksStr = Math.round(locOut * TICKS_PER_SECOND).toString();
                try { trimPi.setOutPoint(outTicksStr, MEDIA_TYPE); } catch (eO1) {}
                trimPi.setInPoint(inTicksStr, MEDIA_TYPE);
                trimPi.setOutPoint(outTicksStr, MEDIA_TYPE);
                var insRes = insertAndRenameClip(trk, trimPi, job.insertPosSec || 0, job.clipName || null, locOut - locIn, false);
                if (insRes.error) return toJson({ success: false, name: job.name, error: insRes.error });
                return toJson({
                    success: true,
                    name: fileNameOf(trimRes.filePath),
                    copied: !trimRes.cached,
                    relinked: 1,
                    itemCount: 1,
                    destPath: trimRes.filePath,
                    note: "",
                    error: ""
                });
            }
        }

        var srcFile = new File(job.mediaPath);
        if (!srcFile.exists) return toJson({ success: false, name: job.name, error: "Kh\u00f4ng t\u00ecm th\u1ea5y file ngu\u1ed3n: " + job.mediaPath });

        var destFile = new File(job.destPath);
        var srcLen = fileSizeOf(srcFile);
        var copied = !!preCopiedFlag, note = "";

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
    _session.folderPickCache = {}; _session.trimmedFiles = {}; _session.csvRows = null;
    return toJson({ success: true });
}

return {
    IMPORTCUT_VERSION: IMPORTCUT_VERSION,
    _session: _session,
    parseCSV: parseCSV,
    toJson: toJson,
    downloadFileFromUrl: downloadFileFromUrl,
    resolveSourceFileOnly: resolveSourceFileOnly,
    findCachedEnvatoFile: findCachedEnvatoFile,
    cep_checkEnvironment: cep_checkEnvironment,
    cep_parseCSVContent: cep_parseCSVContent,
    cep_parseCSVContentManual: cep_parseCSVContentManual,
    cep_parseCSVContentWithCols: cep_parseCSVContentWithCols,
    cep_clearSourceReplacements: cep_clearSourceReplacements,
    cep_applyNormalizedScript: cep_applyNormalizedScript,
    cep_validateSources: cep_validateSources,
    cep_setSourceReplacement: cep_setSourceReplacement,
    cep_initSession: cep_initSession,
    cep_processSingleRow: cep_processSingleRow,
    cep_finishSession: cep_finishSession,
    cep_exportProjectXml: cep_exportProjectXml,
    cep_revealInExplorer: cep_revealInExplorer,
    cep_scanTimelineSources: cep_scanTimelineSources,
    cep_copyRelinkOne: cep_copyRelinkOne,
    cep_copyAndRelinkFootage: cep_copyAndRelinkFootage
};
})();
