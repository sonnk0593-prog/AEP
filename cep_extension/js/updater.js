/**
 * updater.js - Cập nhật tự động (OTA) từ GitHub cho panel Auto Import & Cut.
 *
 * Cách hoạt động:
 *   1. Tải version.json trên kho, so số phiên bản với APP_VERSION đang chạy.
 *   2. Nếu có bản mới: tải TẤT CẢ file vào bộ nhớ, đối chiếu mã kiểm tra SHA-256.
 *   3. Chỉ khi mọi file đều tải xong và đúng mã mới bắt đầu ghi đè -> tránh
 *      trường hợp mất mạng giữa chừng làm panel hỏng không mở lại được.
 *   4. Sao lưu file cũ vào _backup/ trước khi ghi đè.
 *   5. Nạp lại hostscript.jsx rồi reload panel.
 */
var Updater = (function () {

    // =====================================================================
    // CẤU HÌNH - chỉ cần sửa 4 dòng này
    // =====================================================================
    var REPO_OWNER  = "";              // vd: "thaolee1605"
    var REPO_NAME   = "";              // vd: "auto-import-cut"
    var REPO_BRANCH = "main";          // tên nhánh (main hoặc master)
    var REPO_BASE   = "cep_extension"; // thư mục chứa panel trong kho; để "" nếu ở gốc
    // =====================================================================

    // KHÔNG BAO GIỜ cập nhật manifest qua OTA:
    // - Premiere chỉ đọc manifest lúc khởi động -> đổi cũng không có tác dụng ngay.
    // - Manifest hỏng = Premiere không nạp được panel = không còn gì để tự sửa.
    var NEVER_UPDATE = { "CSXS/manifest.xml": 1 };

    var fs = null, pathMod = null, cryptoMod = null;
    try {
        fs = require("fs");
        pathMod = require("path");
        cryptoMod = require("crypto");
    } catch (e) { fs = null; }

    function configured() { return REPO_OWNER !== "" && REPO_NAME !== ""; }
    function usable() { return !!(fs && pathMod && cryptoMod) && configured(); }

    function extensionDir() {
        try { return csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e) { return ""; }
    }

    /** raw.githubusercontent phục vụ qua CDN có cache ~5 phút -> thêm tham số phá cache. */
    function rawUrl(rel) {
        var base = REPO_BASE ? (REPO_BASE + "/") : "";
        return "https://raw.githubusercontent.com/" + REPO_OWNER + "/" + REPO_NAME +
               "/" + REPO_BRANCH + "/" + base + rel + "?t=" + new Date().getTime();
    }

    /** So sánh "2.10.0" với "2.9.0" theo SỐ, không so chuỗi (chuỗi sẽ cho kết quả sai). */
    function compareVersion(a, b) {
        var pa = String(a).split("."), pb = String(b).split(".");
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
            if (na !== nb) return na > nb ? 1 : -1;
        }
        return 0;
    }

    /** Chặn đường dẫn thoát ra ngoài thư mục panel (../.. hoặc đường dẫn tuyệt đối). */
    function safeRelPath(p) {
        var s = String(p || "").replace(/\\/g, "/");
        if (s === "" || s.charAt(0) === "/" || /^[A-Za-z]:/.test(s)) return null;
        if (s.split("/").indexOf("..") !== -1) return null;
        return s;
    }

    function ensureDir(dir) {
        if (fs.existsSync(dir)) return;
        ensureDir(pathMod.dirname(dir));
        try { fs.mkdirSync(dir); } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // Bước 1: hỏi kho xem có bản mới không
    // ---------------------------------------------------------------------
    function check() {
        if (!configured()) return Promise.reject(new Error("Chưa cấu hình kho cập nhật trong updater.js"));
        if (!usable()) return Promise.reject(new Error("Panel không truy cập được hệ thống file (thiếu quyền Node.js)"));

        return fetch(rawUrl("version.json"), { cache: "no-store" }).then(function (r) {
            if (r.status === 404) {
                throw new Error("Không thấy version.json trên kho. Kiểm tra lại tên nhánh (" + REPO_BRANCH +
                                ") và thư mục (" + (REPO_BASE || "gốc kho") + ").");
            }
            if (!r.ok) throw new Error("Kho trả về lỗi " + r.status);
            return r.json();
        }).then(function (info) {
            if (!info || !info.version) throw new Error("version.json sai định dạng (thiếu trường \"version\")");
            info.isNewer = compareVersion(info.version, APP_VERSION) > 0;
            info.current = APP_VERSION;
            return info;
        });
    }

    // ---------------------------------------------------------------------
    // Bước 2: tải hết vào bộ nhớ + đối chiếu SHA-256 (chưa đụng vào file thật)
    // ---------------------------------------------------------------------
    function download(info) {
        var list = [];
        for (var i = 0; i < (info.files || []).length; i++) {
            var f = info.files[i];
            var rel = safeRelPath(f && f.path);
            if (!rel || NEVER_UPDATE[rel]) continue;
            list.push({ path: rel, sha256: f.sha256 });
        }
        if (!list.length) return Promise.reject(new Error("version.json không liệt kê file hợp lệ nào"));

        return Promise.all(list.map(function (f) {
            return fetch(rawUrl(f.path), { cache: "no-store" }).then(function (r) {
                if (!r.ok) throw new Error(f.path + ": tải lỗi " + r.status);
                return r.arrayBuffer();
            }).then(function (buf) {
                var data = Buffer.from(new Uint8Array(buf));
                if (f.sha256) {
                    var got = cryptoMod.createHash("sha256").update(data).digest("hex");
                    if (got !== String(f.sha256).toLowerCase()) {
                        throw new Error(f.path + ": file tải về không khớp mã kiểm tra (tải lại sau ít phút)");
                    }
                }
                return { path: f.path, data: data };
            });
        }));
    }

    // ---------------------------------------------------------------------
    // Bước 3: sao lưu rồi ghi đè. Chỉ chạy khi bước 2 đã xong sạch.
    // ---------------------------------------------------------------------
    function apply(files) {
        var dir = extensionDir();
        if (!dir) throw new Error("Không xác định được thư mục cài đặt panel");
        var backupDir = pathMod.join(dir, "_backup");

        var i, live, dst;
        for (i = 0; i < files.length; i++) {
            live = pathMod.join(dir, files[i].path);
            if (fs.existsSync(live)) {
                dst = pathMod.join(backupDir, files[i].path);
                ensureDir(pathMod.dirname(dst));
                fs.writeFileSync(dst, fs.readFileSync(live));
            }
        }
        for (i = 0; i < files.length; i++) {
            live = pathMod.join(dir, files[i].path);
            ensureDir(pathMod.dirname(live));
            fs.writeFileSync(live, files[i].data);
        }
        return backupDir;
    }

    /**
     * Nạp lại hostscript.jsx. Bắt buộc phải làm riêng: reload panel chỉ nạp lại
     * HTML/CSS/JS, còn bản .jsx cũ vẫn nằm trong bộ máy ExtendScript của Premiere.
     */
    function reloadHostScript() {
        return new Promise(function (resolve) {
            var jsx = extensionDir().replace(/\\/g, "/") + "/jsx/hostscript.jsx";
            csInterface.evalScript(
                '(function(){ try { $.evalFile(new File("' + jsx + '")); return "ok"; } catch(e) { return "err"; } })()',
                function () { resolve(); }
            );
        });
    }

    /** Chạy trọn gói: tải -> ghi đè -> nạp lại. */
    function install(info) {
        return download(info).then(function (files) {
            var backupDir = apply(files);
            return reloadHostScript().then(function () { return { count: files.length, backupDir: backupDir }; });
        });
    }

    return {
        isConfigured: configured,
        check: check,
        install: install,
        compareVersion: compareVersion,
        repoLabel: function () { return REPO_OWNER + "/" + REPO_NAME + " (" + REPO_BRANCH + ")"; }
    };
})();
