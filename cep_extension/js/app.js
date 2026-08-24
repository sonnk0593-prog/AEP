/**
 * app.js - Client-side Controller for Import & Cut by Timecode CEP Extension
 */

var csInterface = new CSInterface();

// ============================================================================
// PHIÊN BẢN - phải KHỚP với IMPORTCUT_VERSION trong jsx/hostscript.jsx
// Đây là 1 trong 2 chỗ duy nhất ghi số phiên bản (chỗ còn lại là hostscript.jsx).
// Badge trên header và tiêu đề Changelog đều lấy từ đây, không ghi tay trong HTML.
// Định dạng: MAJOR.MINOR.PATCH - MAJOR = đổi dòng sản phẩm (V2 -> V3).
// ============================================================================
var APP_VERSION = "2.1.0";

// Nhãn ngắn hiển thị trên badge: "2.0.0" -> "V2"
function versionMajorLabel(v) { return "V" + String(v).split(".")[0]; }

/**
 * Premiere chỉ có MỘT bộ máy ExtendScript dùng chung: nếu mở đồng thời panel bản khác,
 * script của panel nạp sau sẽ ghi đè và panel này sẽ chạy nhầm code. Chặn trước khi làm việc nặng.
 * Cũng bắt được trường hợp file .jsx đã cập nhật nhưng chưa được nạp lại.
 */
function ensureOwnScript(cb) {
    csInterface.evalScript("(function(){ try { return (typeof IMPORTCUT_VERSION !== 'undefined') ? IMPORTCUT_VERSION : ''; } catch(e) { return ''; } })()", function (b) {
        var loaded = String(b === undefined || b === null ? "" : b).replace(/^"|"$/g, "");
        if (loaded === "" || loaded === APP_VERSION) { cb(true); return; }

        var sameMajor = loaded.split(".")[0] === APP_VERSION.split(".")[0];
        if (sameMajor) {
            // Cùng dòng V2 nhưng lệch số -> gần như chắc chắn do file .jsx vừa đổi mà chưa nạp lại.
            showAlert("Script chưa được nạp lại",
                "Panel là bản <strong>" + escapeHtml(APP_VERSION) + "</strong> nhưng script đang chạy trong Premiere là bản <strong>" +
                escapeHtml(loaded) + "</strong>.\n\n" +
                "<strong>Cách xử lý:</strong> khởi động lại Premiere Pro để nạp lại script.", "warning");
        } else {
            showAlert("Đang bị panel khác chiếm",
                "Premiere dùng chung một bộ máy ExtendScript cho mọi panel, và bản <strong>" +
                escapeHtml(versionMajorLabel(loaded)) + "</strong> đang được nạp đè lên bản này.\n\n" +
                "<strong>Cách xử lý:</strong> đóng panel bản kia (Window › Extensions › bỏ chọn), rồi đóng/mở lại panel này.", "warning");
        }
        cb(false);
    });
}

// Helper to escape Unicode characters to \uXXXX for 100% reliable UTF-8 transfer
function toEscapedJson(obj) {
    var json = (typeof obj === "string") ? JSON.stringify(obj) : JSON.stringify(obj);
    if (!json) return '""';
    var res = "";
    for (var i = 0; i < json.length; i++) {
        var code = json.charCodeAt(i);
        if (code > 127) {
            var hex = code.toString(16);
            while (hex.length < 4) hex = "0" + hex;
            res += "\\u" + hex;
        } else {
            res += json.charAt(i);
        }
    }
    return res;
}

// State
var state = {
    csvContent: "",
    csvFileName: "",
    parsedData: null,
    scriptValidated: false,
    isRunning: false,
    shouldCancel: false,
    currentRowIdx: 0,
    lastXmlPath: "",   // đường dẫn XML vừa xuất; rỗng = chưa xuất lần nào phiên này
    aiClipNames: {},   // rowNumber -> AI-generated name
    stats: {
        total: 0,
        success: 0,
        warning: 0,
        error: 0,
        skipped: 0,
        copied: 0,
        downloaded: 0,
        clips: 0
    },
    logs: [],
    logExpanded: false,
    currentFilter: "all",
    relink: null,      // tiến trình Copy & Relink Footage
    colMode: "auto",   // "auto" = tool tự nhận diện cột | "manual" = người dùng tự chọn cột
    copyPlan: null,    // { totalBytes, doneBytes } — biết trước tổng dung lượng (luồng Copy & Relink)
    copiedBytes: 0     // tổng byte đã copy xong trong phiên (luồng Import, không biết trước tổng)
    ,checkProgressTimer: null
    ,checkProgressStarted: 0
    ,checkCancelled: false
    ,checkInProgress: false
};

// =========================================================================
// GEMINI AI MODULE
// =========================================================================
var GeminiAPI = (function () {
    var GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";
    var LS_KEY_APIKEY   = "autoimportcut_v2_gemini_key";

    function getKey() {
        try { return localStorage.getItem(LS_KEY_APIKEY) || ""; } catch (e) { return ""; }
    }
    function saveKey(k) {
        try { localStorage.setItem(LS_KEY_APIKEY, k); } catch (e) {}
    }
    function hasKey() { return getKey().length > 10; }

    /**
     * Call Gemini API with a plain text prompt.
     * Returns Promise<string> with the text response, or rejects on error.
     */
    function call(prompt) {
        var key = getKey();
        if (!key) return Promise.reject(new Error("Chưa có Gemini API Key"));
        var url = GEMINI_API_URL + "?key=" + key;
        var body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
        });
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
        }).then(function (res) {
            if (!res.ok) return res.text().then(function (t) { throw new Error("Gemini HTTP " + res.status + ": " + t.substring(0, 200)); });
            return res.json();
        }).then(function (data) {
            try { return data.candidates[0].content.parts[0].text; } catch (e) { throw new Error("Gemini: Không đọc được response"); }
        });
    }

    /**
     * Feature 1 — Detect columns from CSV header+data rows using AI.
     * Returns Promise<cols object | null>
     */
    function detectColumns(csvPreview) {
        var prompt =
            "Đây là dữ liệu CSV của bảng kịch bản video Premiere Pro (dấu phẩy phân cách, mỗi dòng là 1 hàng):\n\n" +
            csvPreview + "\n\n" +
            "NHIỆM VỤ: Xác định INDEX (bắt đầu từ 0) của từng cột dưới đây.\n\n" +

            "=== NGUYÊN TẮC QUAN TRỌNG NHẤT: XÉT THEO HÀNG NGANG ===\n" +
            "Một hàng ngang mô tả một cảnh. Trong hàng đó có thể có NHIỀU FILE video:\n" +
            "  • File xuất hiện TRƯỚC (cột bên TRÁI nhất) = SOURCE CHÍNH → nằm ở V1.\n" +
            "  • File xuất hiện SAU đó (cột bên PHẢI) = SOURCE TRÁM → đè lên source chính ở V2.\n" +
            "  • Nếu hàng chỉ có 1 file thì KHÔNG có trám: đặt tram*Col = -1.\n" +
            "Mỗi 'nhóm' gồm bộ 3: [đường dẫn thư mục] + [mã/tên file] + [timecode], nằm cạnh nhau.\n" +
            "Cột đường dẫn của một nhóm thường đứng ngay TRƯỚC cột mã file của nhóm đó.\n" +
            "Cột timecode của một nhóm phải nằm TRONG phạm vi cột của nhóm đó, không lấy cột ở xa.\n\n" +

            "=== TIN VÀO DỮ LIỆU, KHÔNG TIN VÀO TÊN HEADER ===\n" +
            "Tên header có thể bị đặt lệch cột. Luôn kiểm tra nội dung các ô bên dưới:\n" +
            "  • Cột tên 'SOURCE' nhưng bên dưới toàn C0694, DJI_2026... → đó là codeCol, KHÔNG phải sourceCol.\n" +
            "  • Cột tên 'TIMECODE' nhưng bên dưới là đường dẫn \\\\... → đó là sourceCol của nhóm trám.\n" +
            "  • Cột tên 'FOLDER', 'NAS', 'Đường dẫn' chứa \\\\... → đó là sourceCol.\n\n" +

            "=== BẪY THƯỜNG GẶP: CỘT THỜI LƯỢNG LỜI THOẠI ===\n" +
            "Các cột như 'TIMEVOICE OFF', 'TIME VOICE', 'Thời lượng voice' cũng chứa dạng 0:25 - 0:36\n" +
            "nhưng đó là thời lượng ĐỌC LỜI BÌNH, KHÔNG PHẢI timecode cắt video. TUYỆT ĐỐI không chọn.\n" +
            "timeCol phải là cột timecode nằm cùng nhóm với cột mã file (vd 'TIME SOURCE CHÍNH').\n\n" +

            "=== MÔ TẢ TỪNG TRƯỜNG ===\n" +
            "sourceCol — thư mục chứa video của source chính: \\\\server\\..., D:\\..., hoặc link http/https.\n" +
            "          ĐẶT -1 nếu cột file đã chứa sẵn ĐƯỜNG DẪN ĐẦY ĐỦ tới file (kể cả khi ô có dấu nháy bao quanh).\n" +
            "codeCol — mã hoặc tên file: C0682, DJI_20260818150455_0052_D, GH010234, GOPR0001,\n" +
            "          hoặc tên file đầy đủ 'C0704.MP4', hoặc cả đường dẫn đầy đủ tới file.\n" +
            "          Một ô có thể chứa nhiều mã trên nhiều dòng.\n" +
            "timeCol — timecode cắt: '0:07 - 0:19', '00:01:23 - 00:02:45', hoặc chỉ 1 mốc '00:06'.\n" +
            "          Đặt -1 NẾU BẢNG KHÔNG CÓ cột timecode nào (hoàn toàn hợp lệ).\n" +
            "bodyCol — cột nội dung/lời thoại mô tả cảnh; đặt -1 nếu không có.\n" +
            "tramSourceCol, tramCodeCol, tramTimeCol — bộ 3 tương ứng của nhóm file thứ hai trong hàng;\n" +
            "          đặt -1 cả 3 nếu bảng chỉ có một nhóm file.\n" +
            "headerRowIndex — index dòng tiêu đề cột; -1 nếu bảng không có dòng tiêu đề.\n" +
            "          Lưu ý: nhiều bảng có vài dòng rác ở đầu (tỉ lệ khung hình, ghi chú) trước dòng tiêu đề thật.\n\n" +

            "=== VÍ DỤ ===\n" +
            "Header: 'STT,Đường dẫn,Mã file,Timecode,Nội dung'\n" +
            "→ {\"sourceCol\":1,\"codeCol\":2,\"timeCol\":3,\"bodyCol\":4,\"tramSourceCol\":-1,\"tramCodeCol\":-1,\"tramTimeCol\":-1,\"headerRowIndex\":0}\n\n" +
            "Header: 'SOURCE CHÍNH,TÊN FILE,TIME SOURCE CHÍNH,SOURCE TRÁM,TÊN FILE,TIME SOURCE TRÁM,MÔ TẢ'\n" +
            "→ {\"sourceCol\":0,\"codeCol\":1,\"timeCol\":2,\"tramSourceCol\":3,\"tramCodeCol\":4,\"tramTimeCol\":5,\"bodyCol\":6,\"headerRowIndex\":0}\n\n" +
            "Header: ',VOICE,FOLDER,SOURCE,TIMECODE,SOURCE TRÁM,TEXT'  (header đặt lệch, không có timecode thật)\n" +
            "Dữ liệu: ',Thoại...,\\\\NAS\\quay\\19-08,C0697,\\\\NAS\\quay\\9-7,DJI_2026_0007_D,...'\n" +
            "→ {\"sourceCol\":2,\"codeCol\":3,\"timeCol\":-1,\"tramSourceCol\":4,\"tramCodeCol\":5,\"tramTimeCol\":-1,\"bodyCol\":1,\"headerRowIndex\":0}\n\n" +

            "=== OUTPUT ===\n" +
            "Trả về JSON thuần túy, KHÔNG markdown, KHÔNG ``` block:\n" +
            "{\"sourceCol\":0,\"codeCol\":1,\"timeCol\":2,\"bodyCol\":-1,\"tramSourceCol\":-1,\"tramCodeCol\":-1,\"tramTimeCol\":-1,\"headerRowIndex\":0}";

        return call(prompt).then(function (text) {
            // Strip possible markdown code fences
            var clean = text.replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
            var jsonMatch = clean.match(/\{[\s\S]+\}/);
            if (!jsonMatch) throw new Error("Gemini không trả về JSON hợp lệ");
            var cols = JSON.parse(jsonMatch[0]);
            // timeCol có thể là -1 (bảng không có cột timecode) nên chỉ bắt buộc source + code
            if (typeof cols.sourceCol !== "number" || typeof cols.codeCol !== "number") {
                throw new Error("JSON thiếu trường bắt buộc (sourceCol/codeCol)");
            }
            var fields = ["timeCol", "bodyCol", "tramSourceCol", "tramCodeCol", "tramTimeCol", "headerRowIndex"];
            for (var i = 0; i < fields.length; i++) {
                if (typeof cols[fields[i]] !== "number") cols[fields[i]] = -1;
            }
            // Trám phải là một NHÓM đầy đủ: không có mã file trám thì không có trám
            if (cols.tramCodeCol === -1) { cols.tramSourceCol = -1; cols.tramTimeCol = -1; }
            cols.detectedByAI = true;
            return cols;
        });
    }

    function normalizeScript(csvContent, cols) {
        var prompt =
            "Bạn là bộ chuẩn hóa kịch bản dựng video Premiere Pro. Dữ liệu CSV bên dưới có thể có nhiều dòng trong một ô. " +
            "Các cột được xác định bằng index 0-based: source=" + cols.sourceCol + ", code=" + cols.codeCol + ", time=" + cols.timeCol +
            ", tramSource=" + cols.tramSourceCol + ", tramCode=" + cols.tramCodeCol + ", tramTime=" + cols.tramTimeCol + ".\n\n" +
            "Nhiệm vụ: trả về JSON thuần túy là mảng các thay đổi, mỗi phần tử có rowIndex (index dòng CSV), " +
            "và chỉ các trường cần sửa: source, code, time, tramSource, tramCode, tramTime.\n" +
            "Quy tắc timecode:\n" +
            "- 'đầu', 'từ đầu', 'bắt đầu' là mốc 00:00.\n" +
            "- 'hết', 'cuối', 'đến hết', 'đến cuối' là mốc END, không tự đoán số giây. " +
            "Ví dụ 'đầu - 00:30' thành '00:00 - 00:30'; '00:30 - hết' thành '00:30 - END'; 'đầu - cuối' thành '00:00 - END'.\n" +
            "- Giữ nguyên timecode số đã đúng, chỉ chuẩn hóa về MM:SS hoặc HH:MM:SS và dấu ' - '.\n" +
            "- Chuẩn hóa đường dẫn: bỏ dấu nháy thừa, dùng dấu gạch chéo ngược cho đường dẫn Windows, không đổi nội dung đường dẫn.\n" +
            "- Chuẩn hóa mã file: bỏ khoảng trắng/dấu nháy thừa, giữ nguyên mã đầy đủ; không tự thêm ký tự hoặc đoán tên file.\n" +
            "- Không sửa nội dung lời thoại, header hoặc các cột khác. Nếu không cần sửa, không đưa dòng đó vào kết quả.\n\n" +
            "CSV:\n" + csvContent + "\n\nTrả về ví dụ: [{\"rowIndex\":1,\"time\":\"00:00 - 00:30\"}]";
        return call(prompt).then(function (text) {
            var clean = text.replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
            var match = clean.match(/\[[\s\S]*\]/);
            if (!match) throw new Error("Gemini không trả về danh sách chuẩn hóa hợp lệ");
            var edits = JSON.parse(match[0]);
            if (!(edits instanceof Array)) throw new Error("Gemini trả về sai định dạng");
            return edits;
        });
    }

    /**
     * Feature 2 — Batch generate clip names from body content rows.
     * rows: array of { rowNumber, body }
     * Returns Promise<{rowNumber -> name}>
     */
    function batchClipNames(rows) {
        if (!rows || rows.length === 0) return Promise.resolve({});
        var lines = rows.map(function (r) {
            return r.rowNumber + ": " + (r.body || "").substring(0, 120);
        });
        var prompt =
            "Dưới đây là danh sách nội dung kịch bản các clip video (mỗi dòng: SỐ_HÀNG: NỘI_DUNG):\n\n" +
            lines.join("\n") + "\n\n" +
            "Nhiệm vụ: Với mỗi clip, tạo một tên clip ngắn gọn (tối đa 25 ký tự), " +
            "không dấu tiếng Việt, không khoảng trắng (dùng underscore), mô tả nội dung chính.\n" +
            "Trả về JSON thuần túy (KHÔNG markdown), ánh xạ số_hàng -> tên_clip. Ví dụ:\n" +
            "{\"1\":\"canh_hop_bao\",\"2\":\"phong_van_giam_doc\",\"3\":\"cau_canh_toan\"}";

        return call(prompt).then(function (text) {
            var clean = text.replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
            var jsonMatch = clean.match(/\{[\s\S]+\}/);
            if (!jsonMatch) return {};
            return JSON.parse(jsonMatch[0]);
        }).catch(function () { return {}; });
    }

    /**
     * Feature 3 — Analyze error/warning logs and return Vietnamese advice.
     * logs: array of {type, text, time}
     * Returns Promise<string>
     */
    function analyzeErrors(logs) {
        var lines = logs.map(function (l) {
            return "[" + l.type.toUpperCase() + "] " + l.text;
        }).join("\n");
        var prompt =
            "Tôi đang dùng plugin Adobe Premiere Pro tên 'Import & Cut by Timecode' " +
            "để tự động import và cắt video từ Google Sheets vào timeline.\n\n" +
            "Dưới đây là log lỗi/cảnh báo khi chạy plugin:\n\n" +
            lines + "\n\n" +
            "Hãy phân tích:\n" +
            "1. Nguyên nhân có thể gây ra từng lỗi\n" +
            "2. Cách khắc phục cụ thể, rõ ràng (từng bước nếu cần)\n" +
            "3. Gợi ý kiểm tra để tránh lỗi lần sau\n\n" +
            "Trả lời bằng tiếng Việt, ngắn gọn, thực tế. Dùng emoji để dễ đọc.";

        return call(prompt);
    }

    return { getKey: getKey, saveKey: saveKey, hasKey: hasKey, detectColumns: detectColumns, normalizeScript: normalizeScript, batchClipNames: batchClipNames, analyzeErrors: analyzeErrors };
})();


