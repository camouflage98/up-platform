/**
 * The project format: one plain JSON file per video.
 *
 * It is deliberately boring and hand-editable so that an agent (or a script)
 * can author a whole video by writing JSON, and a human can then nudge it in
 * the editor UI. See CLAUDE.md for the annotated schema.
 */

import { EFFECTS, DEFAULT_EFFECT, DEFAULT_AMOUNT } from './effects.js';

export const PROJECT_VERSION = 1;

export const DEFAULT_SUBTITLE_STYLE = {
  fontFamily: 'DejaVu Sans',
  fontSize: 52,
  color: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 3,
  shadow: 1,
  bold: true,
  italic: false,
  boxColor: '', // '' = no box, otherwise a #rrggbb behind the text
  boxOpacity: 0.55,
  align: 'bottom', // 'top' | 'middle' | 'bottom'
  marginV: 80, // distance from the top/bottom edge, in project pixels
  lineSpacing: 0,
};

export function defaultProject(name = 'Untitled') {
  return {
    version: PROJECT_VERSION,
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000000',
    clips: [],
    subtitles: [],
    audio: [],
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
  };
}

let idCounter = 0;
export function newId(prefix = 'x') {
  idCounter = (idCounter + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const str = (v, d = '') => (typeof v === 'string' ? v : d);

/**
 * Fill in every optional field and coerce types, so the rest of the code (and
 * the UI) can assume a complete object. Safe to run on hand-written JSON.
 */
export function normalizeProject(input) {
  const p = { ...defaultProject(), ...(input && typeof input === 'object' ? input : {}) };

  p.version = PROJECT_VERSION;
  p.name = str(p.name, 'Untitled');
  p.width = Math.round(clamp(numOr(p.width, 1920), 16, 7680));
  p.height = Math.round(clamp(numOr(p.height, 1080), 16, 4320));
  // even dimensions keep H.264 happy
  if (p.width % 2) p.width += 1;
  if (p.height % 2) p.height += 1;
  p.fps = clamp(numOr(p.fps, 30), 1, 120);
  p.background = normalizeHex(p.background, '#000000');

  p.clips = (Array.isArray(p.clips) ? p.clips : []).map(normalizeClip).sort((a, b) => a.start - b.start);
  p.subtitles = (Array.isArray(p.subtitles) ? p.subtitles : [])
    .map(normalizeSubtitle)
    .sort((a, b) => a.start - b.start);
  p.audio = (Array.isArray(p.audio) ? p.audio : []).map(normalizeAudio).sort((a, b) => a.start - b.start);
  p.subtitleStyle = normalizeSubtitleStyle(p.subtitleStyle);

  return p;
}

function normalizeClip(c = {}) {
  const type = ['image', 'video', 'color'].includes(c.type) ? c.type : (c.src ? guessType(c.src) : 'color');
  const duration = clamp(numOr(c.duration, type === 'image' ? 4 : 5), 0.05, 24 * 3600);
  return {
    id: str(c.id) || newId('c'),
    type,
    src: str(c.src),
    name: str(c.name) || (c.src ? String(c.src).split('/').pop() : type),
    start: Math.max(0, numOr(c.start, 0)),
    duration,
    in: Math.max(0, numOr(c.in, 0)), // source in-point, video only
    effect: EFFECTS[c.effect] ? c.effect : (c.effect === undefined ? DEFAULT_EFFECT : 'none'),
    amount: clamp(numOr(c.amount, DEFAULT_AMOUNT), 0, 1),
    fit: c.fit === 'contain' ? 'contain' : 'cover',
    fadeIn: clamp(numOr(c.fadeIn, 0), 0, duration),
    fadeOut: clamp(numOr(c.fadeOut, 0), 0, duration),
    volume: clamp(numOr(c.volume, 1), 0, 4),
    color: normalizeHex(c.color, '#000000'),
    muted: !!c.muted,
  };
}

function normalizeSubtitle(s = {}) {
  const start = Math.max(0, numOr(s.start, 0));
  const end = Math.max(start + 0.1, numOr(s.end, start + 2));
  return {
    id: str(s.id) || newId('s'),
    text: str(s.text, ''),
    start,
    end,
    // optional per-line overrides of subtitleStyle
    style: s.style && typeof s.style === 'object' ? { ...s.style } : null,
  };
}

function normalizeAudio(a = {}) {
  const duration = numOr(a.duration, 0); // 0 = play to the end of the file
  return {
    id: str(a.id) || newId('a'),
    src: str(a.src),
    name: str(a.name) || (a.src ? String(a.src).split('/').pop() : 'audio'),
    start: Math.max(0, numOr(a.start, 0)),
    in: Math.max(0, numOr(a.in, 0)),
    duration: Math.max(0, duration),
    volume: clamp(numOr(a.volume, 0.6), 0, 4),
    fadeIn: Math.max(0, numOr(a.fadeIn, 0)),
    fadeOut: Math.max(0, numOr(a.fadeOut, 1.5)),
    loop: !!a.loop,
  };
}

function normalizeSubtitleStyle(s = {}) {
  const out = { ...DEFAULT_SUBTITLE_STYLE, ...(s && typeof s === 'object' ? s : {}) };
  out.fontFamily = str(out.fontFamily, DEFAULT_SUBTITLE_STYLE.fontFamily);
  out.fontSize = clamp(numOr(out.fontSize, 52), 8, 400);
  out.color = normalizeHex(out.color, '#FFFFFF');
  out.outlineColor = normalizeHex(out.outlineColor, '#000000');
  out.outlineWidth = clamp(numOr(out.outlineWidth, 3), 0, 20);
  out.shadow = clamp(numOr(out.shadow, 1), 0, 20);
  out.bold = !!out.bold;
  out.italic = !!out.italic;
  out.boxColor = out.boxColor ? normalizeHex(out.boxColor, '#000000') : '';
  out.boxOpacity = clamp(numOr(out.boxOpacity, 0.55), 0, 1);
  out.align = ['top', 'middle', 'bottom'].includes(out.align) ? out.align : 'bottom';
  out.marginV = clamp(numOr(out.marginV, 80), 0, 2000);
  out.lineSpacing = clamp(numOr(out.lineSpacing, 0), -50, 200);
  return out;
}

export function guessType(src) {
  const ext = String(src).toLowerCase().split('.').pop();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio';
  return 'image';
}

function normalizeHex(v, fallback) {
  if (typeof v !== 'string') return fallback;
  let s = v.trim();
  if (/^[0-9a-f]{6}$/i.test(s)) s = '#' + s;
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toUpperCase() : fallback;
}

/** Total length of the finished video, in seconds. */
export function projectDuration(p) {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, c.start + c.duration);
  for (const s of p.subtitles) end = Math.max(end, s.end);
  // Audio alone never extends the video - music is trimmed to the picture.
  return Math.round(end * 1000) / 1000;
}

/**
 * Cut the timeline into consecutive intervals where exactly one clip (or none)
 * is on screen. Later clips win over earlier ones where they overlap, which is
 * what dragging a clip on top of another looks like in the UI.
 *
 * @returns {Array<{start:number, end:number, clip:object|null, offset:number}>}
 *          `offset` is how far into the clip the interval begins.
 */
export function timelineSegments(p) {
  const total = projectDuration(p);
  if (total <= 0) return [];

  const edges = new Set([0, total]);
  for (const c of p.clips) {
    if (c.start < total) edges.add(round(c.start));
    if (c.start + c.duration < total) edges.add(round(c.start + c.duration));
  }
  const points = [...edges].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b);

  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end - start < 1e-4) continue;
    const mid = (start + end) / 2;
    const clip = clipAt(p, mid);
    const last = segs[segs.length - 1];
    if (last && last.clip === clip && Math.abs(last.end - start) < 1e-6) {
      last.end = end; // merge touching intervals of the same clip
    } else {
      segs.push({ start, end, clip, offset: clip ? round(start - clip.start) : 0 });
    }
  }
  return segs;
}

/** The clip visible at time `t` (the last one in list order wins). */
export function clipAt(p, t) {
  let found = null;
  for (const c of p.clips) {
    if (t >= c.start && t < c.start + c.duration) found = c;
  }
  return found;
}

/** Subtitles visible at time `t`. */
export function subtitlesAt(p, t) {
  return p.subtitles.filter((s) => t >= s.start && t < s.end);
}

const round = (n) => Math.round(n * 1000) / 1000;

/** Human-friendly mm:ss.s used by the UI and CLI. */
export function formatTime(t, withMillis = true) {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = withMillis ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${sign}${String(m).padStart(2, '0')}:${ss}`;
}
