/**
 * app.js - Client-side Controller for Import & Cut by Timecode CEP Extension
 */

var csInterface = new CSInterface();
(function () {
    var _origEvalScript = csInterface.evalScript.bind(csInterface);
    csInterface.evalScript = function (script, callback) {
        var s = String(script || "");
        if (s.indexOf("$.fileName") === -1 && s.indexOf("$.evalFile") === -1) {
            s = "with ($.global.AIC_V3 || {}) { " + s + " }";
        }
        return _origEvalScript(s, callback);
    };
})();

// ============================================================================
// PHIÊN BẢN - phải KHỚP với IMPORTCUT_VERSION trong jsx/hostscript.jsx
// Đây là 1 trong 2 chỗ duy nhất ghi số phiên bản (chỗ còn lại là hostscript.jsx).
// Badge trên header và tiêu đề Changelog đều lấy từ đây, không ghi tay trong HTML.
// Định dạng: MAJOR.MINOR.PATCH - MAJOR = đổi dòng sản phẩm (V2 -> V3).
// ============================================================================
var APP_VERSION = "3.1.3";

// Nhãn ngắn hiển thị trên badge: "2.0.0" -> "V2"
function versionMajorLabel(v) { return "V" + String(v).split(".")[0]; }

/**
 * Premiere chỉ có MỘT bộ máy ExtendScript dùng chung: nếu mở đồng thời panel bản khác,
 * script của panel nạp sau sẽ ghi đè và panel này sẽ chạy nhầm code. Chặn trước khi làm việc nặng.
 * Cũng bắt được trường hợp file .jsx đã cập nhật nhưng chưa được nạp lại.
 */