// DOM Elements
var dom = {
    envStatusDot: document.getElementById("envStatusDot"),
    envStatusText: document.getElementById("envStatusText"),
    seqInfoText: document.getElementById("seqInfoText"),
    
    // Google Sheets URL
    txtGSheetUrl: document.getElementById("txtGSheetUrl"),
    
    // Config
    chkCopy: document.getElementById("chkCopy"),
    chkTram: document.getElementById("chkTram"),
    chkLabel: document.getElementById("chkLabel"),
    txtDefaultSec: document.getElementById("txtDefaultSec"),
    chkSingleTime: document.getElementById("chkSingleTime"),
    txtSingleTimeSec: document.getElementById("txtSingleTimeSec"),
    radioCenterTime: document.getElementById("radioCenterTime"),
    radioFullVideo: document.getElementById("radioFullVideo"),
    txtCenterTimeSec: document.getElementById("txtCenterTimeSec"),

    // Nhận diện cột: tự động / thủ công
    btnColAuto: document.getElementById("btnColAuto"),
    btnColManual: document.getElementById("btnColManual"),
    manualCols: document.getElementById("manualCols"),
    selMainFolder: document.getElementById("selMainFolder"),
    selMainCode: document.getElementById("selMainCode"),
    selMainTime: document.getElementById("selMainTime"),
    selTramFolder: document.getElementById("selTramFolder"),
    selTramCode: document.getElementById("selTramCode"),
    selTramTime: document.getElementById("selTramTime"),
    
    // Controls
    btnLoadCheck: document.getElementById("btnLoadCheck"),
    btnStart: document.getElementById("btnStart"),
    btnCancel: document.getElementById("btnCancel"),
    btnCopyRelink: document.getElementById("btnCopyRelink"),
    relinkLabel: document.getElementById("relinkLabel"),
    
    // Progress
    progressCard: document.getElementById("progressCard"),
    copyProgressRow: document.getElementById("copyProgressRow"),
    copyFileName: document.getElementById("copyFileName"),
    copySpeed: document.getElementById("copySpeed"),
    copyBarFill: document.getElementById("copyBarFill"),
    copyBytes: document.getElementById("copyBytes"),
    copyTotal: document.getElementById("copyTotal"),

    // Hộp thoại dùng chung
    dlgOverlay: document.getElementById("dlgOverlay"),
    dlgIcon: document.getElementById("dlgIcon"),
    dlgTitle: document.getElementById("dlgTitle"),
    dlgBody: document.getElementById("dlgBody"),
    dlgOk: document.getElementById("dlgOk"),
    dlgCancel: document.getElementById("dlgCancel"),
    dlgClose: document.getElementById("dlgClose"),

    // Thông báo hoàn tất
    toast: document.getElementById("toast"),
    toastIcon: document.getElementById("toastIcon"),
    toastTitle: document.getElementById("toastTitle"),
    toastMsg: document.getElementById("toastMsg"),
    toastClose: document.getElementById("toastClose"),
    doneSound: document.getElementById("doneSound"),

    progressBarFill: document.getElementById("progressBarFill"),
    progressPercent: document.getElementById("progressPercent"),
    progressStepText: document.getElementById("progressStepText"),
    currentActionText: document.getElementById("currentActionText"),
    
    // Stats
    statClips: document.getElementById("statClips"),
    statCopied: document.getElementById("statCopied"),
    statWarning: document.getElementById("statWarning"),
    statError: document.getElementById("statError"),
    
    // Logs
    logList: document.getElementById("logList"),
    filterBtns: document.querySelectorAll(".filter-btn"),

    // AI elements (popup cài đặt Gemini API)
    txtGeminiKey: document.getElementById("txtGeminiKey"),
    btnAiSave: document.getElementById("btnAiSave"),
    aiStatusBadge: document.getElementById("aiStatusBadge"),
    btnOpenApi: document.getElementById("btnOpenApi"),
    apiBtnDot: document.getElementById("apiBtnDot"),
    apiModalOverlay: document.getElementById("apiModalOverlay"),
    btnApiModalClose: document.getElementById("btnApiModalClose"),
    btnVersion: document.getElementById("btnVersion"),
    changelogOverlay: document.getElementById("changelogOverlay"),
    changelogVersion: document.getElementById("changelogVersion"),
    btnChangelogClose: document.getElementById("btnChangelogClose"),
    btnCheckUpdate: document.getElementById("btnCheckUpdate"),
    updateStatus: document.getElementById("updateStatus"),
    btnExportXml: document.getElementById("btnExportXml"),
    btnOpenXmlDir: document.getElementById("btnOpenXmlDir"),
    mediaCheckPanel: document.getElementById("mediaCheckPanel")
    ,mediaCheckSummary: document.getElementById("mediaCheckSummary")
    ,mediaCheckList: document.getElementById("mediaCheckList")
    ,mediaCheckClose: document.getElementById("mediaCheckClose")
    ,mediaCheckStart: document.getElementById("mediaCheckStart")
    ,logToggle: document.getElementById("logToggle")
};

// =========================================================================
// COPY MONITOR — % và tốc độ của file đang được copy
// hostscript.jsx ghi {state,name,dest,total} vào 1 file JSON tạm khi bắt đầu copy;
// panel dùng Node.js đo dung lượng file đích để tính tiến độ.
// =========================================================================
var CopyMonitor = (function () {
    // Đọc file theo 2 đường: Node.js (nếu panel bật được) hoặc API file sẵn có của CEP.
    var nodeFs = null;
    try { nodeFs = require("fs"); } catch (e) { nodeFs = null; }
    function cepFs() {
        try { return (window.cep && window.cep.fs) ? window.cep.fs : null; } catch (e) { return null; }
    }

    function readText(path) {
        if (nodeFs) { try { return nodeFs.readFileSync(path, "utf8"); } catch (e) {} }
        var c = cepFs();
        if (c && c.readFile) { try { var r = c.readFile(path); if (r && r.err === 0) return r.data; } catch (e2) {} }
        return null;
    }
    function sizeOf(path) {
        if (nodeFs) { try { return nodeFs.statSync(path).size; } catch (e) {} }
        var c = cepFs();
        if (c && c.stat) { try { var r = c.stat(path); if (r && r.err === 0 && r.data) return r.data.size; } catch (e2) {} }
        return -1;
    }
    function removeFile(path) {
        if (nodeFs) { try { nodeFs.unlinkSync(path); return; } catch (e) {} }
        var c = cepFs();
        if (c && c.deleteFile) { try { c.deleteFile(path); } catch (e2) {} }
    }
    function hasFsAccess() { return !!nodeFs || !!cepFs(); }

    var progressPath = "";
    var timer = null;
    var last = { name: "", bytes: 0, time: 0, speed: 0, fileTotal: 0 };

    function setProgressPath(p) {
        progressPath = p ? String(p).replace(/[\\\/]+$/, "") + "/autoimportcut_v2_copy_progress.json" : "";
    }

    function reset() {
        last = { name: "", bytes: 0, time: 0, speed: 0, fileTotal: 0 };
        if (!progressPath) return;
        removeFile(progressPath);
    }

    function readState() {
        var raw = readText(progressPath);
        if (!raw) return null;
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.substring(1);   // bỏ BOM nếu có
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function tick() {
        var st = readState();
        if (!st || st.state !== "copying" || !st.dest) {
            // File vừa copy xong -> cộng dồn vào tổng đã copy của phiên
            if (last.name !== "") {
                state.copiedBytes += (last.fileTotal > 0 ? last.fileTotal : last.bytes);
                last.name = "";
            }
            hideCopyProgress();
            return;
        }

        // Script PowerShell báo số byte chính xác theo thời gian thực; nếu không có thì tự đo file đích.
        var bytes;
        if (st.byScript && typeof st.copied === "number") {
            bytes = st.copied;
        } else {
            bytes = sizeOf(st.dest);
            if (bytes < 0) bytes = 0;
        }
        var now = new Date().getTime();

        if (st.name !== last.name) {
            last.name = st.name;
            last.bytes = bytes;
            last.time = now;
            last.speed = 0;
            last.fileTotal = st.total || 0;
        } else if (now - last.time >= 250) {
            var inst = (bytes - last.bytes) / ((now - last.time) / 1000);
            if (inst < 0) inst = 0;
            last.speed = last.speed ? (last.speed * 0.5 + inst * 0.5) : inst;
            last.bytes = bytes;
            last.time = now;
        }

        showCopyProgress(st.name, bytes, st.total, last.speed);
    }

    function start() {
        if (timer) return;
        if (!hasFsAccess() || !progressPath) return;
        reset();
        timer = setInterval(tick, 250);
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        reset();
        hideCopyProgress();
    }

    /** Vì sao không hiện được % copy: "ok" | "no-fs" | "no-path" */
    function diagnose() {
        if (!hasFsAccess()) return "no-fs";
        if (!progressPath) return "no-path";
        return "ok";
    }

    function engineName() { return nodeFs ? "Node.js" : (cepFs() ? "CEP fs" : "không có"); }
    function getProgressPath() { return progressPath; }

    return { setProgressPath: setProgressPath, start: start, stop: stop,
             diagnose: diagnose, engineName: engineName, getProgressPath: getProgressPath };
})();

/**
 * Lấy đường dẫn thư mục temp của Premiere — nơi hostscript.jsx ghi file báo tiến độ copy.
 * Gọi lại được nhiều lần (lúc mở panel ExtendScript có thể chưa sẵn sàng).
 */
function resolveCopyProgressPath(cb) {
    csInterface.evalScript("(function(){ try { return Folder.temp.fsName; } catch(e) { return ''; } })()", function (tempPath) {
        var p = String(tempPath || "");
        if (p && p !== "undefined" && p !== "null" && p.indexOf("EvalScript error") === -1) {
            CopyMonitor.setProgressPath(p);
        }
        if (cb) cb(CopyMonitor.diagnose());
    });
}

/** Bật theo dõi copy; nếu không theo dõi được thì nói rõ lý do trong log thay vì im lặng. */
function startCopyMonitor() {
    resolveCopyProgressPath(function (status) {
        if (status === "ok") {
            CopyMonitor.start();
            addLog("info", "Theo dõi tiến độ copy qua " + CopyMonitor.engineName() + ": " + CopyMonitor.getProgressPath());
        } else if (status === "no-fs") {
            addLog("warning", "Không đọc được file từ panel (Node.js và CEP fs đều không khả dụng) → không hiện được % và tốc độ copy. Quá trình copy vẫn chạy bình thường.");
        } else {
            addLog("warning", "Không lấy được thư mục tạm của Premiere → không hiện được % và tốc độ copy. Quá trình copy vẫn chạy bình thường.");
        }
    });
}

function formatBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
    return n + " B";
}

