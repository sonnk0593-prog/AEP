/**
 * server.js — Auto Import & Cut V3 Sidecar Backend Server
 * Chạy độc lập ngoài CEP của Premiere Pro tại http://127.0.0.1:9395
 *
 * Nhiệm vụ chính:
 *   1. Tải video YouTube bằng yt-dlp + ffmpeg có báo tiến độ % và tốc độ MB/s theo thời gian thực.
 *   2. Kiểm tra thông số video (codec, container, pixel format, thời lượng) bằng ffprobe.
 *   3. Tự động convert/remux các video có codec Premiere Pro không hỗ trợ (AV1, VP9, VP8, WebM, MKV, HEVC 10-bit lỗi...)
 *      sang chuẩn MP4 (H.264 avc1 + AAC yuv420p) tương thích 100% với mọi bản Premiere Pro.
 *   4. Smart Trim Copy: Với các file nguồn có dung lượng lớn (> X GB, mặc định 1 GB), tự động cắt gọn
 *      theo đúng đoạn timecode kịch bản cộng trừ hao ± Y giây (mặc định 10s) đầu/đuôi bằng FFmpeg stream-copy
 *      căn chuẩn Keyframe, giúp giảm 90–98% dung lượng copy về Footage/ mà vẫn giữ đúng điểm cắt trên Timeline.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const urlMod = require("url");

const PORT = parseInt(process.env.AIC_V3_PORT || "9395", 10);
const HOST = "127.0.0.1";
const VERSION = "3.1.0";

// ============================================================================
// 1. TÌM CÔNG CỤ (yt-dlp, ffmpeg, ffprobe)
// ============================================================================
function findBinary(name, extraCandidates) {
    const localAppData = process.env.LOCALAPPDATA || "";
    const binDir = path.join(localAppData || "C:\\Temp", "AutoImportCutV3", "bin");
    try {
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    } catch (e) {}

    const list = [
        path.join(binDir, name),
        ...(extraCandidates || [])
    ];
    for (let i = 0; i < list.length; i++) {
        if (list[i] && fs.existsSync(list[i])) return list[i];
    }
    try {
        const out = cp.execFileSync("where.exe", [name], { windowsHide: true, timeout: 3000 }).toString("utf8");
        const first = out.split(/\r?\n/)[0].trim();
        if (first && fs.existsSync(first)) return first;
    } catch (e) {}
    return "";
}

function getBinaries() {
    const localAppData = process.env.LOCALAPPDATA || "";
    const appData = process.env.APPDATA || "";
    const ytdlp = findBinary("yt-dlp.exe", [
        localAppData ? path.join(localAppData, "Meowgic", "binaries", "yt-dlp.exe") : "",
        localAppData ? path.join(localAppData, "Programs", "Meowgic", "resources", "backend", "binaries", "win", "yt-dlp.exe") : "",
        appData ? path.join(appData, "blinkl.io", "resources", "io.any-paste.blinkl", "yt-dlp", "yt-dlp.exe") : "",
        localAppData ? path.join(localAppData, "yt-dlp", "yt-dlp.exe") : ""
    ]);
    const ffmpeg = findBinary("ffmpeg.exe", [
        localAppData ? path.join(localAppData, "Programs", "Meowgic", "resources", "backend", "binaries", "win", "ffmpeg.exe") : "",
        localAppData ? path.join(localAppData, "QuickMediaConverter", "ffmpeg.exe") : "",
        appData ? path.join(appData, "blinkl.io", "resources", "ffmpeg", "ffmpeg.exe") : ""
    ]);
    const ffprobe = findBinary("ffprobe.exe", [
        localAppData ? path.join(localAppData, "Programs", "Meowgic", "resources", "backend", "binaries", "win", "ffprobe.exe") : "",
        localAppData ? path.join(localAppData, "QuickMediaConverter", "ffprobe.exe") : "",
        appData ? path.join(appData, "blinkl.io", "resources", "ffmpeg", "ffprobe.exe") : ""
    ]);
    return { ytdlp, ffmpeg, ffprobe };
}

// ============================================================================
// 2. KIỂM TRA METADATA & ĐỘ TƯƠNG THÍCH CODEC VỚI PREMIERE PRO (FFPROBE)
// ============================================================================
const PREMIERE_SUPPORTED_VCODECS = {
    "h264": true,
    "avc1": true,
    "mpeg4": true,
    "mpeg2video": true,
    "mpeg1video": true,
    "prores": true,
    "dnxhd": true,
    "mjpeg": true,
    "dvvideo": true,
    "qtrle": true,
    "hap": true
};

const PREMIERE_SUPPORTED_EXTS = {
    ".mp4": true,
    ".mov": true,
    ".m4v": true,
    ".mxf": true,
    ".mts": true,
    ".m2ts": true,
    ".mpg": true,
    ".mpeg": true,
    ".avi": true
};

function probeMediaFile(filePath, cb) {
    if (!filePath || !fs.existsSync(filePath)) {
        return cb({ ok: false, error: "File không tồn tại: " + filePath });
    }
    const bins = getBinaries();
    const ext = path.extname(filePath).toLowerCase();

    if (!bins.ffprobe) {
        const extOk = !!PREMIERE_SUPPORTED_EXTS[ext];
        return cb({
            ok: true,
            filePath: filePath,
            ext: ext,
            durationSec: 0,
            videoCodec: "unknown",
            audioCodec: "unknown",
            pixFmt: "unknown",
            compatibleWithPremiere: extOk,
            incompatibleReason: extOk ? "" : ("Đuôi file " + ext + " không được Premiere hỗ trợ trực tiếp")
        });
    }

    cp.execFile(bins.ffprobe, [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath
    ], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
            return cb({
                ok: false,
                filePath: filePath,
                error: "ffprobe không đọc được file: " + err.message
            });
        }
        let data = {};
        try { data = JSON.parse(stdout || "{}"); } catch (eP) {}
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const fmt = data.format || {};

        let vStream = null, aStream = null;
        for (let i = 0; i < streams.length; i++) {
            if (streams[i].codec_type === "video" && !vStream) vStream = streams[i];
            else if (streams[i].codec_type === "audio" && !aStream) aStream = streams[i];
        }

        const vCodec = vStream ? String(vStream.codec_name || "").toLowerCase() : "";
        const aCodec = aStream ? String(aStream.codec_name || "").toLowerCase() : "";
        const pixFmt = vStream ? String(vStream.pix_fmt || "").toLowerCase() : "";
        const width = vStream ? (parseInt(vStream.width, 10) || 0) : 0;
        const height = vStream ? (parseInt(vStream.height, 10) || 0) : 0;
        const dur = parseFloat(fmt.duration || (vStream && vStream.duration) || "0") || 0;

        let compatible = true;
        let reasons = [];

        if (!vStream) {
            compatible = false;
            reasons.push("Không tìm thấy luồng video hợp lệ");
        } else {
            if (vCodec === "av1" || vCodec === "vp9" || vCodec === "vp8" || vCodec === "theora") {
                compatible = false;
                reasons.push("Codec video " + vCodec.toUpperCase() + " không được Premiere Pro hỗ trợ");
            } else if (!PREMIERE_SUPPORTED_VCODECS[vCodec] && vCodec !== "hevc") {
                compatible = false;
                reasons.push("Codec video lạ (" + vCodec + ")");
            } else if (vCodec === "h264" && pixFmt && pixFmt.indexOf("10") !== -1) {
                compatible = false;
                reasons.push("H.264 10-bit (" + pixFmt + ") dễ gây đen hình trên Premiere");
            }
        }

        if (!PREMIERE_SUPPORTED_EXTS[ext]) {
            compatible = false;
            reasons.push("Định dạng vỏ container " + ext + " không được Premiere Pro hỗ trợ");
        }

        if (aCodec === "opus" || aCodec === "vorbis") {
            compatible = false;
            reasons.push("Codec âm thanh " + aCodec.toUpperCase() + " không được Premiere Pro hỗ trợ");
        }

        cb({
            ok: true,
            filePath: filePath,
            ext: ext,
            durationSec: dur,
            videoCodec: vCodec,
            audioCodec: aCodec,
            pixFmt: pixFmt,
            width: width,
            height: height,
            compatibleWithPremiere: compatible,
            incompatibleReason: reasons.join(" + ")
        });
    });
}

/**
 * Tìm chính xác mốc thời gian (pts_time) của Keyframe (I-frame) nằm ngay tại hoặc trước targetSec.
 * Nhờ cắt từ đúng Keyframe và trả về actualStartSec, FFmpeg "-c copy" không bao giờ bị đen hình đầu clip
 * hoặc lệch tiếng, đồng thời Premiere đặt InPoint = (reqInSec - actualStartSec) chuẩn từng frame!
 */
