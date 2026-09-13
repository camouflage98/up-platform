#!/usr/bin/env node
/**
 * The local editor server. No framework, no dependencies - just enough HTTP to
 * serve the editor, move files around and drive ffmpeg.
 *
 *   npm start   ->   http://127.0.0.1:4173
 *
 * It binds to localhost only. This is a tool for your own machine, and it can
 * read and write files inside video-studio/, so don't expose it to a network.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROOT,
  MEDIA_DIR,
  EXPORTS_DIR,
  PROJECTS_DIR,
  ensureDirs,
  listProjects,
  loadProject,
  saveProject,
  createProject,
  projectPath,
  projectModified,
  listMedia,
  uniqueMediaName,
  safeName,
} from './lib/store.js';
import { normalizeProject, projectDuration } from './lib/project.js';
import { renderProject, FORMATS, QUALITY, RenderCancelled } from './lib/render.js';
import { ffmpegPath, ffmpegVersion, probeMedia, MISSING_FFMPEG_MESSAGE } from './lib/ffmpeg.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const LIB_DIR = path.join(ROOT, 'lib');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB

ensureDirs();

/** id -> { id, status, percent, message, error, outFile, control } */
const jobs = new Map();
/** id -> Set<ServerResponse> for progress streams */
const jobListeners = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // ── API ──────────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      return await api(req, res, url, route);
    }

    // ── files ────────────────────────────────────────────────────────────
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      if (url.pathname.startsWith('/lib/')) {
        return sendFromDir(res, LIB_DIR, url.pathname.slice('/lib/'.length));
      }
      if (url.pathname.startsWith('/media/')) {
        return sendFromDir(res, MEDIA_DIR, decodeURIComponent(url.pathname.slice('/media/'.length)), req);
      }
      if (url.pathname.startsWith('/exports/')) {
        return sendFromDir(res, EXPORTS_DIR, decodeURIComponent(url.pathname.slice('/exports/'.length)), req);
      }
      return sendFromDir(res, PUBLIC_DIR, url.pathname.slice(1));
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  }
});

// ───────────────────────────────── API ──────────────────────────────────────

async function api(req, res, url, route) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (route === 'GET /api/health') {
    const bin = ffmpegPath();
    return send(res, 200, {
      ok: true,
      ffmpeg: bin ? { path: bin, version: ffmpegVersion() } : null,
      ffmpegHelp: bin ? null : MISSING_FFMPEG_MESSAGE,
      formats: Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v.label])),
      qualities: Object.keys(QUALITY),
      root: ROOT,
    });
  }

  // ── projects ──
  if (route === 'GET /api/projects') return send(res, 200, { projects: listProjects() });

  if (route === 'POST /api/projects') {
    const body = await readJson(req);
    const created = createProject(body.name || 'Untitled');
    return send(res, 200, created);
  }

  if (seg[1] === 'projects' && seg[2]) {
    const id = safeName(decodeURIComponent(seg[2]));
    if (req.method === 'GET') {
      if (!fs.existsSync(projectPath(id))) return send(res, 404, { error: `No project "${id}"` });
      return send(res, 200, { id, project: loadProject(id), modified: projectModified(id) });
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      // Refuse to clobber a change made outside the editor (e.g. by an agent)
      // unless the client says it knows about it.
      const onDisk = projectModified(id);
      if (body.baseModified && onDisk && onDisk - body.baseModified > 1) {
        return send(res, 409, { error: 'changed-on-disk', modified: onDisk, project: loadProject(id) });
      }
      const saved = saveProject(id, body.project);
      return send(res, 200, saved);
    }
    if (req.method === 'DELETE') {
      fs.rmSync(projectPath(id), { force: true });
      return send(res, 200, { ok: true });
    }
  }

  // ── media ──
  if (route === 'GET /api/media') return send(res, 200, { media: listMedia() });

  if (route === 'POST /api/media') {
    const name = uniqueMediaName(url.searchParams.get('name') || 'file');
    const dest = path.join(MEDIA_DIR, name);
    await saveStream(req, dest);
    const probe = probeMedia(dest) || {};
    return send(res, 200, {
      name,
      src: `media/${name}`,
      duration: probe.duration || 0,
      width: probe.width || 0,
      height: probe.height || 0,
      hasAudio: !!probe.hasAudio,
      hasVideo: !!probe.hasVideo,
    });
  }

  if (seg[1] === 'media' && seg[2] && req.method === 'DELETE') {
    const file = safeJoin(MEDIA_DIR, decodeURIComponent(seg[2]));
    if (file) fs.rmSync(file, { force: true });
    return send(res, 200, { ok: true });
  }

  // ── exports ──
  if (route === 'GET /api/exports') {
    const files = fs.existsSync(EXPORTS_DIR)
      ? fs
          .readdirSync(EXPORTS_DIR)
          .filter((f) => !f.startsWith('.'))
          .map((f) => {
            const st = fs.statSync(path.join(EXPORTS_DIR, f));
            return { name: f, url: `/exports/${encodeURIComponent(f)}`, size: st.size, modified: st.mtimeMs };
          })
          .sort((a, b) => b.modified - a.modified)
      : [];
    return send(res, 200, { exports: files });
  }

  if (route === 'POST /api/export') {
    const body = await readJson(req);
    return startExport(res, body);
  }

  if (seg[1] === 'export' && seg[2] && seg[3] === 'events' && req.method === 'GET') {
    return streamJob(res, seg[2]);
  }

  if (seg[1] === 'export' && seg[2] && seg[3] === 'cancel' && req.method === 'POST') {
    const job = jobs.get(seg[2]);
    if (job && job.status === 'running') {
      job.control.cancelled = true;
      if (job.control.child) job.control.child.kill('SIGKILL');
    }
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: `No API route for ${route}` });
}