function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "";
    seconds = Math.round(seconds);
    if (seconds < 60) return "còn ~" + seconds + " giây";
    var m = Math.floor(seconds / 60), s = seconds % 60;
    if (m < 60) return "còn ~" + m + " phút" + (s >= 30 ? " 30 giây" : "");
    return "còn ~" + Math.floor(m / 60) + "h" + (m % 60) + "p";
}

function showCopyProgress(name, bytes, total, speedBytesPerSec) {
    if (!dom.copyProgressRow) return;
    dom.copyProgressRow.classList.add("visible");
    if (dom.copyFileName) dom.copyFileName.textContent = "📄 " + name;
    if (dom.copySpeed) dom.copySpeed.textContent = (speedBytesPerSec > 0 ? (speedBytesPerSec / 1048576).toFixed(1) : "0.0") + " MB/s";

    // --- File đang copy ---
    var percent = (total > 0) ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
    if (dom.copyBarFill) dom.copyBarFill.style.width = percent + "%";
    if (dom.copyBytes) {
        dom.copyBytes.textContent = (total > 0)
            ? (formatBytes(bytes) + " / " + formatBytes(total) + " · " + percent + "%")
            : ("Đã copy " + formatBytes(bytes));
    }

    // --- Tổng tiến độ theo thời gian thực ---
    if (!dom.copyTotal) return;
    var plan = state.copyPlan;
    if (plan && plan.totalBytes > 0) {
        var doneBytes = Math.min(plan.totalBytes, plan.doneBytes + bytes);
        var totalPercent = Math.min(100, Math.round((doneBytes / plan.totalBytes) * 100));
        var eta = (speedBytesPerSec > 1024) ? formatEta((plan.totalBytes - doneBytes) / speedBytesPerSec) : "";
        dom.copyTotal.textContent = "Tổng: " + formatBytes(doneBytes) + " / " + formatBytes(plan.totalBytes) +
                                    " · " + totalPercent + "%" + (eta ? (" · " + eta) : "");
        // Thanh tiến độ chính chạy theo dung lượng thật, không nhảy theo số file
        if (dom.progressBarFill) dom.progressBarFill.style.width = totalPercent + "%";
        if (dom.progressPercent) dom.progressPercent.textContent = totalPercent + "%";
    } else {
        var sessionBytes = state.copiedBytes + bytes;
        dom.copyTotal.textContent = "Tổng đã copy trong phiên: " + formatBytes(sessionBytes);
    }
}

function hideCopyProgress() {
    if (!dom.copyProgressRow) return;
    dom.copyProgressRow.classList.remove("visible");
    if (dom.copyBarFill) dom.copyBarFill.style.width = "0%";
}

// =========================================================================
// HỘP THOẠI DÙNG CHUNG (thay alert/confirm mặc định của trình duyệt)
// =========================================================================

var _dlgCallback = null;
var _dlgMandatory = false;   // true = hộp thoại không cho tắt, buộc bấm nút chính

var DLG_ICONS = { info: "ℹ️", error: "❌", warning: "⚠️", success: "✅", question: "📂" };

/**
 * opts: { title, message, icon, type, okLabel, cancelLabel, onResult }
 * cancelLabel = null → chỉ có 1 nút (kiểu thông báo).
 */
function showDialog(opts) {
    if (!dom.dlgOverlay) {   // phòng khi HTML cũ chưa có hộp thoại
        if (opts.cancelLabel) { if (opts.onResult) opts.onResult(window.confirm(opts.title + "\n\n" + opts.message)); }
        else { window.alert(opts.title + "\n\n" + opts.message); }
        return;
    }

    var type = opts.type || "info";
    if (dom.dlgIcon) dom.dlgIcon.textContent = opts.icon || DLG_ICONS[type] || DLG_ICONS.info;
    if (dom.dlgTitle) {
        dom.dlgTitle.textContent = opts.title || "Thông báo";
        var titleWrap = dom.dlgTitle.parentNode;
        titleWrap.className = "ai-modal-title" + (type !== "info" && type !== "question" ? (" dlg-title-" + type) : "");
    }
    if (dom.dlgBody) dom.dlgBody.innerHTML = opts.message || "";

    if (dom.dlgOk) dom.dlgOk.textContent = opts.okLabel || "Đồng ý";
    if (dom.dlgCancel) {
        if (opts.cancelLabel) {
            dom.dlgCancel.textContent = opts.cancelLabel;
            dom.dlgCancel.style.display = "inline-flex";
        } else {
            dom.dlgCancel.style.display = "none";
        }
    }

    // Hộp thoại bắt buộc: giấu luôn nút X. ESC và click ra ngoài bị chặn
    // trong closeDialog() - mọi đường thoát đều gọi closeDialog(false).
    _dlgMandatory = !!opts.mandatory;
    if (dom.dlgClose) dom.dlgClose.style.display = _dlgMandatory ? "none" : "";

    _dlgCallback = opts.onResult || null;
    dom.dlgOverlay.classList.add("visible");
    if (dom.dlgOk) dom.dlgOk.focus();
}

function closeDialog(result) {
    if (_dlgMandatory && !result) return;   // bắt buộc: không có đường bỏ qua
    _dlgMandatory = false;
    if (dom.dlgOverlay) dom.dlgOverlay.classList.remove("visible");
    var cb = _dlgCallback;
    _dlgCallback = null;
    if (cb) cb(!!result);
}

function isDialogOpen() {
    return !!(dom.dlgOverlay && dom.dlgOverlay.classList.contains("visible"));
}

/** Thông báo 1 nút. type: info | error | warning | success */
function showAlert(title, message, type) {
    showDialog({ title: title, message: message, type: type || "info", okLabel: "Đã hiểu" });
}

/** Hỏi xác nhận 2 nút; cb(true/false) */
function showConfirm(title, message, okLabel, cb) {
    showDialog({
        title: title, message: message, type: "question", icon: "📂",
        okLabel: okLabel || "Tiếp tục", cancelLabel: "Huỷ", onResult: cb
    });
}

function setupDialog() {
    if (dom.dlgOk) dom.dlgOk.addEventListener("click", function () { closeDialog(true); });
    if (dom.dlgCancel) dom.dlgCancel.addEventListener("click", function () { closeDialog(false); });
    if (dom.dlgClose) dom.dlgClose.addEventListener("click", function () { closeDialog(false); });
    if (dom.dlgOverlay) {
        dom.dlgOverlay.addEventListener("click", function (e) {
            if (e.target === dom.dlgOverlay) closeDialog(false);
        });
    }
    document.addEventListener("keydown", function (e) {
        if (!isDialogOpen()) return;
        if (e.key === "Escape") { e.preventDefault(); closeDialog(false); }
        else if (e.key === "Enter") { e.preventDefault(); closeDialog(true); }
    });
}

// =========================================================================
// THÔNG BÁO HOÀN TẤT + ÂM THANH
// =========================================================================

var _toastTimer = null;

function showToast(title, message, isError) {
    if (!dom.toast) return;
    if (dom.toastIcon) dom.toastIcon.textContent = isError ? "⚠️" : "✅";
    if (dom.toastTitle) dom.toastTitle.textContent = title;
    if (dom.toastMsg) dom.toastMsg.textContent = message || "";
    if (isError) dom.toast.classList.add("toast-error");
    else dom.toast.classList.remove("toast-error");
    dom.toast.classList.add("visible");

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(hideToast, 10000);
}

function hideToast() {
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    if (dom.toast) dom.toast.classList.remove("visible");
}

function playDoneSound() {
    try {
        if (!dom.doneSound) return;
        dom.doneSound.currentTime = 0;
        var p = dom.doneSound.play();
        if (p && p.catch) p.catch(function () {});
    } catch (e) {}
}

/** Báo hoàn tất: hiện thông báo + phát âm thanh */
function notifyDone(title, message) {
    showToast(title, message, false);
    playDoneSound();
}

// =========================================================================
// INITIALIZATION
// =========================================================================

window.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("contextmenu", function (event) {
        event.preventDefault();
        return false;
    });

    // Ô link Google Sheet luôn để trống (không nhớ link đã dùng trước đó)
    if (dom.txtGSheetUrl) dom.txtGSheetUrl.value = "";
    try { localStorage.removeItem("autoimportcut_v2_gsheet_url"); } catch (e) {}

    resolveCopyProgressPath();

    checkPremiereEnvironment();
    setupDialog();
    setupEventListeners();
    setupColumnMapping();
    setupAI();
    setupChangelog();
    updateLogVisibility();
    setInterval(checkPremiereEnvironment, 5000);

    // Vừa cập nhật xong ở lần chạy trước? Báo kết quả ngay, trước mọi thứ khác.
    reportUpdateResult();

    // Kiểm tra cập nhật lúc mở panel - lùi vài giây để không giành mạng/CPU
    // với phần dựng giao diện và lần kiểm tra môi trường Premiere đầu tiên.
    setTimeout(function () { runUpdateCheck(false); }, 4000);
});

function checkPremiereEnvironment() {
    csInterface.evalScript("cep_checkEnvironment()", function (resStr) {
        try {
            var res = JSON.parse(resStr);
            if (!res.hasProject) {
                setEnvStatus("offline", "Chưa mở Project", "Vui lòng mở hoặc tạo project");
            } else if (!res.hasSequence) {
                setEnvStatus("warning", res.projectName, "Cần mở/tạo 1 Sequence");
            } else {
                var saveWarn = res.isSaved ? "" : " (Chưa lưu)";
                setEnvStatus("online", res.projectName + saveWarn, res.sequenceName + " (" + res.numVideoTracks + " Video Tracks)");
            }
        } catch (e) {
            setEnvStatus("warning", "Premiere Pro", "Sẵn sàng");
        }
    });
}

function setupChangelog() {
    // Version chỉ khai báo ở APP_VERSION; HTML không ghi tay số nào cả.
    if (dom.btnVersion) {
        dom.btnVersion.textContent = versionMajorLabel(APP_VERSION);
        dom.btnVersion.title = "Bản " + APP_VERSION + " — xem changelog";
    }
    if (dom.changelogVersion) dom.changelogVersion.textContent = "✦ Changelog " + APP_VERSION;

    if (dom.btnVersion) dom.btnVersion.addEventListener("click", function () {
        if (dom.changelogOverlay) dom.changelogOverlay.classList.add("visible");
    });
    if (dom.btnChangelogClose) dom.btnChangelogClose.addEventListener("click", function () {
        if (dom.changelogOverlay) dom.changelogOverlay.classList.remove("visible");
    });
    if (dom.btnCheckUpdate) dom.btnCheckUpdate.addEventListener("click", function () { runUpdateCheck(true); });
}

