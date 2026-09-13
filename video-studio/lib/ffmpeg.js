/**
 * Finding and driving the ffmpeg binary.
 *
 * Resolution order:
 *   1. $FFMPEG_PATH
 *   2. the `ffmpeg-static` npm package (installed by `npm install` here)
 *   3. whatever `ffmpeg` is on PATH
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

let cachedPath;

export function ffmpegPath() {
  if (cachedPath !== undefined) return cachedPath;
  cachedPath = resolve();
  return cachedPath;
}

function resolve() {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && isRunnable(fromEnv)) return fromEnv;

  try {
    const stat = require('ffmpeg-static');
    if (stat && fs.existsSync(stat)) {
      try {
        fs.chmodSync(stat, 0o755);
      } catch {
        /* already executable */
      }
      if (isRunnable(stat)) return stat;
    }
  } catch {
    /* package not installed - fall through */
  }

  return isRunnable('ffmpeg') ? 'ffmpeg' : null;
}

function isRunnable(bin) {
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 15000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function ffmpegVersion() {
  const bin = ffmpegPath();
  if (!bin) return null;
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').split('\n')[0] || null;
}

/** Which of the named filters/encoders this build actually has. */
export function ffmpegHas(kind /* 'filters' | 'encoders' */, names) {
  const bin = ffmpegPath();
  if (!bin) return {};
  const r = spawnSync(bin, [`-${kind}`], { encoding: 'utf8', timeout: 20000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const found = {};
  for (const n of names) found[n] = new RegExp(`\\s${escapeRe(n)}\\s`).test(out);
  return found;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const MISSING_FFMPEG_MESSAGE = [
  'ffmpeg was not found.',
  '',
  'Fix it with either of these:',
  '  • cd video-studio && npm install      (downloads a private copy, nothing global)',
  '  • install it system-wide:  macOS: brew install ffmpeg',
  '                             Debian/Ubuntu: sudo apt install ffmpeg',
  '                             Windows: winget install Gyan.FFmpeg',
  '',
  'Or point at an existing binary:  FFMPEG_PATH=/path/to/ffmpeg npm start',
].join('\n');

export class FfmpegError extends Error {
  constructor(message, { args, log } = {}) {
    super(message);
    this.name = 'FfmpegError';
    this.args = args;
    this.log = log;
  }
}

/**
 * Run ffmpeg once.
 * @param {string[]} args
 * @param {(seconds:number)=>void} [onProgress] called with the encoded timestamp
 * @param {(child:import('node:child_process').ChildProcess)=>void} [onSpawn]
 */
export function runFfmpeg(args, onProgress, onSpawn) {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new FfmpegError(MISSING_FFMPEG_MESSAGE));

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (onSpawn) onSpawn(child);

    let log = '';
    const absorb = (buf) => {
      const text = buf.toString();
      log += text;
      if (log.length > 200000) log = log.slice(-100000);
      if (onProgress) {
        // `-progress pipe:1` writes out_time_us=..., plain stderr writes time=...
        const us = [...text.matchAll(/out_time_us=(\d+)/g)].pop();
        if (us) onProgress(Number(us[1]) / 1e6);
        else {
          const t = [...text.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)].pop();
          if (t) onProgress(Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]));
        }
      }
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);

    child.on('error', (err) => reject(new FfmpegError(`Could not start ffmpeg: ${err.message}`, { args })));
    child.on('close', (code, signal) => {
      if (code === 0) resolve(log);
      else if (signal) reject(new FfmpegError(`ffmpeg was stopped (${signal})`, { args, log }));
      else reject(new FfmpegError(lastRealError(log) || `ffmpeg exited with code ${code}`, { args, log }));
    });
  });
}

function lastRealError(log) {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|invalid|no such file|not found|failed|unable/i.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] || '';
}

/**
 * Read duration / dimensions / audio presence straight out of ffmpeg's own
 * stderr, so we don't need ffprobe as a second dependency.
 */
export function probeMedia(file) {
  const bin = ffmpegPath();
  if (!bin) return null;
  const r = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 30000 });
  const out = (r.stderr || '') + (r.stdout || '');

  const dur = out.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const size = out.match(/Stream #\d+:\d+.*?Video:.*?,\s*(\d{2,5})x(\d{2,5})/s);
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    hasVideo: /Stream #\d+:\d+.*?Video:/.test(out),
    hasAudio: /Stream #\d+:\d+.*?Audio:/.test(out),
  };
}