// ──────────────────────────────── export jobs ───────────────────────────────

function startExport(res, body) {
  if (!ffmpegPath()) return send(res, 400, { error: MISSING_FFMPEG_MESSAGE });

  let project;
  try {
    project = normalizeProject(body.project);
  } catch (err) {
    return send(res, 400, { error: `Bad project: ${err.message}` });
  }
  if (projectDuration(project) <= 0) {
    return send(res, 400, { error: 'Nothing to render yet — add a clip to the timeline first.' });
  }

  const format = FORMATS[body.format] ? body.format : 'mp4';
  const quality = QUALITY[body.quality] ? body.quality : 'good';
  const base = safeName(body.filename || project.name, 'video');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(2);
  const outFile = path.join(EXPORTS_DIR, `${base}-${stamp}.${FORMATS[format].ext}`);

  const id = `job${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const job = {
    id,
    status: 'running',
    percent: 0,
    message: 'Starting',
    outFile,
    name: path.basename(outFile),
    control: { cancelled: false, child: null },
  };
  jobs.set(id, job);

  renderProject(project, {
    outFile,
    format,
    quality,
    rootDir: ROOT,
    control: job.control,
    onProgress: ({ percent, message }) => {
      job.percent = Math.max(job.percent, Math.min(99, percent));
      job.message = message;
      emit(id, { type: 'progress', percent: job.percent, message });
    },
  })
    .then(() => {
      job.status = 'done';
      job.percent = 100;
      job.message = 'Finished';
      job.size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      emit(id, {
        type: 'done',
        percent: 100,
        name: job.name,
        url: `/exports/${encodeURIComponent(job.name)}`,
        size: job.size,
      });
    })
    .catch((err) => {
      job.status = err instanceof RenderCancelled ? 'cancelled' : 'error';
      job.error = err.message;
      fs.rmSync(outFile, { force: true });
      emit(id, { type: job.status, error: err.message });
      if (job.status === 'error') console.error('[export]', err.message);
    })
    .finally(() => {
      setTimeout(() => closeListeners(id), 1000);
    });

  send(res, 200, { jobId: id, name: job.name });
}

function streamJob(res, id) {
  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: 'No such export job' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  if (!jobListeners.has(id)) jobListeners.set(id, new Set());
  jobListeners.get(id).add(res);
  res.on('close', () => jobListeners.get(id)?.delete(res));

  // catch a late subscriber up
  res.write(`data: ${JSON.stringify({ type: 'progress', percent: job.percent, message: job.message })}\n\n`);
  if (job.status === 'done') {
    res.write(
      `data: ${JSON.stringify({
        type: 'done',
        percent: 100,
        name: job.name,
        url: `/exports/${encodeURIComponent(job.name)}`,
        size: job.size,
      })}\n\n`
    );
  } else if (job.status === 'error' || job.status === 'cancelled') {
    res.write(`data: ${JSON.stringify({ type: job.status, error: job.error })}\n\n`);
  }
}

function emit(id, payload) {
  const set = jobListeners.get(id);
  if (!set) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(line);
    } catch {
      set.delete(res);
    }
  }
}

function closeListeners(id) {
  const set = jobListeners.get(id);
  if (!set) return;
  for (const res of set) {
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }
  jobListeners.delete(id);
}

// ──────────────────────────────── plumbing ──────────────────────────────────

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function saveStream(req, dest) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(dest);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        out.destroy();
        fs.rmSync(dest, { force: true });
        reject(new Error('File too large'));
        req.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

/** Resolve `rel` under `dir`, refusing anything that escapes it. */
function safeJoin(dir, rel) {
  const target = path.resolve(dir, rel);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

function sendFromDir(res, dir, rel, req = null) {
  const file = safeJoin(dir, rel || '');
  if (!file) return send(res, 403, { error: 'Forbidden' });
  return sendFile(res, file, req);
}

/**
 * Static file send with byte-range support - the preview player needs ranges
 * to scrub around inside a video without downloading the whole thing.
 */
function sendFile(res, file, req = null) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req && req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;

    if (range) {
      let start = range[1] ? Number(range[1]) : null;
      let end = range[2] ? Number(range[2]) : null;
      if (start === null) {
        // suffix range: last N bytes
        start = Math.max(0, st.size - (end || 0));
        end = st.size - 1;
      }
      if (end === null || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

server.listen(PORT, HOST, () => {
  const bin = ffmpegPath();
  console.log(`\n  Video Studio  →  http://${HOST}:${PORT}\n`);
  console.log(`  projects: ${path.relative(process.cwd(), PROJECTS_DIR) || PROJECTS_DIR}`);
  console.log(`  media:    ${path.relative(process.cwd(), MEDIA_DIR) || MEDIA_DIR}`);
  console.log(`  exports:  ${path.relative(process.cwd(), EXPORTS_DIR) || EXPORTS_DIR}`);
  console.log(bin ? `  ffmpeg:   ${bin}\n` : `\n  ! ${MISSING_FFMPEG_MESSAGE}\n`);
});