function ensureOwnScript(cb) {
    csInterface.evalScript("(function(){ try { return ($.global.AIC_V3 && $.global.AIC_V3.IMPORTCUT_VERSION) ? $.global.AIC_V3.IMPORTCUT_VERSION : ''; } catch(e) { return ''; } })()", function (b) {
        var loaded = String(b === undefined || b === null ? "" : b).replace(/^"|"$/g, "");
        if (loaded === "" || loaded === APP_VERSION) { cb(true); return; }
        var sameMajor = (versionMajorLabel(loaded) === versionMajorLabel(APP_VERSION));

        if (loaded.indexOf("EvalScript error") !== -1) {
            showAlert("Lỗi nạp script ExtendScript",
                "Premiere Pro gặp lỗi khi kiểm tra phiên bản ExtendScript (EvalScript error).\n\n" +
                "<strong>Cách xử lý:</strong> Hãy đóng panel và mở lại (hoặc khởi động lại Premiere Pro) để nạp lại script.", "warning");
        } else if (sameMajor) {
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
    ,envatoFiles: {}
    ,footageFolderPath: ""
    ,mediaTypeEnabled: { nas: true, envato: true, youtube: true }
    ,convertedFiles: {}
    ,trimmedFiles: {}
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
            "sourceCol — thư mục chứa video của source chính: \\\\server\\..., D:\\..., hoặc link http/https (ví dụ link Envato).\n" +
            "          ĐẶT -1 nếu cột file đã chứa sẵn ĐƯỜNG DẪN ĐẦY ĐỦ tới file (kể cả khi ô có dấu nháy bao quanh).\n" +
            "          LƯU Ý: Nếu một nhóm chỉ có 1 cột media duy nhất chứa link Envato (https://app.envato.com/... hoặc https://elements.envato.com/...) hoặc đường dẫn folder (không có cột mã file riêng), hãy đặt cả sourceCol và codeCol cùng trỏ vào cột đó.\n" +
            "codeCol — mã hoặc tên file: C0682, DJI_20260818150455_0052_D, GH010234, GOPR0001,\n" +
            "          hoặc tên file đầy đủ 'C0704.MP4', cả đường dẫn đầy đủ tới file, hoặc link video Envato/YouTube.\n" +
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
            "- Chuẩn hóa đường dẫn: bỏ dấu nháy thừa, dùng dấu gạch chéo ngược cho đường dẫn Windows, không đổi nội dung đường dẫn. TUYỆT ĐỐI giữ nguyên dấu '/' cho các đường link URL http:// hoặc https:// (ví dụ link Envato).\n" +
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
    chkSmartTrimCopy: document.getElementById("chkSmartTrimCopy"),
    txtTrimThresholdGB: document.getElementById("txtTrimThresholdGB"),
    txtTrimPadSec: document.getElementById("txtTrimPadSec"),
    chkTram: document.getElementById("chkTram"),
    chkLabel: document.getElementById("chkLabel"),
    txtDefaultSec: document.getElementById("txtDefaultSec"),
    chkSingleTime: document.getElementById("chkSingleTime"),
    radioSingleAfter: document.getElementById("radioSingleAfter"),
    radioSingleBefore: document.getElementById("radioSingleBefore"),
    txtSingleTimeAfterSec: document.getElementById("txtSingleTimeAfterSec"),
    txtSingleTimeSec: document.getElementById("txtSingleTimeSec"),
    radioCenterTime: document.getElementById("radioCenterTime"),
    radioFullVideo: document.getElementById("radioFullVideo"),
    txtCenterTimeSec: document.getElementById("txtCenterTimeSec"),
    txtFolderRandomCount: document.getElementById("txtFolderRandomCount"),
    txtFolderRandomDuration: document.getElementById("txtFolderRandomDuration"),

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
    btnEnvatoAuth: document.getElementById("btnEnvatoAuth"),
    envatoBtnDot: document.getElementById("envatoBtnDot"),
    envatoBtnText: document.getElementById("envatoBtnText"),
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
    ,configCard: document.getElementById("configCard")
    ,configToggle: document.getElementById("configToggle")
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
        progressPath = p ? String(p).replace(/[\\\/]+$/, "") + "/autoimportcut_v3_copy_progress.json" : "";
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

    function parseRobocopyPercent(logPath) {
        if (!logPath) return -1;
        var txt = readText(logPath);
        if (!txt) return -1;
        var re = /(\d+(?:\.\d+)?)\s*%/g;
        var m, lastPct = -1;
        while ((m = re.exec(txt)) !== null) {
            var v = parseFloat(m[1]);
            if (!isNaN(v) && v >= 0 && v <= 100) lastPct = v;
        }
        return lastPct;
    }

    function tick() {
        if ((typeof FastCopy !== "undefined" && FastCopy.isBusy()) ||
            (typeof SidecarClient !== "undefined" && SidecarClient.isBusy && SidecarClient.isBusy()) ||
            (typeof EnvatoDownloader !== "undefined" && EnvatoDownloader.isBusy && EnvatoDownloader.isBusy())) {
            return;
        }

        var st = readState();
        if (!st || st.state !== "copying" || !st.dest) {
            // Chỉ ẩn thanh tiến độ khi chính CopyMonitor vừa kết thúc 1 file (tránh gọi hideCopyProgress liên tục mỗi 200ms gây chớp giao diện)
            if (last.name !== "") {
                state.copiedBytes += (last.fileTotal > 0 ? last.fileTotal : last.bytes);
                last.name = "";
                hideCopyProgress(false);
            }
            return;
        }

        // Ưu tiên đọc % thật từ log robocopy (vì NTFS pre-allocate kích thước file đích ngay từ 0ms)
        var bytes = 0;
        if (st.roboLog && st.total > 0) {
            var pct = parseRobocopyPercent(st.roboLog);
            if (pct >= 0) bytes = Math.round((st.total * pct) / 100);
        } else if (st.byScript && typeof st.copied === "number") {
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
        } else if (now - last.time >= 200) {
            var inst = (bytes - last.bytes) / ((now - last.time) / 1000);
            if (inst < 0) inst = 0;
            if (bytes > last.bytes) {
                last.speed = last.speed ? (last.speed * 0.5 + inst * 0.5) : inst;
                last.bytes = bytes;
                last.time = now;
            } else if (now - last.time >= 1500) {
                last.speed = last.speed * 0.7;
                last.time = now;
            }
        }

        showCopyProgress(st.name, last.bytes, st.total, last.speed);
    }

    function start() {
        if (timer) return;
        if (!hasFsAccess() || !progressPath) return;
        reset();
        timer = setInterval(tick, 200);
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        reset();
        hideCopyProgress(true);
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
 * FastCopy: Copy file tốc độ cao bằng Node.js + robocopy.exe chạy ngầm (windowsHide: true).
 * - Không qua PowerShell (tiết kiệm 1.5–2s khởi động mỗi file).
 * - Không dùng /J unbuffered I/O (tận dụng tối đa Windows System Cache giống hệt Explorer).
 * - Không khoá luồng ExtendScript của Premiere Pro trong lúc copy.
 * - Đọc trực tiếp phần trăm tiến độ thật từ stdout của robocopy để hiển thị đúng % và MB/s.
 */
var FastCopy = (function () {
    var nodeFs = null, nodePath = null, nodeCp = null;
    try {
        var req = (typeof require === "function") ? require :
                  (window.cep_node && window.cep_node.require ? window.cep_node.require : null);
        if (req) {
            nodeFs = req("fs");
            nodePath = req("path");
            nodeCp = req("child_process");
        }
    } catch (e) {}

    var activeProc = null;
    var activeDestPath = "";
    var cancelled = false;

    function isAvailable() {
        return !!(nodeFs && nodePath && nodeCp && typeof nodeCp.spawn === "function");
    }

    function isBusy() {
        return !!activeProc;
    }

    function cleanRoboDir(d) {
        var s = String(d).replace(/\//g, "\\").replace(/\\+$/, "");
        if (/^[A-Za-z]:$/.test(s)) return s + "\\.";
        return s;
    }

    function statSize(p) {
        try {
            var st = nodeFs.statSync(p);
            return (st && typeof st.size === "number") ? st.size : -1;
        } catch (e) { return -1; }
    }

    function cancel() {
        cancelled = true;
        if (activeProc) {
            var pid = activeProc.pid;
            try { activeProc.kill(); } catch (e1) {}
            if (pid && nodeCp) {
                try { nodeCp.spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch (e2) {}
            }
            activeProc = null;
        }
        if (activeDestPath && nodeFs) {
            try { if (nodeFs.existsSync(activeDestPath)) nodeFs.unlinkSync(activeDestPath); } catch (e3) {}
            activeDestPath = "";
        }
        hideCopyProgress();
    }

    function copyFile(srcPath, destPath, knownSize, cb) {
        if (!isAvailable()) {
            cb({ ok: false, error: "Node.js không khả dụng" });
            return;
        }
        cancelled = false;
        var srcWin = String(srcPath).replace(/\//g, "\\");
        var dstWin = String(destPath).replace(/\//g, "\\");

        var total = (typeof knownSize === "number" && knownSize > 0) ? knownSize : statSize(srcWin);
        if (total < 0) {
            cb({ ok: false, error: "Không tìm thấy file nguồn: " + srcWin });
            return;
        }

        // Nếu file đích đã tồn tại và đúng dung lượng thì bỏ qua ngay lập tức
        var existingSize = statSize(dstWin);
        if (existingSize >= 0 && (total === 0 || existingSize === total)) {
            cb({ ok: true, copied: false, skipped: true, bytes: total });
            return;
        }

        var srcDir = nodePath.dirname(srcWin);
        var srcName = nodePath.basename(srcWin);
        var dstDir = nodePath.dirname(dstWin);
        var dstName = nodePath.basename(dstWin);

        try {
            if (!nodeFs.existsSync(dstDir)) nodeFs.mkdirSync(dstDir, { recursive: true });
        } catch (eMk) {}

        var startTime = Date.now();
        var lastTime = startTime;
        var lastBytes = 0;
        var lastSpeed = 0;
        activeDestPath = dstWin;
        showCopyProgress(dstName, 0, total, 0);

        function fallbackNodeCopy(reason) {
            if (cancelled) {
                cb({ ok: false, cancelled: true, error: "Đã huỷ" });
                return;
            }
            try {
                nodeFs.copyFile(srcWin, dstWin, function (err) {
                    activeDestPath = "";
                    if (cancelled) {
                        try { if (nodeFs.existsSync(dstWin)) nodeFs.unlinkSync(dstWin); } catch (eU) {}
                        hideCopyProgress();
                        cb({ ok: false, cancelled: true, error: "Đã huỷ" });
                        return;
                    }
                    if (err) {
                        hideCopyProgress();
                        cb({ ok: false, error: (reason ? reason + " | " : "") + err.message });
                        return;
                    }
                    var finalSz = statSize(dstWin);
                    if (total > 0 && finalSz !== total) {
                        hideCopyProgress();
                        cb({ ok: false, error: "File copy không đủ dung lượng (" + finalSz + "/" + total + ")" });
                        return;
                    }
                    var elapsedSec = Math.max(0.05, (Date.now() - startTime) / 1000);
                    showCopyProgress(dstName, total, total, total / elapsedSec);
                    state.copiedBytes += total;
                    hideCopyProgress(false);
                    cb({ ok: true, copied: true, bytes: total });
                });
            } catch (eCp) {
                activeDestPath = "";
                hideCopyProgress();
                cb({ ok: false, error: eCp.message || String(eCp) });
            }
        }

        // Nếu file nhỏ (< 1 MB) hoặc đổi tên file đích thì dùng luôn fs.copyFile của Node.js (libuv native CopyFileExW)
        if (total < 1048576 || srcName.toLowerCase() !== dstName.toLowerCase()) {
            fallbackNodeCopy("");
            return;
        }

        var args = [
            cleanRoboDir(srcDir),
            cleanRoboDir(dstDir),
            srcName,
            "/NJH", "/NJS", "/NDL", "/NC", "/NS", "/R:1", "/W:1"
        ];

        var proc;
        try {
            proc = nodeCp.spawn("robocopy.exe", args, { windowsHide: true });
        } catch (eSp) {
            fallbackNodeCopy("spawn robocopy lỗi: " + eSp.message);
            return;
        }
        activeProc = proc;

        if (proc.stdout) {
            proc.stdout.on("data", function (chunk) {
                if (cancelled) return;
                var s = chunk.toString();
                var re = /(\d+(?:\.\d+)?)\s*%/g;
                var m, maxPct = -1;
                while ((m = re.exec(s)) !== null) {
                    var v = parseFloat(m[1]);
                    if (!isNaN(v) && v >= 0 && v <= 100) maxPct = v;
                }
                if (maxPct >= 0 && total > 0) {
                    var curBytes = Math.round((total * maxPct) / 100);
                    var now = Date.now();
                    var dt = (now - lastTime) / 1000;
                    if (dt >= 0.12 && curBytes > lastBytes) {
                        var inst = (curBytes - lastBytes) / dt;
                        lastSpeed = lastSpeed ? (lastSpeed * 0.45 + inst * 0.55) : inst;
                        lastBytes = curBytes;
                        lastTime = now;
                    } else if (lastSpeed === 0 && now > startTime) {
                        lastSpeed = curBytes / ((now - startTime) / 1000);
                    }
                    showCopyProgress(dstName, curBytes, total, lastSpeed);
                }
            });
        }

        var finished = false;
        function onDone(code, errObj) {
            if (finished) return;
            finished = true;
            activeProc = null;
            if (cancelled) {
                try { if (nodeFs.existsSync(dstWin)) nodeFs.unlinkSync(dstWin); } catch (eU) {}
                activeDestPath = "";
                hideCopyProgress();
                cb({ ok: false, cancelled: true, error: "Đã huỷ" });
                return;
            }
            var dstSz = statSize(dstWin);
            var ok = (!errObj && typeof code === "number" && code < 8 && dstSz >= 0 && (total === 0 || dstSz === total));
            if (ok) {
                activeDestPath = "";
                var elapsed = Math.max(0.05, (Date.now() - startTime) / 1000);
                var spd = lastSpeed > 0 ? lastSpeed : (total / elapsed);
                showCopyProgress(dstName, total, total, spd);
                state.copiedBytes += total;
                hideCopyProgress(false);
                cb({ ok: true, copied: true, bytes: total });
            } else {
                fallbackNodeCopy("robocopy exit=" + code);
            }
        }

        proc.on("error", function (err) { onDone(-1, err); });
        proc.on("close", function (code) { onDone(code, null); });
    }

    function copyBatch(items, onStep, cb) {
        var idx = 0, copiedCount = 0, errors = [];
        function next() {
            if (cancelled || state.shouldCancel) {
                cb({ ok: false, cancelled: true, copiedCount: copiedCount, errors: errors });
                return;
            }
            if (idx >= items.length) {
                cb({ ok: true, copiedCount: copiedCount, errors: errors });
                return;
            }
            var item = items[idx];
            if (onStep) onStep(item, idx, items.length);
            copyFile(item.srcPath, item.destPath, item.sizeBytes || 0, function (res) {
                if (res.cancelled) {
                    cb({ ok: false, cancelled: true, copiedCount: copiedCount, errors: errors });
                    return;
                }
                if (!res.ok) {
                    errors.push((item.name || item.srcPath) + ": " + res.error);
                } else if (res.copied) {
                    copiedCount++;
                }
                idx++;
                next();
            });
        }
        next();
    }

    return {
        isAvailable: isAvailable,
        isBusy: isBusy,
        copyFile: copyFile,
        copyBatch: copyBatch,
        cancel: cancel
    };
})();

/**
 * EnvatoDownloader: Tải video stock từ Envato (app.envato.com & elements.envato.com)
 * bằng trình duyệt Chrome/Edge thật với profile cố định + Chrome DevTools Protocol (CDP).
 *
 * Cơ chế an toàn chống khoá tài khoản cá nhân:
 *   1. Dùng trình duyệt Chrome/Edge thật (fingerprint TLS/JA3 chuẩn, lưu cookie đăng nhập cố định).
 *   2. Bắt buộc kiểm tra đã đăng nhập tài khoản Envato trước khi cho phép tải.
 *   3. Ưu tiên chọn định dạng chất lượng cao nhất (4K / Original).
 *   4. Tải tuần tự từng file (1-by-1) kèm độ trễ ngẫu nhiên 3.5–6.5 giây giữa các lần tải.
 *   5. Lưu cache thông minh tại Footage/envato_<id>.<ext> + .envato_cache.json để không bao giờ tải trùng.
 *   6. Circuit breaker: tự động dừng ngay nếu phát hiện mất phiên đăng nhập hoặc giới hạn từ Envato.
 */
var EnvatoDownloader = (function () {
    var nodeFs = null, nodePath = null, nodeCp = null, nodeHttp = null, nodeCrypto = null;
    try {
        var req = (typeof require === "function") ? require :
                  (window.cep_node && window.cep_node.require ? window.cep_node.require : null);
        if (req) {
            nodeFs = req("fs");
            nodePath = req("path");
            nodeCp = req("child_process");
            nodeHttp = req("http");
            nodeCrypto = req("crypto");
        }
    } catch (e) {}

    var DEBUG_PORT = 9296;
    var LS_ENVATO_AUTH = "autoimportcut_v2_envato_auth";
    var LS_ENVATO_USER = "autoimportcut_v2_envato_user";
    var loggedInState = false;
    var loggedInUser = "";
    var lastDownloadFinishedAt = 0;
    var cancelled = false;
    var loginPollTimer = null;
    var activeTimer = null;
    var activeCdp = null;
    var browserMode = ""; // "headless" | "visible"

    try {
        loggedInState = (localStorage.getItem(LS_ENVATO_AUTH) === "1");
        loggedInUser = localStorage.getItem(LS_ENVATO_USER) || "";
    } catch (eLs) {}

    function isAvailable() {
        return !!(nodeFs && nodePath && nodeCp && nodeHttp && nodeCrypto && findBrowserExe());
    }

    function findBrowserExe() {
        if (!nodeFs) return "";
        var localAppData = (typeof process !== "undefined" && process.env && process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : "";
        var candidates = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            localAppData ? (localAppData + "\\Google\\Chrome\\Application\\chrome.exe") : "",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i] && nodeFs.existsSync(candidates[i])) return candidates[i];
        }
        return "";
    }

    function getProfileDir() {
        var base = (typeof process !== "undefined" && process.env)
            ? (process.env.LOCALAPPDATA || process.env.APPDATA || "C:\\Temp")
            : "C:\\Temp";
        var dir = nodePath.join(base, "AutoImportCutV3", "EnvatoBrowserProfile");
        try {
            if (!nodeFs.existsSync(dir)) {
                nodeFs.mkdirSync(dir, { recursive: true });
                var v2Dir = nodePath.join(base, "AutoImportCutV2", "EnvatoBrowserProfile");
                if (nodeFs.existsSync(v2Dir) && nodeCp && typeof nodeCp.spawnSync === "function") {
                    try { nodeCp.spawnSync("robocopy.exe", [v2Dir, dir, "/E", "/R:0", "/W:0", "/NFL", "/NDL", "/NJH", "/NJS"], { windowsHide: true, timeout: 8000 }); } catch (eCp) {}
                }
            }
        } catch (e) {}
        return dir;
    }

    function setLoggedIn(status, userLabel) {
        loggedInState = !!status;
        loggedInUser = status ? (userLabel || loggedInUser || "Đã đăng nhập") : "";
        try {
            if (loggedInState) {
                localStorage.setItem(LS_ENVATO_AUTH, "1");
                localStorage.setItem(LS_ENVATO_USER, loggedInUser);
            } else {
                localStorage.removeItem(LS_ENVATO_AUTH);
                localStorage.removeItem(LS_ENVATO_USER);
            }
        } catch (e) {}
        updateEnvatoAuthUI();
    }

    function getEnvatoItemKey(url) {
        if (!url) return "item";
        var clean = String(url).trim().split("?")[0].split("#")[0].replace(/\/+$/, "");
        var mUuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(clean);
        if (mUuid) return mUuid[1].toLowerCase();
        var mCode = /-([A-Z0-9]{6,12})$/i.exec(clean);
        if (mCode) return mCode[1].toUpperCase();
        var lastSeg = clean.substring(clean.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9_-]/g, "_");
        return lastSeg || "item";
    }

    function readCacheMap(footageDir) {
        if (!nodeFs || !footageDir) return {};
        try {
            var p = nodePath.join(footageDir, ".envato_cache.json");
            if (nodeFs.existsSync(p)) {
                return JSON.parse(nodeFs.readFileSync(p, "utf8")) || {};
            }
        } catch (e) {}
        return {};
    }

    function saveCacheMap(footageDir, mapUpdater) {
        if (!nodeFs || !footageDir) return;
        try {
            var map = readCacheMap(footageDir);
            mapUpdater(map);
            var p = nodePath.join(footageDir, ".envato_cache.json");
            nodeFs.writeFileSync(p, JSON.stringify(map, null, 2), "utf8");
        } catch (e) {}
    }

    function statFileSize(p) {
        try {
            var st = nodeFs.statSync(p);
            return (st && st.isFile() && st.size > 0) ? st.size : -1;
        } catch (e) { return -1; }
    }

    function findLocalCachedFile(footageDir, urlOrKey) {
        if (!nodeFs || !footageDir || !urlOrKey) return "";
        var key = getEnvatoItemKey(urlOrKey);
        if (state.envatoFiles && (state.envatoFiles[urlOrKey] || state.envatoFiles[key])) {
            var memPath = state.envatoFiles[urlOrKey] || state.envatoFiles[key];
            if (statFileSize(memPath) > 0) return memPath;
        }
        var cacheMap = readCacheMap(footageDir);
        var rel = cacheMap[urlOrKey] || cacheMap[key] || cacheMap[key.toLowerCase()];
        if (rel) {
            var mappedFull = nodePath.join(footageDir, rel);
            if (statFileSize(mappedFull) > 0) return mappedFull;
        }
        var exts = ["mp4", "mov", "m4v", "webm", "mkv"];
        for (var i = 0; i < exts.length; i++) {
            var cand = nodePath.join(footageDir, "envato_" + key + "." + exts[i]);
            if (statFileSize(cand) > 0) return cand;
        }
        return "";
    }

    function httpGetJson(url, timeoutMs, cb) {
        var done = false;
        function finish(err, data) {
            if (done) return;
            done = true;
            cb(err, data);
        }
        try {
            var req = nodeHttp.get(url, function (res) {
                var body = "";
                res.on("data", function (chunk) { body += chunk; });
                res.on("end", function () {
                    try { finish(null, JSON.parse(body)); }
                    catch (eP) { finish(eP, null); }
                });
            });
            req.on("error", function (err) { finish(err, null); });
            req.setTimeout(timeoutMs || 2000, function () {
                try { req.destroy(); } catch (eD) {}
                finish(new Error("Timeout"), null);
            });
        } catch (e) {
            finish(e, null);
        }
    }

    function findEnvatoTarget(targets) {
        if (!Array.isArray(targets)) return null;
        var pageTargets = targets.filter(function (t) {
            if (!t || t.type !== "page" || !t.webSocketDebuggerUrl) return false;
            var u = String(t.url || "").toLowerCase();
            if (u.indexOf("chrome://") === 0 || u.indexOf("edge://") === 0 || u.indexOf("devtools://") === 0 || u.indexOf("chrome-extension://") === 0) {
                return false;
            }
            return true;
        });
        for (var i = 0; i < pageTargets.length; i++) {
            if ((pageTargets[i].url || "").indexOf("app.envato.com") !== -1) return pageTargets[i];
        }
        for (var j = 0; j < pageTargets.length; j++) {
            if ((pageTargets[j].url || "").indexOf("envato.com") !== -1) return pageTargets[j];
        }
        return pageTargets[0] || null;
    }

    function closeBrowserInstance(cb) {
        httpGetJson("http://127.0.0.1:" + DEBUG_PORT + "/json", 800, function (err, targets) {
            if (err || !Array.isArray(targets) || targets.length === 0) {
                browserMode = "";
                if (cb) cb();
                return;
            }
            var tgt = findEnvatoTarget(targets) || targets[0];
            if (!tgt || !tgt.webSocketDebuggerUrl) {
                browserMode = "";
                if (cb) cb();
                return;
            }
            connectCdp(tgt.webSocketDebuggerUrl, function (cErr, cdp) {
                if (!cErr && cdp) {
                    cdp.send("Browser.close", {}, function () {
                        cdp.close();
                        browserMode = "";
                        setTimeout(function () { if (cb) cb(); }, 700);
                    });
                } else {
                    browserMode = "";
                    if (cb) cb();
                }
            });
        });
    }

    function ensureBrowserAndTarget(startUrl, allowSpawn, cb, needVisible) {
        if (!isAvailable()) {
            cb(new Error("Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy"), null);
            return;
        }
        var wantMode = needVisible ? "visible" : "headless";

        function checkOrSpawn() {
            httpGetJson("http://127.0.0.1:" + DEBUG_PORT + "/json", 1200, function (err, targets) {
                if (!err && Array.isArray(targets)) {
                    // Nếu đang cần mở cửa sổ hiện hình (để user đăng nhập) mà trình duyệt đang chạy ngầm headless (hoặc ngược lại), đóng để mở lại đúng chế độ
                    if ((needVisible && browserMode !== "visible") || (!needVisible && browserMode === "visible")) {
                        closeBrowserInstance(function () {
                            spawnBrowser();
                        });
                        return;
                    }
                    if (!browserMode) browserMode = wantMode;
                    var existing = findEnvatoTarget(targets);
                    if (existing) { cb(null, existing); return; }
                    httpGetJson("http://127.0.0.1:" + DEBUG_PORT + "/json/new?" + encodeURIComponent(startUrl || "https://app.envato.com/"), 2000, function (errNew, newTab) {
                        if (!errNew && newTab && newTab.webSocketDebuggerUrl) cb(null, newTab);
                        else cb(new Error("Không mở được tab mới trong trình duyệt Envato"), null);
                    });
                    return;
                }
                if (!allowSpawn) {
                    cb(new Error("Trình duyệt Envato chưa mở"), null);
                    return;
                }
                spawnBrowser();
            });
        }

        function spawnBrowser() {
            var exe = findBrowserExe();
            var profileDir = getProfileDir();
            var args = [
                "--user-data-dir=" + profileDir,
                "--remote-debugging-port=" + DEBUG_PORT,
                "--remote-allow-origins=*",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-blink-features=AutomationControlled"
            ];
            if (!needVisible) {
                // Chạy ngầm 100% không hiện cửa sổ hay icon dưới thanh Taskbar
                args.push("--headless=new");
                args.push("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
                args.push("--window-size=1440,900");
                args.push("--mute-audio");
                args.push(startUrl || "https://app.envato.com/");
            } else {
                // Chỉ mở cửa sổ gọn gàng khi người dùng bấm nút Đăng nhập Envato
                args.push("--window-size=1100,760");
                args.push("--app=" + (startUrl || "https://app.envato.com/"));
            }
            try {
                var child = nodeCp.spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: !needVisible });
                if (child && child.unref) child.unref();
                browserMode = wantMode;
            } catch (eSpawn) {
                cb(eSpawn, null);
                return;
            }

            var attempts = 0;
            function pollReady() {
                attempts++;
                httpGetJson("http://127.0.0.1:" + DEBUG_PORT + "/json", 1200, function (e2, tList) {
                    if (!e2 && Array.isArray(tList)) {
                        var tgt = findEnvatoTarget(tList);
                        if (tgt) { cb(null, tgt); return; }
                    }
                    if (attempts >= 30) {
                        cb(new Error("Quá thời gian chờ khởi động trình duyệt Chrome/Edge"), null);
                        return;
                    }
                    setTimeout(pollReady, 450);
                });
            }
            setTimeout(pollReady, 600);
        }

        checkOrSpawn();
    }

    /**
     * Kết nối WebSocket thuần Node.js tới Chrome DevTools Protocol (không cần thư viện ngoài).
     */
    function connectCdp(wsUrl, cb) {
        var m = /^ws:\/\/([^\/:]+):(\d+)(\/.*)$/i.exec(wsUrl);
        if (!m) { cb(new Error("WebSocket URL không hợp lệ: " + wsUrl), null); return; }
        var host = m[1], port = parseInt(m[2], 10), wsPath = m[3];
        var key = nodeCrypto.randomBytes(16).toString("base64");
        var connected = false;

        var req = nodeHttp.request({
            host: host,
            port: port,
            path: wsPath,
            headers: {
                "Connection": "Upgrade",
                "Upgrade": "websocket",
                "Sec-WebSocket-Key": key,
                "Sec-WebSocket-Version": "13"
            }
        });

        req.on("error", function (err) {
            if (!connected) cb(err, null);
        });

        req.on("upgrade", function (res, socket, head) {
            connected = true;
            socket.setNoDelay(true);
            var rxBuf = (head && head.length) ? Buffer.from(head) : Buffer.alloc(0);
            var nextId = 1;
            var pending = {};
            var eventHandlers = {};
            var closed = false;

            function sendFrame(opcode, payloadBuf) {
                if (closed) return;
                var mask = nodeCrypto.randomBytes(4);
                var len = payloadBuf.length;
                var header;
                if (len < 126) {
                    header = Buffer.alloc(6);
                    header[0] = 0x80 | opcode;
                    header[1] = 0x80 | len;
                    mask.copy(header, 2);
                } else if (len < 65536) {
                    header = Buffer.alloc(8);
                    header[0] = 0x80 | opcode;
                    header[1] = 0x80 | 126;
                    header.writeUInt16BE(len, 2);
                    mask.copy(header, 4);
                } else {
                    header = Buffer.alloc(14);
                    header[0] = 0x80 | opcode;
                    header[1] = 0x80 | 127;
                    header.writeUInt32BE(0, 2);
                    header.writeUInt32BE(len, 6);
                    mask.copy(header, 10);
                }
                var masked = Buffer.alloc(len);
                for (var i = 0; i < len; i++) {
                    masked[i] = payloadBuf[i] ^ mask[i & 3];
                }
                try { socket.write(Buffer.concat([header, masked])); } catch (eW) {}
            }

            socket.on("data", function (chunk) {
                rxBuf = Buffer.concat([rxBuf, chunk]);
                while (rxBuf.length >= 2) {
                    var b0 = rxBuf[0], b1 = rxBuf[1];
                    var opcode = b0 & 0x0f;
                    var isMasked = (b1 & 0x80) !== 0;
                    var payloadLen = b1 & 0x7f;
                    var offset = 2;
                    if (payloadLen === 126) {
                        if (rxBuf.length < 4) return;
                        payloadLen = rxBuf.readUInt16BE(2);
                        offset = 4;
                    } else if (payloadLen === 127) {
                        if (rxBuf.length < 10) return;
                        payloadLen = rxBuf.readUInt32BE(2) * 4294967296 + rxBuf.readUInt32BE(6);
                        offset = 10;
                    }
                    var maskOffset = offset;
                    if (isMasked) offset += 4;
                    if (rxBuf.length < offset + payloadLen) return;

                    var dataBuf = rxBuf.slice(offset, offset + payloadLen);
                    if (isMasked) {
                        var mKey = rxBuf.slice(maskOffset, maskOffset + 4);
                        for (var mi = 0; mi < dataBuf.length; mi++) dataBuf[mi] ^= mKey[mi & 3];
                    }
                    rxBuf = rxBuf.slice(offset + payloadLen);

                    if (opcode === 0x08) {
                        closed = true;
                        try { socket.end(); } catch (eC) {}
                        return;
                    } else if (opcode === 0x09) {
                        sendFrame(0x0a, dataBuf);
                    } else if (opcode === 0x01) {
                        var txt = dataBuf.toString("utf8");
                        var msg = null;
                        try { msg = JSON.parse(txt); } catch (eJ) {}
                        if (msg) {
                            if (msg.id && pending[msg.id]) {
                                var pCb = pending[msg.id];
                                delete pending[msg.id];
                                pCb(msg.error || null, msg.result || {});
                            } else if (msg.method && eventHandlers[msg.method]) {
                                var list = eventHandlers[msg.method].slice();
                                for (var hi = 0; hi < list.length; hi++) {
                                    try { list[hi](msg.params || {}); } catch (eH) {}
                                }
                            }
                        }
                    }
                }
            });

            socket.on("close", function () {
                closed = true;
                for (var k in pending) {
                    if (pending.hasOwnProperty(k)) {
                        var fn = pending[k];
                        delete pending[k];
                        try { fn(new Error("CDP socket closed"), null); } catch (e) {}
                    }
                }
            });

            var client = {
                send: function (method, params, sCb) {
                    if (closed) { if (sCb) sCb(new Error("CDP closed"), null); return; }
                    var id = nextId++;
                    if (sCb) pending[id] = sCb;
                    var str = JSON.stringify({ id: id, method: method, params: params || {} });
                    sendFrame(0x01, Buffer.from(str, "utf8"));
                },
                evalJs: function (expression, eCb) {
                    client.send("Runtime.evaluate", {
                        expression: expression,
                        returnByValue: true,
                        awaitPromise: true
                    }, function (err, res) {
                        if (err) { eCb(err, null); return; }
                        var val = (res && res.result) ? res.result.value : undefined;
                        eCb(null, val);
                    });
                },
                on: function (eventName, handler) {
                    if (!eventHandlers[eventName]) eventHandlers[eventName] = [];
                    eventHandlers[eventName].push(handler);
                },
                close: function () {
                    closed = true;
                    try { socket.destroy(); } catch (e) {}
                }
            };
            cb(null, client);
        });

        req.end();
    }

    /**
     * Kiểm tra trạng thái đăng nhập trên trang Envato hiện tại qua CDP.
     */
    var CHECK_LOGIN_EXPR = "(function(){" +
        "try {" +
        "  var href = String(window.location.href || '');" +
        "  var ld = window.__reactRouterContext && window.__reactRouterContext.state && window.__reactRouterContext.state.loaderData;" +
        "  if (ld && ld.root) {" +
        "    if (!ld.root.isGuest && ld.root.user) {" +
        "      var u = ld.root.user;" +
        "      return { ready: true, loggedIn: true, user: u.username || u.email || u.givenName || 'Đã đăng nhập', plan: ld.root.customerPlanName || '' };" +
        "    }" +
        "    if (ld.root.isGuest === true) {" +
        "      return { ready: true, loggedIn: false };" +
        "    }" +
        "  }" +
        "  if (href.indexOf('elements.envato.com') !== -1 && window.INITIAL_HYDRATION_DATA) {" +
        "    var signInEl = document.querySelector('a[href*=\"/sign-in\"], [data-testid=\"header-sign-in\"]');" +
        "    var acctEl = document.querySelector('a[href*=\"/account\"], [data-testid=\"user-menu\"], [data-testid=\"header-account\"]');" +
        "    if (acctEl && !signInEl) return { ready: true, loggedIn: true, user: 'Envato Elements' };" +
        "    if (signInEl) return { ready: true, loggedIn: false };" +
        "  }" +
        "  var signBtn = document.querySelector('[data-cy=\"sign-in\"]');" +
        "  if (signBtn) return { ready: true, loggedIn: false };" +
        "  return { ready: document.readyState === 'complete', loggedIn: false, unknown: true };" +
        "} catch(e) { return { ready: false, loggedIn: false, err: e.toString() }; }" +
    "})()";

    function checkLoginStatus(opts, cb) {
        opts = opts || {};
        var allowSpawn = !!opts.openIfNeeded;
        ensureBrowserAndTarget("https://app.envato.com/", allowSpawn, function (err, target) {
            if (err || !target) {
                if (cb) cb({ ok: false, loggedIn: loggedInState, user: loggedInUser, error: err ? err.message : "" });
                return;
            }
            connectCdp(target.webSocketDebuggerUrl, function (cErr, cdp) {
                if (cErr || !cdp) {
                    if (cb) cb({ ok: false, loggedIn: loggedInState, user: loggedInUser });
                    return;
                }
                var curUrl = String(target.url || "");
                var needNav = (curUrl.indexOf("app.envato.com") === -1 && curUrl.indexOf("elements.envato.com") === -1);
                function inspectPage(triesLeft) {
                    cdp.evalJs(CHECK_LOGIN_EXPR, function (eEval, info) {
                        if (info && info.ready && !info.unknown) {
                            cdp.close();
                            setLoggedIn(!!info.loggedIn, info.user || "");
                            if (cb) cb({ ok: true, loggedIn: !!info.loggedIn, user: info.user || "" });
                            return;
                        }
                        if (triesLeft <= 0) {
                            cdp.close();
                            if (cb) cb({ ok: true, loggedIn: loggedInState, user: loggedInUser });
                            return;
                        }
                        setTimeout(function () { inspectPage(triesLeft - 1); }, 600);
                    });
                }
                if (needNav) {
                    cdp.send("Page.navigate", { url: "https://app.envato.com/" }, function () {
                        setTimeout(function () { inspectPage(12); }, 1200);
                    });
                } else {
                    inspectPage(8);
                }
            });
        });
    }

    /**
     * Mở cửa sổ trình duyệt Envato để người dùng đăng nhập và tự động theo dõi đến khi đăng nhập xong.
     */
    function openLoginWindow(onSuccessCb) {
        if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
        var wasAlreadyLoggedIn = loggedInState && !onSuccessCb;
        addLog("info", "🔑 Đang mở cửa sổ đăng nhập Envato...");
        ensureBrowserAndTarget("https://app.envato.com/", true, function (err, target) {
            if (err || !target) {
                showAlert("Không mở được trình duyệt", escapeHtml(err ? err.message : "Không thể khởi động Chrome/Edge"), "error");
                return;
            }
            connectCdp(target.webSocketDebuggerUrl, function (cErr, cdp) {
                if (!cErr && cdp) {
                    cdp.send("Page.bringToFront", {}, function () {});
                    var tUrl = String(target.url || "");
                    if (tUrl.indexOf("envato.com") === -1) {
                        cdp.send("Page.navigate", { url: "https://app.envato.com/" }, function () {});
                    }
                    // Nếu chưa đăng nhập, tự bấm nút Sign In trên trang để mở thẳng form đăng nhập cho tiện
                    setTimeout(function () {
                        cdp.evalJs("(function(){ var b = document.querySelector('[data-cy=\"sign-in\"]'); if (b) b.click(); })()", function () {
                            cdp.close();
                        });
                    }, 1800);
                }
            });

            var pollCount = 0;
            loginPollTimer = setInterval(function () {
                pollCount++;
                if (pollCount > 150) { // tối đa 5 phút
                    clearInterval(loginPollTimer);
                    loginPollTimer = null;
                    return;
                }
                httpGetJson("http://127.0.0.1:" + DEBUG_PORT + "/json", 1000, function (eList, tList) {
                    if (eList || !Array.isArray(tList)) {
                        // Người dùng đã đóng trình duyệt
                        if (pollCount > 5) {
                            clearInterval(loginPollTimer);
                            loginPollTimer = null;
                        }
                        return;
                    }
                    var tgt = findEnvatoTarget(tList);
                    if (!tgt) return;
                    connectCdp(tgt.webSocketDebuggerUrl, function (eC, cdp2) {
                        if (eC || !cdp2) return;
                        cdp2.evalJs(CHECK_LOGIN_EXPR, function (eEv, info) {
                            cdp2.close();
                            if (info && info.loggedIn) {
                                clearInterval(loginPollTimer);
                                loginPollTimer = null;
                                setLoggedIn(true, info.user || "Đã đăng nhập");
                                addLog("success", "✅ Đã xác nhận đăng nhập tài khoản Envato (" + (info.user || "Active") + ") — các lượt tải sẽ chạy ngầm 100%!");
                                showToast("Đã đăng nhập Envato!", "Tài khoản: " + (info.user || "Đã kết nối") + " (tải ngầm 100%)", false);
                                if (state.mediaCheckItems && state.mediaCheckItems.length > 0) {
                                    renderMediaCheck(state.mediaCheckItems);
                                }
                                if (!wasAlreadyLoggedIn) {
                                    // Tự động đóng cửa sổ hiện hình ngay khi vừa đăng nhập xong để mọi lượt tải sau chạy ngầm (--headless=new)
                                    closeBrowserInstance(function () {
                                        if (onSuccessCb) {
                                            var fn = onSuccessCb;
                                            onSuccessCb = null;
                                            fn(true);
                                        }
                                    });
                                } else if (onSuccessCb) {
                                    var fn2 = onSuccessCb;
                                    onSuccessCb = null;
                                    fn2(true);
                                }
                            } else if (info && info.ready && !info.unknown && !info.loggedIn) {
                                wasAlreadyLoggedIn = false;
                                setLoggedIn(false, "");
                            }
                        });
                    });
                });
            }, 2000);
        }, true);
    }

    function cancel() {
        cancelled = true;
        if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
        if (activeCdp) {
            try { activeCdp.close(); } catch (e) {}
            activeCdp = null;
        }
        hideCopyProgress();
    }

    function extractVideoFromZipIfNeeded(zipPath, targetFileNoExt) {
        if (!nodeFs || !nodeCp) return "";
        var extractDir = zipPath + "_unzip";
        try {
            if (!nodeFs.existsSync(extractDir)) nodeFs.mkdirSync(extractDir, { recursive: true });
            nodeCp.execFileSync("tar.exe", ["-xf", zipPath, "-C", extractDir], { windowsHide: true, timeout: 120000 });
            var bestFile = "", bestSize = 0;
            function scanDir(d) {
                var entries = nodeFs.readdirSync(d);
                for (var i = 0; i < entries.length; i++) {
                    var full = nodePath.join(d, entries[i]);
                    var st = nodeFs.statSync(full);
                    if (st.isDirectory()) scanDir(full);
                    else if (/\.(mp4|mov|m4v|mkv|webm)$/i.test(entries[i]) && st.size > bestSize) {
                        bestSize = st.size;
                        bestFile = full;
                    }
                }
            }
            scanDir(extractDir);
            if (bestFile) {
                var ext = nodePath.extname(bestFile).toLowerCase() || ".mp4";
                var finalPath = targetFileNoExt + ext;
                nodeFs.renameSync(bestFile, finalPath);
                try { nodeFs.unlinkSync(zipPath); } catch (eU) {}
                return finalPath;
            }
        } catch (eZ) {}
        return "";
    }

    /**
     * Tải 1 video Envato với chất lượng cao nhất (4K / Original) về footageDir.
     */
    function downloadSingleItem(item, footageDir, onStatus, cb) {
        var url = item.url;
        var itemKey = item.key || getEnvatoItemKey(url);

        // 1. Kiểm tra lại cache cục bộ trước khi tải
        var existingLocal = findLocalCachedFile(footageDir, url);
        if (existingLocal) {
            state.envatoFiles[url] = existingLocal;
            state.envatoFiles[itemKey] = existingLocal;
            cb({ ok: true, cached: true, filePath: existingLocal });
            return;
        }

        // 2. Độ trễ ngẫu nhiên (3.5s – 6.5s) giữa 2 lần tải liên tiếp để bảo vệ tài khoản cá nhân
        var now = Date.now();
        var minGapMs = 3500 + Math.floor(Math.random() * 3000);
        var elapsedSinceLast = lastDownloadFinishedAt > 0 ? (now - lastDownloadFinishedAt) : 999999;
        var waitMs = Math.max(0, minGapMs - elapsedSinceLast);

        function proceedAfterJitter() {
            if (cancelled || state.shouldCancel) {
                cb({ ok: false, cancelled: true, error: "Đã huỷ" });
                return;
            }
            if (onStatus) onStatus("Đang kết nối trình duyệt Envato cho mã " + itemKey + "...");
            ensureBrowserAndTarget("https://app.envato.com/", true, function (bErr, target) {
                if (bErr || !target) {
                    cb({ ok: false, error: bErr ? bErr.message : "Không mở được trình duyệt Envato" });
                    return;
                }
                connectCdp(target.webSocketDebuggerUrl, function (cErr, cdp) {
                    if (cErr || !cdp) {
                        cb({ ok: false, error: "Không kết nối được CDP: " + (cErr ? cErr.message : "") });
                        return;
                    }
                    activeCdp = cdp;
                    var resolvedUuid = "";
                    var resolvedType = "stock-video";

                    function finishSingle(resObj) {
                        if (activeCdp === cdp) activeCdp = null;
                        try { cdp.close(); } catch (eC) {}
                        hideCopyProgress();
                        cb(resObj);
                    }

                    // Bước A: Nếu link là elements.envato.com -> lấy itemUuid chuẩn (hỗ trợ cả trường hợp Envato tự 302 redirect sang app.envato.com khi đã login)
                    function resolveAppUrl(rCb) {
                        if (url.toLowerCase().indexOf("elements.envato.com") === -1) {
                            var mU = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url);
                            if (mU) resolvedUuid = mU[1].toLowerCase();
                            rCb("https://app.envato.com/stock-video/" + (resolvedUuid || itemKey), false);
                            return;
                        }
                        if (onStatus) onStatus("Đang truy xuất mã gốc Envato (" + itemKey + ")...");
                        // Đánh dấu trang hiện tại trước khi điều hướng để không đọc nhầm DOM của video dòng trước
                        cdp.evalJs("(function(){ try { window.__aicLeavingPage = true; } catch(e){} })()", function () {
                            cdp.send("Page.navigate", { url: url }, function () {
                                var tries = 0;
                                function pollElementsOrRedirect() {
                                    if (cancelled || state.shouldCancel) { finishSingle({ ok: false, cancelled: true }); return; }
                                    tries++;
                                    cdp.evalJs("(function(){" +
                                        "try {" +
                                        "  if (window.__aicLeavingPage === true) return { ok: false, leaving: true };" +
                                        "  var href = String(window.location.href || '');" +
                                        "  var host = String(window.location.hostname || '').toLowerCase();" +
                                        "  if (host.indexOf('app.envato.com') !== -1) {" +
                                        "    var mUrl = href.match(/\\/([a-z0-9-]+)\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);" +
                                        "    var ld = window.__reactRouterContext && window.__reactRouterContext.state && window.__reactRouterContext.state.loaderData;" +
                                        "    var uuidFromLd = '', typeFromLd = '';" +
                                        "    if (ld) {" +
                                        "      for (var k in ld) {" +
                                        "        var it = ld[k] && (ld[k].item || (ld[k].itemDetailsProps && ld[k].itemDetailsProps.item));" +
                                        "        if (it && it.itemUuid) { uuidFromLd = it.itemUuid; typeFromLd = it.itemType || ''; break; }" +
                                        "      }" +
                                        "    }" +
                                        "    var finalUuid = uuidFromLd || (mUrl ? mUrl[2] : '');" +
                                        "    var finalType = typeFromLd || (mUrl ? mUrl[1] : 'stock-video');" +
                                        "    if (finalUuid) return { ok: true, uuid: finalUuid, type: finalType, alreadyOnApp: true, appUrl: href };" +
                                        "  }" +
                                        "  if (window.INITIAL_HYDRATION_DATA) {" +
                                        "    var raw = atob(window.INITIAL_HYDRATION_DATA);" +
                                        "    var mId = raw.match(/\"itemUuid\":\"([0-9a-f-]{36})\"/i);" +
                                        "    var mTp = raw.match(/\"itemType\":\"([^\"]+)\"/i);" +
                                        "    if (mId) return { ok: true, uuid: mId[1], type: mTp ? mTp[1] : 'stock-video', alreadyOnApp: false };" +
                                        "  }" +
                                        "  return { ok: false, href: href, title: document.title };" +
                                        "} catch(e) { return { ok: false, err: e.toString() }; }" +
                                    "})()", function (eH, hInfo) {
                                        if (hInfo && hInfo.ok && hInfo.uuid) {
                                            resolvedUuid = hInfo.uuid.toLowerCase();
                                            resolvedType = hInfo.type || "stock-video";
                                            // Kiểm tra xem file theo UUID này đã có sẵn trong Footage/ chưa!
                                            var cachedByUuid = findLocalCachedFile(footageDir, resolvedUuid);
                                            if (cachedByUuid) {
                                                saveCacheMap(footageDir, function (m) {
                                                    var baseName = nodePath.basename(cachedByUuid);
                                                    m[url] = baseName;
                                                    m[itemKey] = baseName;
                                                    m[resolvedUuid] = baseName;
                                                });
                                                state.envatoFiles[url] = cachedByUuid;
                                                state.envatoFiles[itemKey] = cachedByUuid;
                                                finishSingle({ ok: true, cached: true, filePath: cachedByUuid });
                                                return;
                                            }
                                            rCb("https://app.envato.com/" + resolvedType + "/" + resolvedUuid, !!hInfo.alreadyOnApp);
                                            return;
                                        }
                                        if (tries >= 40) {
                                            finishSingle({ ok: false, error: "Không lấy được thông tin video từ trang Envato (" + itemKey + ")" });
                                            return;
                                        }
                                        activeTimer = setTimeout(pollElementsOrRedirect, 600);
                                    });
                                }
                                activeTimer = setTimeout(pollElementsOrRedirect, 700);
                            });
                        });
                    }

                    // Bước B: Mở trang item trên app.envato.com, chọn chất lượng cao nhất (4K/Original) và bấm tải
                    resolveAppUrl(function (appItemUrl, alreadyOnAppPage) {
                        if (cancelled || state.shouldCancel) { finishSingle({ ok: false, cancelled: true }); return; }
                        if (onStatus) onStatus("Đang chuẩn bị tải chất lượng cao nhất (" + itemKey + ")...");

                        var tempDlDir = nodePath.join(footageDir, "_envato_dl_tmp");
                        try {
                            if (!nodeFs.existsSync(footageDir)) nodeFs.mkdirSync(footageDir, { recursive: true });
                            if (!nodeFs.existsSync(tempDlDir)) nodeFs.mkdirSync(tempDlDir, { recursive: true });
                            // Dọn các file tạm cũ trong _envato_dl_tmp trước khi tải file mới
                            var oldTmp = nodeFs.readdirSync(tempDlDir);
                            for (var oi = 0; oi < oldTmp.length; oi++) {
                                try { nodeFs.unlinkSync(nodePath.join(tempDlDir, oldTmp[oi])); } catch (eRm) {}
                            }
                        } catch (eDir) {}

                        var dlWinPath = String(tempDlDir).replace(/\//g, "\\");
                        cdp.send("Browser.setDownloadBehavior", {
                            behavior: "allow",
                            downloadPath: dlWinPath,
                            eventsEnabled: true
                        }, function () {});
                        cdp.send("Page.setDownloadBehavior", {
                            behavior: "allow",
                            downloadPath: dlWinPath
                        }, function () {});

                        var dlStarted = false;
                        var dlCompleted = false;
                        var dlStartTime = Date.now();
                        var lastBytes = 0, lastSpeedTime = Date.now(), lastSpeed = 0;
                        var totalExpectedBytes = 0;
                        var chosenFormatLabel = "Chất lượng cao nhất";

                        function onProgressUpdate(rxBytes, totBytes) {
                            if (cancelled || state.shouldCancel) return;
                            var nowT = Date.now();
                            var dt = (nowT - lastSpeedTime) / 1000;
                            if (dt >= 0.2 && rxBytes > lastBytes) {
                                var inst = (rxBytes - lastBytes) / dt;
                                lastSpeed = lastSpeed ? (lastSpeed * 0.5 + inst * 0.5) : inst;
                                lastBytes = rxBytes;
                                lastSpeedTime = nowT;
                            }
                            showCopyProgress("Envato [" + itemKey.substring(0, 8) + "] " + chosenFormatLabel, rxBytes, totBytes || totalExpectedBytes, lastSpeed);
                        }

                        cdp.on("Browser.downloadWillBegin", function (params) {
                            dlStarted = true;
                            dlStartTime = Date.now();
                        });
                        cdp.on("Page.downloadWillBegin", function (params) {
                            dlStarted = true;
                            dlStartTime = Date.now();
                        });
                        cdp.on("Browser.downloadProgress", function (params) {
                            dlStarted = true;
                            if (params.totalBytes > 0) totalExpectedBytes = params.totalBytes;
                            onProgressUpdate(params.receivedBytes || 0, params.totalBytes || totalExpectedBytes);
                            if (params.state === "completed") {
                                dlCompleted = true;
                            }
                        });
                        cdp.on("Page.downloadProgress", function (params) {
                            dlStarted = true;
                            if (params.totalBytes > 0) totalExpectedBytes = params.totalBytes;
                            onProgressUpdate(params.receivedBytes || 0, params.totalBytes || totalExpectedBytes);
                            if (params.state === "completed") {
                                dlCompleted = true;
                            }
                        });

                        var waitTries = 0;
                        function pollItemPageReady() {
                            if (cancelled || state.shouldCancel) { finishSingle({ ok: false, cancelled: true }); return; }
                            waitTries++;
                            var expectedUuidJs = JSON.stringify(resolvedUuid || "");
                            cdp.evalJs("(function(){" +
                                "try {" +
                                "  if (window.__aicLeavingPage === true) return { ready: false, leaving: true };" +
                                "  var expUuid = " + expectedUuidJs + ";" +
                                "  var ld = window.__reactRouterContext && window.__reactRouterContext.state && window.__reactRouterContext.state.loaderData;" +
                                "  var signBtn = document.querySelector('[data-cy=\"sign-in\"]');" +
                                "  var dlBtn = document.querySelector('[data-cy=\"idp-download-button\"]');" +
                                "  if (ld && ld.root && ld.root.isGuest === true) return { ready: true, needLogin: true };" +
                                "  if (signBtn && !dlBtn) return { ready: true, needLogin: true };" +
                                "  if (!dlBtn) return { ready: false };" +
                                "  var btnItemId = (dlBtn.getAttribute('data-analytics-item_id') || '').toLowerCase();" +
                                "  if (expUuid && btnItemId && btnItemId !== expUuid) return { ready: false, mismatch: true };" +
                                "  if (ld && ld.root && ld.root.userPreferences && ld.root.userPreferences.licensePreference) {" +
                                "    ld.root.userPreferences.licensePreference.mode = 'never_ask';" +
                                "  }" +
                                "  var formats = [];" +
                                "  if (ld) {" +
                                "    for (var k in ld) {" +
                                "      var it = ld[k] && (ld[k].item || (ld[k].itemDetailsProps && ld[k].itemDetailsProps.item));" +
                                "      if (it && Array.isArray(it.downloadFormats)) { formats = it.downloadFormats; break; }" +
                                "    }" +
                                "  }" +
                                "  var bestFmt = formats[0] || null;" +
                                "  function rankFmt(f) {" +
                                "    var lbl = String((f && (f.label || f.shortLabel)) || '').toUpperCase();" +
                                "    if (lbl.indexOf('4K') !== -1 || lbl.indexOf('2160') !== -1) return 4000;" +
                                "    if (lbl.indexOf('2K') !== -1 || lbl.indexOf('1440') !== -1) return 2000;" +
                                "    if (lbl.indexOf('1080') !== -1) return 1080;" +
                                "    if (lbl.indexOf('720') !== -1) return 720;" +
                                "    return 500;" +
                                "  }" +
                                "  for (var fi = 1; fi < formats.length; fi++) {" +
                                "    if (rankFmt(formats[fi]) > rankFmt(bestFmt)) bestFmt = formats[fi];" +
                                "  }" +
                                "  var curAsset = dlBtn.getAttribute('data-analytics-asset_uuid') || '';" +
                                "  var curLabel = dlBtn.getAttribute('data-analytics-format_label') || String(dlBtn.innerText || dlBtn.textContent || '').replace(/\\s+/g, ' ').trim();" +
                                "  return {" +
                                "    ready: true," +
                                "    needLogin: false," +
                                "    curAsset: curAsset," +
                                "    bestAsset: bestFmt ? bestFmt.assetUuid : curAsset," +
                                "    bestLabel: bestFmt ? (bestFmt.label || bestFmt.shortLabel || curLabel || 'Original') : (curLabel || 'Original')" +
                                "  };" +
                                "} catch(e) { return { ready: false, err: e.toString() }; }" +
                            "})()", function (eR, pInfo) {
                                if (!pInfo || !pInfo.ready) {
                                    if (waitTries >= 40) {
                                        finishSingle({ ok: false, error: "Quá thời gian chờ tải trang Envato (" + itemKey + ")" });
                                        return;
                                    }
                                    activeTimer = setTimeout(pollItemPageReady, 600);
                                    return;
                                }
                                if (pInfo.needLogin) {
                                    setLoggedIn(false, "");
                                    finishSingle({
                                        ok: false,
                                        needLogin: true,
                                        error: "Tài khoản Envato chưa đăng nhập hoặc phiên đăng nhập đã hết hạn"
                                    });
                                    return;
                                }

                                chosenFormatLabel = pInfo.bestLabel || "4K / Original";
                                var sizeMatch = /(\d+(?:[.,]\d+)?)\s*(MB|MO|GB|GO)/i.exec(chosenFormatLabel);
                                if (sizeMatch) {
                                    var num = parseFloat(String(sizeMatch[1]).replace(",", "."));
                                    var unit = sizeMatch[2].toUpperCase();
                                    totalExpectedBytes = Math.round(num * ((unit === "GB" || unit === "GO") ? 1073741824 : 1048576));
                                }

                                function triggerDownloadClick() {
                                    if (onStatus) onStatus("Đang tải Envato [" + itemKey.substring(0, 8) + "] — " + chosenFormatLabel + "...");
                                    showCopyProgress("Envato [" + itemKey.substring(0, 8) + "] " + chosenFormatLabel, 0, totalExpectedBytes, 0);
                                    cdp.evalJs("(function(){" +
                                        "var b = document.querySelector('[data-cy=\"idp-download-button\"]');" +
                                        "if (b) { b.click(); return true; }" +
                                        "return false;" +
                                    "})()", function () {
                                        waitForDownloadFile();
                                    });
                                }

                                // Nếu format đang chọn chưa phải cao nhất thì mở dropdown chọn lại format cao nhất
                                if (pInfo.bestAsset && pInfo.curAsset && pInfo.bestAsset !== pInfo.curAsset) {
                                    cdp.evalJs("(function(){" +
                                        "var trig = document.querySelector('[data-cy=\"idp-format-dropdown-trigger\"]');" +
                                        "if (trig) trig.click();" +
                                    "})()", function () {
                                        setTimeout(function () {
                                            cdp.evalJs("(function(){" +
                                                "var opt = document.querySelector('[data-analytics-asset_uuid=\"" + pInfo.bestAsset + "\"]');" +
                                                "if (opt) opt.click();" +
                                            "})()", function () {
                                                setTimeout(triggerDownloadClick, 350);
                                            });
                                        }, 400);
                                    });
                                } else {
                                    triggerDownloadClick();
                                }
                            });
                        }

                        if (alreadyOnAppPage) {
                            // Trình duyệt đã tự động 302 redirect sang đúng trang app.envato.com của video này -> không cần load lại lần 2!
                            activeTimer = setTimeout(pollItemPageReady, 200);
                        } else {
                            cdp.evalJs("(function(){ try { window.__aicLeavingPage = true; } catch(e){} })()", function () {
                                cdp.send("Page.navigate", { url: appItemUrl }, function () {
                                    activeTimer = setTimeout(pollItemPageReady, 800);
                                });
                            });
                        }

                        function waitForDownloadFile() {
                            var dlPolls = 0;
                            function checkDiskAndStatus() {
                                if (cancelled || state.shouldCancel) { finishSingle({ ok: false, cancelled: true }); return; }
                                dlPolls++;

                        // Nếu sau 3 giây chưa bắt đầu tải, kiểm tra xem có popup hỏi License (Anh/Pháp/Việt) hoặc nút tải chưa ăn click đầu
                                if (!dlStarted && (dlPolls === 4 || dlPolls === 8)) {
                                    cdp.evalJs("(function(){" +
                                        "var dlgs = document.querySelectorAll('[role=\"dialog\"]');" +
                                        "for (var d = 0; d < dlgs.length; d++) {" +
                                        "  var dlg = dlgs[d];" +
                                        "  if (!dlg || (!dlg.offsetWidth && !(dlg.innerText || '').trim())) continue;" +
                                        "  var btns = dlg.querySelectorAll('button');" +
                                        "  for (var i = 0; i < btns.length; i++) {" +
                                        "    var t = (btns[i].textContent || '').toLowerCase();" +
                                        "    if (t.indexOf('without license') !== -1 || t.indexOf('sans licence') !== -1 || t.indexOf('download') !== -1 || t.indexOf('télécharger') !== -1 || t.indexOf('telecharger') !== -1 || t.indexOf('skip') !== -1 || t.indexOf('continue') !== -1) {" +
                                        "      btns[i].click(); return { clickedDialog: true };" +
                                        "    }" +
                                        "  }" +
                                        "}" +
                                        "var b = document.querySelector('[data-cy=\"idp-download-button\"]');" +
                                        "if (b && b.getAttribute('aria-busy') !== 'true') { b.click(); return { retriedClick: true }; }" +
                                        "return { clickedDialog: false };" +
                                    "})()", function () {});
                                }

                                try {
                                    var files = nodeFs.readdirSync(tempDlDir);
                                    var finishedFile = "";
                                    var crFile = "";
                                    for (var i = 0; i < files.length; i++) {
                                        var fName = files[i];
                                        var lower = fName.toLowerCase();
                                        if (lower.indexOf(".crdownload") !== -1 || lower.indexOf(".part") !== -1 || lower.indexOf(".tmp") !== -1) {
                                            crFile = nodePath.join(tempDlDir, fName);
                                        } else if (/\.(mp4|mov|m4v|webm|mkv|zip)$/i.test(lower)) {
                                            var candFull = nodePath.join(tempDlDir, fName);
                                            if (statFileSize(candFull) > 0) finishedFile = candFull;
                                        }
                                    }

                                    if (crFile) {
                                        dlStarted = true;
                                        var curSz = statFileSize(crFile);
                                        if (curSz > 0) onProgressUpdate(curSz, totalExpectedBytes);
                                    }

                                    if (finishedFile && !crFile) {
                                        var finalSz = statFileSize(finishedFile);
                                        var ext = nodePath.extname(finishedFile).toLowerCase() || ".mp4";
                                        var destNoExt = nodePath.join(footageDir, "envato_" + itemKey);
                                        var destFull = destNoExt + ext;

                                        if (ext === ".zip") {
                                            var unzipped = extractVideoFromZipIfNeeded(finishedFile, destNoExt);
                                            if (unzipped) destFull = unzipped;
                                        } else {
                                            try {
                                                if (nodeFs.existsSync(destFull)) nodeFs.unlinkSync(destFull);
                                                nodeFs.renameSync(finishedFile, destFull);
                                            } catch (eRen) {
                                                nodeFs.copyFileSync(finishedFile, destFull);
                                                try { nodeFs.unlinkSync(finishedFile); } catch (eU2) {}
                                            }
                                        }

                                        var savedName = nodePath.basename(destFull);
                                        saveCacheMap(footageDir, function (m) {
                                            m[url] = savedName;
                                            m[itemKey] = savedName;
                                            if (resolvedUuid) m[resolvedUuid] = savedName;
                                        });
                                        state.envatoFiles[url] = destFull;
                                        state.envatoFiles[itemKey] = destFull;
                                        if (resolvedUuid) state.envatoFiles[resolvedUuid] = destFull;
                                        state.copiedBytes += (finalSz > 0 ? finalSz : 0);
                                        lastDownloadFinishedAt = Date.now();

                                        SidecarClient.convertVideoForPremiere(destFull, footageDir, false, function (cMsg) {
                                            if (onStatus) onStatus("Envato [" + itemKey.substring(0, 8) + "] — " + cMsg);
                                        }, function (cRes) {
                                            if (cRes && cRes.ok && cRes.filePath && cRes.filePath !== destFull) {
                                                destFull = cRes.filePath;
                                                var newSaved = nodePath.basename(destFull);
                                                saveCacheMap(footageDir, function (m) {
                                                    m[url] = newSaved;
                                                    m[itemKey] = newSaved;
                                                    if (resolvedUuid) m[resolvedUuid] = newSaved;
                                                });
                                                state.envatoFiles[url] = destFull;
                                                state.envatoFiles[itemKey] = destFull;
                                                if (resolvedUuid) state.envatoFiles[resolvedUuid] = destFull;
                                                if (cRes.converted) addLog("info", "Đã tự động convert codec Envato (" + (cRes.originalVideoCodec || "") + " → H.264 MP4): " + newSaved);
                                            }
                                            finishSingle({
                                                ok: true,
                                                cached: false,
                                                filePath: destFull,
                                                formatLabel: chosenFormatLabel,
                                                bytes: finalSz
                                            });
                                        });
                                        return;
                                    }
                                } catch (eScan) {}

                                // Timeout: nếu sau 25 giây vẫn chưa bắt đầu tải, hoặc quá 15 phút cho file 4K lớn
                                if (!dlStarted && dlPolls >= 35) {
                                    finishSingle({
                                        ok: false,
                                        error: "Envato không phản hồi lệnh tải cho mã " + itemKey + " (kiểm tra tài khoản đã có gói đăng ký Envato hoạt động chưa)"
                                    });
                                    return;
                                }
                                if (dlPolls >= 1200) {
                                    finishSingle({ ok: false, error: "Quá thời gian tải file Envato (" + itemKey + ")" });
                                    return;
                                }
                                activeTimer = setTimeout(checkDiskAndStatus, 750);
                            }
                            activeTimer = setTimeout(checkDiskAndStatus, 800);
                        }
                    });
                });
            });
        }

        if (waitMs > 200) {
            var waitUntil = Date.now() + waitMs;
            function tickJitter() {
                if (cancelled || state.shouldCancel) {
                    cb({ ok: false, cancelled: true, error: "Đã huỷ" });
                    return;
                }
                var rem = waitUntil - Date.now();
                if (rem <= 0) {
                    proceedAfterJitter();
                    return;
                }
                if (onStatus) {
                    onStatus("⏳ Nghỉ " + (rem / 1000).toFixed(1) + "s giữa các lần tải để bảo vệ tài khoản Envato...");
                }
                activeTimer = setTimeout(tickJitter, 300);
            }
            tickJitter();
        } else {
            proceedAfterJitter();
        }
    }

    function downloadBatch(items, footageDir, onStep, cb) {
        cancelled = false;
        var idx = 0, downloadedCount = 0, errors = [];
        function next() {
            if (cancelled || state.shouldCancel) {
                cb({ ok: false, cancelled: true, downloadedCount: downloadedCount, errors: errors });
                return;
            }
            if (idx >= items.length) {
                cb({ ok: true, downloadedCount: downloadedCount, errors: errors });
                return;
            }
            var item = items[idx];
            downloadSingleItem(item, footageDir, function (statusMsg) {
                if (onStep) onStep(item, idx, items.length, statusMsg);
            }, function (res) {
                if (res.cancelled) {
                    cb({ ok: false, cancelled: true, downloadedCount: downloadedCount, errors: errors });
                    return;
                }
                if (res.needLogin) {
                    cb({ ok: false, needLogin: true, error: res.error, downloadedCount: downloadedCount, errors: errors });
                    return;
                }
                if (!res.ok) {
                    errors.push((item.key || item.url) + ": " + res.error);
                    addLog("warning", "Envato [" + (item.key || "") + "]: " + res.error);
                } else {
                    if (!res.cached) {
                        downloadedCount++;
                        addLog("success", "Đã tải Envato [" + (item.key || "").substring(0, 8) + "] (" + (res.formatLabel || "Highest") + ") → " + nodePath.basename(res.filePath));
                    } else {
                        addLog("info", "Dùng lại file Envato đã có trong Footage/: " + nodePath.basename(res.filePath));
                    }
                }
                idx++;
                next();
            });
        }
        next();
    }

    return {
        isAvailable: isAvailable,
        isBusy: function () { return !!(activeTimer || activeCdp); },
        isLoggedIn: function () { return loggedInState; },
        getLoggedInUser: function () { return loggedInUser; },
        getEnvatoItemKey: getEnvatoItemKey,
        findLocalCachedFile: findLocalCachedFile,
        checkLoginStatus: checkLoginStatus,
        openLoginWindow: openLoginWindow,
        downloadBatch: downloadBatch,
        cancel: cancel
    };
})();

function updateEnvatoAuthUI() {
    var logged = EnvatoDownloader.isLoggedIn();
    var user = EnvatoDownloader.getLoggedInUser();
    if (dom.envatoBtnDot) {
        dom.envatoBtnDot.className = "api-dot" + (logged ? " active" : " warning");
    }
    if (dom.envatoBtnText) {
        dom.envatoBtnText.textContent = logged ? "Envato ✓" : "Envato";
    }
    if (dom.btnEnvatoAuth) {
        dom.btnEnvatoAuth.title = logged
            ? ("Đã đăng nhập Envato (" + (user || "Active") + ") — bấm để mở trình duyệt kiểm tra/đổi tài khoản")
            : "Chưa đăng nhập Envato — bấm để mở trình duyệt Chrome đăng nhập tài khoản cá nhân";
    }
}

// ============================================================================
// SIDECAR BACKEND CLIENT (V3 Architecture Option A)
// Giao tiếp với tiến trình Node.js độc lập ngoài CEP (http://127.0.0.1:9395)
// Chuyên trách: Tải YouTube tốc độ cao + Tự động kiểm tra & convert codec (AV1/VP9/WEBM/MKV) sang H.264 MP4 chuẩn Premiere
// ============================================================================
var SidecarClient = (function () {
    var PORT = 9395;
    var BASE_URL = 'http://127.0.0.1:' + PORT;
    var nodeFs = null, nodePath = null, nodeCp = null, nodeHttp = null;
    try {
        var req = (typeof require === 'function') ? require :
                  (window.cep_node && window.cep_node.require ? window.cep_node.require : null);
        if (req) {
            nodeFs = req('fs');
            nodePath = req('path');
            nodeCp = req('child_process');
            nodeHttp = req('http');
        }
    } catch (e) {}

    var isOnline = false;
    var starting = false;
    var cancelled = false;
    var activePollTimer = null;

    function updateBadge(online, label) {
        isOnline = !!online;
        var dot = document.getElementById('sidecarDot');
        var txt = document.getElementById('sidecarText');
        var badge = document.getElementById('sidecarBadge');
        if (dot) dot.className = 'api-dot' + (online ? ' active' : ' warning');
        if (txt) txt.textContent = label || (online ? 'Sidecar ✓' : 'Sidecar');
        if (badge) {
            badge.title = online
                ? 'Sidecar Pro Backend đang chạy (127.0.0.1:' + PORT + ') — Tự động tải YouTube & convert mọi codec lạ sang H.264 MP4'
                : 'Sidecar Pro Backend đang khởi động...';
        }
    }

    function httpReq(method, pathUrl, bodyObj, cb) {
        if (!nodeHttp) {
            fetch(BASE_URL + pathUrl, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: bodyObj ? JSON.stringify(bodyObj) : undefined
            }).then(function (r) { return r.json(); }).then(function (d) { cb(null, d); }).catch(function (e) { cb(e, null); });
            return;
        }
        var payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
        var req = nodeHttp.request({
            hostname: '127.0.0.1',
            port: PORT,
            path: pathUrl,
            method: method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
            timeout: 15000
        }, function (res) {
            var raw = '';
            res.on('data', function (c) { raw += c.toString(); });
            res.on('end', function () {
                try { cb(null, JSON.parse(raw)); } catch (eP) { cb(eP, null); }
            });
        });
        req.on('error', function (err) { cb(err, null); });
        req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(new Error('timeout'), null); });
        if (payload) req.write(payload);
        req.end();
    }

    function findNodeExe() {
        if (!nodeFs) return '';
        var cands = [
            'C:\\Program Files\\nodejs\\node.exe',
            'C:\\Program Files\\Adobe\\Adobe Creative Cloud Experience\\libs\\node.exe',
            'C:\\Program Files (x86)\\Adobe\\Adobe Creative Cloud Experience\\libs\\node.exe'
        ];
        for (var i = 0; i < cands.length; i++) {
            if (nodeFs.existsSync(cands[i])) return cands[i];
        }
        return 'node.exe';
    }

    function findServerScript() {
        if (!nodeFs || !nodePath) return '';
        try {
            var extRoot = String(csInterface.getSystemPath(SystemPath.EXTENSION) || '');
            if (extRoot.indexOf('file:///') === 0) {
                extRoot = extRoot.substring(8);
            } else if (extRoot.indexOf('file://') === 0) {
                extRoot = extRoot.substring(7);
            }
            if (extRoot) {
                var winExt = extRoot.replace(/\//g, '\\');
                var c1 = nodePath.join(winExt, 'backend', 'server.js');
                if (nodeFs.existsSync(c1)) return c1;
                var c2 = nodePath.join(nodePath.dirname(winExt), 'backend', 'server.js');
                if (nodeFs.existsSync(c2)) return c2;
            }
        } catch (e) {}
        var fallback = 'c:\\Users\\admin\\Desktop\\Auto import & cut V3\\backend\\server.js';
        if (nodeFs.existsSync(fallback)) return fallback;
        return '';
    }

    var inProcessLoaded = false;
    function startInProcessFallback(srvScript) {
        if (inProcessLoaded || !srvScript) return;
        try {
            var reqFn = (typeof require === 'function') ? require :
                        (window.cep_node && window.cep_node.require ? window.cep_node.require : null);
            if (reqFn) {
                inProcessLoaded = true;
                reqFn(srvScript);
            }
        } catch (eInProc) {}
    }

    var SIDECAR_MIN_VERSION = '3.1.3';

    function ensureRunning(cb) {
        httpReq('GET', '/health', null, function (err, data) {
            if (!err && data && data.ok) {
                if (data.version && data.version !== SIDECAR_MIN_VERSION && data.pid && nodeCp) {
                    try { nodeCp.spawnSync('taskkill.exe', ['/PID', String(data.pid), '/T', '/F'], { windowsHide: true }); } catch (eKill) {}
                } else {
                    updateBadge(true, 'Sidecar ✓');
                    if (cb) cb(true, data);
                    return;
                }
            }
            if (starting) {
                setTimeout(function () { ensureRunning(cb); }, 500);
                return;
            }
            starting = true;
            updateBadge(false, 'Sidecar…');
            var nodeExe = findNodeExe();
            var srvScript = findServerScript();
            if (nodeCp && nodeExe && srvScript) {
                try {
                    var child = nodeCp.spawn(nodeExe, [srvScript], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    });
                    if (child && typeof child.unref === 'function') child.unref();
                } catch (eSp) {
                    startInProcessFallback(srvScript);
                }
            } else if (srvScript) {
                startInProcessFallback(srvScript);
            }
            var tries = 0;
            function waitHealth() {
                tries++;
                if (tries === 3 && srvScript) {
                    // Nếu máy người dùng (ví dụ nâng cấp OTA từ V2) không cài Node.js rời bên ngoài,
                    // tự động nạp server.js ngay trên nhân Node.js tích hợp sẵn của CEP!
                    startInProcessFallback(srvScript);
                }
                httpReq('GET', '/health', null, function (e2, d2) {
                    if (!e2 && d2 && d2.ok) {
                        starting = false;
                        updateBadge(true, 'Sidecar ✓');
                        if (cb) cb(true, d2);
                        return;
                    }
                    if (tries >= 12) {
                        starting = false;
                        updateBadge(false, 'Sidecar ✗');
                        if (cb) cb(false, null);
                        return;
                    }
                    setTimeout(waitHealth, 400);
                });
            }
            setTimeout(waitHealth, 350);
        });
    }

    function isCancelRequested() {
        return !!(cancelled || (state.isRunning && state.shouldCancel) || (state.relink && state.relink.cancelled));
    }

    function pollJob(jobId, displayLabel, onStatus, cb) {
        if (activePollTimer) { clearTimeout(activePollTimer); activePollTimer = null; }
        function tick() {
            if (isCancelRequested()) {
                httpReq('POST', '/cancel', {}, function () {});
                hideCopyProgress();
                cb({ ok: false, cancelled: true, error: 'Đã huỷ' });
                return;
            }
            httpReq('GET', '/job?id=' + encodeURIComponent(jobId), null, function (err, res) {
                if (err || !res || !res.ok || !res.job) {
                    activePollTimer = setTimeout(tick, 400);
                    return;
                }
                var j = res.job;
                if (onStatus && j.message) onStatus(j.message);
                var pct = Math.max(0, Math.min(100, Number(j.percent) || 0));
                var realTotal = j.totalBytes > 0 ? j.totalBytes : 0;
                var realDone = j.downloadedBytes || j.bytesDone || (realTotal > 0 ? Math.round(realTotal * pct / 100) : 0);
                showCopyProgress(displayLabel + (j.stage === 'convert' ? ' [Convert H.264]' : ''), realDone, realTotal, j.speedBps || 0, pct);
                if (j.status === 'done') {
                    activePollTimer = null;
                    hideCopyProgress(false);
                    cb(j.result || { ok: true, filePath: j.destPath });
                    return;
                }
                if (j.status === 'error' || j.status === 'cancelled') {
                    activePollTimer = null;
                    hideCopyProgress(false);
                    cb({ ok: false, cancelled: j.status === 'cancelled', error: j.error || 'Lỗi xử lý trên Sidecar' });
                    return;
                }
                activePollTimer = setTimeout(tick, 300);
            });
        }
        tick();
    }

    function downloadYouTubeSingle(item, footageDir, onStatus, cb) {
        cancelled = false;
        ensureRunning(function (online) {
            if (!online) {
                cb({ ok: false, error: 'Sidecar Backend chưa khởi động được' });
                return;
            }
            httpReq('POST', '/start-youtube', {
                url: item.url,
                id: item.id,
                destPath: item.destPath,
                footageDir: footageDir
            }, function (err, res) {
                if (err || !res || !res.ok || !res.jobId) {
                    cb({ ok: false, error: (res && res.error) ? res.error : 'Không tạo được tác vụ tải YouTube' });
                    return;
                }
                pollJob(res.jobId, 'YouTube [' + (item.id || '') + ']', onStatus, cb);
            });
        });
    }

    function downloadYouTubeBatch(items, footageDir, onStep, cb) {
        cancelled = false;
        var idx = 0, downloadedCount = 0, errors = [];
        function next() {
            if (isCancelRequested()) {
                cb({ ok: false, cancelled: true, downloadedCount: downloadedCount, errors: errors });
                return;
            }
            if (idx >= items.length) {
                cb({ ok: true, downloadedCount: downloadedCount, errors: errors });
                return;
            }
            var item = items[idx];
            downloadYouTubeSingle(item, footageDir, function (msg) {
                if (onStep) onStep(item, idx, items.length, msg);
            }, function (res) {
                if (res.cancelled) {
                    cb({ ok: false, cancelled: true, downloadedCount: downloadedCount, errors: errors });
                    return;
                }
                if (!res.ok) {
                    errors.push((item.id || item.url) + ': ' + res.error);
                    addLog('warning', 'YouTube [' + (item.id || '') + ']: ' + res.error);
                } else {
                    if (!res.cached) {
                        downloadedCount++;
                        var convNote = res.converted ? (' · Đã tự động convert codec ' + (res.originalVideoCodec || '') + ' → H.264 MP4') : '';
                        addLog('success', 'Đã tải YouTube [' + (item.id || '') + '] → yt_' + item.id + '.mp4' + convNote);
                    }
                }
                idx++;
                next();
            });
        }
        next();
    }

    function convertVideoForPremiere(filePath, footageDir, forceTranscode, onStatus, cb) {
        cancelled = false;
        ensureRunning(function (online) {
            if (!online) {
                cb({ ok: false, error: 'Sidecar Backend chưa khởi động được' });
                return;
            }
            var baseName = nodePath ? nodePath.basename(filePath) : String(filePath).split(/[\\/]/).pop();
            httpReq('POST', '/start-convert', {
                filePath: filePath,
                footageDir: footageDir,
                forceTranscode: !!forceTranscode
            }, function (err, res) {
                if (err || !res || !res.ok || !res.jobId) {
                    cb({ ok: false, error: (res && res.error) ? res.error : 'Không tạo được tác vụ convert codec' });
                    return;
                }
                pollJob(res.jobId, baseName, onStatus, function (convRes) {
                    if (convRes && convRes.ok && convRes.filePath) {
                        var normOrig = String(filePath).replace(/\\/g, '/').toLowerCase();
                        state.convertedFiles[normOrig] = convRes.filePath;
                        state.convertedFiles[filePath] = convRes.filePath;
                    }
                    cb(convRes);
                });
            });
        });
    }

    function trimCopySingle(item, footageDir, onStatus, cb) {
        cancelled = false;
        ensureRunning(function (online) {
            if (!online) {
                cb({ ok: false, error: 'Sidecar Backend chưa khởi động được' });
                return;
            }
            var baseName = item.name || (nodePath ? nodePath.basename(item.srcPath) : String(item.srcPath).split(/[\\/]/).pop());
            httpReq('POST', '/start-trim-copy', {
                trimKey: item.trimKey || '',
                srcPath: item.srcPath,
                footageDir: footageDir,
                padSec: (typeof item.padSec === 'number') ? item.padSec : 10,
                rangeSpec: item.rangeSpec || {}
            }, function (err, res) {
                if (err || !res || !res.ok || !res.jobId) {
                    cb({ ok: false, error: (res && res.error) ? res.error : 'Không tạo được tác vụ cắt gọn file nặng' });
                    return;
                }
                pollJob(res.jobId, '✂️ Cắt gọn ' + baseName, onStatus, function (trimRes) {
                    if (trimRes && trimRes.ok && trimRes.filePath) {
                        if (item.trimKey) {
                            state.trimmedFiles[item.trimKey] = trimRes;
                        }
                        if (!trimRes.cached && trimRes.bytes > 0) {
                            state.copiedBytes += trimRes.bytes;
                        }
                    }
                    cb(trimRes);
                });
            });
        });
    }

    function trimCopyBatch(items, footageDir, onStep, cb) {
        cancelled = false;
        var idx = 0, copiedCount = 0, errors = [];
        function next() {
            if (isCancelRequested()) {
                cb({ ok: false, cancelled: true, copiedCount: copiedCount, errors: errors });
                return;
            }
            if (idx >= items.length) {
                cb({ ok: true, copiedCount: copiedCount, errors: errors });
                return;
            }
            var item = items[idx];
            trimCopySingle(item, footageDir, function (msg) {
                if (onStep) onStep(item, idx, items.length, msg);
            }, function (res) {
                if (res && res.cancelled) {
                    cb({ ok: false, cancelled: true, copiedCount: copiedCount, errors: errors });
                    return;
                }
                if (!res || !res.ok) {
                    var errMsg = (res && res.error) ? res.error : 'Lỗi cắt gọn file nặng';
                    errors.push((item.name || item.srcPath) + ': ' + errMsg);
                    addLog('warning', 'Cắt gọn file nặng [' + (item.name || '') + '] thất bại: ' + errMsg + ' → sẽ dùng cách copy thường');
                } else {
                    var outName = nodePath ? nodePath.basename(res.filePath) : String(res.filePath).split(/[\\/]/).pop();
                    var savedMB = res.bytes ? (Math.round(res.bytes / 1048576 * 10) / 10 + ' MB') : '';
                    var origGB = item.sizeBytes ? (Math.round(item.sizeBytes / 1073741824 * 100) / 100 + ' GB') : '';
                    if (!res.cached) {
                        copiedCount++;
                        addLog('success', '✂️ Đã copy cắt gọn (' + origGB + ' → ' + savedMB + ', ±' + (res.padSec !== undefined ? res.padSec : 10) + 's): ' + outName);
                    } else {
                        addLog('info', '✂️ Dùng lại đoạn cắt gọn đã có trong Footage/: ' + outName);
                    }
                }
                idx++;
                next();
            });
        }
        next();
    }

    function cancel() {
        cancelled = true;
        if (activePollTimer) { clearTimeout(activePollTimer); activePollTimer = null; }
        httpReq('POST', '/cancel', {}, function () {});
        hideCopyProgress();
    }

    return {
        ensureRunning: ensureRunning,
        isBusy: function () { return !!activePollTimer; },
        isOnline: function () { return isOnline; },
        downloadYouTubeBatch: downloadYouTubeBatch,
        convertVideoForPremiere: convertVideoForPremiere,
        trimCopySingle: trimCopySingle,
        trimCopyBatch: trimCopyBatch,
        cancel: cancel
    };
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

var _hideCopyTimer = null;

function showCopyProgress(name, bytes, total, speedBytesPerSec, overridePercent) {
    if (_hideCopyTimer) {
        clearTimeout(_hideCopyTimer);
        _hideCopyTimer = null;
    }
    if (!dom.copyProgressRow) return;
    if (!dom.copyProgressRow.classList.contains("visible")) {
        dom.copyProgressRow.classList.add("visible");
    }
    var fileLabel = "📄 " + name;
    if (dom.copyFileName && dom.copyFileName.textContent !== fileLabel) {
        dom.copyFileName.textContent = fileLabel;
    }
    var spdText = (speedBytesPerSec > 0 ? (speedBytesPerSec / 1048576).toFixed(1) : "0.0") + " MB/s";
    if (dom.copySpeed && dom.copySpeed.textContent !== spdText) {
        dom.copySpeed.textContent = spdText;
    }

    // --- File đang copy / cắt gọn ---
    var percent = (total > 0)
        ? Math.min(100, Math.round((bytes / total) * 100))
        : ((typeof overridePercent === "number" && overridePercent >= 0) ? Math.min(100, Math.round(overridePercent)) : 0);
    var widthStr = percent + "%";
    if (dom.copyBarFill && dom.copyBarFill.style.width !== widthStr) {
        dom.copyBarFill.style.width = widthStr;
    }
    if (dom.copyBytes) {
        var bytesText;
        if (total > 0) {
            bytesText = formatBytes(bytes) + " / " + formatBytes(total) + " · " + percent + "%";
        } else if (typeof overridePercent === "number" && overridePercent >= 0) {
            bytesText = (bytes > 0 ? ("Đã xử lý " + formatBytes(bytes) + " · ") : "") + percent + "%";
        } else {
            bytesText = "Đã copy " + formatBytes(bytes);
        }
        if (dom.copyBytes.textContent !== bytesText) {
            dom.copyBytes.textContent = bytesText;
        }
    }

    // --- Tổng tiến độ theo thời gian thực ---
    if (!dom.copyTotal) return;
    var plan = state.copyPlan;
    if (plan && plan.totalBytes > 0) {
        var doneBytes = Math.min(plan.totalBytes, plan.doneBytes + bytes);
        var totalPercent = Math.min(100, Math.round((doneBytes / plan.totalBytes) * 100));
        var eta = (speedBytesPerSec > 1024) ? formatEta((plan.totalBytes - doneBytes) / speedBytesPerSec) : "";
        var totTxt = "Tổng: " + formatBytes(doneBytes) + " / " + formatBytes(plan.totalBytes) +
                     " · " + totalPercent + "%" + (eta ? (" · " + eta) : "");
        if (dom.copyTotal.textContent !== totTxt) dom.copyTotal.textContent = totTxt;
        if (dom.progressBarFill) dom.progressBarFill.style.width = totalPercent + "%";
        if (dom.progressPercent) dom.progressPercent.textContent = totalPercent + "%";
    } else {
        var sessionBytes = state.copiedBytes + bytes;
        var sessTxt = "Tổng đã copy trong phiên: " + formatBytes(sessionBytes);
        if (dom.copyTotal.textContent !== sessTxt) dom.copyTotal.textContent = sessTxt;
    }
}

function hideCopyProgress(immediate) {
    if (_hideCopyTimer) {
        clearTimeout(_hideCopyTimer);
        _hideCopyTimer = null;
    }
    if (!dom.copyProgressRow) return;
    if (immediate === true || (!state.isRunning && !state.relink)) {
        dom.copyProgressRow.classList.remove("visible");
        if (dom.copyBarFill) dom.copyBarFill.style.width = "0%";
        return;
    }
    // Khi đang trong luồng cắt / relink nhiều dòng liên tiếp, giữ khung tiến độ ổn định 1.2s
    // để không bị đóng/mở giật cục (chớp 1 frame cắt / 1 frame tiến độ) giữa các dòng.
    _hideCopyTimer = setTimeout(function () {
        _hideCopyTimer = null;
        if ((typeof FastCopy !== "undefined" && FastCopy.isBusy()) ||
            (typeof SidecarClient !== "undefined" && SidecarClient.isBusy && SidecarClient.isBusy()) ||
            (typeof EnvatoDownloader !== "undefined" && EnvatoDownloader.isBusy && EnvatoDownloader.isBusy())) {
            return;
        }
        dom.copyProgressRow.classList.remove("visible");
        if (dom.copyBarFill) dom.copyBarFill.style.width = "0%";
    }, 1200);
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
    updateEnvatoAuthUI();
    SidecarClient.ensureRunning();
    setInterval(function () { SidecarClient.ensureRunning(); }, 10000);
    updateLogVisibility();
    setInterval(checkPremiereEnvironment, 5000);

    // Kiểm tra trạng thái đăng nhập Envato ngầm (không tự mở trình duyệt)
    setTimeout(function () {
        EnvatoDownloader.checkLoginStatus({ openIfNeeded: false });
    }, 1500);

    // Vừa cập nhật xong ở lần chạy trước? Báo kết quả ngay, trước mọi thứ khác.
    // (reportUpdateResult tự gọi syncHostScript trong trường hợp đó.)
    if (!reportUpdateResult()) {
        // Mở panel bình thường: vẫn kiểm tra script trong Premiere có đúng bản không.
        // Cần thiết vì CEP tiêm lại bản script cũ mỗi lần panel nạp lại trang, nên
        // script có thể bị tụt lại kể cả khi không có cập nhật nào vừa diễn ra.
        syncHostScript(function () {});
    }

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
// Hỗ trợ nhận cả cờ từ bản V2 khi người dùng nâng cấp OTA trực tiếp từ V2 -> V3.
var LS_UPDATED_TO = "autoimportcut_v3_updated_to";
var LS_UPDATE_HOSTMSG = "autoimportcut_v3_update_hostmsg";  // lý do nạp lại script thất bại
var LS_V2_UPDATED_TO = "autoimportcut_v2_updated_to";
var LS_V2_UPDATE_HOSTMSG = "autoimportcut_v2_update_hostmsg";

/**
 * Chạy ngay khi mở panel: nếu lần trước vừa cập nhật thì báo kết quả.
 * Đối chiếu với APP_VERSION đang chạy thật, không tin suông vào cờ đã lưu -
 * nhờ vậy bắt được cả trường hợp file đã ghi nhưng panel vẫn nạp code cũ.
 * Trả về true nếu vừa có cập nhật (và đã tự lo phần đồng bộ script).
 */
function reportUpdateResult() {
    var flag = null;
    try {
        flag = localStorage.getItem(LS_UPDATED_TO) || localStorage.getItem(LS_V2_UPDATED_TO);
    } catch (e) { return false; }
    if (!flag) return false;
    try {
        localStorage.removeItem(LS_UPDATED_TO);
        localStorage.removeItem(LS_UPDATE_HOSTMSG);
        localStorage.removeItem(LS_V2_UPDATED_TO);
        localStorage.removeItem(LS_V2_UPDATE_HOSTMSG);
    } catch (e2) {}

    if (flag !== APP_VERSION) {
        showAlert("Cập nhật chưa có hiệu lực",
            "Đã tải bản <strong>" + escapeHtml(flag) + "</strong> nhưng panel vẫn đang chạy bản <strong>" +
            escapeHtml(APP_VERSION) + "</strong>.<br><br>Đóng panel rồi mở lại (Window › Extensions).", "warning");
        return true;
    }

    addLog("success", "Đã cập nhật lên phiên bản " + APP_VERSION);
    syncHostScript(function (ok, loaded, detail) {
        if (ok) {
            showAlert("Đã cập nhật phiên bản mới",
                "Panel và script trong Premiere đều đang chạy bản <strong>" + escapeHtml(APP_VERSION) +
                "</strong>.<br><br>Không cần khởi động lại Premiere, dùng tiếp được ngay.", "success");
        } else {
            var diag = detail
                ? '<br><br><span style="opacity:.75;font-size:10.5px">Chẩn đoán: ' + escapeHtml(detail) + "</span>"
                : "";
            showAlert("Đã cập nhật phiên bản mới",
                "Panel đã lên bản <strong>" + escapeHtml(APP_VERSION) + "</strong>, nhưng script bên trong Premiere " +
                "vẫn là bản <strong>" + escapeHtml(loaded || "cũ") + "</strong>.<br><br>" +
                "<strong>Hãy khởi động lại Premiere Pro</strong> để dùng được đầy đủ bản mới." + diag, "warning");
        }
    });
    return true;
}

/**
 * Bảo đảm script chạy trong Premiere đúng bằng phiên bản panel — nạp lại nếu lệch.
 *
 * PHẢI làm ở đây, lúc panel vừa mở, chứ KHÔNG phải ngay sau khi ghi file cập nhật:
 * CEP giữ sẵn một bản script từ lúc Premiere khởi động và tự tiêm lại mỗi khi panel
 * nạp lại trang, đè mất bản ta vừa nạp. Nạp trước reload nên luôn công cốc.
 * Gọi ở đây thì không còn lần nạp lại nào phía sau để đè lên nữa.
 */
function syncHostScript(cb) {
    var probe = "(function(){ try { return (($.global.AIC_V3 && $.global.AIC_V3.IMPORTCUT_VERSION) ? $.global.AIC_V3.IMPORTCUT_VERSION : '') + '|' + (typeof resolveSourceFileOnly === 'function' ? '1' : '0') + '|' + (typeof findCachedEnvatoFile === 'function' ? '1' : '0'); } catch(e) { return ''; } })()";
    csInterface.evalScript(probe, function (b) {
        var raw = String(b === undefined || b === null ? "" : b).replace(/^"|"$/g, "");
        var parts = raw.split("|");
        var loaded = parts[0] || "";
        var hasNewCopyEngine = (parts[1] === "1");
        var hasEnvatoSupport = (parts[2] === "1");
        if (loaded === APP_VERSION && hasNewCopyEngine && hasEnvatoSupport) { cb(true, loaded, ""); return; }
        if (typeof Updater === "undefined" || !Updater.reloadHost) { cb(false, loaded, "khong co Updater.reloadHost"); return; }

        addLog("info", "Đang nạp lại script tốc độ cao vào Premiere (bản " + APP_VERSION + ")…");
        Updater.reloadHost(APP_VERSION).then(function (r) {
            if (r.ok) addLog("success", "Đã nạp lại script trong Premiere: bản " + APP_VERSION);
            else addLog("warning", "Nạp lại script thất bại — " + (r.detail || ""));
            cb(r.ok, r.after || loaded, r.detail || "");
        });
    });
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
    if (dom.txtSingleTimeAfterSec && dom.radioSingleAfter) {
        dom.txtSingleTimeAfterSec.addEventListener("focus", function () { dom.radioSingleAfter.checked = true; });
        dom.txtSingleTimeAfterSec.addEventListener("input", function () { dom.radioSingleAfter.checked = true; });
    }
    if (dom.txtSingleTimeSec && dom.radioSingleBefore) {
        dom.txtSingleTimeSec.addEventListener("focus", function () { dom.radioSingleBefore.checked = true; });
        dom.txtSingleTimeSec.addEventListener("input", function () { dom.radioSingleBefore.checked = true; });
    }
    dom.btnStart.addEventListener("click", function () {
        if (state.scriptValidated) startImportProcess();
    });
    dom.btnCancel.addEventListener("click", cancelCurrentProcess);
    if (dom.btnCopyRelink) dom.btnCopyRelink.addEventListener("click", copyAndRelinkFootage);
    if (dom.btnExportXml) dom.btnExportXml.addEventListener("click", function () { exportProjectXml(false); });
    if (dom.btnOpenXmlDir) dom.btnOpenXmlDir.addEventListener("click", openXmlFolder);
    if (dom.btnEnvatoAuth) {
        dom.btnEnvatoAuth.addEventListener("click", function () {
            EnvatoDownloader.openLoginWindow(function () {
                if (state.scriptValidated && state.mediaCheckItems && state.mediaCheckItems.length > 0) {
                    renderMediaCheck(state.mediaCheckItems);
                }
            });
        });
    }
    if (dom.toastClose) dom.toastClose.addEventListener("click", hideToast);
    if (dom.mediaCheckClose) dom.mediaCheckClose.addEventListener("click", toggleMediaCheck);
    if (dom.mediaCheckStart) dom.mediaCheckStart.addEventListener("click", function () {
        startImportProcess();
    });
    if (dom.logToggle) dom.logToggle.addEventListener("click", function () {
        state.logExpanded = !state.logExpanded;
        updateLogVisibility();
    });
    if (dom.configToggle && dom.configCard) {
        // Bam vao CA thanh tieu de, khong chi rieng chu "Mo rong": CSS da de con
        // tro hinh ban tay tren ca thanh nay (.config-header { cursor: pointer })
        // nen nguoi dung se bam vao chu "Cau hinh dung" truoc.
        // Chi gan MOT listener - o thanh. Click tu nut con noi len day, gan ca hai
        // cho se lam mo roi dong lai ngay lap tuc.
        var configHeader = dom.configCard.querySelector(".config-header") || dom.configToggle;
        configHeader.addEventListener("click", function () {
            var collapsed = dom.configCard.classList.toggle("collapsed");
            dom.configToggle.textContent = collapsed ? "Mở rộng" : "Thu gọn";
            dom.configToggle.title = collapsed ? "Mở rộng" : "Thu gọn";
        });
    }

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
    // Nut nay KHONG con kiem nhiem viec dung nua - viec dung da don ve nut Dung
    // duy nhat trong Progress Card. Dang chay thi bam vao day khong lam gi ca.
    if (state.checkInProgress) return;
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
    resetLoadCheckButton();
    showStopButton(false);
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
        dom.btnLoadCheck.disabled = true;
        dom.btnLoadCheck.innerHTML = "<span>⏳ Đang tải kịch bản…</span>";
    }
    showStopButton(true);

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
    showStopButton(false);
}

function scriptLoadedForCheck() {
    state.scriptValidated = false;
    state.checkInProgress = true;
    state.mediaTypeEnabled = { nas: true, envato: true, youtube: true };
    dom.btnStart.disabled = true;
    dom.btnStart.style.display = "inline-flex";
    dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
    if (dom.btnLoadCheck) { dom.btnLoadCheck.disabled = true; dom.btnLoadCheck.innerHTML = "<span>⏳ Đang chuẩn hoá bằng AI…</span>"; }
    showStopButton(true);
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
    dom.btnLoadCheck.innerHTML = "<span>⏳ Gemini đang chuẩn hoá…</span>";
    showStopButton(true);
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
    dom.btnLoadCheck.innerHTML = "<span>⏳ Đang kiểm tra media…</span>";
    showStopButton(true);
    if (!state.checkProgressTimer) startCheckProgress("Đang kiểm tra đường dẫn và mã file...", 68, 94);
    var payload = {
        csvContent: state.csvContent,
        cols: state.parsedData.cols,
        enableTram: true,
        folderRandomCount: parseInt(dom.txtFolderRandomCount ? dom.txtFolderRandomCount.value : 3, 10) || 3
    };
    evalJson("cep_validateSources(" + toEscapedJson(JSON.stringify(payload)) + ")", function (res, err) {
        if (state.checkCancelled) return;
        resetLoadCheckButton();
        if (err || !res || !res.success) {
            stopCheckProgress();
            state.checkInProgress = false;
            showStopButton(false);
            addLog("error", "Kiểm tra media thất bại: " + (err || (res && res.error) || "Lỗi không xác định"));
            showAlert("Không kiểm tra được media", escapeHtml(String(err || (res && res.error) || "Lỗi không xác định")), "error");
            return;
        }
        stopCheckProgress();
        state.checkInProgress = false;
        state.footageFolderPath = res.footageFolderPath || "";
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

/**
 * Gom cac dong CUNG MOT FILE lai thanh nhom.
 *
 * Kich ban hay cat mot video thanh nhieu doan -> nhieu dong tren Google Sheet
 * nhung ban chat van la MOT file. Truoc day moi dong dem thanh mot file, nen mot
 * file thieu ma dung o 3 dong thi bao "thieu 3 file" - sai va lam nguoi dung
 * tuong phai di tim 3 file khac nhau.
 *
 * checkKey do hostscript sinh ra tu (thu muc + ten file) da chuan hoa, chinh la
 * danh tinh cua file. Trung checkKey = trung file.
 * Giu nguyen thu tu xuat hien dau tien de danh sach khong bi xao tron.
 */
function getItemMediaType(item) {
    if (!item) return "nas";
    if (item.mediaType === "youtube" || item.isYouTube) return "youtube";
    if (item.mediaType === "envato" || item.isEnvato) return "envato";
    var c = String(item.code || item.requested || "").toLowerCase();
    if (c.indexOf("youtube.com/") !== -1 || c.indexOf("youtu.be/") !== -1) return "youtube";
    if (c.indexOf("envato.com/") !== -1) return "envato";
    return "nas";
}

function groupMediaItems(items) {
    var order = [];
    var map = {};
    items.forEach(function (item) {
        // Them tien to de khoa khong dung ten thuoc tinh co san cua Object
        // (vi du mot file ten "constructor" se lam map[key] tra ve ham dung).
        var key = "k_" + (item.checkKey || item.id);
        if (!map[key]) {
            map[key] = { items: [], found: true, mediaType: getItemMediaType(item) };
            order.push(map[key]);
        }
        map[key].items.push(item);
        if (!item.found) map[key].found = false;
    });
    return order;
}

/** Phan ruot chung cua mot dong: tieu de dong + o duong dan + o ten file. */
function mediaRowMain(item) {
    return '<div class="media-check-main"><strong>Dòng ' + item.rowNumber + ' · ' + escapeHtml(item.kind) + '</strong>' +
        '<div class="media-check-field"><span>Đường dẫn</span><input readonly value="' + escapeHtml(item.displayFolder || "(đường dẫn đầy đủ)") + '"><button class="btn-copy-media" data-copy-value="' + escapeHtml(item.displayFolder || "") + '" title="Copy đường dẫn">⧉</button></div>' +
        '<div class="media-check-field"><span>Tên file</span><input readonly value="' + escapeHtml(item.displayName || item.code || "") + '"><button class="btn-copy-media" data-copy-value="' + escapeHtml(item.displayName || item.code || "") + '" title="Copy tên file">⧉</button></div></div>';
}

/**
 * Ve mot nhom. Nhom 1 dong thi ve y het kieu cu (khong ve dau ngoac cho roi mat).
 * Nhom nhieu dong thi boc trong dau ngoac "{" va CHI co mot nut Tim & thay the:
 * cep_setSourceReplacement luu theo (thu muc + ten file) nen thay mot lan la ca
 * nhom duoc thay, khong can bam lai tung dong.
 */
function renderMediaGroup(group) {
    var first = group.items[0];
    var mType = group.mediaType || getItemMediaType(first);
    var isEnabled = !state.mediaTypeEnabled || state.mediaTypeEnabled[mType] !== false;
    var status = !isEnabled ? "check-disabled" : (group.found ? "check-found" : "check-not-found");
    var isEnvato = (mType === "envato");
    var isYouTube = (mType === "youtube");
    var isCached = !!(first && (first.envatoCached || (isEnvato && EnvatoDownloader.findLocalCachedFile(state.footageFolderPath, first.code))));
    var isYtCached = !!(first && first.ytCached);
    var label;
    if (!isEnabled) {
        label = "⏸️ Đã tắt (Bỏ qua)";
    } else if (group.found) {
        if (isEnvato) label = isCached ? "✓ Đã có trong Footage" : "☁️ Envato (Tự tải 4K)";
        else if (isYouTube) label = isYtCached ? "✓ Đã có trong Footage" : "▶️ YouTube (Tự tải MP4)";
        else label = "✓ Đã tìm thấy";
    } else {
        label = "✕ Không tìm thấy";
    }
    var many = group.items.length > 1;
    var action = (!isEnabled || group.found) ? "" :
        '<button class="btn-find-media" data-media-id="' + escapeHtml(first.id) + '">🔎 Tìm &amp; thay thế' +
        (many ? " (cả " + group.items.length + " dòng)" : "") + '</button>';

    if (!many) {
        return '<div class="media-check-row ' + status + '">' + mediaRowMain(first) +
            '<span class="media-check-status">' + label + '</span>' + action + '</div>';
    }

    var rowNumbers = group.items.map(function (item) { return item.rowNumber; }).join(", ");
    var rows = group.items.map(function (item) {
        return '<div class="media-check-row ' + status + ' is-grouped">' + mediaRowMain(item) + '</div>';
    }).join("");

    return '<div class="media-group ' + status + '">' +
            '<div class="media-group-brace" aria-hidden="true"></div>' +
            '<div class="media-group-body">' +
                '<div class="media-group-head">🔗 Cùng 1 file · dùng ở ' + group.items.length + ' dòng: ' + rowNumbers + '</div>' +
                rows +
                '<div class="media-group-foot"><span class="media-check-status">' + label + '</span>' + action + '</div>' +
            '</div>' +
        '</div>';
}

function renderMediaCheck(items, isToggleRefresh) {
    if (!state.mediaTypeEnabled) {
        state.mediaTypeEnabled = { nas: true, envato: true, youtube: true };
    }
    // Dem theo FILE chu khong theo dong: 1 file cat lam 3 doan van la 1 file.
    var groups = groupMediaItems(items);
    var totalFiles = groups.length;

    var nasGroups = groups.filter(function (g) { return g.mediaType === "nas"; });
    var envatoGroups = groups.filter(function (g) { return g.mediaType === "envato"; });
    var youtubeGroups = groups.filter(function (g) { return g.mediaType === "youtube"; });

    var activeGroups = groups.filter(function (g) { return state.mediaTypeEnabled[g.mediaType] !== false; });
    var missing = activeGroups.filter(function (group) { return !group.found; }).length;

    var envatoCachedCount = envatoGroups.filter(function (g) {
        var f = g.items[0];
        return f && (f.envatoCached || EnvatoDownloader.findLocalCachedFile(state.footageFolderPath, f.code));
    }).length;
    var envatoNeedDlCount = envatoGroups.length - envatoCachedCount;

    var summaryHtml = "Đã kiểm tra <strong>" + totalFiles + "</strong> file" +
        (items.length > totalFiles ? " (" + items.length + " dòng)" : "") + ": " +
        "<span class=\"check-ok\">" + (activeGroups.length - missing) + " hợp lệ đang bật</span>" +
        (missing > 0 ? (", <span class=\"check-missing\">" + missing + " chưa tìm thấy</span>") : "") +
        (activeGroups.length < totalFiles ? (", <span class=\"check-skipped-note\">" + (totalFiles - activeGroups.length) + " đang tắt</span>") : "") + ".";

    // Thanh bật/tắt 3 thể loại media (chỉ hiển thị thể loại nào thực sự tìm thấy trong kịch bản)
    var typeTogglesHtml = "";
    function buildTypeToggleBtn(typeKey, icon, titleText, count) {
        var isOn = (state.mediaTypeEnabled[typeKey] !== false);
        return '<button type="button" class="media-type-toggle ' + (isOn ? 'is-on' : 'is-off') + ' type-' + typeKey + '" data-media-type="' + typeKey + '" title="Bấm để bật/tắt tải và cắt ' + titleText + '">' +
            '<span class="mtt-switch"><span class="mtt-knob"></span></span>' +
            '<span class="mtt-label">' + icon + ' ' + titleText + '</span>' +
            '<span class="mtt-count">' + count + '</span>' +
        '</button>';
    }
    if (nasGroups.length > 0) {
        typeTogglesHtml += buildTypeToggleBtn("nas", "📁", "File NAS", nasGroups.length);
    }
    if (envatoGroups.length > 0) {
        typeTogglesHtml += buildTypeToggleBtn("envato", "🎬", "Envato", envatoGroups.length);
    }
    if (youtubeGroups.length > 0) {
        typeTogglesHtml += buildTypeToggleBtn("youtube", "▶️", "YouTube", youtubeGroups.length);
    }
    if (typeTogglesHtml !== "") {
        summaryHtml += '<div class="media-type-bar">' +
            '<span class="media-type-bar-label">Chọn loại file tải &amp; cắt:</span>' +
            '<div class="media-type-bar-btns">' + typeTogglesHtml + '</div>' +
        '</div>';
    }

    if (envatoGroups.length > 0 && state.mediaTypeEnabled.envato !== false) {
        var logged = EnvatoDownloader.isLoggedIn();
        var user = EnvatoDownloader.getLoggedInUser();
        var needLoginBanner = (!logged && envatoNeedDlCount > 0);
        summaryHtml += '<div class="envato-check-banner' + (needLoginBanner ? ' need-login' : '') + '">' +
            '<div class="envato-banner-info">' +
                '<strong>🎬 Phát hiện ' + envatoGroups.length + ' video Envato</strong> (' +
                (envatoCachedCount > 0 ? (envatoCachedCount + ' đã có trong Footage, ') : '') +
                (envatoNeedDlCount > 0 ? ('cần tải mới ' + envatoNeedDlCount + ' video chất lượng cao nhất 4K/Original') : 'tất cả đã có sẵn trong Footage') + ')' +
                '<span class="envato-banner-sub">' +
                    (logged
                        ? ('✓ Đã đăng nhập Envato (' + escapeHtml(user || 'Active') + ') · Chạy ngầm 100% + bảo vệ tài khoản')
                        : (envatoNeedDlCount > 0
                            ? '⚠️ Yêu cầu đăng nhập tài khoản Envato trên trình duyệt trước khi bắt đầu tải & cắt'
                            : 'ℹ️ Tất cả video Envato trong kịch bản đã được tải sẵn trong thư mục Footage')) +
                '</span>' +
            '</div>' +
            '<button class="btn-envato-action" id="btnBannerEnvatoLogin">' +
                (logged ? '🔄 Kiểm tra / Đổi TK' : '🔑 Đăng nhập Envato') +
            '</button>' +
        '</div>';
    }

    dom.mediaCheckSummary.innerHTML = summaryHtml;
    Array.prototype.forEach.call(dom.mediaCheckSummary.querySelectorAll(".media-type-toggle"), function (btn) {
        btn.addEventListener("click", function () {
            var tKey = btn.getAttribute("data-media-type");
            if (!tKey) return;
            state.mediaTypeEnabled[tKey] = !(state.mediaTypeEnabled[tKey] !== false);
            renderMediaCheck(state.mediaCheckItems || items, true);
        });
    });
    var btnBannerEnvato = document.getElementById("btnBannerEnvatoLogin");
    if (btnBannerEnvato) {
        btnBannerEnvato.addEventListener("click", function () {
            EnvatoDownloader.openLoginWindow(function () {
                renderMediaCheck(state.mediaCheckItems || items, true);
            });
        });
    }
    if (!items.length) dom.mediaCheckList.innerHTML = '<div class="log-empty">Không có file media hợp lệ trong dữ liệu.</div>';
    else dom.mediaCheckList.innerHTML = groups.map(renderMediaGroup).join("");
    Array.prototype.forEach.call(dom.mediaCheckList.querySelectorAll(".btn-find-media"), function (button) {
        button.addEventListener("click", function () { chooseMediaReplacement(items, button.getAttribute("data-media-id")); });
    });
    Array.prototype.forEach.call(dom.mediaCheckList.querySelectorAll(".btn-copy-media"), function (button) {
        button.addEventListener("click", function () { copyMediaText(button.getAttribute("data-copy-value") || ""); });
    });
    state.mediaCheckItems = items;
    state.scriptValidated = true;
    var allDisabled = (totalFiles > 0 && activeGroups.length === 0);
    dom.btnStart.disabled = allDisabled;
    dom.mediaCheckStart.disabled = allDisabled;
    if (allDisabled) {
        dom.mediaCheckStart.textContent = "✂️ Hãy bật ít nhất 1 loại file để cắt";
    } else {
        dom.mediaCheckStart.textContent = missing ? "✂️ Bắt đầu cắt (bỏ qua file thiếu)" : "✂️ Bắt đầu cắt";
    }
    if (!isToggleRefresh) {
        dom.mediaCheckPanel.classList.add("visible");
        dom.mediaCheckPanel.classList.remove("collapsed"); // ket qua moi -> luon mo san
        dom.mediaCheckClose.textContent = "Thu gọn";
        dom.mediaCheckClose.title = "Thu gọn";
        showStopButton(false);
        state.checkInProgress = false;
        resetLoadCheckButton();
        dom.progressBarFill.style.width = "100%";
        dom.progressPercent.textContent = "100%";
        dom.progressStepText.textContent = "Đã kiểm tra kịch bản";
        dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
        var breakdown = [];
        if (nasGroups.length > 0) breakdown.push(nasGroups.length + " File NAS");
        if (envatoGroups.length > 0) breakdown.push(envatoGroups.length + " Envato");
        if (youtubeGroups.length > 0) breakdown.push(youtubeGroups.length + " YouTube");
        addLog(missing ? "warning" : "success", "Kiểm tra media: " + (totalFiles - missing) + "/" + totalFiles + " file hợp lệ" +
            (breakdown.length > 0 ? (" [" + breakdown.join(", ") + "]") : "") +
            (items.length > totalFiles ? (" (" + items.length + " dòng dùng chung các file này).") : "."));
    }
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
    if (!state.parsedData || state.isRunning) return;

    // Kiểm tra xem kịch bản có chứa link Envato chưa tải về Footage/ hay không (chỉ khi tuỳ chọn Envato đang bật)
    var envatoEnabled = !state.mediaTypeEnabled || state.mediaTypeEnabled.envato !== false;
    var uncachedEnvato = !envatoEnabled ? [] : (state.mediaCheckItems || []).filter(function (item) {
        if (!item || !item.isEnvato) return false;
        if (item.envatoCached) return false;
        var cachedLocal = EnvatoDownloader.findLocalCachedFile(state.footageFolderPath, item.code);
        return !cachedLocal;
    });

    if (uncachedEnvato.length > 0) {
        dom.btnStart.disabled = true;
        dom.btnStart.innerHTML = "<span>⏳ Kiểm tra Envato…</span>";
        if (dom.mediaCheckStart) dom.mediaCheckStart.disabled = true;
        addLog("info", "Đang kiểm tra trạng thái đăng nhập tài khoản Envato trước khi tải " + uncachedEnvato.length + " mục...");

        EnvatoDownloader.checkLoginStatus({ openIfNeeded: true }, function (authRes) {
            if (authRes && authRes.loggedIn) {
                if (state.mediaCheckItems && state.mediaCheckItems.length > 0) {
                    renderMediaCheck(state.mediaCheckItems);
                }
                startImportProcessCore();
                return;
            }

            resetStartButton();
            if (dom.mediaCheckStart) dom.mediaCheckStart.disabled = false;

            // Tự động lắng nghe khi người dùng đăng nhập xong trên cửa sổ Chrome vừa mở
            EnvatoDownloader.openLoginWindow(function () {
                if (isDialogOpen()) closeDialog(false);
                if (state.mediaCheckItems && state.mediaCheckItems.length > 0) {
                    renderMediaCheck(state.mediaCheckItems);
                }
                if (!state.isRunning) {
                    startImportProcessCore();
                }
            });

            showConfirm(
                "Yêu cầu đăng nhập Envato trước khi tải",
                "Kịch bản có chứa video từ <strong>Envato</strong> cần tải về thư mục <code>Footage/</code>.<br><br>" +
                "Cửa sổ trình duyệt <strong>Envato</strong> đã được mở. Vui lòng đăng nhập <strong>tài khoản cá nhân</strong> của bạn trên trình duyệt đó.<br><br>" +
                "• Ưu tiên tải chất lượng cao nhất (<strong>4K / Original</strong>)<br>" +
                "• Tải tuần tự từng video kèm độ trễ ngẫu nhiên (3.5–6.5s) để <strong>phòng tránh khoá tài khoản</strong><br><br>" +
                "<em>Sau khi bạn đăng nhập xong trên trình duyệt, panel sẽ tự động phát hiện và bắt đầu tải &amp; cắt ngay!</em>",
                "🔄 Đã đăng nhập, kiểm tra lại",
                function (ok) {
                    if (ok && !state.isRunning) {
                        startImportProcess();
                    }
                }
            );
        });
        return;
    }

    startImportProcessCore();
}

function startImportProcessCore() {
    if (!state.parsedData || state.isRunning) return;

    state.isRunning = true;
    state.shouldCancel = false;
    state.currentRowIdx = 0;
    state.aiClipNames = {};
    state.trimmedFiles = {};
    resetStats();

    // Nut 2 o lai cho cu nhung khoa lai va doi chu - truoc day no bi AN DI va thay
    // bang nut do "Dung lai", lam ba nut chinh nhay cho moi lan chay.
    dom.btnStart.disabled = true;
    dom.btnStart.style.display = "inline-flex";
    dom.btnStart.innerHTML = "<span>⏳ Đang cắt…</span>";
    showStopButton(true);
    dom.progressCard.style.display = "block";

    var config = {
        mainTrackIndex: 0,
        tramTrackIndex: 1,
        enableCopyToLocal: dom.chkCopy.checked,
        smartTrimCopy: dom.chkSmartTrimCopy ? dom.chkSmartTrimCopy.checked : true,
        trimThresholdGB: parseFloat(dom.txtTrimThresholdGB ? dom.txtTrimThresholdGB.value : 1) || 1,
        trimPadSec: (dom.txtTrimPadSec && dom.txtTrimPadSec.value !== "" && !isNaN(parseFloat(dom.txtTrimPadSec.value))) ? Math.max(0, parseFloat(dom.txtTrimPadSec.value)) : 10,
        enableTram: true,
        enableLabel: dom.chkLabel.checked,
        defaultDuration: parseFloat(dom.txtDefaultSec.value) || 5,
        singleTimeEnabled: dom.chkSingleTime.checked,
        singleTimeMode: (dom.radioSingleBefore && dom.radioSingleBefore.checked) ? "before" : "after",
        singleTimeDuration: parseFloat((dom.radioSingleBefore && dom.radioSingleBefore.checked) ? dom.txtSingleTimeSec.value : (dom.txtSingleTimeAfterSec ? dom.txtSingleTimeAfterSec.value : dom.txtSingleTimeSec.value)) || 5,
        noTimecodeMode: dom.radioFullVideo.checked ? "full" : "center",
        noTimecodeDuration: parseFloat(dom.txtCenterTimeSec.value) || 5,
        folderRandomCount: parseInt(dom.txtFolderRandomCount ? dom.txtFolderRandomCount.value : 3, 10) || 3,
        folderRandomDuration: parseFloat(dom.txtFolderRandomDuration ? dom.txtFolderRandomDuration.value : 2) || 2,
        enableNas: !state.mediaTypeEnabled || state.mediaTypeEnabled.nas !== false,
        enableEnvato: !state.mediaTypeEnabled || state.mediaTypeEnabled.envato !== false,
        enableYouTube: !state.mediaTypeEnabled || state.mediaTypeEnabled.youtube !== false,
        footageFolderName: "Footage"
    };

    // Theo dõi % + tốc độ khi có bật copy file về Footage/
    // (luồng Import không biết trước tổng dung lượng nên chỉ cộng dồn số byte đã copy)
    state.copyPlan = null;
    state.copiedBytes = 0;
    if (config.enableCopyToLocal) startCopyMonitor();

    var initScript = "cep_initSession(" + toEscapedJson(JSON.stringify(config)) + "," +
                     toEscapedJson(state.csvContent) + "," +
                     toEscapedJson(JSON.stringify(_sessionCols())) + ")";
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

function buildRowEvalScript(actualDataIndex, rowNumber, deferCopy, preCopiedCount, deferEnvato, preDownloadedCount, deferYouTube, allowConvertRetry, deferTrimCopy) {
    if (deferYouTube === undefined) deferYouTube = true;
    if (allowConvertRetry === undefined) allowConvertRetry = true;
    if (deferTrimCopy === undefined) deferTrimCopy = true;
    return "(function(){ " +
        "var rows = (_session && _session.csvRows) ? _session.csvRows : parseCSV(" + toEscapedJson(state.csvContent) + "); " +
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
        "   labelOverride: " + toEscapedJson(state.aiClipNames[String(rowNumber)] || "") + ", " +
        "   deferCopy: " + (deferCopy ? "true" : "false") + ", " +
        "   deferTrimCopy: " + (deferTrimCopy ? "true" : "false") + ", " +
        "   preCopiedCount: " + (preCopiedCount || 0) + ", " +
        "   deferEnvato: " + (deferEnvato ? "true" : "false") + ", " +
        "   deferYouTube: " + (deferYouTube ? "true" : "false") + ", " +
        "   allowConvertRetry: " + (allowConvertRetry ? "true" : "false") + ", " +
        "   preDownloadedCount: " + (preDownloadedCount || 0) + ", " +
        "   envatoFiles: " + JSON.stringify(state.envatoFiles || {}) + ", " +
        "   convertedFiles: " + JSON.stringify(state.convertedFiles || {}) + ", " +
        "   trimmedFiles: " + JSON.stringify(state.trimmedFiles || {}) + " " +
        "}; " +
        "return cep_processSingleRow(toJson(data)); " +
    "})()";
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

    var useFastCopy = !!(dom.chkCopy.checked && FastCopy.isAvailable());
    var useEnvatoDl = EnvatoDownloader.isAvailable();

    function handleEvalResult(resStr, preDownloadedCount) {
        var result = null;
        try {
            result = JSON.parse(resStr);
        } catch (e) {
            addLog("error", "Dòng " + rowNumber + ": Lỗi xử lý - " + e.toString());
            state.stats.error++;
            updateStatsUI();
            state.currentRowIdx++;
            setTimeout(processNextRow, 20);
            return;
        }

        // Bước 1: Nếu dòng này có link Envato chưa có trong Footage/, tải tuần tự qua trình duyệt thật (4K/Original)
        if (result && result.status === "need_envato_download" && result.downloads && result.downloads.length > 0) {
            var targetDir = result.footageDir || state.footageFolderPath;
            EnvatoDownloader.downloadBatch(result.downloads, targetDir, function (item, idx, total, statusMsg) {
                dom.currentActionText.textContent = "Dòng " + rowNumber + " (" + (idx + 1) + "/" + total + ") — " + statusMsg;
            }, function (dlRes) {
                if (dlRes.cancelled || state.shouldCancel) {
                    finishProcess("Đã dừng bởi người dùng");
                    return;
                }
                if (dlRes.needLogin) {
                    finishProcess("Tạm dừng: Cần đăng nhập tài khoản Envato");
                    showConfirm(
                        "Phiên đăng nhập Envato đã hết hạn",
                        "Tài khoản Envato chưa đăng nhập hoặc vừa hết hạn phiên.<br><br>" +
                        "Đã tự động ngắt tải (Circuit Breaker) để bảo vệ tài khoản của bạn. Vui lòng đăng nhập lại trên cửa sổ trình duyệt trước khi chạy tiếp.",
                        "🔑 Mở trình duyệt đăng nhập",
                        function (ok) {
                            if (ok) EnvatoDownloader.openLoginWindow();
                        }
                    );
                    return;
                }
                dom.currentActionText.textContent = "Đang import & cắt video Envato dòng " + rowNumber + "...";
                var afterDlScript = buildRowEvalScript(actualDataIndex, rowNumber, useFastCopy, 0, false, dlRes.downloadedCount || 0);
                csInterface.evalScript(afterDlScript, function (resStrAfterDl) {
                    handleEvalResult(resStrAfterDl, dlRes.downloadedCount || 0);
                });
            });
            return;
        }

        // Bước 1B (Sidecar Pro V3): Tải YouTube tốc độ cao + tự động convert codec AV1/VP9 sang H.264 MP4
        if (result && result.status === "need_youtube_download" && result.downloads && result.downloads.length > 0) {
            var ytDir = result.footageDir || state.footageFolderPath;
            SidecarClient.downloadYouTubeBatch(result.downloads, ytDir, function (item, idx, total, statusMsg) {
                dom.currentActionText.textContent = "Dòng " + rowNumber + " (" + (idx + 1) + "/" + total + ") — " + statusMsg;
            }, function (ytRes) {
                if (ytRes.cancelled || state.shouldCancel) {
                    finishProcess("Đã dừng bởi người dùng");
                    return;
                }
                var totalDl = (preDownloadedCount || 0) + (ytRes.downloadedCount || 0);
                dom.currentActionText.textContent = "Đang import & cắt video YouTube dòng " + rowNumber + "...";
                var afterYtScript = buildRowEvalScript(actualDataIndex, rowNumber, useFastCopy, 0, false, totalDl, false, true);
                csInterface.evalScript(afterYtScript, function (resStrAfterYt) {
                    handleEvalResult(resStrAfterYt, totalDl);
                });
            });
            return;
        }

        // Bước 1C (Sidecar Pro V3): Nếu Premiere từ chối import vì codec lạ (AV1, VP9, HEVC 10-bit, MKV, WEBM...), tự động convert sang H.264 MP4
        if (result && result.status === "need_codec_convert" && result.filePath) {
            var convDir = result.footageDir || state.footageFolderPath;
            addLog("info", "Dòng " + rowNumber + ": Phát hiện video có codec Premiere không hỗ trợ → Sidecar đang tự động convert sang H.264 MP4...");
            SidecarClient.convertVideoForPremiere(result.filePath, convDir, true, function (cMsg) {
                dom.currentActionText.textContent = "Dòng " + rowNumber + " — " + cMsg;
            }, function (convRes) {
                if (convRes && convRes.cancelled || state.shouldCancel) {
                    finishProcess("Đã dừng bởi người dùng");
                    return;
                }
                if (convRes && convRes.ok && convRes.filePath) {
                    addLog("success", "Dòng " + rowNumber + ": Đã convert codec thành công → " + convRes.filePath.split(/[\\/]/).pop());
                } else {
                    addLog("warning", "Dòng " + rowNumber + ": Convert codec thất bại (" + ((convRes && convRes.error) || "Lỗi FFmpeg") + ")");
                }
                var retryScript = buildRowEvalScript(actualDataIndex, rowNumber, false, 0, false, preDownloadedCount || 0, false, false);
                csInterface.evalScript(retryScript, function (resAfterConv) {
                    handleEvalResult(resAfterConv, preDownloadedCount || 0);
                });
            });
            return;
        }

        // Bước 2A (Sidecar Pro V3): Nếu dòng này có file nặng > X GB cần copy cắt gọn theo Timecode ± Y giây
        if (result && result.status === "need_trim_copy" && result.trims && result.trims.length > 0) {
            var trimDir = result.footageDir || state.footageFolderPath;
            SidecarClient.trimCopyBatch(result.trims, trimDir, function (item, idx, total, statusMsg) {
                dom.currentActionText.textContent = "Dòng " + rowNumber + " (" + (idx + 1) + "/" + total + ") — " + statusMsg;
            }, function (trimRes) {
                if (trimRes.cancelled || state.shouldCancel) {
                    finishProcess("Đã dừng bởi người dùng");
                    return;
                }
                dom.currentActionText.textContent = "Đang chèn clip cắt gọn dòng " + rowNumber + "...";
                var afterTrimScript = buildRowEvalScript(actualDataIndex, rowNumber, useFastCopy, trimRes.copiedCount || 0, false, preDownloadedCount || 0, false, true, false);
                csInterface.evalScript(afterTrimScript, function (resStrAfterTrim) {
                    handleEvalResult(resStrAfterTrim, preDownloadedCount || 0);
                });
            });
            return;
        }

        // Bước 2: Nếu dòng này có file local cần copy về Footage/, dùng FastCopy (Node.js robocopy)
        if (result && result.status === "need_copy" && result.copies && result.copies.length > 0) {
            FastCopy.copyBatch(result.copies, function (item, idx, total) {
                var szMB = item.sizeBytes ? (" (" + (Math.round(item.sizeBytes / 1048576 * 10) / 10) + " MB)") : "";
                dom.currentActionText.textContent = "Dòng " + rowNumber + " — Đang copy (" + (idx + 1) + "/" + total + "): " + (item.name || "") + szMB;
            }, function (batchRes) {
                if (batchRes.cancelled || state.shouldCancel) {
                    finishProcess("Đã dừng bởi người dùng");
                    return;
                }
                dom.currentActionText.textContent = "Đang chèn clip dòng " + rowNumber + "...";
                var cutScript = buildRowEvalScript(actualDataIndex, rowNumber, false, batchRes.copiedCount || 0, false, preDownloadedCount || 0, false, true);
                csInterface.evalScript(cutScript, function (resStr2) {
                    handleEvalResult(resStr2, preDownloadedCount || 0);
                });
            });
            return;
        }

        handleRowResult(rowNumber, result);
        updateStatsUI();
        state.currentRowIdx++;
        setTimeout(processNextRow, 20);
    }

    var rowScript = buildRowEvalScript(actualDataIndex, rowNumber, useFastCopy, 0, useEnvatoDl, 0);
    csInterface.evalScript(rowScript, function (resStr) {
        handleEvalResult(resStr, 0);
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

// =========================================================================
// NUT DUNG DUY NHAT
// =========================================================================

/**
 * Bat/tat nut Dung trong Progress Card.
 * Goi showStopButton(true) khi bat dau mot viec chay dai, va (false) khi viec do
 * ket thuc - du la xong, loi hay bi dung giua chung. Ham nay luon tra nut ve
 * trang thai bam duoc, khong can don dep rieng o cho goi.
 */
function showStopButton(show) {
    if (!dom.btnCancel) return;
    dom.btnCancel.style.display = show ? "inline-flex" : "none";
    dom.btnCancel.disabled = false;
    dom.btnCancel.innerHTML = "<span>⏹️ Dừng</span>";
}

/** Chuyen nut Dung sang trang thai "da bam roi, dang cho dung". */
function markStopping(message) {
    if (dom.btnCancel) {
        dom.btnCancel.disabled = true;
        dom.btnCancel.innerHTML = "<span>⏳ Đang dừng…</span>";
    }
    if (dom.currentActionText) dom.currentActionText.textContent = message;
}

/** Tra nut "Tải & kiểm tra kịch bản" ve chu goc, bam duoc. */
function resetLoadCheckButton() {
    if (!dom.btnLoadCheck) return;
    dom.btnLoadCheck.disabled = false;
    dom.btnLoadCheck.innerHTML = "<span>📥 Tải &amp; kiểm tra kịch bản</span>";
}

/**
 * MOT nut dung cho ca ba viec. Thu tu kiem tra di tu viec "nang" nhat xuong.
 *
 * Khi đang copy qua FastCopy (Node.js robocopy), có thể huỷ ngay lập tức và xoá file
 * đang copy dở trong Footage/.
 */
function cancelCurrentProcess() {
    if (state.relink) {
        state.relink.cancelled = true;
        FastCopy.cancel();
        SidecarClient.cancel();
        markStopping("Đang dừng Copy & Relink…");
        addLog("info", "Đã yêu cầu dừng Copy & Relink Footage.");
        return;
    }
    if (state.isRunning) {
        state.shouldCancel = true;
        FastCopy.cancel();
        EnvatoDownloader.cancel();
        SidecarClient.cancel();
        markStopping("Đang dừng — đợi xong thao tác hiện tại…");
        addLog("info", "Đã yêu cầu dừng Import & Cắt.");
        return;
    }
    if (state.checkInProgress) {
        state.checkCancelled = true;
        state.checkInProgress = false;
        stopCheckProgress();
        showStopButton(false);
        resetLoadCheckButton();
        if (dom.btnStart) {
            dom.btnStart.disabled = true;
            dom.btnStart.innerHTML = "<span>✂️ Bắt đầu cắt</span>";
        }
        dom.currentActionText.textContent = "Đã dừng tải & kiểm tra.";
        addLog("info", "Đã dừng tải & kiểm tra kịch bản theo yêu cầu.");
        return;
    }
    // Khong co viec nao chay ma nut van hien -> tu an di cho sach.
    showStopButton(false);
}

function finishProcess(message) {
    var wasCancelled = state.shouldCancel;
    state.isRunning = false;
    state.shouldCancel = false;
    if (wasCancelled) {
        FastCopy.cancel();
        EnvatoDownloader.cancel();
        SidecarClient.cancel();
    }
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
            btn.title = "Xuất sequence đang mở ra file XML, đặt cùng thư mục và cùng tên với project";
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
            // seqCount do hostscript đếm trực tiếp trong file XML - đây là bằng chứng
            // file thật sự có timeline, không phải chỉ có danh sách clip rời.
            var seqInfo = res.seqCount ? (", " + res.seqCount + " sequence") : "";
            addLog("success", "Đã xuất XML: " + res.path + " (" + kb + " KB" + seqInfo + ")");
            if (res.warning) addLog("warning", res.warning);
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
        "<strong>1.</strong> Copy tất cả video source đang dùng trong Timeline về thư mục <code>Footage/</code> ở thư mục gốc order (cùng cấp _PRJ, File).\n" +
        "<strong>2.</strong> Relink toàn bộ source cũ sang file vừa copy.\n\n" +
        "Premiere sẽ tạm đứng trong lúc copy — đó là bình thường, panel vẫn hiện % và tốc độ.",
        "Bắt đầu copy",
        function (ok) { if (ok) runCopyAndRelink(); });
}

function runCopyAndRelink() {
    hideToast();
    state.shouldCancel = false;
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

        var config = {
            footageFolderName: "Footage",
            smartTrimCopy: dom.chkSmartTrimCopy ? dom.chkSmartTrimCopy.checked : true,
            trimThresholdGB: parseFloat(dom.txtTrimThresholdGB ? dom.txtTrimThresholdGB.value : 1) || 1,
            trimPadSec: (dom.txtTrimPadSec && dom.txtTrimPadSec.value !== "" && !isNaN(parseFloat(dom.txtTrimPadSec.value))) ? Math.max(0, parseFloat(dom.txtTrimPadSec.value)) : 10
        };
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
                errors: [],
                cancelled: false   // nut Dung dat co nay, relinkNextFile doc no
            };
            state.copyPlan = { totalBytes: totalBytes, doneBytes: 0 };
            state.copiedBytes = 0;

            addLog("info", "Tìm thấy " + files.length + " file cần copy (" + (res.skipCount || 0) + " file đã có trong Footage/)" +
                           (totalBytes > 0 ? (" — tổng " + formatBytes(totalBytes)) : "") + ".");
            startCopyMonitor();
            // Chi bat nut Dung tu day: buoc quet Timeline o tren la mot lenh
            // ExtendScript chay lien mach, co bam cung khong cat ngang duoc.
            showStopButton(true);
            relinkNextFile();
        });
    });
}

function relinkNextFile() {
    var st = state.relink;
    if (!st) return;

    // Nguoi dung bam Dung: khong bat dau file ke tiep nua. File dang copy dở thì
    // vẫn để nó copy xong (Premiere dang bi khoa, cat ngang se de lai file hong).
    if (st.cancelled) {
        finishRelink(true);
        return;
    }

    var total = st.files.length;
    if (st.idx >= total) {
        finishRelink(false);
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

    function doExtendScriptRelink(preCopied, trimResObj) {
        if (st.cancelled) {
            finishRelink(true);
            return;
        }
        var trimArg = trimResObj ? ("," + toEscapedJson(JSON.stringify(trimResObj))) : "";
        evalJson("cep_copyRelinkOne(" + JSON.stringify(String(st.idx)) + "," + (preCopied ? "1" : "0") + trimArg + ")", function (res, err) {
            if (err) {
                st.failed++;
                st.errors.push(f.name + ": " + err);
                addLog("error", f.name + ": " + err);
            } else if (!res.success) {
                st.failed++;
                st.errors.push(res.error || "Lỗi không xác định");
                addLog("error", res.error || ("Lỗi không xác định với " + f.name));
            } else {
                if (res.copied || preCopied) st.copied++;
                if (res.relinked) st.relinked += res.relinked;
                if (res.note) addLog("warning", f.name + ": " + res.note);
                if (res.error) addLog("warning", f.name + ": " + res.error);
                else addLog("success", f.name + ((res.copied || preCopied) ? " → đã copy" : " → đã có sẵn") + ", relink " + res.relinked + " source");
            }
            // File này xong (copy được hay bỏ qua) -> cộng vào tổng để tính % tổng
            if (state.copyPlan) state.copyPlan.doneBytes += (f.sizeBytes || 0);
            st.idx++;
            setTimeout(relinkNextFile, 15);
        });
    }

    if (f.isTrim && f.mediaPath) {
        SidecarClient.trimCopySingle({
            trimKey: f.trimKey || "",
            srcPath: f.mediaPath,
            name: f.name,
            sizeBytes: f.sizeBytes || 0,
            padSec: (typeof f.padSec === "number") ? f.padSec : 10,
            rangeSpec: { mode: "full", inSec: f.reqInSec || 0, outSec: f.reqOutSec || 5 }
        }, st.footagePath, function (msg) {
            dom.currentActionText.textContent = msg;
        }, function (trimRes) {
            if ((trimRes && trimRes.cancelled) || st.cancelled) {
                finishRelink(true);
                return;
            }
            if (trimRes && trimRes.ok && trimRes.filePath) {
                dom.currentActionText.textContent = "Đang relink đoạn cắt gọn: " + f.name + "...";
                doExtendScriptRelink(!trimRes.cached, trimRes);
            } else {
                addLog("warning", "Cắt gọn " + f.name + " thất bại → chuyển sang copy cả file");
                if (FastCopy.isAvailable()) {
                    var destPathFallback = f.destPath || (String(st.footagePath || "").replace(/[\\\/]+$/, "") + "/" + f.name);
                    FastCopy.copyFile(f.mediaPath, destPathFallback, f.sizeBytes || 0, function (cpRes) {
                        if (cpRes.cancelled || st.cancelled) { finishRelink(true); return; }
                        doExtendScriptRelink(!!(cpRes.ok && cpRes.copied), null);
                    });
                } else {
                    doExtendScriptRelink(false, null);
                }
            }
        });
    } else if (FastCopy.isAvailable() && f.mediaPath) {
        var destPath = f.destPath || (String(st.footagePath || "").replace(/[\\\/]+$/, "") + "/" + f.name);
        FastCopy.copyFile(f.mediaPath, destPath, f.sizeBytes || 0, function (cpRes) {
            if (cpRes.cancelled || st.cancelled) {
                finishRelink(true);
                return;
            }
            dom.currentActionText.textContent = "Đang relink: " + f.name + "...";
            doExtendScriptRelink(!!(cpRes.ok && cpRes.copied), null);
        });
    } else {
        setTimeout(function () { doExtendScriptRelink(false, null); }, 25);
    }
}

function finishRelink(cancelled) {
    var st = state.relink;
    FastCopy.cancel();
    CopyMonitor.stop();
    state.copyPlan = null;
    showStopButton(false);
    setRelinkBusy(false);

    if (cancelled) {
        // Giu nguyen % dang co - keo len 100% se lam tuong la da copy het.
        dom.progressStepText.textContent = "Đã dừng Copy & Relink";
        dom.currentActionText.textContent = "Đã dừng ở file " + st.idx + "/" + st.files.length +
                                            " — đã copy " + st.copied + " file, relink " + st.relinked + " source.";
        addLog("info", "--- COPY & RELINK (đã dừng): copy " + st.copied + "/" + st.files.length +
                       " file | relink " + st.relinked + " source | lỗi " + st.failed + " ---");
        showToast("Đã dừng Copy & Relink",
                  "Dừng ở file " + st.idx + "/" + st.files.length + ". Bấm lại nút Copy & Relink để chạy tiếp phần còn lại.",
                  true);
        state.relink = null;
        return;
    }

    dom.progressBarFill.style.width = "100%";
    dom.progressPercent.textContent = "100%";
    dom.progressStepText.textContent = "Hoàn thành Copy & Relink";
    dom.currentActionText.textContent = "Đã copy " + st.copied + " file, relink " + st.relinked + " source.";

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