// =========================================================================
// CẬP NHẬT TỰ ĐỘNG (OTA)
// =========================================================================
function setUpdateStatus(text, isError) {
    if (!dom.updateStatus) return;
    dom.updateStatus.textContent = text || "";
    dom.updateStatus.className = "update-status" + (isError ? " update-status-error" : "");
}

// Ghi lại phiên bản vừa cập nhật, để sau khi panel nạp lại thì biết mà báo kết quả.
var LS_UPDATED_TO = "autoimportcut_v2_updated_to";
var LS_UPDATE_HOSTMSG = "autoimportcut_v2_update_hostmsg";  // lý do nạp lại script thất bại

/**
 * Chạy ngay khi mở panel: nếu lần trước vừa cập nhật thì báo kết quả.
 * Đối chiếu với APP_VERSION đang chạy thật, không tin suông vào cờ đã lưu -
 * nhờ vậy bắt được cả trường hợp file đã ghi nhưng panel vẫn nạp code cũ.
 */
function reportUpdateResult() {
    var flag = null, hostMsg = "";
    try {
        flag = localStorage.getItem(LS_UPDATED_TO);
        hostMsg = localStorage.getItem(LS_UPDATE_HOSTMSG) || "";
    } catch (e) { return; }
    if (!flag) return;
    try {
        localStorage.removeItem(LS_UPDATED_TO);
        localStorage.removeItem(LS_UPDATE_HOSTMSG);
    } catch (e2) {}
    if (hostMsg) addLog("warning", "Nạp lại script trong Premiere không thành công — " + hostMsg);

    if (flag !== APP_VERSION) {
        showAlert("Cập nhật chưa có hiệu lực",
            "Đã tải bản <strong>" + escapeHtml(flag) + "</strong> nhưng panel vẫn đang chạy bản <strong>" +
            escapeHtml(APP_VERSION) + "</strong>.<br><br>Đóng panel rồi mở lại (Window › Extensions).", "warning");
        return;
    }

    addLog("success", "Đã cập nhật lên phiên bản " + APP_VERSION);

    // Panel đã lên bản mới. Nhưng script chạy trong Premiere là thứ RIÊNG BIỆT
    // (Premiere giữ nó trong bộ máy ExtendServer dùng chung). Hỏi thẳng nó đang ở
    // bản nào rồi mới kết luận, thay vì đoán - có nạp lại được thì không cần
    // khởi động lại Premiere, không thì phải nói rõ cho người dùng biết.
    csInterface.evalScript(
        "(function(){ try { return (typeof IMPORTCUT_VERSION !== 'undefined') ? IMPORTCUT_VERSION : ''; } catch(e) { return ''; } })()",
        function (b) {
            var loaded = String(b === undefined || b === null ? "" : b).replace(/^"|"$/g, "");
            if (loaded === APP_VERSION) {
                showAlert("Đã cập nhật phiên bản mới",
                    "Panel và script trong Premiere đều đang chạy bản <strong>" + escapeHtml(APP_VERSION) +
                    "</strong>.<br><br>Không cần khởi động lại Premiere, dùng tiếp được ngay.", "success");
            } else {
                showAlert("Đã cập nhật phiên bản mới",
                    "Panel đã lên bản <strong>" + escapeHtml(APP_VERSION) + "</strong>, nhưng script bên trong Premiere " +
                    "vẫn là bản <strong>" + escapeHtml(loaded || "cũ") + "</strong>.<br><br>" +
                    "<strong>Hãy khởi động lại Premiere Pro</strong> để dùng được đầy đủ bản mới.", "warning");
            }
        }
    );
}

/**
 * manual = true  -> người dùng tự bấm: báo mọi kết quả, kể cả "đã mới nhất".
 * manual = false -> tự chạy lúc mở panel: im lặng, chỉ lên tiếng khi có bản mới.
 */
function runUpdateCheck(manual) {
    if (typeof Updater === "undefined" || !Updater.isConfigured()) {
        if (manual) setUpdateStatus("Chưa cấu hình kho cập nhật", true);
        return;
    }
    if (dom.btnCheckUpdate) dom.btnCheckUpdate.disabled = true;
    setUpdateStatus("Đang kiểm tra…");

    Updater.check().then(function (info) {
        if (dom.btnCheckUpdate) dom.btnCheckUpdate.disabled = false;
        if (!info.isNewer) {
            setUpdateStatus("Đang dùng bản mới nhất (" + APP_VERSION + ")");
            return;
        }
        setUpdateStatus("Có bản mới: " + info.version);
        promptMandatoryUpdate(info);
    }).catch(function (err) {
        if (dom.btnCheckUpdate) dom.btnCheckUpdate.disabled = false;
        var msg = (err && err.message) ? err.message : String(err);
        setUpdateStatus(msg, true);
        if (manual) showAlert("Không kiểm tra được cập nhật", escapeHtml(msg), "warning");
        else addLog("warning", "Không kiểm tra được cập nhật: " + msg);
    });
}

/**
 * Hộp thoại bắt buộc cập nhật - chỉ một nút, không có đường bỏ qua.
 * Ngoại lệ DUY NHẤT: đang cắt dở thì hoãn lại. Ép cập nhật giữa chừng sẽ
 * nạp lại panel và làm hỏng công việc đang chạy.
 */
function promptMandatoryUpdate(info) {
    if (state.isRunning) {
        addLog("info", "Có bản mới " + info.version + ", sẽ nhắc sau khi cắt xong.");
        setTimeout(function () { promptMandatoryUpdate(info); }, 20000);
        return;
    }
    if (isDialogOpen()) {   // đang có hộp thoại khác, đợi rồi nhắc lại
        setTimeout(function () { promptMandatoryUpdate(info); }, 3000);
        return;
    }

    var notes = (info.notes && info.notes.length)
        ? "<br><br>" + info.notes.map(function (n) { return "• " + escapeHtml(n); }).join("<br>")
        : "";
    showDialog({
        title: "Có phiên bản mới, cần cập nhật",
        message: "Bản mới: <strong>" + escapeHtml(info.version) + "</strong> — bạn đang dùng <strong>" +
                 escapeHtml(APP_VERSION) + "</strong>." + notes +
                 "<br><br>Panel sẽ tải về và tự khởi động lại.",
        type: "warning",
        icon: "⬆️",
        okLabel: "Cập nhật ngay",
        cancelLabel: null,
        mandatory: true,
        onResult: function () { doInstallUpdate(info); }
    });
}

function doInstallUpdate(info) {
    setUpdateStatus("Đang tải bản " + info.version + "…");
    if (dom.btnCheckUpdate) dom.btnCheckUpdate.disabled = true;

    Updater.install(info).then(function (res) {
        addLog("success", "Đã cập nhật lên bản " + info.version + " (" + res.count + " file). Bản cũ lưu ở _backup.");
        setUpdateStatus("Xong, đang khởi động lại…");
        // Đánh dấu trước khi nạp lại: sau khi reload, code mới sẽ đọc cờ này để báo kết quả.
        // Giữ luôn kết quả nạp lại script - nhật ký bị xoá sạch khi panel reload.
        try {
            localStorage.setItem(LS_UPDATED_TO, info.version);
            localStorage.setItem(LS_UPDATE_HOSTMSG, res.hostReloaded ? "" : String(res.hostDetail || ""));
        } catch (e) {}
        setTimeout(function () { location.reload(); }, 900);
    }).catch(function (err) {
        if (dom.btnCheckUpdate) dom.btnCheckUpdate.disabled = false;
        var msg = (err && err.message) ? err.message : String(err);
        setUpdateStatus(msg, true);
        // Cố ý KHÔNG bắt buộc ở đây: nếu mạng hỏng hoặc kho lỗi mà vẫn ép,
        // người dùng sẽ kẹt vĩnh viễn không dùng được panel. Lần mở sau vẫn nhắc lại.
        showDialog({
            title: "Cập nhật không thành công",
            message: escapeHtml(msg).replace(/\n/g, "<br>") +
                     "<br><br>Panel vẫn giữ nguyên bản cũ và dùng được bình thường.",
            type: "warning",
            okLabel: "Thử lại",
            cancelLabel: "Để sau",
            onResult: function (retry) { if (retry) doInstallUpdate(info); }
        });
    });
}

function setEnvStatus(type, title, subtitle) {
    dom.envStatusDot.className = "env-status-dot dot-" + type;
    dom.envStatusText.textContent = title;
    dom.seqInfoText.textContent = subtitle;
}

// =========================================================================
// EVENT LISTENERS
// =========================================================================

function setupEventListeners() {
    dom.btnLoadCheck.addEventListener("click", handleLoadCheckButton);
    dom.chkTram.checked = true;
    dom.btnStart.addEventListener("click", function () {
        if (state.scriptValidated) startImportProcess();
    });
    dom.btnCancel.addEventListener("click", cancelImportProcess);
    if (dom.btnCopyRelink) dom.btnCopyRelink.addEventListener("click", copyAndRelinkFootage);
    if (dom.btnExportXml) dom.btnExportXml.addEventListener("click", function () { exportProjectXml(false); });
    if (dom.btnOpenXmlDir) dom.btnOpenXmlDir.addEventListener("click", openXmlFolder);
    if (dom.toastClose) dom.toastClose.addEventListener("click", hideToast);
    if (dom.mediaCheckClose) dom.mediaCheckClose.addEventListener("click", toggleMediaCheck);
    if (dom.mediaCheckStart) dom.mediaCheckStart.addEventListener("click", function () {
        startImportProcess();
    });
    if (dom.logToggle) dom.logToggle.addEventListener("click", function () {
        state.logExpanded = !state.logExpanded;
        updateLogVisibility();
    });

    dom.txtGSheetUrl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
            dom.btnLoadCheck.click();
        }
    });
    dom.txtGSheetUrl.addEventListener("input", resetScriptForUrlChange);

    dom.filterBtns.forEach(function (btn) {
        btn.addEventListener("click", function () {
            dom.filterBtns.forEach(function (b) { b.classList.remove("active"); });
            btn.classList.add("active");
            state.currentFilter = btn.dataset.filter;
            renderLogs();
        });
    });
}

function handleLoadCheckButton() {
    if (state.checkInProgress) {
        cancelImportProcess();
        return;
    }
    handleStartClick();
}

// =========================================================================
// CHỌN CỘT THỦ CÔNG (theo tên cột Google Sheet: A, B, C…)
// =========================================================================

var COL_SELECTS = ["selMainFolder", "selMainCode", "selMainTime", "selTramFolder", "selTramCode", "selTramTime"];

/** 0 -> "A", 25 -> "Z", 26 -> "AA" */
function colLetter(idx) {
    if (idx === undefined || idx === null || idx < 0) return "—";
    var s = "";
    idx = Math.floor(idx);
    while (idx >= 0) {
        s = String.fromCharCode(65 + (idx % 26)) + s;
        idx = Math.floor(idx / 26) - 1;
    }
    return s;
}

function setupColumnMapping() {
    // Đổ danh sách cột A → BZ cho tất cả ô chọn
    for (var i = 0; i < COL_SELECTS.length; i++) {
        var sel = dom[COL_SELECTS[i]];
        if (!sel) continue;
        var html = '<option value="-1">—</option>';
        for (var c = 0; c < 78; c++) {
            html += '<option value="' + c + '">' + colLetter(c) + "</option>";
        }
        sel.innerHTML = html;
    }

    if (dom.btnColAuto) dom.btnColAuto.addEventListener("click", function () { setColMode("auto"); });
    if (dom.btnColManual) dom.btnColManual.addEventListener("click", function () { setColMode("manual"); });
    setColMode("auto");
}

function setColMode(mode) {
    state.colMode = (mode === "manual") ? "manual" : "auto";
    var manual = (state.colMode === "manual");
    if (dom.btnColAuto) dom.btnColAuto.classList.toggle("active", !manual);
    if (dom.btnColManual) dom.btnColManual.classList.toggle("active", manual);
    if (dom.manualCols) dom.manualCols.classList.toggle("visible", manual);
}

function selVal(sel) {
    if (!sel) return -1;
    var v = parseInt(sel.value, 10);
    return isNaN(v) ? -1 : v;
}

/** Bộ cột người dùng tự chọn; trả về null kèm alert nếu thiếu cột bắt buộc. */
function getManualCols() {
    var cols = {
        bodyCol: -1,
        sourceCol: selVal(dom.selMainFolder),
        codeCol: selVal(dom.selMainCode),
        timeCol: selVal(dom.selMainTime),
        tramSourceCol: selVal(dom.selTramFolder),
        tramCodeCol: selVal(dom.selTramCode),
        tramTimeCol: selVal(dom.selTramTime)
    };
    if (cols.codeCol === -1) {
        showAlert("Thiếu cột bắt buộc", "Chế độ thủ công cần chọn cột <strong>Tên file</strong> cho Source chính (V1).\n\nVí dụ: tên/mã file nằm ở cột C thì chọn <code>C</code>.", "warning");
        return null;
    }
    // Trám phải có mã file mới chèn được — chọn mỗi Folder/Timecode thì bỏ qua trám
    if (cols.tramCodeCol === -1 && (cols.tramSourceCol !== -1 || cols.tramTimeCol !== -1)) {
        addLog("warning", "Chưa chọn cột Tên file cho Source trám (V2) → bỏ qua phần trám.");
        cols.tramSourceCol = -1; cols.tramTimeCol = -1;
    }
    return cols;
}