function findKeyframeBefore(filePath, targetSec, cb) {
    if (!targetSec || targetSec <= 0.05) return cb(0);
    const bins = getBinaries();
    if (!bins.ffprobe) return cb(targetSec);

    cp.execFile(bins.ffprobe, [
        "-v", "error",
        "-read_intervals", targetSec.toFixed(3) + "%+#1",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,flags",
        "-of", "json",
        filePath
    ], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        if (err || !stdout) return cb(targetSec);
        try {
            const d = JSON.parse(stdout);
            if (d && Array.isArray(d.packets) && d.packets.length > 0) {
                const pts = parseFloat(d.packets[0].pts_time);
                if (!isNaN(pts) && pts >= 0 && pts <= targetSec + 1.0) {
                    return cb(pts);
                }
            }
        } catch (e) {}
        cb(targetSec);
    });
}

// ============================================================================
// 3. QUẢN LÝ TIẾN TRÌNH NỀN (JOBS: YOUTUBE DOWNLOAD, FFMPEG CONVERT, SMART TRIM)
// ============================================================================
const jobs = {};
const activeProcs = {};
let nextJobSeq = 1;

function setJobStatus(job, status, msg) {
    job.state = status;
    job.status = status;
    if (msg !== undefined) {
        job.label = msg;
        job.message = msg;
    }
}

function createJob(type, label) {
    const id = "job_" + Date.now() + "_" + (nextJobSeq++);
    const job = {
        id: id,
        type: type,
        state: "running",
        status: "running",
        stage: "init",
        label: label || "",
        message: label || "",
        percent: 0,
        speedMBs: 0,
        speedBps: 0,
        bytesDone: 0,
        downloadedBytes: 0,
        bytesTotal: 0,
        totalBytes: 0,
        result: null,
        error: "",
        startedAt: Date.now()
    };
    jobs[id] = job;
    return job;
}

