import express from "express";
import { spawn, execSync } from "child_process";
import { createReadStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const YTDLP_CANDIDATES = [
    process.env.YTDLP_BIN,
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
].filter(Boolean);

function resolveYtDlpBin() {
    for (const bin of YTDLP_CANDIDATES) {
        if (fs.existsSync(bin)) return bin;
    }
    try {
        return execSync("command -v yt-dlp", { encoding: "utf8" }).trim();
    } catch {
        return process.env.YTDLP_BIN || "/usr/local/bin/yt-dlp";
    }
}

const YTDLP_BIN = resolveYtDlpBin();

const spawnEnv = {
    ...process.env,
    PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOWNLOADS = path.join(__dirname, "downloads");
const AUDIO_EXT = new Set([".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav", ".webm"]);

const app = express();
const PORT = 3000;

function resolveDownloadsRoot(customDest) {
    const dest = (customDest || "").trim();
    return dest ? path.resolve(dest) : DEFAULT_DOWNLOADS;
}

function safeInsideRoot(root, ...segments) {
    const base = path.resolve(root);
    const target = path.resolve(base, ...segments);
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error("Caminho inválido");
    }
    return target;
}

function isAudioFile(name) {
    return AUDIO_EXT.has(path.extname(name).toLowerCase());
}

function archiveKeyForLink(link) {
    return Buffer.from(link.trim()).toString("base64").slice(0, 8);
}

function archiveFilePath(dest, link) {
    return path.join(dest, `.archive_${archiveKeyForLink(link)}.txt`);
}

function metaFilePath(dest, link) {
    return path.join(dest, `.download_${archiveKeyForLink(link)}.json`);
}

function countArchiveEntries(archiveFile) {
    if (!fs.existsSync(archiveFile)) return 0;
    return fs
        .readFileSync(archiveFile, "utf8")
        .split("\n")
        .filter((line) => line.trim()).length;
}

function saveDownloadMeta(dest, link, patch = {}) {
    const file = metaFilePath(dest, link);
    let meta = {
        link: link.trim(),
        dest,
        archiveFile: archiveFilePath(dest, link),
        playlistDir: null,
        status: "active",
        updatedAt: Date.now(),
    };
    if (fs.existsSync(file)) {
        try {
            meta = { ...meta, ...JSON.parse(fs.readFileSync(file, "utf8")) };
        } catch { /* ignora meta corrompido */ }
    }
    meta = { ...meta, ...patch, link: link.trim(), updatedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(meta, null, 2));
}

function listDownloadMetas(root) {
    fs.mkdirSync(root, { recursive: true });
    const resumes = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(".download_") || !entry.name.endsWith(".json")) {
            continue;
        }
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
            if (!meta.link || meta.status === "complete") continue;
            resumes.push({
                link: meta.link,
                playlistDir: meta.playlistDir ?? null,
                status: meta.status,
                archivedCount: countArchiveEntries(meta.archiveFile),
                archiveFile: meta.archiveFile,
                updatedAt: meta.updatedAt,
                canResume: true,
            });
        } catch { /* ignora */ }
    }

    resumes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return resumes;
}