function describeManualCols(c) {
    return "Cột thủ công → V1: Folder=" + colLetter(c.sourceCol) + ", Tên file=" + colLetter(c.codeCol) +
           ", Timecode=" + colLetter(c.timeCol) +
           " | V2 trám: Folder=" + colLetter(c.tramSourceCol) + ", Tên file=" + colLetter(c.tramCodeCol) +
           ", Timecode=" + colLetter(c.tramTimeCol);
}

// =========================================================================
// 1-CLICK GOOGLE SHEETS FETCH & RUN
// =========================================================================

function parseGoogleSheetUrl(url) {
    if (!url) return null;
    url = url.trim();
    
    var idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
    if (!idMatch) return null;
    var sheetId = idMatch[1];
    
    var gidMatch = url.match(/[?#&]gid=([0-9]+)/i);
    var gid = gidMatch ? gidMatch[1] : "0";
    
    return {
        sheetId: sheetId,
        gid: gid,
        exportUrl: "https://docs.google.com/spreadsheets/d/" + sheetId + "/export?format=csv&gid=" + gid,
        gvizUrl: "https://docs.google.com/spreadsheets/d/" + sheetId + "/gviz/tq?tqx=out:csv&gid=" + gid
    };
}

function handleStartClick() {
    if (state.parsedData) {
        validateScriptSources();
        return;
    }
    ensureOwnScript(function (ok) { if (ok) startFromSheetUrl(); });
}

function resetScriptForUrlChange() {
    state.parsedData = null;
    state.scriptValidated = false;
    stopCheckProgress();
    state.checkCancelled = true;
    state.checkInProgress = false;
    state.mediaCheckItems = [];
    state.logs = [];
    renderLogs();
    if (dom.btnStart) {
        dom.btnStart.disabled = true;
        dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
    }
    if (dom.btnLoadCheck) {
        dom.btnLoadCheck.disabled = false;
        dom.btnLoadCheck.innerHTML = "<span>📥 Tải &amp; kiểm tra kịch bản</span>";
    }
    if (dom.progressCard) dom.progressCard.style.display = "none";
    if (dom.mediaCheckPanel) { dom.mediaCheckPanel.classList.remove("visible"); dom.mediaCheckPanel.classList.remove("collapsed"); }
}

function startFromSheetUrl() {
    var url = dom.txtGSheetUrl.value.trim();
    if (!url) {
        showAlert("Chưa có link kịch bản", "Vui lòng dán link Google Sheet vào ô nhập liệu phía trên.", "warning");
        dom.txtGSheetUrl.focus();
        return;
    }

    var parsed = parseGoogleSheetUrl(url);
    if (!parsed) {
        showAlert("Link không đúng định dạng", "Link phải có dạng:\n\n<code>https://docs.google.com/spreadsheets/d/&lt;ID&gt;/edit#gid=&lt;số&gt;</code>\n\nMở sheet trên trình duyệt rồi copy nguyên link trên thanh địa chỉ.", "error");
        return;
    }

    state.parsedData = null;
    state.scriptValidated = false;
    state.checkCancelled = false;
    state.checkInProgress = true;
    if (dom.btnLoadCheck) {
        dom.btnLoadCheck.disabled = false;
        dom.btnLoadCheck.innerHTML = "<span>⏹️ Dừng tải &amp; kiểm tra</span>";
    }
    dom.btnCancel.style.display = "none";

    hideToast();
    dom.btnStart.disabled = true;
    dom.btnStart.innerHTML = "<span>⏳ Đang tải kịch bản...</span>";
    dom.progressCard.style.display = "block";
    dom.progressStepText.textContent = "Đang tải Google Sheet...";
    dom.progressBarFill.style.width = "5%";
    dom.progressPercent.textContent = "5%";
    dom.currentActionText.textContent = "Đang tải dữ liệu từ Google Sheets...";

    addLog("info", "Đang kết nối Google Sheet (ID: " + parsed.sheetId.substring(0, 8) + "..., Tab gid=" + parsed.gid + ")...");

    // Tải trực tiếp qua fetch()
    fetch(parsed.exportUrl, { cache: "no-store" })
        .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.text();
        })
        .then(function (csvText) {
            if (state.checkCancelled) return;
            processDownloadedCsv(csvText, parsed);
        })
        .catch(function (err) {
            if (state.checkCancelled) return;
            // Fallback: Tải qua ExtendScript (curl / PowerShell)
            addLog("info", "Đang thử tải bằng động cơ mạng ExtendScript...");
            var downloadScript = "(function(){ " +
                "var exportUrl = " + JSON.stringify(parsed.exportUrl) + "; " +
                "var tempCsv = Folder.temp.fsName + '/pr_gsheet_' + (new Date().getTime()) + '.csv'; " +
                "var f = downloadFileFromUrl(exportUrl, tempCsv); " +
                "if (!f || !f.exists || f.length === 0) return toJson({ error: 'Không tải được' }); " +
                "f.encoding = 'UTF-8'; f.open('r'); var content = f.read(); f.close(); f.remove(); " +
                "return toJson({ success: true, csvContent: content }); " +
            "})()";

            csInterface.evalScript(downloadScript, function (resStr) {
                try {
                    var res = JSON.parse(resStr);
                    if (res.success && res.csvContent) {
                        if (state.checkCancelled) return;
                        processDownloadedCsv(res.csvContent, parsed);
                    } else {
                        showGSheetPermissionError();
                    }
                } catch (e2) {
                    showGSheetPermissionError();
                }
            });
        });
}

function processDownloadedCsv(csvText, parsed) {
    if (state.checkCancelled) return;
    if (!csvText || csvText.indexOf("<!DOCTYPE html") !== -1 || csvText.indexOf("accounts.google.com") !== -1) {
        showGSheetPermissionError();
        return;
    }

    state.csvContent = csvText;
    state.csvFileName = "GoogleSheet_gid" + parsed.gid;

    if (state.colMode === "manual") {
        processCsvWithManualCols();
        return;
    }

    var script = "cep_parseCSVContent(" + toEscapedJson(state.csvContent) + ")";
    csInterface.evalScript(script, function (resStr) {
        if (state.checkCancelled) return;
        try {
            var res = JSON.parse(resStr);
            if (res.success) {
                state.parsedData = res;
                addLog("success", "Đã tải kịch bản thành công (" + res.dataRowCount + " dòng)");
                addLog("info", describeCols(res.cols) + (res.cols.detectedByContent ? " [nhận diện theo nội dung]" : ""));
                warnMissingTimeCols(res.cols);
                scriptLoadedForCheck();
            } else {
                // Rule-based detection failed — nhận diện cột bằng AI (luôn bật khi có key)
                if (GeminiAPI.hasKey()) {
                    addLog("info", "⚠️ Không nhận diện được cột theo quy tắc. Đang nhờ Gemini AI phân tích cấu trúc sheet...");
                    dom.currentActionText.textContent = "✨ Gemini đang phân tích cấu trúc bảng...";

                    var previewLines = csvText.split("\n").slice(0, 25).join("\n");
                    GeminiAPI.detectColumns(previewLines).then(function (aiCols) {
                        if (state.checkCancelled) return;
                        // Đếm số hàng bằng parseCSV thật trong ExtendScript (ô nhiều dòng
                        // không bị tính thành nhiều hàng), thay vì đếm dòng vật lý của file.
                        var applyScript = "cep_parseCSVContentWithCols(" + toEscapedJson(state.csvContent) + "," + toEscapedJson(JSON.stringify(aiCols)) + ")";
                        csInterface.evalScript(applyScript, function (applyStr) {
                            if (state.checkCancelled) return;
                            var applied = null;
                            try { applied = JSON.parse(applyStr); } catch (eA) {}
                            if (!applied || !applied.success) {
                                resetStartButton();
                                addLog("error", "Không áp dụng được cột AI: " + (applied ? applied.error : applyStr));
                                showAlert("Không áp dụng được cột AI", "Gemini đã nhận diện cột nhưng không áp dụng được.\n\n" + escapeHtml(applied ? String(applied.error) : ""), "error");
                                return;
                            }
                            state.parsedData = applied;
                            var c = applied.cols;
                            addLog("success", "✨ Gemini AI: Source=cột " + (c.sourceCol+1) + ", Mã file=cột " + (c.codeCol+1) +
                                   ", Time=" + (c.timeCol === -1 ? "không có" : ("cột " + (c.timeCol+1))) +
                                   (c.tramCodeCol !== -1 ? (" | TRÁM: Source=cột " + (c.tramSourceCol+1) + ", Mã file=cột " + (c.tramCodeCol+1)) : " | không có trám"));
                            warnMissingTimeCols(c);
                            scriptLoadedForCheck();
                        });
                    }).catch(function (err) {
                        if (state.checkCancelled) return;
                        resetStartButton();
                        addLog("error", "AI phân tích cột thất bại: " + err.message);
                        addLog("error", "Lỗi cấu trúc sheet gốc: " + res.error);
                        showAlert("Không đọc được cấu trúc kịch bản", escapeHtml(String(res.error)) + "\n\nGemini AI cũng không nhận diện được sheet này. Bạn có thể chuyển sang <strong>chọn cột thủ công</strong> ở phần Cấu hình dựng.", "error");
                    });
                } else {
                    resetStartButton();
                    addLog("error", "Lỗi cấu trúc: " + res.error);
                    showAlert("Không đọc được cấu trúc kịch bản", escapeHtml(String(res.error)) + "\n\nBạn có thể chuyển sang <strong>chọn cột thủ công</strong> ở phần Cấu hình dựng.", "error");
                }
            }
        } catch (err) {
            resetStartButton();
            addLog("error", "Lỗi phân tích: " + err.toString());
        }
    });
}

/**
 * Chế độ thủ công: dùng đúng bộ cột người dùng chỉ định, không nhận diện, không gọi AI phân tích cột.
 * Mọi ngữ cảnh xử lý (trám, timecode, đường dẫn đầy đủ, 5s giữa video…) giữ nguyên như chế độ tự động.
 */
function processCsvWithManualCols() {
    var cols = getManualCols();
    if (!cols) { resetStartButton(); return; }

    var script = "cep_parseCSVContentManual(" + toEscapedJson(state.csvContent) + "," + toEscapedJson(JSON.stringify(cols)) + ")";
    csInterface.evalScript(script, function (resStr) {
        if (state.checkCancelled) return;
        var res = null;
        try { res = JSON.parse(resStr); } catch (e) {}
        if (!res || !res.success) {
            resetStartButton();
            var msg = res ? res.error : ("Premiere không trả về dữ liệu: " + String(resStr).substring(0, 200));
            addLog("error", "Chế độ thủ công: " + msg);
            showAlert("Chế độ thủ công", escapeHtml(String(msg)), "error");
            return;
        }
        state.parsedData = res;
        addLog("success", "Đã tải kịch bản thành công (" + res.dataRowCount + " dòng)");
        addLog("info", describeManualCols(res.cols) + (res.cols.fullPathCode ? " [ô Tên file là đường dẫn đầy đủ]" : ""));
        warnMissingTimeCols(res.cols);
        scriptLoadedForCheck();
    });
}

/** Mô tả bộ cột đã nhận diện để soi nhanh trong log khi chạy nhiều kiểu kịch bản khác nhau. */
function describeCols(c) {
    if (!c) return "Không có thông tin cột";
    function col(i) { return (i === -1) ? "không có" : ("cột " + (i + 1)); }
    var s = "CHÍNH → Source=" + (c.fullPathCode ? "nằm luôn trong cột file" : col(c.sourceCol)) +
            ", Mã file=" + col(c.codeCol) + (c.fullPathCode ? " (đường dẫn đầy đủ)" : "") +
            ", Time=" + col(c.timeCol);
    if (c.timeCol === -1) s += " (dùng thời lượng mặc định)";
    if (c.tramCodeCol !== -1) {
        s += " | TRÁM → Source=" + col(c.tramSourceCol) + ", Mã file=" + col(c.tramCodeCol) + ", Time=" + col(c.tramTimeCol);
    } else {
        s += " | không có source trám";
    }
    return s;
}

/**
 * Cảnh báo khi một nhóm source không có cột timecode: clip sẽ bị lấy mặc định
 * (đoạn giữa file) thay vì đúng đoạn trong kịch bản — lỗi rất dễ bị bỏ sót
 * vì clip vẫn được chèn bình thường, chỉ sai nội dung.
 */
function warnMissingTimeCols(cols) {
    if (!cols) return;
    var sec = parseFloat(dom.txtDefaultSec.value) || 5;
    if (cols.timeCol === -1) {
        addLog("warning", "Không tìm thấy cột timecode của source chính → mỗi clip lấy " + sec + "s ở giữa file. Kiểm tra lại cột timecode trong sheet.");
    }
    if (cols.tramCodeCol !== -1 && cols.tramTimeCol === -1) {
        addLog("warning", "Không tìm thấy cột timecode của source TRÁM → clip trám lấy " + sec + "s ở giữa file. Kiểm tra lại cột timecode của nhóm trám trong sheet.");
    }
}

function showGSheetPermissionError() {
    resetStartButton();
    addLog("error", "Không thể tải Google Sheet này (Cần quyền truy cập công khai)");
    showAlert("Không tải được Google Sheet",
        "Sheet đang ở chế độ <strong>Riêng tư</strong> nên panel không đọc được.\n\n" +
        "<strong>Cách khắc phục:</strong>\n" +
        "1. Trên Google Sheet, bấm <strong>Chia sẻ</strong> (góc trên bên phải).\n" +
        "2. Mục <em>Quyền truy cập chung</em> đổi thành <strong>Bất kỳ ai có đường liên kết</strong> (Người xem).\n" +
        "3. Bấm Xong rồi chạy lại Bắt đầu Import &amp; Cắt.", "warning");
}