function killJobProc(jobId) {
    const proc = activeProcs[jobId];
    if (proc) {
        delete activeProcs[jobId];
        const pid = proc.pid;
        try { proc.kill(); } catch (e1) {}
        if (pid) {
            try { cp.spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch (e2) {}
        }
    }
}

function cancelAllJobs() {
    for (const jId of Object.keys(jobs)) {
        if (jobs[jId] && jobs[jId].state === "running") {
            setJobStatus(jobs[jId], "cancelled", "Đã huỷ bởi người dùng");
            jobs[jId].error = "Đã huỷ bởi người dùng";
            killJobProc(jId);
        }
    }
}

/**
 * Tự động chuyển đổi (remux hoặc transcode) file video sang chuẩn H.264 + AAC (.mp4)
 * tương thích 100% với Premiere Pro, có cập nhật % theo thời gian thực vào đối tượng job.
 */
function ensurePremiereCompatibleWithJob(job, inputPath, targetDir, forceConvert, cb) {
    probeMediaFile(inputPath, (probeRes) => {
        if (job.state === "cancelled") return cb({ ok: false, cancelled: true });

        const bins = getBinaries();
        if (!bins.ffmpeg) {
            return cb({
                ok: true,
                converted: false,
                filePath: inputPath,
                durationSec: probeRes.durationSec || 0,
                videoCodec: probeRes.videoCodec || "unknown",
                originalVideoCodec: probeRes.videoCodec || "unknown"
            });
        }

        const needConvert = forceConvert || !probeRes.ok || !probeRes.compatibleWithPremiere;
        if (!needConvert) {
            return cb({
                ok: true,
                converted: false,
                filePath: inputPath,
                durationSec: probeRes.durationSec || 0,
                videoCodec: probeRes.videoCodec || "h264",
                originalVideoCodec: probeRes.videoCodec || "h264"
            });
        }

        const outFolder = targetDir || path.dirname(inputPath);
        try {
            if (!fs.existsSync(outFolder)) fs.mkdirSync(outFolder, { recursive: true });
        } catch (e) {}

        const baseNoExt = path.basename(inputPath, path.extname(inputPath)).replace(/_h264$/i, "");
        const outPath = path.join(outFolder, baseNoExt + "_h264.mp4");

        try {
            if (outPath.toLowerCase() !== inputPath.toLowerCase() && fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
                return probeMediaFile(outPath, (reProbe) => {
                    if (reProbe && reProbe.ok && reProbe.compatibleWithPremiere) {
                        return cb({
                            ok: true,
                            converted: true,
                            cachedConvert: true,
                            filePath: outPath,
                            durationSec: reProbe.durationSec || probeRes.durationSec || 0,
                            videoCodec: "h264",
                            originalVideoCodec: (probeRes && probeRes.videoCodec) || "unknown",
                            reason: probeRes.incompatibleReason || "Đã dùng bản H.264 có sẵn"
                        });
                    }
                    runFfmpegConvert();
                });
            }
        } catch (eSt) {}

        runFfmpegConvert();

        function runFfmpegConvert() {
            const tempOutPath = path.join(outFolder, baseNoExt + "_converting_" + Date.now() + ".mp4");
            const totalDurSec = (probeRes && probeRes.durationSec > 0) ? probeRes.durationSec : 0;
            const canCopyVideo = (!forceConvert && probeRes && probeRes.videoCodec === "h264" && (!probeRes.pixFmt || probeRes.pixFmt.indexOf("10") === -1));

            const reasonText = (probeRes && probeRes.incompatibleReason)
                ? probeRes.incompatibleReason
                : "Chuyển đổi sang H.264 MP4 cho Premiere Pro";

            job.stage = "convert";
            setJobStatus(job, "running", "🔄 Convert H.264: " + path.basename(inputPath) + " (" + reasonText + ")");
            job.percent = 0;

            function spawnFfmpegWithEncoder(vEncoderArgs, onFfmpegDone) {
                const args = [
                    "-y",
                    "-i", inputPath,
                    ...vEncoderArgs,
                    "-c:a", "aac",
                    "-b:a", "192k",
                    "-ac", "2",
                    "-ar", "48000",
                    "-movflags", "+faststart",
                    "-progress", "pipe:1",
                    "-nostats",
                    tempOutPath
                ];

                let proc;
                try {
                    proc = cp.spawn(bins.ffmpeg, args, { windowsHide: true });
                } catch (eSp) {
                    return onFfmpegDone(new Error("Không khởi chạy được ffmpeg: " + eSp.message));
                }
                activeProcs[job.id] = proc;

                let stderrTail = "";
                if (proc.stdout) {
                    proc.stdout.on("data", (chunk) => {
                        if (job.state === "cancelled") return;
                        const txt = chunk.toString("utf8");
                        const mTime = /out_time_ms=(\d+)/.exec(txt) || /out_time_us=(\d+)/.exec(txt);
                        const mSize = /total_size=(\d+)/.exec(txt);
                        if (mSize) {
                            job.bytesDone = parseInt(mSize[1], 10) || 0;
                            job.downloadedBytes = job.bytesDone;
                        }
                        if (mTime && totalDurSec > 0) {
                            const curSec = parseInt(mTime[1], 10) / 1000000;
                            const pct = Math.min(99, Math.max(0, Math.round((curSec / totalDurSec) * 100)));
                            job.percent = pct;
                        }
                    });
                }
                if (proc.stderr) {
                    proc.stderr.on("data", (chunk) => {
                        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
                    });
                }

                let finished = false;
                function finishProc(code, err) {
                    if (finished) return;
                    finished = true;
                    delete activeProcs[job.id];
                    if (job.state === "cancelled") {
                        try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch (eU) {}
                        return onFfmpegDone(new Error("Đã huỷ"));
                    }
                    const ok = (!err && code === 0 && fs.existsSync(tempOutPath) && fs.statSync(tempOutPath).size > 1024);
                    if (ok) {
                        onFfmpegDone(null);
                    } else {
                        try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch (eU2) {}
                        onFfmpegDone(new Error("FFmpeg exit=" + code + " " + stderrTail.substring(0, 200)));
                    }
                }
                proc.on("error", (err) => finishProc(-1, err));
                proc.on("close", (code) => finishProc(code, null));
            }

            const copyArgs = ["-c:v", "copy"];
            const cpuArgs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];

            const primaryArgs = canCopyVideo ? copyArgs : cpuArgs;
            spawnFfmpegWithEncoder(primaryArgs, (err1) => {
                if (!err1) {
                    finalizeConvertedFile();
                } else if (canCopyVideo && job.state !== "cancelled") {
                    spawnFfmpegWithEncoder(cpuArgs, (err2) => {
                        if (err2) return cb({ ok: false, error: err2.message });
                        finalizeConvertedFile();
                    });
                } else {
                    return cb({ ok: false, error: err1.message });
                }
            });

            function finalizeConvertedFile() {
                try {
                    const finalDest = (outPath.toLowerCase() === inputPath.toLowerCase())
                        ? path.join(outFolder, baseNoExt + "_premiere_h264.mp4")
                        : outPath;
                    if (fs.existsSync(finalDest)) {
                        try { fs.unlinkSync(finalDest); } catch (eRm) {}
                    }
                    fs.renameSync(tempOutPath, finalDest);
                    job.percent = 100;
                    probeMediaFile(finalDest, (finalProbe) => {
                        cb({
                            ok: true,
                            converted: true,
                            filePath: finalDest,
                            durationSec: (finalProbe && finalProbe.durationSec) || totalDurSec,
                            videoCodec: "h264",
                            originalVideoCodec: (probeRes && probeRes.videoCodec) || "unknown",
                            reason: reasonText
                        });
                    });
                } catch (eFin) {
                    cb({ ok: false, error: "Không lưu được file sau khi convert: " + eFin.message });
                }
            }
        }
    });
}

