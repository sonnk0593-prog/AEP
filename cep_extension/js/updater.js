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
 *
 * CỐ Ý KHÔNG phụ thuộc vào Node.js:
 *   - require() chỉ chạy khi manifest bật --enable-nodejs ĐÚNG cách, mà việc đó
 *     lại cần khởi động lại Premiere mới có tác dụng.
 *   - window.cep.fs thì CEP luôn cấp sẵn, không cần cờ gì.
 *   Vì vậy mọi thao tác file đều có 2 đường: Node.js (nhanh hơn) hoặc cep.fs.
 *   SHA-256 cũng tự cài bằng JS thuần thay vì dùng require("crypto").
 */
var Updater = (function () {

    // =====================================================================
    // CẤU HÌNH - chỉ cần sửa 4 dòng này
    // =====================================================================
    var REPO_OWNER  = "sonnk0593-prog"; // https://github.com/sonnk0593-prog/AEP
    var REPO_NAME   = "AEP";
    var REPO_BRANCH = "main";           // nhánh mặc định của kho
    var REPO_BASE   = "cep_extension";  // thư mục chứa panel trong kho; để "" nếu ở gốc
    // =====================================================================

    // KHÔNG BAO GIỜ cập nhật manifest qua OTA:
    // - Premiere chỉ đọc manifest lúc khởi động -> đổi cũng không có tác dụng ngay.
    // - Manifest hỏng = Premiere không nạp được panel = không còn gì để tự sửa.
    var NEVER_UPDATE = { "CSXS/manifest.xml": 1 };

    // ---------------------------------------------------------------------
    // Lớp truy cập file: Node.js nếu có, không thì dùng cep.fs
    // ---------------------------------------------------------------------
    var nodeFs = null;
    try { nodeFs = require("fs"); } catch (e) { nodeFs = null; }

    function cepFs() {
        try { return (window.cep && window.cep.fs) ? window.cep.fs : null; } catch (e) { return null; }
    }
    function b64Enc() {
        try { if (window.cep && window.cep.encoding && window.cep.encoding.Base64) return window.cep.encoding.Base64; } catch (e) {}
        return "Base64";
    }
    function hasFileAccess() { return !!nodeFs || !!cepFs(); }

    function normPath(p) { return String(p).replace(/\\/g, "/").replace(/\/+$/, ""); }
    function joinPath(a, b) { return normPath(a) + "/" + String(b).replace(/^\/+/, ""); }
    function dirOf(p) {
        var s = normPath(p), i = s.lastIndexOf("/");
        return i <= 0 ? s : s.substring(0, i);
    }

    function fileExists(p) {
        if (nodeFs) { try { return nodeFs.existsSync(p); } catch (e) {} }
        var c = cepFs();
        if (c && c.stat) { try { var r = c.stat(p); return !!(r && r.err === 0); } catch (e2) {} }
        return false;
    }

    function mkdirp(dir) {
        var d = normPath(dir);
        if (d === "" || fileExists(d)) return;
        var parent = dirOf(d);
        if (parent !== d) mkdirp(parent);
        if (nodeFs) { try { nodeFs.mkdirSync(d); return; } catch (e) {} }
        var c = cepFs();
        if (c && c.makedir) { try { c.makedir(d); } catch (e2) {} }
    }

    /** Đọc file ra chuỗi Base64 (dùng chung cho cả file chữ lẫn file nhị phân). */
    function readBase64(p) {
        if (nodeFs) { try { return nodeFs.readFileSync(p).toString("base64"); } catch (e) {} }
        var c = cepFs();
        if (c && c.readFile) { try { var r = c.readFile(p, b64Enc()); if (r && r.err === 0) return r.data; } catch (e2) {} }
        return null;
    }

    function writeBase64(p, b64) {
        if (nodeFs) {
            try { nodeFs.writeFileSync(p, Buffer.from(b64, "base64")); return true; } catch (e) {}
        }
        var c = cepFs();
        if (c && c.writeFile) { try { var r = c.writeFile(p, b64, b64Enc()); return !!(r && r.err === 0); } catch (e2) {} }
        return false;
    }

    function bytesToBase64(bytes) {
        var bin = "", chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            var slice = bytes.subarray ? bytes.subarray(i, i + chunk) : bytes.slice(i, i + chunk);
            bin += String.fromCharCode.apply(null, slice);
        }
        return btoa(bin);
    }

    // ---------------------------------------------------------------------
    // SHA-256 thuần JS - không dùng require("crypto") nên luôn chạy được.
    // Nhận vào mảng byte (Uint8Array hoặc Array thường), trả về chuỗi hex.
    // ---------------------------------------------------------------------
    var SHA_K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];

    function sha256Hex(bytes) {
        var len = bytes.length, i, t;

        // Đệm: 0x80, các byte 0, rồi 8 byte độ dài tính bằng bit (big-endian).
        var msg = [];
        for (i = 0; i < len; i++) msg.push(bytes[i] & 0xff);
        msg.push(0x80);
        while (msg.length % 64 !== 56) msg.push(0);
        var bitHi = Math.floor(len / 536870912);   // len * 8 / 2^32
        var bitLo = (len * 8) >>> 0;
        msg.push((bitHi >>> 24) & 0xff, (bitHi >>> 16) & 0xff, (bitHi >>> 8) & 0xff, bitHi & 0xff);
        msg.push((bitLo >>> 24) & 0xff, (bitLo >>> 16) & 0xff, (bitLo >>> 8) & 0xff, bitLo & 0xff);

        var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
        var W = new Array(64);

        for (var off = 0; off < msg.length; off += 64) {
            for (t = 0; t < 16; t++) {
                W[t] = ((msg[off + t*4] << 24) | (msg[off + t*4 + 1] << 16) |
                        (msg[off + t*4 + 2] << 8) | msg[off + t*4 + 3]) >>> 0;
            }
            for (t = 16; t < 64; t++) {
                var w15 = W[t-15], w2 = W[t-2];
                var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
                var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
                W[t] = (W[t-16] + s0 + W[t-7] + s1) >>> 0;
            }
            var a=H[0], b=H[1], c=H[2], d=H[3], e=H[4], f=H[5], g=H[6], h=H[7];
            for (t = 0; t < 64; t++) {
                var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                var ch = (e & f) ^ ((~e) & g);
                var t1 = (h + S1 + ch + SHA_K[t] + W[t]) >>> 0;
                var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var t2 = (S0 + maj) >>> 0;
                h = g; g = f; f = e; e = (d + t1) >>> 0;
                d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }
            H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
            H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
        }

        var hex = "", digits = "0123456789abcdef";
        for (i = 0; i < 8; i++) {
            for (var j = 7; j >= 0; j--) hex += digits.charAt((H[i] >>> (j*4)) & 0xf);
        }
        return hex;
    }

    // ---------------------------------------------------------------------
    function configured() { return REPO_OWNER !== "" && REPO_NAME !== ""; }

    /**
     * Thư mục cài panel, dạng đường dẫn thật ("C:/Users/...").
     * Vẫn tự bỏ tiền tố "file:///" một lần nữa ở đây: CSInterface.js có thể bị
     * ghi đè bởi bản rút gọn thiếu bước đó, mà sai chỗ này thì mọi lệnh ghi file
     * đều hỏng và rất khó truy ra nguyên nhân.
     */
    function extensionDir() {
        var p = "";
        try { p = String(csInterface.getSystemPath(SystemPath.EXTENSION) || ""); } catch (e) { return ""; }
        if (p.indexOf("file:///") === 0) {
            p = p.substring(8);
            if (!/^[A-Za-z]:/.test(p)) p = "/" + p;
        } else if (p.indexOf("file://") === 0) {
            p = p.substring(7);
        }
        return normPath(p);
    }

    /** Đường dẫn phải là tuyệt đối thì cep.fs/Node mới ghi được. */
    function assertUsablePath(dir) {
        if (dir === "") throw new Error("Không xác định được thư mục cài đặt panel");
        if (!/^[A-Za-z]:\//.test(dir) && dir.charAt(0) !== "/") {
            throw new Error("Đường dẫn cài đặt không hợp lệ: " + dir);
        }
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

    // ---------------------------------------------------------------------
    // Bước 1: hỏi kho xem có bản mới không
    // ---------------------------------------------------------------------
    function check() {
        if (!configured()) return Promise.reject(new Error("Chưa cấu hình kho cập nhật trong updater.js"));
        if (!hasFileAccess()) return Promise.reject(new Error("Panel không ghi được file (cep.fs lẫn Node.js đều không dùng được)"));

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
                var bytes = new Uint8Array(buf);
                if (f.sha256) {
                    var got = sha256Hex(bytes);
                    if (got !== String(f.sha256).toLowerCase()) {
                        throw new Error(f.path + ": file tải về không khớp mã kiểm tra (thử lại sau ít phút)");
                    }
                }
                return { path: f.path, b64: bytesToBase64(bytes) };
            });
        }));
    }

    // ---------------------------------------------------------------------
    // Bước 3: sao lưu rồi ghi đè. Chỉ chạy khi bước 2 đã xong sạch.
    // ---------------------------------------------------------------------
    function apply(files) {
        var dir = extensionDir();
        assertUsablePath(dir);
        var backupDir = joinPath(dir, "_backup");
        var i, live, dst, cur;

        // --- Sao lưu. Phải ĐẾM xem có thật sự sao lưu được không: trước đây
        // bỏ qua kết quả writeBase64 nên khi ghi hỏng, thông báo lỗi vẫn bảo
        // "bản cũ nằm ở _backup" trong khi thư mục đó chưa từng được tạo. ---
        var existing = 0, backedUp = 0;
        for (i = 0; i < files.length; i++) {
            live = joinPath(dir, files[i].path);
            if (!fileExists(live)) continue;
            existing++;
            cur = readBase64(live);
            if (cur === null) continue;
            dst = joinPath(backupDir, files[i].path);
            mkdirp(dirOf(dst));
            if (writeBase64(dst, cur)) backedUp++;
        }

        // Có file để sao lưu mà không sao lưu nổi cái nào = chắc chắn cũng không
        // ghi đè được. Dừng ở đây, khi chưa file thật nào bị đụng tới.
        if (existing > 0 && backedUp === 0) {
            throw new Error("Không ghi được vào thư mục cài đặt.\nĐường dẫn: " + dir +
                            "\nNode.js: " + (nodeFs ? "có" : "không") + " · cep.fs: " + (cepFs() ? "có" : "không"));
        }

        for (i = 0; i < files.length; i++) {
            live = joinPath(dir, files[i].path);
            mkdirp(dirOf(live));
            if (!writeBase64(live, files[i].b64)) {
                throw new Error("Không ghi được " + files[i].path +
                                "\nĐường dẫn: " + live +
                                "\nBản cũ đã lưu ở _backup, chạy restore.bat để quay lại.");
            }
        }
        return backupDir;
    }

    /**
     * Nạp lại hostscript.jsx. Bắt buộc phải làm riêng: reload panel chỉ nạp lại
     * HTML/CSS/JS, còn bản .jsx cũ vẫn nằm trong bộ máy ExtendScript của Premiere.
     */
    function reloadHostScript() {
        return new Promise(function (resolve) {
            var jsx = extensionDir() + "/jsx/hostscript.jsx";
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
        hasFileAccess: hasFileAccess,
        usingNode: function () { return !!nodeFs; },
        check: check,
        install: install,
        compareVersion: compareVersion,
        repoLabel: function () { return REPO_OWNER + "/" + REPO_NAME + " (" + REPO_BRANCH + ")"; },
        __sha256Hex: sha256Hex   // để kiểm thử
    };
})();