function resetStartButton() {
    dom.btnStart.disabled = !state.scriptValidated;
    dom.btnStart.style.display = "inline-flex";
    dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
    dom.btnCancel.style.display = "none";
}

function scriptLoadedForCheck() {
    state.scriptValidated = false;
    state.checkInProgress = true;
    dom.btnStart.disabled = true;
    dom.btnStart.style.display = "inline-flex";
    dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
    if (dom.btnLoadCheck) { dom.btnLoadCheck.disabled = false; dom.btnLoadCheck.innerHTML = "<span>⏹️ Dừng Gemini &amp; kiểm tra</span>"; }
    csInterface.evalScript("cep_clearSourceReplacements()", function () {
        if (state.checkCancelled) return;
        if (!GeminiAPI.hasKey()) {
            addLog("warning", "Chưa có Gemini API Key, bỏ qua chuẩn hóa AI và kiểm tra dữ liệu gốc.");
            validateScriptSources();
            return;
        }
        normalizeScriptWithGemini();
    });
}

function normalizeScriptWithGemini() {
    if (state.checkCancelled) return;
    dom.btnLoadCheck.disabled = true;
    dom.btnLoadCheck.innerHTML = "<span>⏹️ Dừng Gemini đang chuẩn hóa</span>";
    startCheckProgress("Gemini đang chuẩn hóa timecode và đường dẫn...", 12, 62);
    GeminiAPI.normalizeScript(state.csvContent, state.parsedData.cols).then(function (edits) {
        if (state.checkCancelled) return;
        evalJson("cep_applyNormalizedScript(" + toEscapedJson(state.csvContent) + "," +
            toEscapedJson(JSON.stringify(edits)) + "," + toEscapedJson(JSON.stringify(state.parsedData.cols)) + ")", function (res, err) {
            if (err || !res || !res.success) {
                addLog("warning", "Không áp dụng được chuẩn hóa Gemini, dùng dữ liệu gốc: " + (err || (res && res.error) || "Lỗi không xác định"));
                validateScriptSources();
                return;
            }
            if (state.checkCancelled) return;
            state.csvContent = res.csvContent;
            state.normalizedScriptPath = res.normalizedPath || "";
            addLog("success", "Gemini đã chuẩn hóa kịch bản" + (state.normalizedScriptPath ? " và tạo file CSV mới: " + state.normalizedScriptPath : "."));
            updateCheckProgress("Đã tạo file chuẩn hóa, đang kiểm tra đường dẫn media...", 68);
            validateScriptSources();
        });
    }).catch(function (err) {
        if (state.checkCancelled) return;
        addLog("warning", "Gemini chuẩn hóa thất bại, dùng dữ liệu gốc: " + err.message);
        stopCheckProgress();
        validateScriptSources();
    });
}

function closeMediaCheck() {
    if (dom.mediaCheckPanel) dom.mediaCheckPanel.classList.remove("visible");
}

// Thu gọn = giấu danh sách file, VẪN giữ tiêu đề, dòng tóm tắt và nút "Bắt đầu cắt"
// (giống tab Nhật ký xử lý). Không dùng class "visible" ở đây — class đó điều khiển
// việc panel có tồn tại hay không, bật/tắt nó sẽ làm biến mất cả tab.
function toggleMediaCheck() {
    if (!dom.mediaCheckPanel) return;
    var collapsed = dom.mediaCheckPanel.classList.toggle("collapsed");
    dom.mediaCheckClose.textContent = collapsed ? "Mở rộng" : "Thu gọn";
    dom.mediaCheckClose.title = collapsed ? "Mở rộng" : "Thu gọn";
}

function validateScriptSources() {
    if (!state.parsedData || state.isRunning || state.checkCancelled) return;
    dom.btnLoadCheck.disabled = true;
    dom.btnLoadCheck.innerHTML = "<span>⏹️ Dừng kiểm tra media</span>";
    if (!state.checkProgressTimer) startCheckProgress("Đang kiểm tra đường dẫn và mã file...", 68, 94);
    var payload = { csvContent: state.csvContent, cols: state.parsedData.cols, enableTram: true };
    evalJson("cep_validateSources(" + toEscapedJson(JSON.stringify(payload)) + ")", function (res, err) {
        if (state.checkCancelled) return;
        dom.btnLoadCheck.disabled = false;
        dom.btnLoadCheck.innerHTML = "<span>📥 Tải &amp; kiểm tra kịch bản</span>";
        if (err || !res || !res.success) {
            stopCheckProgress();
            state.checkInProgress = false;
            dom.btnLoadCheck.disabled = false;
            dom.btnLoadCheck.innerHTML = "<span>📥 Tải &amp; kiểm tra kịch bản</span>";
            addLog("error", "Kiểm tra media thất bại: " + (err || (res && res.error) || "Lỗi không xác định"));
            showAlert("Không kiểm tra được media", escapeHtml(String(err || (res && res.error) || "Lỗi không xác định")), "error");
            return;
        }
        stopCheckProgress();
        state.checkInProgress = false;
        renderMediaCheck(res.items || []);
    });
}

function startCheckProgress(message, from, cap) {
    stopCheckProgress();
    state.checkProgressStarted = Date.now();
    dom.progressCard.style.display = "block";
    dom.progressStepText.textContent = "Tải & kiểm tra kịch bản";
    updateCheckProgress(message, from);
    state.checkProgressTimer = setInterval(function () {
        var elapsed = Math.floor((Date.now() - state.checkProgressStarted) / 1000);
        var current = Math.min(cap, from + Math.floor(elapsed / 2));
        updateCheckProgress(message, current, elapsed);
    }, 1000);
}

function updateCheckProgress(message, percent, elapsed) {
    dom.progressBarFill.style.width = percent + "%";
    dom.progressPercent.textContent = percent + "%";
    dom.currentActionText.textContent = message + (elapsed !== undefined ? " (" + elapsed + " giây)" : "");
}

function stopCheckProgress() {
    if (state.checkProgressTimer) clearInterval(state.checkProgressTimer);
    state.checkProgressTimer = null;
}

function renderMediaCheck(items) {
    var missing = items.filter(function (item) { return !item.found; }).length;
    dom.mediaCheckSummary.innerHTML = "Đã kiểm tra <strong>" + items.length + "</strong> file: " +
        "<span class=\"check-ok\">" + (items.length - missing) + " tìm thấy</span>, " +
        "<span class=\"check-missing\">" + missing + " chưa tìm thấy</span>.";
    if (!items.length) dom.mediaCheckList.innerHTML = '<div class="log-empty">Không có file media hợp lệ trong dữ liệu.</div>';
    else dom.mediaCheckList.innerHTML = items.map(function (item) {
        var status = item.found ? "check-found" : "check-not-found";
        var label = item.found ? "✓ Đã tìm thấy" : "✕ Không tìm thấy";
        var action = item.found ? "" : '<button class="btn-find-media" data-media-id="' + escapeHtml(item.id) + '">🔎 Tìm &amp; thay thế</button>';
        return '<div class="media-check-row ' + status + '">' +
            '<div class="media-check-main"><strong>Dòng ' + item.rowNumber + ' · ' + escapeHtml(item.kind) + '</strong>' +
                '<div class="media-check-field"><span>Đường dẫn</span><input readonly value="' + escapeHtml(item.displayFolder || "(đường dẫn đầy đủ)") + '"><button class="btn-copy-media" data-copy-value="' + escapeHtml(item.displayFolder || "") + '" title="Copy đường dẫn">⧉</button></div>' +
                '<div class="media-check-field"><span>Tên file</span><input readonly value="' + escapeHtml(item.displayName || item.code || "") + '"><button class="btn-copy-media" data-copy-value="' + escapeHtml(item.displayName || item.code || "") + '" title="Copy tên file">⧉</button></div></div>' +
            '<span class="media-check-status">' + label + '</span>' + action + '</div>';
    }).join("");
    Array.prototype.forEach.call(dom.mediaCheckList.querySelectorAll(".btn-find-media"), function (button) {
        button.addEventListener("click", function () { chooseMediaReplacement(items, button.getAttribute("data-media-id")); });
    });
    Array.prototype.forEach.call(dom.mediaCheckList.querySelectorAll(".btn-copy-media"), function (button) {
        button.addEventListener("click", function () { copyMediaText(button.getAttribute("data-copy-value") || ""); });
    });
    state.mediaCheckItems = items;
    state.scriptValidated = true;
    dom.btnStart.disabled = false;
    dom.mediaCheckStart.disabled = false;
    dom.mediaCheckStart.textContent = missing ? "✂️ Bắt đầu cắt (bỏ qua file thiếu)" : "✂️ Bắt đầu cắt";
    dom.mediaCheckPanel.classList.add("visible");
    dom.mediaCheckPanel.classList.remove("collapsed"); // ket qua moi -> luon mo san
    dom.mediaCheckClose.textContent = "Thu gọn";
    dom.mediaCheckClose.title = "Thu gọn";
    dom.btnCancel.style.display = "none";
    dom.btnCancel.disabled = false;
    state.checkInProgress = false;
    dom.btnLoadCheck.disabled = false;
    dom.btnLoadCheck.innerHTML = "<span>📥 Tải &amp; kiểm tra kịch bản</span>";
    dom.progressBarFill.style.width = "100%";
    dom.progressPercent.textContent = "100%";
    dom.progressStepText.textContent = "Đã kiểm tra kịch bản";
    dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
    addLog(missing ? "warning" : "success", "Kiểm tra media: " + (items.length - missing) + "/" + items.length + " file tìm thấy.");
}

function chooseMediaReplacement(items, id) {
    var item = items.filter(function (entry) { return entry.id === id; })[0];
    if (!item) return;
    var picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "video/*,.mp4,.mov,.mxf,.mts,.m4v,.avi,.wmv";
    picker.style.display = "none";
    document.body.appendChild(picker);
    picker.addEventListener("change", function () {
        var file = picker.files && picker.files[0];
        var path = file && (file.path || file.fsName || file.name);
        document.body.removeChild(picker);
        if (!path || (file && path === file.name)) {
            showAlert("Không lấy được đường dẫn", "Hãy chọn file từ Explorer của Premiere.", "warning");
            return;
        }
        evalJson("cep_setSourceReplacement(" + toEscapedJson(item.folder || "") + "," + toEscapedJson(item.code || "") + "," + toEscapedJson(path) + ")", function (res, err) {
            if (err || !res || !res.success) { showAlert("Không thay được file", escapeHtml(String(err || (res && res.error) || "Lỗi không xác định")), "error"); return; }
            items.forEach(function (entry) {
                if (entry.checkKey === item.checkKey) {
                    entry.found = true; entry.foundPath = path; entry.displayFolder = path.replace(/[\\\/][^\\\/]*$/, "");
                    entry.displayName = path.split(/[\\\/]/).pop(); entry.replaced = true;
                }
            });
            renderMediaCheck(items);
        });
    });
    picker.click();
}

function copyMediaText(text) {
    if (!text) return;
    try {
        var area = document.createElement("textarea");
        area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
        document.body.appendChild(area); area.select(); document.execCommand("copy"); document.body.removeChild(area);
        addLog("info", "Đã copy: " + text);
    } catch (e) { showAlert("Không copy được", "Hãy bôi đen và copy thủ công.", "warning"); }
}

// =========================================================================
// MAIN PROCESSING LOOP (STEP-BY-STEP)
// =========================================================================

function startImportProcess() {
    if (!state.parsedData) return;

    state.isRunning = true;
    state.shouldCancel = false;
    state.currentRowIdx = 0;
    state.aiClipNames = {};
    resetStats();

    dom.btnStart.style.display = "none";
    dom.btnCancel.style.display = "inline-flex";
    dom.progressCard.style.display = "block";

    var config = {
        mainTrackIndex: 0,
        tramTrackIndex: 1,
        enableCopyToLocal: dom.chkCopy.checked,
        enableTram: true,
        enableLabel: dom.chkLabel.checked,
        defaultDuration: parseFloat(dom.txtDefaultSec.value) || 5,
        singleTimeEnabled: dom.chkSingleTime.checked,
        singleTimeDuration: parseFloat(dom.txtSingleTimeSec.value) || 5,
        noTimecodeMode: dom.radioFullVideo.checked ? "full" : "center",
        noTimecodeDuration: parseFloat(dom.txtCenterTimeSec.value) || 5,
        footageFolderName: "Footage"
    };

    // Theo dõi % + tốc độ khi có bật copy file về Footage/
    // (luồng Import không biết trước tổng dung lượng nên chỉ cộng dồn số byte đã copy)
    state.copyPlan = null;
    state.copiedBytes = 0;
    if (config.enableCopyToLocal) startCopyMonitor();

    var initScript = "cep_initSession(" + toEscapedJson(JSON.stringify(config)) + ")";
    csInterface.evalScript(initScript, function (resStr) {
        addLog("info", "Bắt đầu dựng " + state.parsedData.dataRowCount + " dòng kịch bản lên Timeline...");

        // AI Clip Namer: luôn bật khi có key và bật đổi tên theo số hàng
        if (GeminiAPI.hasKey() && dom.chkLabel.checked) {
            var cols = state.parsedData.cols;
            var bodyColIdx = (cols && cols.bodyCol !== undefined) ? cols.bodyCol : -1;
            if (bodyColIdx !== -1) {
                var csvRows;
                try {
                    // Minimal CSV parse for body column only
                    var rawLines = state.csvContent.split(/\r?\n/);
                    var firstData = (cols.headerRowIndex || 0) + 1;
                    var bodyRows = [];
                    for (var ri = firstData; ri < rawLines.length && bodyRows.length < 60; ri++) {
                        var cellVal = extractCsvCell(rawLines[ri], bodyColIdx);
                        if (cellVal && cellVal.trim() !== "") {
                            bodyRows.push({ rowNumber: ri + 1, body: cellVal.trim() });
                        }
                    }
                    if (bodyRows.length > 0) {
                        dom.currentActionText.textContent = "✨ Gemini đang đặt tên clip (" + bodyRows.length + " clip)...";
                        addLog("info", "✨ Gemini AI đang tạo tên clip thông minh cho " + bodyRows.length + " hàng...");
                        GeminiAPI.batchClipNames(bodyRows).then(function (names) {
                            var count = 0;
                            for (var k in names) { if (names.hasOwnProperty(k)) { state.aiClipNames[k] = names[k]; count++; } }
                            if (count > 0) addLog("success", "✨ Gemini AI đã tạo " + count + " tên clip");
                            processNextRow();
                        }).catch(function (err) {
                            addLog("warning", "AI đặt tên thất bại, dùng tên mặc định: " + err.message);
                            processNextRow();
                        });
                        return; // Will continue inside the .then() above
                    }
                } catch (e) {}
            }
        }
        processNextRow();
    });
}