/**
 * Tự động tìm hoặc tải yt-dlp.exe về %LOCALAPPDATA%\AutoImportCutV3\bin\yt-dlp.exe
 * (giống cơ chế tự tải của bản V2 để máy người dùng nâng cấp OTA từ V2 lên V3 không cần cài tay).
 */
function ensureYtdlpBinary(extraDir, job, cb) {
    const bins = getBinaries();
    if (bins.ytdlp) return cb(bins.ytdlp);

    if (extraDir) {
        const inOutDir = path.join(extraDir, "yt-dlp.exe");
        if (fs.existsSync(inOutDir)) return cb(inOutDir);
    }

    const localAppData = process.env.LOCALAPPDATA || "C:\\Temp";
    const binDir = path.join(localAppData, "AutoImportCutV3", "bin");
    try {
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    } catch (e) {}
    const targetExe = path.join(binDir, "yt-dlp.exe");
    if (fs.existsSync(targetExe) && fs.statSync(targetExe).size > 100000) {
        return cb(targetExe);
    }

    setJobStatus(job, "running", "⬇️ Đang tự động tải công cụ yt-dlp.exe lần đầu...");
    const dlUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const curlExe = path.join(sysRoot, "System32", "curl.exe");

    if (fs.existsSync(curlExe)) {
        cp.execFile(curlExe, ["-L", "-k", "-s", "-o", targetExe, dlUrl], { windowsHide: true, timeout: 120000 }, () => {
            if (fs.existsSync(targetExe) && fs.statSync(targetExe).size > 100000) {
                return cb(targetExe);
            }
            downloadViaPowershell();
        });
    } else {
        downloadViaPowershell();
    }

    function downloadViaPowershell() {
        const psCmd = "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " +
                      "$ProgressPreference = 'SilentlyContinue'; " +
                      "(New-Object Net.WebClient).DownloadFile('" + dlUrl + "', '" + targetExe.replace(/'/g, "''") + "')";
        cp.execFile("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCmd], { windowsHide: true, timeout: 120000 }, () => {
            if (fs.existsSync(targetExe) && fs.statSync(targetExe).size > 100000) {
                return cb(targetExe);
            }
            cb("");
        });
    }
}

/**
 * Tải video YouTube bằng yt-dlp + tự động kiểm tra/convert sang H.264 MP4 tương thích Premiere Pro.
 */
function runYouTubeDownloadJob(job, url, destPath) {
    const outDir = path.dirname(destPath);
    try {
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    } catch (e) {}

    ensureYtdlpBinary(outDir, job, (ytdlpExe) => {
        if (job.state === "cancelled") return;
        const bins = getBinaries();
        const ytdlpPath = ytdlpExe || bins.ytdlp;
        if (!ytdlpPath) {
            setJobStatus(job, "error");
            job.error = "Không tìm thấy và không tự tải được yt-dlp.exe trên máy (kiểm tra kết nối mạng)";
            return;
        }
        runYouTubeWithBinary(job, url, destPath, outDir, ytdlpPath, bins.ffmpeg);
    });
}