function listDirFiles(dirPath) {
    return fs
        .readdirSync(dirPath, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => {
            const fp = path.join(dirPath, f.name);
            const stat = fs.statSync(fp);
            return {
                name: f.name,
                size: stat.size,
                mtime: stat.mtimeMs,
                path: fp,
                isAudio: isAudioFile(f.name),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function listLibrary(root) {
    fs.mkdirSync(root, { recursive: true });
    const playlists = [];
    let totalBytes = 0;
    const resumes = listDownloadMetas(root);

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

        const dirPath = path.join(root, entry.name);
        const files = listDirFiles(dirPath);
        const folderBytes = files.reduce((sum, f) => sum + f.size, 0);
        totalBytes += folderBytes;

        const tracks = files
            .filter((f) => f.isAudio)
            .map((f) => ({
                name: f.name.replace(/\.[^.]+$/, ""),
                file: f.name,
                size: f.size,
                mtime: f.mtime,
                path: f.path,
            }));

        if (tracks.length === 0 && files.length === 0) continue;

        const stat = fs.statSync(dirPath);
        const resume = resumes.find((r) => r.playlistDir === entry.name) ?? null;

        playlists.push({
            name: entry.name,
            path: dirPath,
            tracks,
            files: files.map((f) => ({
                name: f.name,
                size: f.size,
                path: f.path,
                isAudio: f.isAudio,
            })),
            totalSize: folderBytes,
            mtime: stat.mtimeMs,
            resume,
        });
    }

    playlists.sort((a, b) => b.mtime - a.mtime);
    return {
        root,
        playlists,
        storage: { root, totalBytes },
        resumes,
    };
}

function findLatestPlaylistDir(root, sinceMs) {
    try {
        const { playlists } = listLibrary(root);
        const candidates = playlists.filter((p) => p.mtime >= sinceMs - 5000);
        if (candidates.length === 0) return playlists[0]?.name ?? null;
        return candidates.sort((a, b) => b.mtime - a.mtime)[0].name;
    } catch {
        return null;
    }
}

function countNewTracks(root, sinceMs) {
    try {
        const { playlists } = listLibrary(root);
        let count = 0;
        for (const pl of playlists) {
            for (const t of pl.tracks) {
                if (t.mtime >= sinceMs - 3000) count++;
            }
        }
        return count;
    } catch {
        return 0;
    }
}

function isTrackFinishedLine(line) {
    return (
        /\[ExtractAudio\]\s+Destination:.+\.mp3/i.test(line)
        || /Adding metadata to ".+\.mp3"/i.test(line)
        || /\[EmbedThumbnail\].+\.mp3/i.test(line)
    );
}

function buildJobFinishPayload(job, code) {
    const newTracks = countNewTracks(job.dest, job.startedAt);
    if (!job.playlistDir) {
        job.playlistDir = findLatestPlaylistDir(job.dest, job.startedAt);
    }
    const playlistDir = job.playlistDir ?? null;

    if (code === 0) {
        return {
            event: "done",
            data: { message: "Download concluído com sucesso!", playlistDir },
        };
    }
    if (code === 127) {
        return {
            event: "error",
            data: {
                message: "yt-dlp não instalado no container (código 127). Rode: docker exec zima-dlp-ytb yt-dlp --version",
            },
        };
    }
    if (newTracks > 0) {
        return {
            event: "done",
            data: {
                message: `Download concluído com avisos (${newTracks} faixa(s), código ${code})`,
                playlistDir,
                partial: true,
            },
        };
    }
    return {
        event: "error",
        data: { message: `Processo encerrado com código ${code}` },
    };
}

function detectPlaylistDirFromLine(line, destRoot) {
    const dest = path.resolve(destRoot);
    const idx = line.indexOf(dest);
    if (idx !== -1) {
        const after = line.slice(idx + dest.length).replace(/^[/\\]+/, "");
        const folder = after.split(/[/\\]/)[0];
        if (folder && !folder.startsWith(".")) return folder;
    }
    const base = path.basename(dest);
    const rel = `${base}${path.sep}`;
    const relIdx = line.indexOf(rel);
    if (relIdx !== -1) {
        const after = line.slice(relIdx + rel.length);
        const folder = after.split(/[/\\]/)[0];
        if (folder && !folder.startsWith(".")) return folder;
    }
    return null;
}

function streamAudioFile(req, res, filePath) {
    const stat = fs.statSync(filePath);
    const total = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const mime =
        ext === ".mp3" ? "audio/mpeg"
            : ext === ".m4a" ? "audio/mp4"
                : ext === ".ogg" ? "audio/ogg"
                    : ext === ".opus" ? "audio/opus"
                        : ext === ".flac" ? "audio/flac"
                            : "application/octet-stream";

    const range = req.headers.range;
    if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : total - 1;
        if (start >= total || end >= total) {
            res.status(416).setHeader("Content-Range", `bytes */${total}`);
            return res.end();
        }
        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            "Content-Type": mime,
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        "Content-Length": total,
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
    });
    createReadStream(filePath).pipe(res);
}

app.use(express.json());

app.use((req, res, next) => {
    if (req.path === "/sw.js") {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
    next();
});

app.use(express.static(path.join(__dirname, "public")));

// Map de jobs: jobId -> { process, subscribers[], history[], ... }
const jobs = new Map();
const MAX_JOB_HISTORY = 4000;

function appendJobHistory(job, event, data) {
    if (!job.history) job.history = [];
    job.history.push({ event, data });
    if (job.history.length > MAX_JOB_HISTORY) {
        job.history.splice(0, job.history.length - MAX_JOB_HISTORY);
    }
}

function writeSseEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function replayJobHistory(res, job) {
    for (const { event, data } of job.history || []) {
        writeSseEvent(res, event, data);
    }
}

function cookieArgs() {
    if (process.env.YTDLP_COOKIES_FILE) {
        return ["--cookies", process.env.YTDLP_COOKIES_FILE];
    }
    if (process.env.YTDLP_DISABLE_COOKIES === "1") {
        return [];
    }
    const browser = process.env.YTDLP_COOKIES_BROWSER || "chrome";
    return ["--cookies-from-browser", browser];
}

function buildArgs(link, destino) {
    const playlistSafe = `%(playlist_title)s`;
    const archiveFile = archiveFilePath(destino, link);

    return [
        "--download-archive", archiveFile,
        "--no-overwrites",
        "--continue",
        "--sleep-interval", "3",
        "--max-sleep-interval", "8",
        "--ignore-errors",
        ...cookieArgs(),
        "--js-runtimes", "node",
        "-x", "--audio-format", "mp3",
        "--embed-thumbnail",
        "--add-metadata",
        "--metadata-from-title", "%(artist)s - %(title)s",
        "--parse-metadata", "%(playlist_title)s:%(album)s",
        "--parse-metadata", "%(playlist_index)02d:%(track_number)s",
        "--replace-in-metadata", "playlist_title", "Album - ", "",
        "-o", path.join(destino, `${playlistSafe}/%(title)s.%(ext)s`),
        "--newline",       // força uma linha por update de progresso
        link,
    ];
}

// POST /download — inicia o download, retorna jobId
app.post("/download", (req, res) => {
    const { link, destino } = req.body;

    if (!link) {
        return res.status(400).json({ error: "Campo 'link' é obrigatório." });
    }

    const dest = destino?.trim() || path.join(__dirname, "downloads");

    // Garante que a pasta de destino existe
    fs.mkdirSync(dest, { recursive: true });

    const linkTrim = link.trim();
    const jobId = `job_${Date.now()}`;
    const args = buildArgs(linkTrim, dest);
    const archivedBefore = countArchiveEntries(archiveFilePath(dest, linkTrim));

    saveDownloadMeta(dest, linkTrim, { status: "active", dest });

    if (!fs.existsSync(YTDLP_BIN)) {
        return res.status(503).json({
            error: `yt-dlp não encontrado em ${YTDLP_BIN}. O container precisa rodar via entrypoint.sh (instalar.sh).`,
        });
    }

    const proc = spawn(YTDLP_BIN, args, { cwd: dest, env: spawnEnv });
    const startedAt = Date.now();

    jobs.set(jobId, {
        process: proc,
        subscribers: [],
        history: [],
        done: false,
        exitCode: null,
        dest,
        link: linkTrim,
        startedAt,
        playlistDir: null,
        archivedBefore,
    });

    function broadcast(event, data) {
        const job = jobs.get(jobId);
        if (!job) return;
        appendJobHistory(job, event, data);
        job.subscribers.forEach((sub) => writeSseEvent(sub, event, data));
        if (event === "done" || event === "error") {
            job.subscribers.forEach((sub) => sub.end());
            job.done = true;
        }
    }

    function onLogLine(line, stderr) {
        const job = jobs.get(jobId);
        if (job) {
            const detected = detectPlaylistDirFromLine(line, job.dest);
            if (detected) {
                job.playlistDir = detected;
                saveDownloadMeta(job.dest, job.link, { playlistDir: detected });
            }
            if (isTrackFinishedLine(line)) {
                broadcast("track", { playlistDir: job.playlistDir });
            }
        }
        broadcast("log", { line, stderr });
    }

    proc.stdout.on("data", (chunk) => {
        chunk.toString().split("\n").filter(Boolean).forEach((line) => onLogLine(line, false));
    });

    proc.stderr.on("data", (chunk) => {
        chunk.toString().split("\n").filter(Boolean).forEach((line) => onLogLine(line, true));
    });

    proc.on("error", (err) => {
        broadcast("error", {
            message: err.code === "ENOENT"
                ? `yt-dlp não encontrado (${YTDLP_BIN}). Reinicie o container com ./instalar.sh`
                : err.message,
        });
    });

    proc.on("close", (code) => {
        const job = jobs.get(jobId);
        if (job) {
            job.exitCode = code;
            job.done = true;
            const archivedNow = countArchiveEntries(archiveFilePath(job.dest, job.link));
            const { event, data } = buildJobFinishPayload(job, code);
            let status = "failed";
            if (event === "done" && !data.partial) status = "complete";
            else if (event === "done") status = "partial";
            else if (countNewTracks(job.dest, job.startedAt) > 0 || archivedNow > job.archivedBefore) {
                status = "partial";
            }
            saveDownloadMeta(job.dest, job.link, {
                playlistDir: job.playlistDir,
                status,
                archivedCount: archivedNow,
            });
            broadcast(event, {
                ...data,
                resumeLink: status !== "complete" ? job.link : null,
                archivedCount: archivedNow,
            });
        }
        setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
    });

    res.json({
        jobId,
        resumed: archivedBefore > 0,
        archivedCount: archivedBefore,
    });
});

// GET /api/jobs/active — job em andamento (para reconectar após refresh)
app.get("/api/jobs/active", (req, res) => {
    for (const [jobId, job] of jobs) {
        if (!job.done) {
            return res.json({
                active: true,
                jobId,
                link: job.link,
                dest: job.dest,
                playlistDir: job.playlistDir,
                startedAt: job.startedAt,
                logCount: job.history?.length ?? 0,
            });
        }
    }
    res.json({ active: false });
});

// GET /api/jobs/:jobId — status do job (existe? terminou?)
app.get("/api/jobs/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.json({ exists: false });
    }
    res.json({
        exists: true,
        done: job.done,
        exitCode: job.exitCode,
        link: job.link,
        playlistDir: job.playlistDir,
        logCount: job.history?.length ?? 0,
    });
});

