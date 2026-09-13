/**
 * Rendering a project to MP4 / AVI.
 *
 * Strategy: render each stretch of the timeline to its own short, identically
 * encoded segment, concatenate them, then do one final pass that burns in the
 * subtitles and mixes the music. Segments are far easier to reason about (and
 * to debug) than one enormous filtergraph, and the concat is a stream copy.
 *
 *   clips ──▶ seg000.mp4 seg001.mp4 … ──▶ concat ──▶ subtitles + music ──▶ out
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { timelineSegments, projectDuration } from './project.js';
import { getEffect, toFfmpegExpr } from './effects.js';
import { buildAss, buildSrt, escapeFilterPath } from './subtitles.js';
import { runFfmpeg, ffmpegPath, probeMedia, FfmpegError, MISSING_FFMPEG_MESSAGE } from './ffmpeg.js';

/** Supersampling factor for moving shots: bigger source = smoother zoompan. */
const SUPERSAMPLE = 2;

export const QUALITY = {
  draft: { crf: 28, preset: 'veryfast', audioBitrate: '128k' },
  good: { crf: 20, preset: 'medium', audioBitrate: '192k' },
  best: { crf: 16, preset: 'slow', audioBitrate: '256k' },
};

export const FORMATS = {
  mp4: {
    ext: 'mp4',
    label: 'MP4 (H.264 + AAC) — best for web, phones, social',
    videoArgs: (q) => ['-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p'],
    audioArgs: (q) => ['-c:a', 'aac', '-b:a', q.audioBitrate],
    extraArgs: () => ['-movflags', '+faststart'],
  },
  avi: {
    ext: 'avi',
    label: 'AVI (MPEG-4 + MP3) — for older editors and players',
    videoArgs: (q) => ['-c:v', 'mpeg4', '-vtag', 'DIVX', '-q:v', String(Math.max(2, Math.round(q.crf / 5)))],
    audioArgs: (q) => ['-c:a', 'libmp3lame', '-b:a', q.audioBitrate],
    extraArgs: () => [],
  },
};

export class RenderCancelled extends Error {
  constructor() {
    super('Render cancelled');
    this.name = 'RenderCancelled';
  }
}

/**
 * @param {object} project      a normalized project
 * @param {object} opts
 * @param {string} opts.outFile absolute path of the file to write
 * @param {string} [opts.format] 'mp4' | 'avi'
 * @param {string} opts.rootDir  directory that relative `src` paths resolve against
 * @param {string} [opts.quality] 'draft' | 'good' | 'best'
 * @param {(p:{percent:number,stage:string,message:string})=>void} [opts.onProgress]
 * @param {{cancelled:boolean, child:any}} [opts.control] set control.cancelled to abort
 */