function runYouTubeWithBinary(job, url, destPath, outDir, ytdlpPath, ffmpegPath) {

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 10000) {
        ensurePremiereCompatibleWithJob(job, destPath, outDir, false, (compatRes) => {
            if (!compatRes.ok) {
                setJobStatus(job, "error");
                job.error = compatRes.error || "Lỗi kiểm tra codec YouTube";
                return;
            }
            let finalFile = compatRes.filePath;
            if (compatRes.converted && finalFile.toLowerCase() !== destPath.toLowerCase()) {
                try {
                    fs.copyFileSync(finalFile, destPath);
                    fs.unlinkSync(finalFile);
                    finalFile = destPath;
                } catch (eCp) {}
            }
            job.percent = 100;
            job.result = {
                ok: true,
                filePath: finalFile,
                cached: true,
                converted: !!compatRes.converted,
                originalVideoCodec: compatRes.originalVideoCodec || "",
                reason: compatRes.reason || "",
                durationSec: compatRes.durationSec || 0
            };
            setJobStatus(job, "done", "Đã tải xong YouTube");
        });
        return;
    }

    job.stage = "downloading";
    setJobStatus(job, "running", "▶️ Đang tải YouTube: " + path.basename(destPath));

    const args = [
        "--no-update",
        "--no-warnings",
        "--no-playlist",
        "--newline",
        "--progress"
    ];
    if (ffmpegPath) {
        args.push("--ffmpeg-location", ffmpegPath);
        args.push("-S", "vcodec:h264,res,acodec:m4a");
        args.push("-f", "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][ext=mp4]/bv*[vcodec^=avc1]+ba/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b");
        args.push("--merge-output-format", "mp4");
    } else {
        args.push("-S", "vcodec:h264,res,acodec:m4a");
        args.push("-f", "b[vcodec^=avc1][ext=mp4]/b[ext=mp4]/b");
    }
    args.push("-o", destPath, url);

    let proc;
    try {
        proc = cp.spawn(ytdlpPath, args, { windowsHide: true });
    } catch (eSp) {
        setJobStatus(job, "error");
        job.error = "Không chạy được yt-dlp: " + eSp.message;
        return;
    }
    activeProcs[job.id] = proc;

    let stderrTail = "";
    function parseYtdlpProgress(line) {
        const mPct = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?(\d+(?:\.\d+)?)(KiB|MiB|GiB)/i.exec(line);
        if (mPct) {
            const pct = parseFloat(mPct[1]);
            const totVal = parseFloat(mPct[2]);
            const unit = mPct[3].toUpperCase();
            const mult = unit === "GIB" ? 1073741824 : (unit === "MIB" ? 1048576 : 1024);
            job.percent = Math.min(99, Math.round(pct));
            job.bytesTotal = Math.round(totVal * mult);
            job.totalBytes = job.bytesTotal;
            job.bytesDone = Math.round((job.bytesTotal * pct) / 100);
            job.downloadedBytes = job.bytesDone;
        }
        const mSpd = /at\s+(\d+(?:\.\d+)?)(KiB|MiB|GiB)\/s/i.exec(line);
        if (mSpd) {
            const spdVal = parseFloat(mSpd[1]);
            const sUnit = mSpd[2].toUpperCase();
            const sMult = sUnit === "GIB" ? 1073741824 : (sUnit === "MIB" ? 1048576 : 1024);
            job.speedMBs = Math.round(spdVal * sMult);
            job.speedBps = job.speedMBs;
        }
    }

    if (proc.stdout) {
        proc.stdout.on("data", (chunk) => {
            if (job.state === "cancelled") return;
            const lines = chunk.toString("utf8").split(/[\r\n]+/);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i]) parseYtdlpProgress(lines[i]);
            }
        });
    }
    if (proc.stderr) {
        proc.stderr.on("data", (chunk) => {
            stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
        });
    }

    let finished = false;
    proc.on("close", (code) => {
        if (finished) return;
        finished = true;
        delete activeProcs[job.id];
        if (job.state === "cancelled") return;

        let downloadedFile = "";
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
            downloadedFile = destPath;
        } else {
            const baseNoExt = path.basename(destPath, path.extname(destPath));
            try {
                const entries = fs.readdirSync(outDir);
                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].indexOf(baseNoExt + ".") === 0 && !/\.(part|ytdl|temp)$/i.test(entries[i])) {
                        const full = path.join(outDir, entries[i]);
                        if (fs.statSync(full).size > 1000) {
                            downloadedFile = full;
                            break;
                        }
                    }
                }
            } catch (eScan) {}
        }

        if (!downloadedFile) {
            setJobStatus(job, "error");
            job.error = "Không tải được video YouTube (code=" + code + ") " + stderrTail.substring(0, 180);
            return;
        }

        ensurePremiereCompatibleWithJob(job, downloadedFile, outDir, false, (compatRes) => {
            if (job.state === "cancelled") return;
            if (!compatRes.ok) {
                setJobStatus(job, "error");
                job.error = compatRes.error || "Lỗi chuyển đổi codec YouTube";
                return;
            }
            let finalFile = compatRes.filePath;
            if (compatRes.converted && finalFile.toLowerCase() !== destPath.toLowerCase()) {
                try {
                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                    fs.renameSync(finalFile, destPath);
                    finalFile = destPath;
                    if (downloadedFile.toLowerCase() !== destPath.toLowerCase() && fs.existsSync(downloadedFile)) {
                        try { fs.unlinkSync(downloadedFile); } catch (eRmOrig) {}
                    }
                } catch (eRen) {}
            }
            job.percent = 100;
            job.result = {
                ok: true,
                filePath: finalFile,
                cached: false,
                converted: !!compatRes.converted,
                originalVideoCodec: compatRes.originalVideoCodec || "",
                reason: compatRes.reason || "",
                durationSec: compatRes.durationSec || 0
            };
            setJobStatus(job, "done", "Đã tải xong YouTube");
        });
    });
}