function processNextRow() {
    if (state.shouldCancel) {
        finishProcess("Đã dừng bởi người dùng");
        return;
    }

    var totalRows = state.parsedData.dataRowCount;
    if (state.currentRowIdx >= totalRows) {
        finishProcess("Hoàn tất xử lý toàn bộ kịch bản!");
        return;
    }

    var actualDataIndex = state.parsedData.cols.headerRowIndex + 1 + state.currentRowIdx;
    var rowNumber = actualDataIndex + 1;

    var percent = Math.round(((state.currentRowIdx + 1) / totalRows) * 100);
    dom.progressBarFill.style.width = percent + "%";
    dom.progressPercent.textContent = percent + "%";
    dom.progressStepText.textContent = "Dòng " + (state.currentRowIdx + 1) + " / " + totalRows;
    dom.currentActionText.textContent = "Đang xử lý dòng " + rowNumber + "...";

    var fallbackScript = "(function(){ " +
        "var rows = parseCSV(" + toEscapedJson(state.csvContent) + "); " +
        "var cols = " + toEscapedJson(_sessionCols()) + "; " +
        "var r = rows[" + actualDataIndex + "]; " +
        "if (!r) return toJson({status:'skipped', details:'Dòng trống'}); " +
        "var data = { " +
        "   rowNumber: " + rowNumber + ", " +
        "   rawRow: r, " +
        "   body: (cols.bodyCol!==-1 ? r[cols.bodyCol] : ''), " +
        "   source: (cols.sourceCol!==-1 ? r[cols.sourceCol] : ''), " +
        "   code: (cols.codeCol!==-1 ? r[cols.codeCol] : ''), " +
        "   time: (cols.timeCol!==-1 ? r[cols.timeCol] : ''), " +
        "   tramSource: (cols.tramSourceCol!==-1 ? r[cols.tramSourceCol] : ''), " +
        "   tramCode: (cols.tramCodeCol!==-1 ? r[cols.tramCodeCol] : ''), " +
        "   tramTime: (cols.tramTimeCol!==-1 ? r[cols.tramTimeCol] : ''), " +
        "   labelOverride: " + toEscapedJson(state.aiClipNames[String(rowNumber)] || "") + " " +
        "}; " +
        "return cep_processSingleRow(toJson(data)); " +
    "})()";

    csInterface.evalScript(fallbackScript, function (resStr) {
        try {
            var result = JSON.parse(resStr);
            handleRowResult(rowNumber, result);
        } catch (e) {
            addLog("error", "Dòng " + rowNumber + ": Lỗi xử lý - " + e.toString());
            state.stats.error++;
        }

        updateStatsUI();
        state.currentRowIdx++;
        setTimeout(processNextRow, 25);
    });
}

function _sessionCols() {
    return state.parsedData ? state.parsedData.cols : {};
}

function handleRowResult(rowNumber, res) {
    if (res.status === "skipped") {
        state.stats.skipped++;
    } else if (res.status === "error") {
        state.stats.error++;
        addLog("error", "Dòng " + rowNumber + ": " + res.errorMsg);
    } else if (res.status === "warning") {
        state.stats.warning++;
        state.stats.clips += (res.clipCount || 0);
        state.stats.copied += (res.copyCount || 0);
        state.stats.downloaded += (res.downloadCount || 0);
        var warnText = res.warnings ? (" (" + res.warnings.join(", ") + ")") : "";
        addLog("warning", "Dòng " + rowNumber + ": " + (res.details || "Thành công") + warnText);
    } else {
        state.stats.success++;
        state.stats.clips += (res.clipCount || 0);
        state.stats.copied += (res.copyCount || 0);
        state.stats.downloaded += (res.downloadCount || 0);
        addLog("success", "Dòng " + rowNumber + ": " + (res.details || "Chèn clip thành công"));
    }
}

function cancelImportProcess() {
    if (!state.isRunning) {
        state.checkCancelled = true;
        state.checkInProgress = false;
        stopCheckProgress();
        dom.btnCancel.style.display = "none";
        dom.btnCancel.disabled = true;
        if (dom.btnLoadCheck) {
            dom.btnLoadCheck.disabled = false;
            dom.btnLoadCheck.innerHTML = "<span>📥 Tải &amp; kiểm tra kịch bản</span>";
        }
        if (dom.btnStart) {
            dom.btnStart.disabled = true;
            dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
        }
        dom.currentActionText.textContent = "Đã dừng tải & kiểm tra.";
        addLog("info", "Đã dừng tải & kiểm tra kịch bản theo yêu cầu.");
        return;
    }
    state.shouldCancel = true;
    dom.btnCancel.disabled = true;
    dom.currentActionText.textContent = "Đang dừng...";
}

function finishProcess(message) {
    var wasCancelled = state.shouldCancel;
    state.isRunning = false;
    CopyMonitor.stop();
    csInterface.evalScript("cep_finishSession()", function () {});

    dom.progressBarFill.style.width = "100%";
    dom.progressPercent.textContent = "100%";
    dom.progressStepText.textContent = "Hoàn thành";
    dom.currentActionText.textContent = message;

    resetStartButton();

    addLog("info", "--- TỔNG KẾT: " + message + " ---");
    addLog("info", "Đã chèn: " + state.stats.clips + " clip | Đã copy/tải: " + (state.stats.copied + state.stats.downloaded) + " file | Lỗi: " + state.stats.error + " | Cảnh báo: " + state.stats.warning);

    if (wasCancelled) {
        showToast("Đã dừng", message, true);
    } else {
        notifyDone("Đã xong Import & Cắt!",
            "Đã chèn " + state.stats.clips + " clip · copy/tải " + (state.stats.copied + state.stats.downloaded) + " file\n" +
            "Lỗi: " + state.stats.error + " · Cảnh báo: " + state.stats.warning);
    }
}

// =========================================================================
// STATS & LOGS MANAGEMENT
// =========================================================================

function resetStats() {
    state.stats = { total: state.parsedData ? state.parsedData.dataRowCount : 0, success: 0, warning: 0, error: 0, skipped: 0, copied: 0, downloaded: 0, clips: 0 };
    updateStatsUI();
}

// =========================================================================
// COPY & RELINK FOOTAGE
// =========================================================================

var RELINK_BTN_LABEL = "Copy & Relink Footage";

function setRelinkBusy(busy, text) {
    if (!dom.btnCopyRelink) return;
    dom.btnCopyRelink.disabled = !!busy;
    if (dom.relinkLabel) {
        dom.relinkLabel.textContent = busy ? (text || "Đang xử lý...") : RELINK_BTN_LABEL;
    }
}

/**
 * evalScript wrapper: bắt mọi trường hợp ExtendScript không trả về JSON
 * (hàm chưa tồn tại, lỗi cú pháp, trả về rỗng...) thay vì im lặng.
 */
function evalJson(script, cb) {
    csInterface.evalScript(script, function (resStr) {
        var raw = (resStr === undefined || resStr === null) ? "" : String(resStr);
        if (raw === "" || raw === "undefined" || raw === "null") {
            cb(null, "Premiere không trả về dữ liệu (hàm ExtendScript có thể chưa được nạp).");
            return;
        }
        if (raw.indexOf("EvalScript error") !== -1) {
            cb(null, "Lỗi ExtendScript: " + raw);
            return;
        }
        try {
            cb(JSON.parse(raw), null);
        } catch (e) {
            cb(null, "Không đọc được kết quả từ Premiere: " + raw.substring(0, 300));
        }
    });
}

// =========================================================================
// XUẤT XML
// =========================================================================
/**
 * Dựng lại cả hai nút XML từ một nguồn duy nhất là state.lastXmlPath.
 * Gom vào một chỗ để nút "Mở thư mục XML" không bao giờ hiện khi chưa có file,
 * và dấu tích không bị mất mỗi lần bật/tắt trạng thái nút.
 */
function renderXmlButtons(busy) {
    var btn = dom.btnExportXml, open = dom.btnOpenXmlDir;
    var done = !!state.lastXmlPath;

    if (btn) {
        btn.disabled = !!busy;
        if (busy) {
            btn.className = "btn-mini";
            btn.innerHTML = "<span>⏳ Đang xuất…</span>";
        } else if (done) {
            btn.className = "btn-mini is-done";
            btn.innerHTML = '<span>📄 Xuất XML</span><span class="btn-mini-check">✓</span>';
            btn.title = "Đã xuất: " + state.lastXmlPath + "\nBấm để xuất lại";
        } else {
            btn.className = "btn-mini";
            btn.innerHTML = "<span>📄 Xuất XML</span>";
            btn.title = "Xuất project đang mở ra file XML, đặt cùng thư mục và cùng tên với project";
        }
    }
    if (open) {
        open.style.display = (done && !busy) ? "inline-flex" : "none";
        open.disabled = !!busy;
        if (done) open.title = "Mở Explorer và chọn sẵn: " + state.lastXmlPath;
    }
}

/**
 * Xuất project đang mở ra file XML cùng thư mục, cùng tên với project.
 * force = true khi người dùng đã đồng ý ghi đè file XML có sẵn.
 */
function exportProjectXml(force) {
    if (state.isRunning) {
        showAlert("Đang bận", "Đợi quá trình Import &amp; Cắt hiện tại xong đã rồi hãy xuất XML.", "warning");
        return;
    }
    ensureOwnScript(function (own) {
        if (!own) return;
        renderXmlButtons(true);

        evalJson("cep_exportProjectXml(" + (force ? 1 : 0) + ")", function (res, err) {
            if (err) {
                renderXmlButtons(false);
                showAlert("Xuất XML thất bại", escapeHtml(err), "error");
                return;
            }
            if (res.needConfirm) {
                renderXmlButtons(false);
                showConfirm("File XML đã tồn tại",
                    "Đã có file này:<br><strong>" + escapeHtml(res.path) + "</strong><br><br>Ghi đè lên nó?",
                    "Ghi đè",
                    function (ok) { if (ok) exportProjectXml(true); });
                return;
            }
            if (!res.success) {
                renderXmlButtons(false);
                showAlert("Xuất XML thất bại", escapeHtml(res.error || "Không rõ nguyên nhân").replace(/\n/g, "<br>"), "error");
                addLog("error", "Xuất XML thất bại: " + (res.error || ""));
                return;
            }

            state.lastXmlPath = res.path;
            renderXmlButtons(false);
            var kb = Math.max(1, Math.round((res.size || 0) / 1024));
            addLog("success", "Đã xuất XML: " + res.path + " (" + kb + " KB)");
            showToast("Đã xuất XML", res.path);
        });
    });
}

/**
 * Mở Explorer ở thư mục chứa file XML vừa xuất.
 *
 * ĐÃ THỬ VÀ BỎ: nhờ CEP chạy `explorer /select,<file>` để bôi sẵn đúng file.
 * cep.process.createProcess() bọc tham số vào dấu nháy, explorer không hiểu
 * được cú pháp /select, nên nó mở đại thư mục Documents. Tệ hơn là lệnh vẫn
 * báo thành công nên không rơi sang đường dự phòng. Dùng thẳng ExtendScript.
 */
function openXmlFolder() {
    if (!state.lastXmlPath) return;

    evalJson("cep_revealInExplorer(" + toEscapedJson(state.lastXmlPath) + ")", function (res, err) {
        if (err) { showAlert("Không mở được thư mục", escapeHtml(err), "error"); return; }
        if (!res.success) {
            // File có thể đã bị xoá/di chuyển sau khi xuất -> trả nút về trạng thái ban đầu.
            state.lastXmlPath = "";
            renderXmlButtons(false);
            showAlert("Không mở được thư mục",
                escapeHtml(res.error || "Không rõ nguyên nhân").replace(/\n/g, "<br>"), "warning");
        }
    });
}