export async function renderProject(project, opts) {
  const {
    outFile,
    format = 'mp4',
    rootDir,
    quality = 'good',
    onProgress = () => {},
    control = {},
  } = opts;

  if (!ffmpegPath()) throw new FfmpegError(MISSING_FFMPEG_MESSAGE);

  const fmt = FORMATS[format] || FORMATS.mp4;
  const q = QUALITY[quality] || QUALITY.good;
  const total = projectDuration(project);
  if (total <= 0) throw new Error('Nothing to render yet — add a clip to the timeline first.');

  const segments = timelineSegments(project);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-'));

  const runStep = async (args, onTime) => {
    if (control.cancelled) throw new RenderCancelled();
    return runFfmpeg(args, onTime, (child) => {
      control.child = child;
      if (control.cancelled) child.kill('SIGKILL');
    });
  };

  try {
    // ── 1. one file per timeline segment ──────────────────────────────────
    // Segments are 80% of the wall-clock cost; weight progress accordingly.
    const segFiles = [];
    let doneSeconds = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDur = seg.end - seg.start;
      const file = path.join(work, `seg${String(i).padStart(4, '0')}.mp4`);
      const args = buildSegmentArgs(project, seg, { rootDir, file, quality: q });

      onProgress({
        percent: (doneSeconds / total) * 80,
        stage: 'clips',
        message: `Rendering clip ${i + 1} of ${segments.length}`,
      });

      await runStep(args, (t) => {
        const pct = ((doneSeconds + Math.min(t, segDur)) / total) * 80;
        onProgress({ percent: pct, stage: 'clips', message: `Rendering clip ${i + 1} of ${segments.length}` });
      });

      doneSeconds += segDur;
      segFiles.push(file);
    }

    // ── 2. stitch, burn subtitles, mix music ──────────────────────────────
    const listFile = path.join(work, 'segments.txt');
    fs.writeFileSync(listFile, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');

    const finalArgs = buildFinalArgs(project, {
      listFile,
      work,
      rootDir,
      outFile,
      fmt,
      quality: q,
      total,
    });

    onProgress({ percent: 80, stage: 'finishing', message: 'Adding subtitles and audio' });
    await runStep(finalArgs, (t) => {
      onProgress({
        percent: 80 + Math.min(1, t / total) * 20,
        stage: 'finishing',
        message: 'Adding subtitles and audio',
      });
    });

    onProgress({ percent: 100, stage: 'done', message: 'Done' });
    return { outFile, duration: total, segments: segments.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ───────────────────────────── segment builder ──────────────────────────────

function buildSegmentArgs(project, seg, { rootDir, file, quality }) {
  const { width: W, height: H, fps } = project;
  const dur = round(seg.end - seg.start);
  const clip = seg.clip;
  const bg = project.background;

  const inputs = [];
  const vChain = [];
  let audioLabel = null;

  if (!clip || clip.type === 'color' || !clip.src) {
    const color = clip && clip.type === 'color' ? clip.color : bg;
    inputs.push('-f', 'lavfi', '-t', String(dur), '-i', `color=c=${color}:s=${W}x${H}:r=${fps}`);
    vChain.push('[0:v]');
  } else {
    const src = resolveMedia(clip.src, rootDir);
    if (clip.type === 'video') {
      const seek = round(clip.in + seg.offset);
      if (seek > 0) inputs.push('-ss', String(seek));
      inputs.push('-i', src);
      const probe = probeMedia(src);
      if (probe && probe.hasAudio && !clip.muted && clip.volume > 0) audioLabel = '[0:a]';
    } else {
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(dur), '-i', src);
    }
    vChain.push('[0:v]');
  }

  // video filter chain
  const filters = [];
  if (clip && clip.type === 'video') {
    // clone the final frame if the source runs out early, so the segment keeps
    // its exact slot on the timeline instead of shifting everything after it
    filters.push(`tpad=stop_mode=clone:stop_duration=${dur}`);
    filters.push(`fps=${fps}`);
  }

  const moving = clip && clip.effect && clip.effect !== 'none' && clip.type !== 'color';
  const S = moving ? SUPERSAMPLE : 1;

  if (clip && clip.type !== 'color' && clip.src) {
    filters.push(fitFilter(clip.fit, W * S, H * S, bg));
  }

  if (moving) {
    const eff = getEffect(clip.effect);
    const ctx = { amount: clip.amount, fps, offset: seg.offset, duration: clip.duration };
    const z = `max(1,${toFfmpegExpr(eff.z, ctx)})`;
    const fx = toFfmpegExpr(eff.x, ctx);
    const fy = toFfmpegExpr(eff.y, ctx);
    // top-left of the visible window, in the (supersampled) source's pixels
    const x = `(iw-iw/zoom)/2*(1+(${fx}))`;
    const y = `(ih-ih/zoom)/2*(1+(${fy}))`;
    filters.push(`zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`);
  } else {
    filters.push(`scale=${W}:${H}:flags=bicubic`);
  }

  // fades, measured from the start of the clip (not the segment)
  if (clip) {
    const fadeIn = clip.fadeIn - seg.offset;
    if (fadeIn > 0.01) filters.push(`fade=t=in:st=0:d=${round(Math.min(fadeIn, dur))}:color=${bg}`);
    const clipEnd = clip.start + clip.duration;
    const outStartsAt = clipEnd - clip.fadeOut - seg.start;
    if (clip.fadeOut > 0.01 && outStartsAt < dur) {
      const st = Math.max(0, round(outStartsAt));
      filters.push(`fade=t=out:st=${st}:d=${round(Math.min(clip.fadeOut, dur - st))}:color=${bg}`);
    }
  }

  filters.push('setsar=1', 'format=yuv420p');

  const filterComplex = [`${vChain[0]}${filters.join(',')}[v]`];

  // audio: real audio from a video clip, otherwise silence so every segment
  // has the same stream layout and `concat -c copy` works
  if (audioLabel) {
    filterComplex.push(
      `${audioLabel}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=${round(clip.volume)},apad[a]`
    );
  } else {
    inputs.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
    filterComplex.push(`[${countInputs(inputs) - 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]`);
  }

  return [
    '-y',
    ...inputs,
    '-filter_complex',
    filterComplex.join(';'),
    '-map', '[v]',
    '-map', '[a]',
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(Math.max(12, quality.crf - 4)), // a little headroom for the final pass
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-t', String(dur),
    '-video_track_timescale', String(fps * 1000),
    file,
  ];
}

function fitFilter(fit, w, h, bg) {
  if (fit === 'contain') {
    return (
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bicubic,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${bg}`
    );
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=${w}:${h}`;
}

function countInputs(inputs) {
  let n = 0;
  for (let i = 0; i < inputs.length; i++) if (inputs[i] === '-i') n++;
  return n;
}

// ────────────────────────────── final assembly ──────────────────────────────

function buildFinalArgs(project, { listFile, work, rootDir, outFile, fmt, quality, total }) {
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];

  // music / voice-over tracks
  const music = (project.audio || []).filter((a) => a.src && a.volume > 0);
  music.forEach((track) => {
    const src = resolveMedia(track.src, rootDir);
    if (track.loop) args.push('-stream_loop', '-1');
    if (track.in > 0) args.push('-ss', String(round(track.in)));
    args.push('-i', src);
  });

  const parts = [];

  // video: burn subtitles
  const hasSubs = (project.subtitles || []).some((s) => String(s.text || '').trim());
  if (hasSubs) {
    const assFile = path.join(work, 'subtitles.ass');
    fs.writeFileSync(assFile, buildAss(project), 'utf8');
    const fontsDir = bundledFontsDir();
    const fontsArg = fontsDir ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : '';
    parts.push(`[0:v]subtitles='${escapeFilterPath(assFile)}'${fontsArg}[v]`);
  } else {
    parts.push('[0:v]null[v]');
  }

  // audio: clip audio + every music track, mixed
  const mixLabels = ['[0:a]'];
  music.forEach((track, i) => {
    const idx = i + 1;
    const chain = [
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      `volume=${round(track.volume)}`,
    ];
    const length = track.duration > 0 ? Math.min(track.duration, total - track.start) : total - track.start;
    if (length <= 0) return; // starts after the video ends
    chain.push(`atrim=0:${round(length)}`, 'asetpts=PTS-STARTPTS');
    if (track.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${round(track.fadeIn)}`);
    if (track.fadeOut > 0 && length > track.fadeOut) {
      chain.push(`afade=t=out:st=${round(length - track.fadeOut)}:d=${round(track.fadeOut)}`);
    }
    if (track.start > 0) chain.push(`adelay=${Math.round(track.start * 1000)}:all=1`);
    chain.push(`apad=whole_dur=${round(total)}`);
    parts.push(`[${idx}:a]${chain.join(',')}[m${idx}]`);
    mixLabels.push(`[m${idx}]`);
  });

  if (mixLabels.length > 1) {
    parts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[a]`);
  } else {
    parts.push('[0:a]anull[a]');
  }

  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]');
  args.push('-r', String(project.fps));
  args.push(...fmt.videoArgs(quality));
  args.push(...fmt.audioArgs(quality));
  args.push(...fmt.extraArgs());
  args.push('-t', String(round(total)));
  args.push(outFile);
  return args;
}

/** A font directory we ship with the tool, if there is one. */
function bundledFontsDir() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(ttf|otf|ttc)$/i.test(f))) return dir;
  } catch {
    /* ignore */
  }
  return null;
}

export function resolveMedia(src, rootDir) {
  if (!src) return src;
  return path.isAbsolute(src) ? src : path.resolve(rootDir, src);
}

/** Write the subtitles next to the video as a .srt sidecar. */
export function writeSrt(project, outFile) {
  const srt = buildSrt(project);
  const file = outFile.replace(/\.[^.]+$/, '') + '.srt';
  fs.writeFileSync(file, srt, 'utf8');
  return file;
}

const round = (n) => Math.round(n * 1000) / 1000;