// ============================================================================
// 3B. SMART TRIM COPY (CHỈ CẮT ĐOẠN CẦN DÙNG ± Y GIÂY VỚI FILE NẶNG > X GB)
// ============================================================================
function fmtSecTag(sec) {
    const s = Math.max(0, Math.round(Number(sec) * 10) / 10);
    const totalInt = Math.floor(s);
    const frac = Math.round((s - totalInt) * 10);
    const hh = Math.floor(totalInt / 3600);
    const mm = Math.floor((totalInt % 3600) / 60);
    const ss = totalInt % 60;
    const pad2 = (n) => (n < 10 ? "0" + n : String(n));
    let res = (hh > 0 ? pad2(hh) + "h" : "") + pad2(mm) + "m" + pad2(ss) + "s";
    if (frac > 0) res += frac;
    return res;
}

function fmtClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad2 = (n) => (n < 10 ? "0" + n : String(n));
    return (hh > 0 ? pad2(hh) + ":" : "") + pad2(mm) + ":" + pad2(ss);
}

function runTrimCopyJob(job, opts) {
    const srcPath = String(opts.srcPath || "").trim();
    const footageDir = String(opts.footageDir || "").trim();
    const trimKey = String(opts.trimKey || "");
    const padSec = (typeof opts.padSec === "number" && opts.padSec >= 0) ? opts.padSec : 10;
    const rangeSpec = opts.rangeSpec || {};

    if (!srcPath || !fs.existsSync(srcPath)) {
        setJobStatus(job, "error");
        job.error = "Không tìm thấy file nguồn: " + srcPath;
        return;
    }
    const bins = getBinaries();
    if (!bins.ffmpeg) {
        setJobStatus(job, "error");
        job.error = "Không tìm thấy công cụ ffmpeg.exe để cắt gọn file nặng";
        return;
    }

    try {
        if (!fs.existsSync(footageDir)) fs.mkdirSync(footageDir, { recursive: true });
    } catch (eMk) {}

    let srcSizeBytes = 0;
    try { srcSizeBytes = fs.statSync(srcPath).size || 0; } catch (eSz) {}

    job.stage = "trim";
    setJobStatus(job, "running", "✂️ Đang đọc thông số file nặng: " + path.basename(srcPath) + "...");

    probeMediaFile(srcPath, (probeRes) => {
        if (job.state === "cancelled") return;

        const totalDur = (probeRes && probeRes.durationSec > 0) ? probeRes.durationSec : 0;
        const defaultDur = Number(rangeSpec.defaultDuration) || 5;
        const mode = String(rangeSpec.mode || "auto");
        let reqInSec = 0, reqOutSec = defaultDur;

        if (mode === "full" || mode === "reversed") {
            reqInSec = Math.max(0, Number(rangeSpec.inSec) || 0);
            reqOutSec = Math.max(reqInSec + 0.1, Number(rangeSpec.outSec) || (reqInSec + defaultDur));
        } else if (mode === "start") {
            const sDur = Number(rangeSpec.singleTimeDuration) || defaultDur;
            const sPoint = Math.max(0, Number(rangeSpec.inSec) || 0);
            if (rangeSpec.singleTimeMode === "before") {
                reqInSec = Math.max(0, sPoint - sDur);
                reqOutSec = Math.max(reqInSec + 0.1, sPoint);
            } else {
                reqInSec = sPoint;
                reqOutSec = sPoint + sDur;
            }
        } else if (mode === "end") {
            reqInSec = Math.max(0, Number(rangeSpec.inSec) || 0);
            reqOutSec = (totalDur > reqInSec) ? totalDur : (reqInSec + defaultDur);
        } else if (mode === "random") {
            const rDur = Number(rangeSpec.randomDur) || 2;
            if (totalDur > rDur) {
                reqInSec = Math.floor(Math.random() * Math.max(0, totalDur - rDur));
                reqOutSec = reqInSec + rDur;
            } else {
                reqInSec = 0;
                reqOutSec = totalDur > 0 ? totalDur : rDur;
            }
        } else {
            // mode === "auto"
            const noDur = Number(rangeSpec.noTimecodeDuration) || defaultDur;
            if (totalDur > noDur) {
                const mid = totalDur / 2;
                reqInSec = mid - noDur / 2;
                reqOutSec = mid + noDur / 2;
            } else {
                reqInSec = 0;
                reqOutSec = totalDur > 0 ? totalDur : noDur;
            }
        }

        if (totalDur > 0 && reqOutSec > totalDur) {
            reqOutSec = totalDur;
        }
        if (reqOutSec <= reqInSec) {
            reqOutSec = reqInSec + Math.min(defaultDur, totalDur > reqInSec ? (totalDur - reqInSec) : defaultDur);
        }

        // Khoảng cần lấy đã cộng trừ hao ± padSec đầu và đuôi
        const targetStart = Math.max(0, reqInSec - padSec);
        const targetEnd = (totalDur > 0) ? Math.min(totalDur, reqOutSec + padSec) : (reqOutSec + padSec);

        const origExt = path.extname(srcPath) || ".mp4";
        const baseNoExt = path.basename(srcPath, origExt);
        const canStreamCopy = !!(probeRes && probeRes.ok && probeRes.compatibleWithPremiere);
        const outExt = canStreamCopy ? origExt : ".mp4";

        const segFileName = baseNoExt + "_cut_" + fmtSecTag(reqInSec) + "_" + fmtSecTag(reqOutSec) + "_pad" + Math.round(padSec) + "s" + outExt;
        const destPath = path.join(footageDir, segFileName);
        const metaPath = destPath + ".meta.json";

        // Kiểm tra nếu đoạn cắt này đã có sẵn trong Footage/ từ dòng trước thì dùng lại ngay!
        try {
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024 && fs.existsSync(metaPath)) {
                const metaObj = JSON.parse(fs.readFileSync(metaPath, "utf8"));
                if (metaObj && typeof metaObj.localInSec === "number" && typeof metaObj.localOutSec === "number") {
                    job.percent = 100;
                    job.result = {
                        ok: true,
                        cached: true,
                        trimKey: trimKey,
                        filePath: destPath,
                        srcSizeBytes: srcSizeBytes,
                        bytes: fs.statSync(destPath).size,
                        actualStartSec: metaObj.actualStartSec,
                        reqInSec: reqInSec,
                        reqOutSec: reqOutSec,
                        localInSec: metaObj.localInSec,
                        localOutSec: metaObj.localOutSec,
                        padSec: padSec
                    };
                    setJobStatus(job, "done", "Đã có sẵn đoạn cắt gọn: " + segFileName);
                    return;
                }
            }
        } catch (eMeta) {}

        findKeyframeBefore(srcPath, canStreamCopy ? targetStart : 0, (kfStartSec) => {
            if (job.state === "cancelled") return;
            const actualStartSec = canStreamCopy ? kfStartSec : targetStart;
            const cutDuration = Math.max(0.5, targetEnd - actualStartSec);
            const tempOutPath = path.join(footageDir, baseNoExt + "_trimming_" + Date.now() + "_" + Math.floor(Math.random() * 10000) + outExt);

            setJobStatus(
                job,
                "running",
                "✂️ Đang cắt gọn " + path.basename(srcPath) + " (" + fmtClock(targetStart) + " ~ " + fmtClock(targetEnd) + ", ±" + padSec + "s)..."
            );

            function runFfmpegTrim(useStreamCopy, startSecToUse, onDone) {
                const durToUse = Math.max(0.5, targetEnd - startSecToUse);
                const args = [
                    "-y",
                    "-ss", startSecToUse.toFixed(3),
                    "-t", durToUse.toFixed(3),
                    "-i", srcPath
                ];
                if (useStreamCopy) {
                    args.push("-c", "copy", "-avoid_negative_ts", "make_zero");
                } else {
                    args.push(
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"
                    );
                }
                if (outExt.toLowerCase() === ".mp4" || outExt.toLowerCase() === ".mov" || outExt.toLowerCase() === ".m4v") {
                    args.push("-movflags", "+faststart");
                }
                args.push("-progress", "pipe:1", "-nostats", tempOutPath);

                let proc;
                try {
                    proc = cp.spawn(bins.ffmpeg, args, { windowsHide: true });
                } catch (eSp) {
                    return onDone(new Error("Không chạy được ffmpeg: " + eSp.message));
                }
                activeProcs[job.id] = proc;

                const startedMs = Date.now();
                let stderrTail = "";
                if (proc.stdout) {
                    proc.stdout.on("data", (chunk) => {
                        if (job.state === "cancelled") return;
                        const txt = chunk.toString("utf8");
                        const mTime = /out_time_ms=(\d+)/.exec(txt) || /out_time_us=(\d+)/.exec(txt);
                        const mSize = /total_size=(\d+)/.exec(txt);
                        if (mSize) {
                            const curB = parseInt(mSize[1], 10) || 0;
                            job.bytesDone = curB;
                            job.downloadedBytes = curB;
                            const elapsedSec = Math.max(0.1, (Date.now() - startedMs) / 1000);
                            job.speedBps = Math.round(curB / elapsedSec);
                            job.speedMBs = job.speedBps;
                        }
                        if (mTime && durToUse > 0) {
                            const curSec = parseInt(mTime[1], 10) / 1000000;
                            const pct = Math.min(99, Math.max(1, Math.round((curSec / durToUse) * 100)));
                            job.percent = pct;
                        }
                    });
                }
                if (proc.stderr) {
                    proc.stderr.on("data", (chunk) => {
                        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
                    });
                }

                let finished = false;
                function finish(code, err) {
                    if (finished) return;
                    finished = true;
                    delete activeProcs[job.id];
                    if (job.state === "cancelled") {
                        try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch (eU) {}
                        return onDone(new Error("Đã huỷ"));
                    }
                    const ok = (!err && code === 0 && fs.existsSync(tempOutPath) && fs.statSync(tempOutPath).size > 1024);
                    if (ok) {
                        onDone(null, startSecToUse);
                    } else {
                        try { if (fs.existsSync(tempOutPath)) fs.unlinkSync(tempOutPath); } catch (eU2) {}
                        onDone(new Error("FFmpeg trim exit=" + code + " " + stderrTail.substring(0, 200)), startSecToUse);
                    }
                }
                proc.on("error", (err) => finish(-1, err));
                proc.on("close", (code) => finish(code, null));
            }

            runFfmpegTrim(canStreamCopy, actualStartSec, (err1, usedStart1) => {
                if (!err1) {
                    return finalizeTrim(usedStart1);
                }
                if (canStreamCopy && job.state !== "cancelled") {
                    // Fallback sang re-encode nếu container nguồn bị lỗi stream-copy
                    runFfmpegTrim(false, targetStart, (err2, usedStart2) => {
                        if (err2) {
                            setJobStatus(job, "error");
                            job.error = err2.message;
                            return;
                        }
                        finalizeTrim(usedStart2);
                    });
                } else {
                    setJobStatus(job, "error");
                    job.error = err1.message;
                }
            });

            function finalizeTrim(finalStartSec) {
                try {
                    if (fs.existsSync(destPath)) {
                        try { fs.unlinkSync(destPath); } catch (eRm) {}
                    }
                    fs.renameSync(tempOutPath, destPath);
                    const outSizeBytes = fs.statSync(destPath).size || 0;
                    const localInSec = Math.max(0, reqInSec - finalStartSec);
                    const localOutSec = Math.max(localInSec + 0.1, reqOutSec - finalStartSec);

                    const metaData = {
                        srcPath: srcPath,
                        srcSizeBytes: srcSizeBytes,
                        bytes: outSizeBytes,
                        actualStartSec: finalStartSec,
                        reqInSec: reqInSec,
                        reqOutSec: reqOutSec,
                        localInSec: localInSec,
                        localOutSec: localOutSec,
                        padSec: padSec,
                        createdAt: Date.now()
                    };
                    try { fs.writeFileSync(metaPath, JSON.stringify(metaData, null, 2), "utf8"); } catch (eW) {}

                    job.percent = 100;
                    job.result = {
                        ok: true,
                        cached: false,
                        trimKey: trimKey,
                        filePath: destPath,
                        srcSizeBytes: srcSizeBytes,
                        bytes: outSizeBytes,
                        actualStartSec: finalStartSec,
                        reqInSec: reqInSec,
                        reqOutSec: reqOutSec,
                        localInSec: localInSec,
                        localOutSec: localOutSec,
                        padSec: padSec
                    };
                    setJobStatus(job, "done", "Đã cắt gọn xong: " + segFileName);
                } catch (eFin) {
                    setJobStatus(job, "error");
                    job.error = "Không lưu được file cắt gọn: " + eFin.message;
                }
            }
        });
    });
}