// GET /progress/:jobId — SSE stream de progresso (replay do histórico ao reconectar)
app.get("/progress/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    if (!job) {
        writeSseEvent(res, "error", { message: "Job não encontrado" });
        return res.end();
    }

    writeSseEvent(res, "reconnected", {
        replay: true,
        logCount: job.history?.length ?? 0,
        done: job.done,
    });

    replayJobHistory(res, job);

    if (job.done) {
        return res.end();
    }

    job.subscribers.push(res);

    req.on("close", () => {
        const j = jobs.get(jobId);
        if (j) j.subscribers = j.subscribers.filter((s) => s !== res);
    });
});

// GET /api/library — lista playlists e faixas
app.get("/api/library", (req, res) => {
    try {
        const root = resolveDownloadsRoot(req.query.dest);
        res.json(listLibrary(root));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/audio/:playlist/:file — stream com suporte a Range
app.get("/api/audio/:playlist/:file", (req, res) => {
    try {
        const root = resolveDownloadsRoot(req.query.dest);
        const playlist = decodeURIComponent(req.params.playlist);
        const file = decodeURIComponent(req.params.file);
        const filePath = safeInsideRoot(root, playlist, file);
        if (!fs.existsSync(filePath) || !isAudioFile(file)) {
            return res.status(404).json({ error: "Arquivo não encontrado" });
        }
        streamAudioFile(req, res, filePath);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/library/rename — renomeia pasta da playlist
app.post("/api/library/rename", (req, res) => {
    const { oldName, newName, destino } = req.body || {};
    if (!oldName?.trim() || !newName?.trim()) {
        return res.status(400).json({ error: "oldName e newName são obrigatórios" });
    }
    const cleanNew = newName.trim().replace(/[/\\]/g, "");
    if (!cleanNew || cleanNew === "." || cleanNew === "..") {
        return res.status(400).json({ error: "Nome inválido" });
    }

    try {
        const root = resolveDownloadsRoot(destino);
        const from = safeInsideRoot(root, oldName.trim());
        const to = safeInsideRoot(root, cleanNew);

        if (!fs.existsSync(from)) {
            return res.status(404).json({ error: "Pasta não encontrada" });
        }
        if (fs.existsSync(to)) {
            return res.status(409).json({ error: "Já existe uma pasta com esse nome" });
        }

        fs.renameSync(from, to);
        res.json({ ok: true, name: cleanNew });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /cancel/:jobId — mata o processo
app.post("/cancel/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.done) return res.json({ ok: false, message: "Job não encontrado ou já finalizado" });

    job.process.kill("SIGTERM");
    res.json({ ok: true });
});

// console.log();
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🎵 Music Downloader rodando em http://0.0.0.0:${PORT}`);
    try {
        const version = execSync(`"${YTDLP_BIN}" --version`, { encoding: "utf8", env: spawnEnv }).trim();
        console.log(`✓ yt-dlp: ${version} (${YTDLP_BIN})`);
    } catch {
        console.error(`✗ yt-dlp NÃO encontrado em ${YTDLP_BIN} — downloads falharão (erro 127)`);
        console.error("  Suba o container com: ./instalar.sh  (roda entrypoint.sh)");
    }
});