function copyAndRelinkFootage() {
    if (state.isRunning) {
        showAlert("Đang bận", "Vui lòng đợi quá trình Import &amp; Cắt hiện tại hoàn thành trước khi dùng tính năng này.", "warning");
        return;
    }

    ensureOwnScript(function (ok) { if (ok) askCopyAndRelink(); });
}

function askCopyAndRelink() {
    showConfirm("Copy & Relink Footage",
        "Tính năng này sẽ:\n\n" +
        "<strong>1.</strong> Copy tất cả video source đang dùng trong Timeline về thư mục <code>Footage/</code> cạnh file project.\n" +
        "<strong>2.</strong> Relink toàn bộ source cũ sang file vừa copy.\n\n" +
        "Premiere sẽ tạm đứng trong lúc copy — đó là bình thường, panel vẫn hiện % và tốc độ.",
        "Bắt đầu copy",
        function (ok) { if (ok) runCopyAndRelink(); });
}

function runCopyAndRelink() {
    hideToast();
    setRelinkBusy(true, "⏳ Đang quét Timeline...");
    addLog("info", "Bắt đầu Copy & Relink Footage...");

    dom.progressCard.style.display = "block";
    dom.progressStepText.textContent = "Copy & Relink Footage";
    dom.progressBarFill.style.width = "0%";
    dom.progressPercent.textContent = "0%";
    dom.currentActionText.textContent = "Đang quét source trên Timeline...";

    // Kiểm tra hostscript.jsx đã nạp bản mới chưa
    csInterface.evalScript("typeof cep_scanTimelineSources", function (t) {
        if (String(t).indexOf("function") === -1) {
            setRelinkBusy(false);
            dom.currentActionText.textContent = "Chưa nạp được script Copy & Relink";
            addLog("error", "Premiere đang chạy bản hostscript.jsx cũ (thiếu hàm cep_scanTimelineSources).");
            showAlert("Panel đang chạy script cũ", "Premiere vẫn giữ bản <code>hostscript.jsx</code> cũ trong bộ nhớ.\n\n<strong>Cách khắc phục:</strong>\n1. Đóng panel (Window › Extensions › bỏ chọn panel).\n2. Mở lại panel, hoặc khởi động lại Premiere Pro.\n\nSau đó bấm lại nút Copy &amp; Relink Footage.", "warning");
            return;
        }

        var config = { footageFolderName: "Footage" };
        evalJson("cep_scanTimelineSources(" + toEscapedJson(JSON.stringify(config)) + ")", function (res, err) {
            if (err) {
                setRelinkBusy(false);
                dom.currentActionText.textContent = "Quét Timeline thất bại";
                addLog("error", "Quét Timeline thất bại: " + err);
                showAlert("Không quét được Timeline", escapeHtml(String(err)), "error");
                return;
            }
            if (!res.success) {
                setRelinkBusy(false);
                dom.currentActionText.textContent = res.error || "Lỗi không xác định";
                addLog("error", "Copy & Relink thất bại: " + (res.error || "Lỗi không xác định"));
                showAlert("Copy & Relink thất bại", escapeHtml(String(res.error || "Lỗi không xác định")), "error");
                return;
            }

            if (res.warnings && res.warnings.length) {
                res.warnings.forEach(function (w) { addLog("warning", w); });
            }
            addLog("info", "Thư mục đích: " + res.footagePath);

            var files = res.files || [];
            if (files.length === 0) {
                setRelinkBusy(false);
                dom.progressBarFill.style.width = "100%";
                dom.progressPercent.textContent = "100%";
                var msg = (res.clipCount === 0)
                    ? "Timeline không có clip nào gắn với file media (kiểm tra lại Sequence đang mở)."
                    : "Tất cả " + res.skipCount + " source đã nằm sẵn trong Footage/ — không cần copy.";
                dom.currentActionText.textContent = msg;
                addLog(res.clipCount === 0 ? "warning" : "success", msg);
                showAlert(res.clipCount === 0 ? "Không có gì để copy" : "Không cần copy", escapeHtml(String(msg)), res.clipCount === 0 ? "warning" : "success");
                return;
            }

            var totalBytes = 0;
            for (var fi = 0; fi < files.length; fi++) totalBytes += (files[fi].sizeBytes || 0);

            state.relink = {
                files: files, idx: 0,
                copied: 0, relinked: 0, failed: 0,
                skipCount: res.skipCount || 0,
                footagePath: res.footagePath,
                errors: []
            };
            state.copyPlan = { totalBytes: totalBytes, doneBytes: 0 };
            state.copiedBytes = 0;

            addLog("info", "Tìm thấy " + files.length + " file cần copy (" + (res.skipCount || 0) + " file đã có trong Footage/)" +
                           (totalBytes > 0 ? (" — tổng " + formatBytes(totalBytes)) : "") + ".");
            startCopyMonitor();
            relinkNextFile();
        });
    });
}

function relinkNextFile() {
    var st = state.relink;
    if (!st) return;

    var total = st.files.length;
    if (st.idx >= total) {
        finishRelink();
        return;
    }

    var f = st.files[st.idx];
    // Thanh chính chạy theo dung lượng thật khi biết tổng, không thì theo số file
    var plan = state.copyPlan;
    var percent = (plan && plan.totalBytes > 0)
        ? Math.min(100, Math.round((plan.doneBytes / plan.totalBytes) * 100))
        : Math.round((st.idx / total) * 100);
    dom.progressBarFill.style.width = percent + "%";
    dom.progressPercent.textContent = percent + "%";
    dom.progressStepText.textContent = "Copy & Relink " + (st.idx + 1) + " / " + total + " file";
    dom.currentActionText.textContent = "Đang copy: " + f.name + (f.sizeMB ? " (" + f.sizeMB + " MB)" : "");
    setRelinkBusy(true, "⏳ " + (st.idx + 1) + "/" + total);

    // setTimeout để giao diện kịp vẽ trước khi ExtendScript copy (thao tác này khoá Premiere)
    setTimeout(function () {
        evalJson("cep_copyRelinkOne(" + JSON.stringify(String(st.idx)) + ")", function (res, err) {
            if (err) {
                st.failed++;
                st.errors.push(f.name + ": " + err);
                addLog("error", f.name + ": " + err);
            } else if (!res.success) {
                st.failed++;
                st.errors.push(res.error || "Lỗi không xác định");
                addLog("error", res.error || ("Lỗi không xác định với " + f.name));
            } else {
                if (res.copied) st.copied++;
                if (res.relinked) st.relinked += res.relinked;
                if (res.note) addLog("warning", f.name + ": " + res.note);
                if (res.error) addLog("warning", f.name + ": " + res.error);
                else addLog("success", f.name + (res.copied ? " → đã copy" : " → đã có sẵn") + ", relink " + res.relinked + " source");
            }
            // File này xong (copy được hay bỏ qua) -> cộng vào tổng để tính % tổng
            if (state.copyPlan) state.copyPlan.doneBytes += (f.sizeBytes || 0);
            st.idx++;
            setTimeout(relinkNextFile, 20);
        });
    }, 30);
}

function finishRelink() {
    var st = state.relink;
    CopyMonitor.stop();
    state.copyPlan = null;
    dom.progressBarFill.style.width = "100%";
    dom.progressPercent.textContent = "100%";
    dom.progressStepText.textContent = "Hoàn thành Copy & Relink";
    dom.currentActionText.textContent = "Đã copy " + st.copied + " file, relink " + st.relinked + " source.";
    setRelinkBusy(false);

    addLog("info", "--- COPY & RELINK: copy " + st.copied + " file | relink " + st.relinked + " source | bỏ qua " + st.skipCount + " file đã có | lỗi " + st.failed + " ---");
    notifyDone("Đã xong Copy & Relink!",
        "Đã copy " + st.copied + " file · relink " + st.relinked + " source\n" +
        "Bỏ qua (đã có trong Footage/): " + st.skipCount + " file · Lỗi: " + st.failed +
        (st.footagePath ? ("\n" + st.footagePath) : ""));
    state.relink = null;
}

function updateStatsUI() {
    dom.statClips.textContent = state.stats.clips;
    dom.statCopied.textContent = state.stats.copied + state.stats.downloaded;
    dom.statWarning.textContent = state.stats.warning;
    dom.statError.textContent = state.stats.error;
}

function addLog(type, text) {
    var timeStr = new Date().toTimeString().split(" ")[0];
    state.logs.push({ type: type, text: text, time: timeStr });
    renderLogs();
}

function renderLogs() {
    var filtered = state.logs.filter(function (log) {
        if (state.currentFilter === "all") return true;
        return log.type === state.currentFilter;
    });

    if (filtered.length === 0) {
        dom.logList.innerHTML = '<div class="log-empty">Chưa có nhật ký hoạt động</div>';
        return;
    }

    var html = "";
    filtered.forEach(function (log) {
        var badgeClass = "badge-info";
        var badgeText = "INFO";
        if (log.type === "success") { badgeClass = "badge-success"; badgeText = "OK"; }
        else if (log.type === "warning") { badgeClass = "badge-warning"; badgeText = "WARN"; }
        else if (log.type === "error") { badgeClass = "badge-error"; badgeText = "ERR"; }

        html += '<div class="log-item">' +
            '<span class="log-badge ' + badgeClass + '">' + badgeText + '</span>' +
            '<span class="log-text">[' + log.time + '] ' + escapeHtml(log.text) + '</span>' +
            '</div>';
    });

    dom.logList.innerHTML = html;
    dom.logList.scrollTop = dom.logList.scrollHeight;
    updateLogVisibility();
}

function updateLogVisibility() {
    var logCard = dom.logList ? dom.logList.parentNode : null;
    if (!logCard) return;
    logCard.classList.toggle("log-collapsed", !state.logExpanded);
    if (dom.logToggle) dom.logToggle.textContent = state.logExpanded ? "Thu gọn" : "Xem thêm";
}

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// =========================================================================
// AI SETUP & HELPERS
// =========================================================================

function setupAI() {
    // Restore saved API key (masked)
    var savedKey = GeminiAPI.getKey();
    if (savedKey && dom.txtGeminiKey) {
        dom.txtGeminiKey.value = savedKey;
    }
    updateAiStatus();

    // Save button
    if (dom.btnAiSave) {
        dom.btnAiSave.addEventListener("click", function () {
            var key = dom.txtGeminiKey ? dom.txtGeminiKey.value.trim() : "";
            if (!key) {
                showAlert("Ch\u01b0a c\u00f3 API Key", "Vui l\u00f2ng nh\u1eadp Gemini API Key tr\u01b0\u1edbc khi l\u01b0u.", "warning");
                return;
            }
            GeminiAPI.saveKey(key);
            updateAiStatus();
            dom.btnAiSave.textContent = "\u2713 Đ\u00e3 l\u01b0u";
            setTimeout(function () { dom.btnAiSave.textContent = "\ud83d\udcbe L\u01b0u Key"; }, 1500);
        });
    }

    // Mở popup cài đặt API
    if (dom.btnOpenApi) {
        dom.btnOpenApi.addEventListener("click", function () {
            if (!dom.apiModalOverlay) return;
            dom.apiModalOverlay.classList.add("visible");
            if (dom.txtGeminiKey) dom.txtGeminiKey.focus();
        });
    }
    // Đóng popup
    if (dom.btnApiModalClose) {
        dom.btnApiModalClose.addEventListener("click", closeApiModal);
    }
    if (dom.apiModalOverlay) {
        dom.apiModalOverlay.addEventListener("click", function (e) {
            if (e.target === dom.apiModalOverlay) closeApiModal();
        });
    }
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeApiModal();
    });
}

function closeApiModal() {
    if (dom.apiModalOverlay) dom.apiModalOverlay.classList.remove("visible");
}

function updateAiStatus() {
    var active = GeminiAPI.hasKey();
    if (dom.aiStatusBadge) {
        dom.aiStatusBadge.textContent = active ? "\u2728 Đ\u00e3 k\u00edch ho\u1ea1t" : "Ch\u01b0a k\u00edch ho\u1ea1t";
        if (active) dom.aiStatusBadge.classList.add("active");
        else dom.aiStatusBadge.classList.remove("active");
    }
    // Chấm trạng thái trên nút API ở header
    if (dom.apiBtnDot) {
        if (active) dom.apiBtnDot.classList.add("active");
        else dom.apiBtnDot.classList.remove("active");
    }
    if (dom.btnOpenApi) {
        dom.btnOpenApi.title = active ? "Gemini API đã kích hoạt — bấm để đổi key" : "Chưa có Gemini API Key — bấm để cài đặt";
    }
}

/**
 * Extract a single cell value from a raw CSV line by column index.
 * Handles quoted fields.
 */
function extractCsvCell(line, colIdx) {
    if (!line) return "";
    var fields = [], field = "", inQ = false, i = 0;
    while (i < line.length) {
        var c = line.charAt(i);
        if (inQ) {
            if (c === '"' && line.charAt(i+1) === '"') { field += '"'; i += 2; continue; }
            if (c === '"') { inQ = false; i++; continue; }
            field += c; i++;
        } else {
            if (c === '"') { inQ = true; i++; continue; }
            if (c === ',') { fields.push(field); field = ""; i++; continue; }
            field += c; i++;
        }
    }
    fields.push(field);
    return colIdx < fields.length ? fields[colIdx] : "";
}