// ============================================================================
// 4. HTTP SERVER ROUTER
// ============================================================================
function sendJson(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(body);
}

function readJsonBody(req, cb) {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
        if (!raw) return cb({});
        try { cb(JSON.parse(raw)); } catch (e) { cb({}); }
    });
}

const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
        return sendJson(res, 200, { ok: true });
    }
    const parsed = urlMod.parse(req.url, true);
    const pathname = parsed.pathname || "/";

    if (req.method === "GET" && pathname === "/health") {
        const bins = getBinaries();
        return sendJson(res, 200, {
            ok: true,
            service: "AutoImportCutV3-Sidecar",
            version: VERSION,
            pid: process.pid,
            bins: {
                ytdlp: !!bins.ytdlp,
                ffmpeg: !!bins.ffmpeg,
                ffprobe: !!bins.ffprobe
            }
        });
    }

    if (req.method === "GET" && pathname === "/job") {
        const id = parsed.query.id || "";
        const job = jobs[id];
        if (!job) return sendJson(res, 404, { ok: false, error: "Không tìm thấy job: " + id });
        return sendJson(res, 200, { ok: true, job: job });
    }

    if (req.method === "POST" && pathname === "/cancel") {
        cancelAllJobs();
        return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/probe") {
        return readJsonBody(req, (body) => {
            probeMediaFile(body.filePath || "", (probeRes) => {
                sendJson(res, 200, probeRes);
            });
        });
    }

    if (req.method === "POST" && pathname === "/start-youtube") {
        return readJsonBody(req, (body) => {
            const url = String(body.url || "").trim();
            const destPath = String(body.destPath || "").trim();
            if (!url || !destPath) {
                return sendJson(res, 400, { ok: false, error: "Thiếu url hoặc destPath" });
            }
            const job = createJob("youtube", path.basename(destPath));
            setImmediate(() => runYouTubeDownloadJob(job, url, destPath));
            return sendJson(res, 200, { ok: true, jobId: job.id });
        });
    }

    if (req.method === "POST" && pathname === "/start-convert") {
        return readJsonBody(req, (body) => {
            const filePath = String(body.filePath || "").trim();
            const targetDir = String(body.footageDir || body.targetDir || "").trim();
            const forceConvert = !!(body.forceTranscode || body.forceConvert);
            if (!filePath) {
                return sendJson(res, 400, { ok: false, error: "Thiếu filePath" });
            }
            const job = createJob("convert", path.basename(filePath));
            setImmediate(() => {
                ensurePremiereCompatibleWithJob(job, filePath, targetDir, forceConvert, (compatRes) => {
                    if (job.state === "cancelled") return;
                    if (!compatRes.ok) {
                        setJobStatus(job, "error");
                        job.error = compatRes.error || "Lỗi convert video";
                    } else {
                        job.percent = 100;
                        job.result = compatRes;
                        setJobStatus(job, "done", "Đã convert xong");
                    }
                });
            });
            return sendJson(res, 200, { ok: true, jobId: job.id });
        });
    }

    if (req.method === "POST" && pathname === "/start-trim-copy") {
        return readJsonBody(req, (body) => {
            const srcPath = String(body.srcPath || "").trim();
            const footageDir = String(body.footageDir || "").trim();
            if (!srcPath || !footageDir) {
                return sendJson(res, 400, { ok: false, error: "Thiếu srcPath hoặc footageDir" });
            }
            const job = createJob("trim", path.basename(srcPath));
            setImmediate(() => runTrimCopyJob(job, body));
            return sendJson(res, 200, { ok: true, jobId: job.id });
        });
    }

    sendJson(res, 404, { ok: false, error: "Endpoint không tồn tại: " + pathname });
});

server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
        if (typeof require !== "undefined" && require.main === module) {
            process.exit(0);
        }
    }
});

server.listen(PORT, HOST, () => {
    console.log("AutoImportCutV3 Sidecar Server listening on http://" + HOST + ":" + PORT);
});
