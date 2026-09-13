/**
 * Video Studio — editor front end.
 *
 * The preview draws with the same effect maths the exporter uses (lib/effects.js),
 * so what you scrub through is what ffmpeg renders. Subtitles are approximated
 * here and rendered properly by libass on export.
 */

import { EFFECTS, EFFECT_NAMES, effectAt, computeDraw, DEFAULT_AMOUNT } from '/lib/effects.js';
import {
  normalizeProject,
  projectDuration,
  clipAt,
  subtitlesAt,
  formatTime,
  newId,
  guessType,
  DEFAULT_SUBTITLE_STYLE,
} from '/lib/project.js';

// ───────────────────────────────── state ────────────────────────────────────

const state = {
  projectId: null,
  project: normalizeProject({}),
  savedModified: 0,
  dirty: false,
  time: 0,
  playing: false,
  selection: null, // { kind: 'clip' | 'sub' | 'audio', id }
  pxPerSec: 80,
  snap: true,
  media: [],
  health: null,
};

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 60;

const $ = (id) => document.getElementById(id);
const el = {
  projectSelect: $('projectSelect'),
  projectName: $('projectName'),
  saveState: $('saveState'),
  mediaList: $('mediaList'),
  mediaPanel: $('mediaPanel'),
  fileInput: $('fileInput'),
  canvas: $('preview'),
  stage: $('stage'),
  playPause: $('playPause'),
  currentTime: $('currentTime'),
  totalTime: $('totalTime'),
  inspector: $('inspector'),
  ruler: $('ruler'),
  videoTrack: $('videoTrack'),
  subtitleTrack: $('subtitleTrack'),
  audioTrack: $('audioTrack'),
  timeline: $('timeline'),
  timelineScroll: $('timelineScroll'),
  playhead: $('playhead'),
  toasts: $('toasts'),
  dropVeil: $('dropVeil'),
};

const ctx = el.canvas.getContext('2d');

// ─────────────────────────────── tiny helpers ───────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round3 = (n) => Math.round(n * 1000) / 1000;

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function toast(message, kind = '', actions = []) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.append(document.createTextNode(message));
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label;
    b.onclick = () => {
      node.remove();
      a.onClick();
    };
    node.append(b);
  }
  el.toasts.append(node);
  if (!actions.length) setTimeout(() => node.remove(), 3200);
  return node;
}

function formatBytes(n) {
  if (!n) return '';
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

// ───────────────────────────── project lifecycle ────────────────────────────

function snapshot() {
  return JSON.stringify(state.project);
}

/** Record the current project so the change about to happen can be undone. */
function beginHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

/** Make a change, remember it, redraw and queue a save. */
function mutate(fn) {
  beginHistory();
  fn(state.project);
  afterChange();
}

/** Redraw + save without touching history (used during a live drag). */
function afterChange() {
  state.project = normalizeProject(state.project);
  renderAll();
  scheduleSave();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state.project = normalizeProject(JSON.parse(undoStack.pop()));
  afterChange();
  toast('Undone');
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state.project = normalizeProject(JSON.parse(redoStack.pop()));
  afterChange();
  toast('Redone');
}

let saveTimer = null;
function scheduleSave() {
  state.dirty = true;
  setSaveState('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  if (!state.projectId) return;
  clearTimeout(saveTimer);
  setSaveState('saving');
  try {
    const res = await api(`/api/projects/${encodeURIComponent(state.projectId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: state.project, baseModified: state.savedModified }),
    });
    state.savedModified = res.modified;
    state.dirty = false;
    setSaveState('saved');
  } catch (err) {
    if (err.status === 409) {
      setSaveState('unsaved');
      offerReload(err.body);
      return;
    }
    setSaveState('error');
    toast(`Could not save: ${err.message}`, 'bad');
  }
}

function setSaveState(kind) {
  const labels = { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved', error: 'Save failed' };
  el.saveState.textContent = labels[kind] || '';
  el.saveState.dataset.state = kind;
}

let reloadPrompt = null;
function offerReload(info) {
  if (reloadPrompt) return;
  reloadPrompt = toast('This project changed on disk.', 'warn', [
    {
      label: 'Load it',
      onClick: () => {
        reloadPrompt = null;
        beginHistory();
        state.project = normalizeProject(info.project);
        state.savedModified = info.modified;
        state.dirty = false;
        setSaveState('saved');
        renderAll();
      },
    },
    {
      label: 'Keep mine',
      onClick: () => {
        reloadPrompt = null;
        state.savedModified = info.modified;
        saveNow();
      },
    },
  ]);
}

/**
 * Watch for edits made outside the editor — this is how a change written
 * straight into projects/*.json shows up without a manual refresh.
 */
function watchDisk() {
  setInterval(async () => {
    if (!state.projectId || document.hidden) return;
    try {
      const res = await api(`/api/projects/${encodeURIComponent(state.projectId)}`);
      if (res.modified - state.savedModified <= 1) return;
      if (state.dirty) {
        offerReload(res);
      } else {
        state.project = normalizeProject(res.project);
        state.savedModified = res.modified;
        el.projectName.value = state.project.name;
        renderAll();
        toast('Reloaded — the project changed on disk');
      }
    } catch {
      /* server restarting, try again next tick */
    }
  }, 2500);
}

async function loadProjectList(selectId) {
  const { projects } = await api('/api/projects');
  el.projectSelect.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    el.projectSelect.append(opt);
  }
  if (selectId) el.projectSelect.value = selectId;
  return projects;
}

async function openProject(id) {
  const res = await api(`/api/projects/${encodeURIComponent(id)}`);
  state.projectId = id;
  state.project = normalizeProject(res.project);
  state.savedModified = res.modified;
  state.dirty = false;
  state.selection = null;
  state.time = 0;
  undoStack.length = 0;
  redoStack.length = 0;
  el.projectName.value = state.project.name;
  el.projectSelect.value = id;
  localStorage.setItem('video-studio:last', id);
  setSaveState('saved');
  resizeCanvas();
  renderAll();
}

// ──────────────────────────────── media bin ─────────────────────────────────

async function refreshMedia() {
  const { media } = await api('/api/media');
  state.media = media;
  renderMediaList();
}

function renderMediaList() {
  el.mediaList.innerHTML = '';
  if (!state.media.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.border = 'none';
    p.textContent = 'Nothing here yet.';
    el.mediaList.append(p);
    return;
  }

  for (const item of state.media) {
    const kind = guessType(item.src);
    const node = document.createElement('div');
    node.className = 'media-item';
    node.draggable = true;
    node.title = item.name;

    const thumb = document.createElement('div');
    thumb.className = 'media-thumb';
    if (kind === 'image') thumb.style.backgroundImage = `url("/${item.src}")`;
    else if (kind === 'video') {
      thumb.textContent = '▶';
      videoPoster(item.src).then((url) => {
        if (url) {
          thumb.textContent = '';
          thumb.style.backgroundImage = `url("${url}")`;
        }
      });
    } else thumb.textContent = '♪';

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const name = document.createElement('div');
    name.className = 'media-name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'media-sub';
    sub.textContent = `${kind}${item.duration ? ` · ${formatTime(item.duration, false)}` : ''}`;
    meta.append(name, sub);

    const remove = document.createElement('button');
    remove.className = 'media-remove';
    remove.title = 'Remove from the media folder';
    remove.textContent = '×';
    remove.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${item.name} from the media folder?`)) return;
      await api(`/api/media/${encodeURIComponent(item.name)}`, { method: 'DELETE' });
      refreshMedia();
    };

    node.append(thumb, meta, remove);
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-vs-media', JSON.stringify(item));
      e.dataTransfer.effectAllowed = 'copy';
    });
    node.addEventListener('dblclick', () => appendMedia(item));

    el.mediaList.append(node);
  }
}

async function uploadFiles(files) {
  const added = [];
  for (const file of files) {
    const t = toast(`Adding ${file.name}…`, '', []);
    try {
      const res = await api(`/api/media?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      added.push(res);
    } catch (err) {
      toast(`Could not add ${file.name}: ${err.message}`, 'bad');
    } finally {
      t.remove();
    }
  }
  await refreshMedia();
  return added;
}

/** Add a media item to the end of the timeline. */
function appendMedia(item) {
  const at = guessType(item.src) === 'audio' ? 0 : projectDuration(state.project);
  addMediaAt(item, at);
}

function addMediaAt(item, at) {
  const kind = guessType(item.src);
  mutate((p) => {
    if (kind === 'audio') {
      p.audio.push({
        id: newId('a'),
        src: item.src,
        name: item.name,
        start: round3(Math.max(0, at)),
        duration: item.duration || 0,
        volume: 0.5,
      });
      state.selection = { kind: 'audio', id: p.audio[p.audio.length - 1].id };
    } else {
      const duration = kind === 'video' && item.duration ? Math.min(item.duration, 30) : 4;
      p.clips.push({
        id: newId('c'),
        type: kind,
        src: item.src,
        name: item.name,
        start: round3(Math.max(0, at)),
        duration: round3(duration),
        effect: kind === 'image' ? 'zoomIn' : 'none',
        amount: DEFAULT_AMOUNT,
      });
      state.selection = { kind: 'clip', id: p.clips[p.clips.length - 1].id };
    }
  });
}

// ──────────────────────── media element cache (preview) ─────────────────────

const elements = new Map(); // src -> HTMLImageElement | HTMLVideoElement | HTMLAudioElement
const posters = new Map();
/** Sources this browser cannot decode (e.g. ProRes, HEVC). ffmpeg still can. */
const undecodable = new Set();

function mediaEl(src, kind) {
  if (elements.has(src)) return elements.get(src);
  let node;
  if (kind === 'image') {
    node = new Image();
    node.src = `/${src}`;
  } else if (kind === 'video') {
    node = document.createElement('video');
    node.src = `/${src}`;
    node.preload = 'auto';
    node.playsInline = true;
    node.crossOrigin = 'anonymous';
  } else {
    node = new Audio(`/${src}`);
    node.preload = 'auto';
  }
  node.addEventListener(kind === 'image' ? 'load' : 'loadeddata', () => {
    undecodable.delete(src);
    draw();
  });
  node.addEventListener('error', () => {
    undecodable.add(src);
    draw();
  });
  elements.set(src, node);
  return node;
}

/** Grab a frame from a video for use as a thumbnail. */
function videoPoster(src) {
  if (posters.has(src)) return Promise.resolve(posters.get(src));
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.src = `/${src}`;
    v.muted = true;
    v.preload = 'metadata';
    const bail = setTimeout(() => resolve(null), 6000);
    v.addEventListener('loadeddata', () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    });
    v.addEventListener('seeked', () => {
      clearTimeout(bail);
      try {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = Math.max(1, Math.round((160 * v.videoHeight) / v.videoWidth));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.6);
        posters.set(src, url);
        resolve(url);
      } catch {
        resolve(null);
      }
    });
    v.addEventListener('error', () => {
      clearTimeout(bail);
      resolve(null);
    });
  });
}

// ───────────────────────────── preview drawing ──────────────────────────────

function resizeCanvas() {
  el.canvas.width = state.project.width;
  el.canvas.height = state.project.height;
  el.canvas.style.aspectRatio = `${state.project.width} / ${state.project.height}`;
}

function draw() {
  const p = state.project;
  const t = state.time;

  ctx.save();
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, p.width, p.height);

  const clip = clipAt(p, t);
  if (clip) {
    const progress = clip.duration > 0 ? (t - clip.start) / clip.duration : 0;
    const cam = effectAt(clip.effect, progress, clip.amount);

    if (clip.type === 'color') {
      ctx.fillStyle = clip.color;
      ctx.fillRect(0, 0, p.width, p.height);
    } else if (clip.src && undecodable.has(clip.src)) {
      drawUndecodable(clip);
    } else if (clip.src) {
      const node = mediaEl(clip.src, clip.type);
      const srcW = node.naturalWidth || node.videoWidth || 0;
      const srcH = node.naturalHeight || node.videoHeight || 0;
      if (srcW && srcH) {
        const r = computeDraw(srcW, srcH, p.width, p.height, clip.fit, cam.z, cam.fx, cam.fy);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, p.width, p.height);
        ctx.clip();
        try {
          ctx.drawImage(node, r.dx, r.dy, r.dw, r.dh);
        } catch {
          /* frame not decodable yet */
        }
        ctx.restore();
      }
    }

    // fades, drawn as a wash of the background colour
    const intoClip = t - clip.start;
    const toEnd = clip.start + clip.duration - t;
    let fade = 0;
    if (clip.fadeIn > 0 && intoClip < clip.fadeIn) fade = 1 - intoClip / clip.fadeIn;
    if (clip.fadeOut > 0 && toEnd < clip.fadeOut) fade = Math.max(fade, 1 - toEnd / clip.fadeOut);
    if (fade > 0) {
      ctx.globalAlpha = clamp(fade, 0, 1);
      ctx.fillStyle = p.background;
      ctx.fillRect(0, 0, p.width, p.height);
      ctx.globalAlpha = 1;
    }
  }

  drawSubtitles(subtitlesAt(p, t));
  ctx.restore();
}

/** Some formats (ProRes, HEVC, odd codecs) play in ffmpeg but not in a browser. */
function drawUndecodable(clip) {
  const p = state.project;
  ctx.fillStyle = '#1a1c20';
  ctx.fillRect(0, 0, p.width, p.height);
  ctx.fillStyle = '#9aa1ac';
  ctx.textAlign = 'center';
  const size = Math.round(p.height / 26);
  ctx.font = `600 ${size}px sans-serif`;
  ctx.fillText(clip.name, p.width / 2, p.height / 2 - size * 0.4);
  ctx.font = `400 ${Math.round(size * 0.72)}px sans-serif`;
  ctx.fillText('This browser cannot preview this file —', p.width / 2, p.height / 2 + size * 0.9);
  ctx.fillText('it will still be in the exported video.', p.width / 2, p.height / 2 + size * 2);
}

/**
 * A close approximation of what libass will burn in. Exact metrics differ a
 * little (libass uses real font metrics); the exported file is the truth.
 */
function drawSubtitles(subs) {
  const p = state.project;
  let stacked = 0; // libass pushes overlapping lines out of each other's way
  for (const sub of subs) {
    const st = { ...DEFAULT_SUBTITLE_STYLE, ...p.subtitleStyle, ...(sub.style || {}) };
    const size = st.fontSize;
    const weight = st.bold ? '700' : '400';
    const style = st.italic ? 'italic ' : '';
    ctx.font = `${style}${weight} ${size}px "${st.fontFamily}", "DejaVu Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    const maxWidth = p.width * 0.88;
    const lines = [];
    for (const para of String(sub.text).split('\n')) lines.push(...wrapLine(para, maxWidth));

    const lineHeight = size * 1.2 + st.lineSpacing;
    const blockHeight = lines.length * lineHeight;
    let top;
    if (st.align === 'top') top = st.marginV + stacked;
    else if (st.align === 'middle') top = (p.height - blockHeight) / 2 + stacked;
    else top = p.height - st.marginV - blockHeight - stacked;
    stacked += blockHeight;

    lines.forEach((line, i) => {
      const baseline = top + i * lineHeight + size * 0.82;
      const x = p.width / 2;
      if (st.boxColor) {
        const w = ctx.measureText(line).width + size * 0.5;
        ctx.globalAlpha = st.boxOpacity;
        ctx.fillStyle = st.boxColor;
        ctx.fillRect(x - w / 2, baseline - size * 0.92, w, lineHeight);
        ctx.globalAlpha = 1;
      }
      if (st.outlineWidth > 0) {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.lineWidth = st.outlineWidth * 2;
        ctx.strokeStyle = st.outlineColor;
        ctx.strokeText(line, x, baseline);
      }
      ctx.fillStyle = st.color;
      ctx.fillText(line, x, baseline);
    });
  }
}

function wrapLine(text, maxWidth) {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ─────────────────────────────── playback ───────────────────────────────────

let rafId = null;
let playStartedAt = 0;
let playStartTime = 0;

function play() {
  const total = projectDuration(state.project);
  if (total <= 0) return;
  if (state.time >= total - 0.01) state.time = 0;
  state.playing = true;
  playStartedAt = performance.now();
  playStartTime = state.time;
  el.playPause.textContent = '⏸';
  el.playPause.setAttribute('aria-label', 'Pause');
  rafId = requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  cancelAnimationFrame(rafId);
  el.playPause.textContent = '▶';
  el.playPause.setAttribute('aria-label', 'Play');
  stopAllMedia();
  draw();
}

function togglePlay() {
  state.playing ? pause() : play();
}

function tick(now) {
  if (!state.playing) return;
  const total = projectDuration(state.project);
  state.time = playStartTime + (now - playStartedAt) / 1000;
  if (state.time >= total) {
    state.time = total;
    pause();
    updateTimeUI();
    return;
  }
  syncMedia();
  draw();
  updateTimeUI();
  rafId = requestAnimationFrame(tick);
}

function seek(t) {
  const total = projectDuration(state.project);
  state.time = clamp(t, 0, Math.max(0, total));
  if (state.playing) {
    playStartedAt = performance.now();
    playStartTime = state.time;
  }
  syncMedia(true);
  draw();
  updateTimeUI();
}

/** Keep video/audio elements lined up with the timeline position. */
function syncMedia(force = false) {
  const p = state.project;
  const t = state.time;
  const active = clipAt(p, t);

  for (const [src, node] of elements) {
    if (node instanceof HTMLImageElement) continue;
    const isActiveClip = active && active.src === src && active.type === 'video';
    const track = p.audio.find((a) => a.src === src && t >= a.start && (!a.duration || t < a.start + a.duration));

    if (isActiveClip) {
      const want = active.in + (t - active.start);
      node.volume = clamp(active.muted ? 0 : active.volume, 0, 1);
      if (force || Math.abs(node.currentTime - want) > 0.3) node.currentTime = want;
      if (state.playing && node.paused) node.play().catch(() => {});
      if (!state.playing && !node.paused) node.pause();
    } else if (track && node instanceof HTMLAudioElement) {
      const want = track.in + (t - track.start);
      node.volume = clamp(track.volume, 0, 1);
      if (force || Math.abs(node.currentTime - want) > 0.3) node.currentTime = want;
      if (state.playing && node.paused) node.play().catch(() => {});
      if (!state.playing && !node.paused) node.pause();
    } else if (!node.paused) {
      node.pause();
    }
  }

  // make sure music elements exist so they can start on time
  for (const a of p.audio) if (a.src) mediaEl(a.src, 'audio');
}

function stopAllMedia() {
  for (const node of elements.values()) {
    if (!(node instanceof HTMLImageElement) && !node.paused) node.pause();
  }
}

function updateTimeUI() {
  el.currentTime.textContent = formatTime(state.time);
  el.totalTime.textContent = formatTime(projectDuration(state.project));
  el.playhead.style.left = `${state.time * state.pxPerSec}px`;
}

// ─────────────────────────────── timeline UI ────────────────────────────────

const LANE_OFFSET = 66; // matches .track-label width in styles.css

function renderTimeline() {
  const p = state.project;
  const total = Math.max(projectDuration(p), 10);
  const width = total * state.pxPerSec + 240;
  el.timeline.style.width = `${width + LANE_OFFSET}px`;

  renderRuler(total, width);
  renderClips();
  renderSubtitles();
  renderAudio();
  updateTimeUI();
}

function renderRuler(total, width) {
  el.ruler.innerHTML = '';
  el.ruler.style.width = `${width}px`;

  // pick a tick spacing that stays readable at any zoom
  const targetPx = 90;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * state.pxPerSec >= targetPx) || 600;

  for (let t = 0; t <= total + step; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${t * state.pxPerSec}px`;
    const label = document.createElement('span');
    label.textContent = formatTime(t, step < 1);
    tick.append(label);
    el.ruler.append(tick);

    const half = document.createElement('div');
    half.className = 'tick minor';
    half.style.left = `${(t + step / 2) * state.pxPerSec}px`;
    el.ruler.append(half);
  }
}

function renderClips() {
  el.videoTrack.innerHTML = '';
  for (const clip of state.project.clips) {
    const node = document.createElement('div');
    node.className = `item clip ${clip.type}`;
    node.dataset.id = clip.id;
    node.dataset.kind = 'clip';
    node.style.left = `${clip.start * state.pxPerSec}px`;
    node.style.width = `${Math.max(4, clip.duration * state.pxPerSec)}px`;
    node.title = `${clip.name} — ${formatTime(clip.duration)}`;

    if (clip.type === 'image' && clip.src) {
      const strip = document.createElement('div');
      strip.className = 'thumb-strip';
      strip.style.backgroundImage = `url("/${clip.src}")`;
      node.append(strip);
    } else if (clip.type === 'video' && clip.src) {
      const strip = document.createElement('div');
      strip.className = 'thumb-strip';
      node.append(strip);
      videoPoster(clip.src).then((url) => url && (strip.style.backgroundImage = `url("${url}")`));
    } else if (clip.type === 'color') {
      node.style.background = clip.color;
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = clip.name;
    node.append(label);

    if (clip.effect && clip.effect !== 'none') {
      const tag = document.createElement('span');
      tag.className = 'effect-tag';
      tag.textContent = EFFECTS[clip.effect]?.label || clip.effect;
      node.append(tag);
    }

    addHandles(node);
    if (isSelected('clip', clip.id)) node.classList.add('selected');
    el.videoTrack.append(node);
  }
}

function renderSubtitles() {
  el.subtitleTrack.innerHTML = '';
  for (const sub of state.project.subtitles) {
    const node = document.createElement('div');
    node.className = 'item sub';
    node.dataset.id = sub.id;
    node.dataset.kind = 'sub';
    node.style.left = `${sub.start * state.pxPerSec}px`;
    node.style.width = `${Math.max(4, (sub.end - sub.start) * state.pxPerSec)}px`;
    node.title = sub.text;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = sub.text.replace(/\n/g, ' ') || '(empty)';
    node.append(label);

    addHandles(node);
    if (isSelected('sub', sub.id)) node.classList.add('selected');
    el.subtitleTrack.append(node);
  }
}

function renderAudio() {
  el.audioTrack.innerHTML = '';
  const total = projectDuration(state.project);
  for (const track of state.project.audio) {
    const length = track.duration > 0 ? track.duration : Math.max(1, total - track.start);
    const node = document.createElement('div');
    node.className = 'item audio';
    node.dataset.id = track.id;
    node.dataset.kind = 'audio';
    node.style.left = `${track.start * state.pxPerSec}px`;
    node.style.width = `${Math.max(4, length * state.pxPerSec)}px`;
    node.title = track.name;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `♪ ${track.name}`;
    node.append(label);

    addHandles(node);
    if (isSelected('audio', track.id)) node.classList.add('selected');
    el.audioTrack.append(node);
  }
}

function addHandles(node) {
  for (const side of ['left', 'right']) {
    const h = document.createElement('div');
    h.className = `handle ${side}`;
    h.dataset.handle = side;
    node.append(h);
  }
}

const isSelected = (kind, id) => state.selection && state.selection.kind === kind && state.selection.id === id;

function select(kind, id) {
  state.selection = kind ? { kind, id } : null;
  renderTimeline();
  renderInspector();
}

function findSelected() {
  if (!state.selection) return null;
  const { kind, id } = state.selection;
  const list = kind === 'clip' ? state.project.clips : kind === 'sub' ? state.project.subtitles : state.project.audio;
  return list.find((x) => x.id === id) || null;
}

// ───────────────────────── timeline drag interactions ───────────────────────

function laneTime(event, lane) {
  const rect = lane.getBoundingClientRect();
  return Math.max(0, (event.clientX - rect.left) / state.pxPerSec);
}

/** Candidate edges to snap a dragged edge to. */
function snapPoints(excludeId) {
  const p = state.project;
  const points = [0, state.time];
  for (const c of p.clips) if (c.id !== excludeId) points.push(c.start, c.start + c.duration);
  for (const s of p.subtitles) if (s.id !== excludeId) points.push(s.start, s.end);
  for (const a of p.audio) if (a.id !== excludeId) points.push(a.start);
  return points;
}

function applySnap(value, excludeId) {
  if (!state.snap) return value;
  const tolerance = 7 / state.pxPerSec;
  let best = value;
  let bestDist = tolerance;
  for (const point of snapPoints(excludeId)) {
    const d = Math.abs(point - value);
    if (d < bestDist) {
      bestDist = d;
      best = point;
    }
  }
  return round3(best);
}

function setupTrackInteractions(lane) {
  lane.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('.item');
    if (!item) {
      // clicking empty lane space moves the playhead
      seek(laneTime(event, lane));
      select(null);
      return;
    }

    const kind = item.dataset.kind;
    const id = item.dataset.id;
    select(kind, id);

    const handle = event.target.dataset.handle;
    const record = findSelected();
    if (!record) return;

    const startX = event.clientX;
    const original = { ...record };
    let moved = false;
    event.preventDefault();

    const onMove = (e) => {
      const deltaT = (e.clientX - startX) / state.pxPerSec;
      if (!moved && Math.abs(e.clientX - startX) < 3) return;
      if (!moved) {
        beginHistory();
        moved = true;
      }
      // look the record up again: normalising replaces the objects each time
      const live = findSelected();
      if (!live) return;
      applyDrag(live, kind, original, deltaT, handle);
      afterChange();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) saveNow();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // drops from the media bin or the OS
  lane.addEventListener('dragover', (e) => {
    e.preventDefault();
    lane.classList.add('dragover');
  });
  lane.addEventListener('dragleave', () => lane.classList.remove('dragover'));
  lane.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    lane.classList.remove('dragover');
    const at = applySnap(laneTime(e, lane), null);

    const raw = e.dataTransfer.getData('application/x-vs-media');
    if (raw) return addMediaAt(JSON.parse(raw), at);

    if (e.dataTransfer.files?.length) {
      const added = await uploadFiles([...e.dataTransfer.files]);
      let cursor = at;
      for (const item of added) {
        addMediaAt(item, cursor);
        if (guessType(item.src) !== 'audio') {
          const last = state.project.clips[state.project.clips.length - 1];
          cursor = last ? last.start + last.duration : cursor;
        }
      }
    }
  });
}

function applyDrag(record, kind, original, deltaT, handle) {
  if (kind === 'sub') {
    if (handle === 'left') {
      record.start = clamp(applySnap(original.start + deltaT, record.id), 0, original.end - 0.1);
    } else if (handle === 'right') {
      record.end = Math.max(original.start + 0.1, applySnap(original.end + deltaT, record.id));
    } else {
      const length = original.end - original.start;
      record.start = Math.max(0, applySnap(original.start + deltaT, record.id));
      record.end = record.start + length;
    }
    return;
  }

  if (kind === 'audio') {
    if (handle === 'right' && original.duration > 0) {
      record.duration = Math.max(0.1, applySnap(original.start + original.duration + deltaT, record.id) - record.start);
    } else {
      record.start = Math.max(0, applySnap(original.start + deltaT, record.id));
    }
    return;
  }

  // clip
  if (handle === 'left') {
    const newStart = clamp(applySnap(original.start + deltaT, record.id), 0, original.start + original.duration - 0.1);
    const shift = newStart - original.start;
    record.start = newStart;
    record.duration = Math.max(0.1, original.duration - shift);
    if (original.type === 'video') record.in = Math.max(0, original.in + shift);
  } else if (handle === 'right') {
    record.duration = Math.max(
      0.1,
      applySnap(original.start + original.duration + deltaT, record.id) - original.start
    );
  } else {
    record.start = Math.max(0, applySnap(original.start + deltaT, record.id));
  }
}

// ──────────────────────────────── inspector ─────────────────────────────────

function renderInspector() {
  const panel = el.inspector;
  panel.innerHTML = '';
  const record = findSelected();

  if (!record) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <p><strong>Nothing selected.</strong></p>
      <p>Drag a photo or video from the left onto the Video track, then click it to add a slow zoom or slide.</p>
      <p>Use <em>+ Subtitle</em> to add a caption at the playhead, then drag its edges to change when it appears.</p>`;
    panel.append(empty);
    return;
  }

  const kind = state.selection.kind;
  const head = document.createElement('div');
  head.className = 'inspector-head';
  const title = document.createElement('h2');
  title.textContent = kind === 'clip' ? record.name : kind === 'sub' ? 'Subtitle' : record.name;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = kind === 'clip' ? record.type : kind === 'sub' ? 'text' : 'audio';
  head.append(title, badge);
  panel.append(head);

  const commit = () => {
    afterChange();
  };
  const change = (fn) => (e) => {
    beginHistory();
    fn(e.target);
    commit();
  };

  if (kind === 'clip') {
    panel.append(
      numberField('Start', record.start, 0.1, (v) => (record.start = Math.max(0, v)), change),
      numberField('Duration', record.duration, 0.1, (v) => (record.duration = Math.max(0.1, v)), change)
    );

    if (record.type !== 'color') {
      const effect = selectField(
        'Effect',
        EFFECT_NAMES.map((n) => [n, EFFECTS[n].label]),
        record.effect,
        (v) => (record.effect = v),
        change
      );
      panel.append(effect);
      panel.append(
        rangeField('Strength', record.amount, 0, 0.6, 0.01, (v) => (record.amount = v), change, (v) =>
          `${Math.round(v * 100)}%`
        )
      );
      panel.append(
        selectField(
          'Framing',
          [
            ['cover', 'Fill the frame (crop)'],
            ['contain', 'Fit inside (letterbox)'],
          ],
          record.fit,
          (v) => (record.fit = v),
          change
        )
      );
    }

    if (record.type === 'color') {
      panel.append(colorField('Colour', record.color, (v) => (record.color = v), change));
    }

    panel.append(separator());
    panel.append(
      numberField('Fade in', record.fadeIn, 0.1, (v) => (record.fadeIn = Math.max(0, v)), change),
      numberField('Fade out', record.fadeOut, 0.1, (v) => (record.fadeOut = Math.max(0, v)), change)
    );

    if (record.type === 'video') {
      panel.append(separator());
      panel.append(
        numberField('Start inside clip', record.in, 0.1, (v) => (record.in = Math.max(0, v)), change),
        rangeField('Volume', record.volume, 0, 2, 0.05, (v) => (record.volume = v), change, (v) =>
          `${Math.round(v * 100)}%`
        ),
        checkField('Mute', record.muted, (v) => (record.muted = v), change)
      );
    }
  }

  if (kind === 'sub') {
    const text = document.createElement('label');
    text.className = 'field';
    text.innerHTML = '<span>Text</span>';
    const area = document.createElement('textarea');
    area.value = record.text;
    area.rows = 3;
    area.placeholder = 'Caption text — press Enter for a second line';
    let historyTaken = false;
    area.addEventListener('input', () => {
      if (!historyTaken) {
        beginHistory();
        historyTaken = true;
      }
      record.text = area.value;
      renderSubtitles();
      draw();
      scheduleSave();
    });
    area.addEventListener('blur', () => (historyTaken = false));
    text.append(area);
    panel.append(text);

    panel.append(
      numberField('Appears at', record.start, 0.1, (v) => (record.start = Math.max(0, v)), change),
      numberField('Disappears at', record.end, 0.1, (v) => (record.end = Math.max(record.start + 0.1, v)), change)
    );

    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      button('Start here', () => {
        beginHistory();
        const length = record.end - record.start;
        record.start = round3(state.time);
        record.end = round3(state.time + length);
        commit();
      }),
      button('End here', () => {
        beginHistory();
        record.end = Math.max(record.start + 0.1, round3(state.time));
        commit();
      })
    );
    panel.append(row);

    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = 'Font, size and colour live in Settings → Subtitle style.';
    panel.append(note);
  }

  if (kind === 'audio') {
    panel.append(
      numberField('Start', record.start, 0.1, (v) => (record.start = Math.max(0, v)), change),
      numberField('Start inside file', record.in, 0.1, (v) => (record.in = Math.max(0, v)), change),
      numberField('Length (0 = to the end)', record.duration, 0.5, (v) => (record.duration = Math.max(0, v)), change),
      rangeField('Volume', record.volume, 0, 2, 0.05, (v) => (record.volume = v), change, (v) => `${Math.round(v * 100)}%`),
      numberField('Fade in', record.fadeIn, 0.5, (v) => (record.fadeIn = Math.max(0, v)), change),
      numberField('Fade out', record.fadeOut, 0.5, (v) => (record.fadeOut = Math.max(0, v)), change)
    );
  }

  panel.append(separator());
  panel.append(button('Delete', deleteSelected, 'btn danger'));
}

// small field builders — plain DOM, no framework
function labelled(label, control) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function numberField(label, value, step, apply, change) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = step;
  input.value = Number(value).toFixed(2).replace(/\.?0+$/, '') || '0';
  input.addEventListener('change', change((t) => apply(Number(t.value))));
  return labelled(label, input);
}

function rangeField(label, value, min, max, step, apply, change, format) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const out = document.createElement('span');
  out.className = 'value';
  out.textContent = format(value);
  span.append(' ', out);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  let taken = false;
  input.addEventListener('input', () => {
    if (!taken) {
      beginHistory();
      taken = true;
    }
    apply(Number(input.value));
    out.textContent = format(Number(input.value));
    renderTimeline();
    draw();
    scheduleSave();
  });
  input.addEventListener('change', () => (taken = false));
  wrap.append(span, input);
  return wrap;
}

function selectField(label, options, value, apply, change) {
  const select = document.createElement('select');
  for (const [v, text] of options) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = text;
    select.append(opt);
  }
  select.value = value;
  select.addEventListener('change', change((t) => apply(t.value)));
  return labelled(label, select);
}

function colorField(label, value, apply, change) {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.addEventListener('change', change((t) => apply(t.value)));
  return labelled(label, input);
}

function checkField(label, value, apply, change) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', change((t) => apply(t.checked)));
  const wrap = labelled(label, input);
  wrap.classList.add('inline');
  return wrap;
}

function separator() {
  const line = document.createElement('div');
  line.className = 'sep';
  return line;
}

function button(text, onClick, className = 'btn') {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

// ───────────────────────────── timeline actions ─────────────────────────────

function deleteSelected() {
  const sel = state.selection;
  if (!sel) return;
  mutate((p) => {
    if (sel.kind === 'clip') p.clips = p.clips.filter((c) => c.id !== sel.id);
    if (sel.kind === 'sub') p.subtitles = p.subtitles.filter((s) => s.id !== sel.id);
    if (sel.kind === 'audio') p.audio = p.audio.filter((a) => a.id !== sel.id);
  });
  state.selection = null;
  renderAll();
}

function addSubtitle() {
  const start = round3(state.time);
  mutate((p) => {
    const sub = { id: newId('s'), text: 'New subtitle', start, end: round3(start + 2.5) };
    p.subtitles.push(sub);
    state.selection = { kind: 'sub', id: sub.id };
  });
  renderInspector();
  el.inspector.querySelector('textarea')?.select();
}

function addTitleCard() {
  const start = round3(state.time);
  mutate((p) => {
    const clip = {
      id: newId('c'),
      type: 'color',
      name: 'Title card',
      color: p.background,
      start,
      duration: 3,
      effect: 'none',
      fadeIn: 0.4,
      fadeOut: 0.4,
    };
    p.clips.push(clip);
    state.selection = { kind: 'clip', id: clip.id };
  });
}

function splitClip() {
  const t = state.time;
  const clip = clipAt(state.project, t);
  if (!clip || t - clip.start < 0.1 || clip.start + clip.duration - t < 0.1) {
    return toast('Put the playhead inside a clip first', 'warn');
  }
  mutate((p) => {
    const original = p.clips.find((c) => c.id === clip.id);
    const cutAt = t - original.start;
    const tail = {
      ...original,
      id: newId('c'),
      start: round3(t),
      duration: round3(original.duration - cutAt),
      in: original.type === 'video' ? round3(original.in + cutAt) : 0,
      fadeIn: 0,
    };
    original.duration = round3(cutAt);
    original.fadeOut = 0;
    p.clips.push(tail);
    state.selection = { kind: 'clip', id: tail.id };
  });
}

// ─────────────────────────────── dialogs ────────────────────────────────────

function openSettings() {
  const p = state.project;
  const dialog = $('settingsDialog');

  $('setWidth').value = p.width;
  $('setHeight').value = p.height;
  $('setFps').value = String(p.fps);
  $('setBackground').value = p.background;
  const presetValue = `${p.width}x${p.height}`;
  $('setPreset').value = [...$('setPreset').options].some((o) => o.value === presetValue) ? presetValue : 'custom';

  const st = p.subtitleStyle;
  $('stFontSize').value = st.fontSize;
  $('stFontFamily').value = st.fontFamily;
  $('stColor').value = st.color;
  $('stOutlineColor').value = st.outlineColor;
  $('stOutlineWidth').value = st.outlineWidth;
  $('stAlign').value = st.align;
  $('stMarginV').value = st.marginV;
  $('stBold').checked = st.bold;
  $('stBoxOn').checked = !!st.boxColor;
  $('stBoxColor').value = st.boxColor || '#000000';

  dialog.showModal();
}

function wireSettings() {
  const dialog = $('settingsDialog');
  const apply = () => {
    const p = state.project;
    p.width = Number($('setWidth').value) || p.width;
    p.height = Number($('setHeight').value) || p.height;
    p.fps = Number($('setFps').value) || p.fps;
    p.background = $('setBackground').value;
    p.subtitleStyle = {
      ...p.subtitleStyle,
      fontSize: Number($('stFontSize').value),
      fontFamily: $('stFontFamily').value || 'DejaVu Sans',
      color: $('stColor').value,
      outlineColor: $('stOutlineColor').value,
      outlineWidth: Number($('stOutlineWidth').value),
      align: $('stAlign').value,
      marginV: Number($('stMarginV').value),
      bold: $('stBold').checked,
      boxColor: $('stBoxOn').checked ? $('stBoxColor').value : '',
    };
    afterChange();
    resizeCanvas();
    draw();
  };

  $('setPreset').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    const [w, h] = e.target.value.split('x');
    $('setWidth').value = w;
    $('setHeight').value = h;
    beginHistory();
    apply();
  });

  for (const id of [
    'setWidth', 'setHeight', 'setFps', 'setBackground',
    'stFontSize', 'stFontFamily', 'stColor', 'stOutlineColor', 'stOutlineWidth',
    'stAlign', 'stMarginV', 'stBold', 'stBoxOn', 'stBoxColor',
  ]) {
    $(id).addEventListener('change', () => {
      beginHistory();
      apply();
    });
  }

  dialog.addEventListener('close', () => renderAll());
}

// ── export ──

let exportSource = null;

function openExport() {
  const dialog = $('exportDialog');
  const total = projectDuration(state.project);
  $('exportSummary').textContent =
    `${state.project.width} × ${state.project.height} · ${state.project.fps} fps · ${formatTime(total)} · ` +
    `${state.project.clips.length} clip${state.project.clips.length === 1 ? '' : 's'}, ` +
    `${state.project.subtitles.length} subtitle${state.project.subtitles.length === 1 ? '' : 's'}`;
  $('exportProgress').hidden = true;
  $('exportResult').hidden = true;
  $('exportError').hidden = true;
  $('exportStart').disabled = false;
  $('exportStart').textContent = 'Render';
  dialog.showModal();
}

async function startExport() {
  const btn = $('exportStart');
  await saveNow();

  $('exportError').hidden = true;
  $('exportResult').hidden = true;
  $('exportProgress').hidden = false;
  $('exportFill').style.width = '0%';
  $('exportMessage').textContent = 'Starting…';
  btn.disabled = true;
  btn.textContent = 'Rendering…';

  let job;
  try {
    job = await api('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: state.project,
        format: $('exportFormat').value,
        quality: $('exportQuality').value,
        filename: state.project.name,
      }),
    });
  } catch (err) {
    return failExport(err.message);
  }

  exportSource?.close();
  exportSource = new EventSource(`/api/export/${job.jobId}/events`);
  exportSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'progress') {
      $('exportFill').style.width = `${data.percent}%`;
      $('exportMessage').textContent = `${Math.round(data.percent)}% — ${data.message}`;
    } else if (data.type === 'done') {
      $('exportFill').style.width = '100%';
      $('exportMessage').textContent = 'Finished';
      $('exportResult').hidden = false;
      $('exportResultName').textContent = data.name;
      $('exportResultSize').textContent = formatBytes(data.size);
      const link = $('exportDownload');
      link.href = data.url;
      link.setAttribute('download', data.name);
      btn.disabled = false;
      btn.textContent = 'Render again';
      exportSource.close();
      toast('Export finished');
    } else if (data.type === 'error' || data.type === 'cancelled') {
      failExport(data.error || 'Cancelled');
      exportSource.close();
    }
  };
  exportSource.onerror = () => exportSource.close();
}

function failExport(message) {
  $('exportProgress').hidden = true;
  const box = $('exportError');
  box.hidden = false;
  box.textContent = message;
  $('exportStart').disabled = false;
  $('exportStart').textContent = 'Render';
}

// ───────────────────────────────── wiring ───────────────────────────────────

function renderAll() {
  el.totalTime.textContent = formatTime(projectDuration(state.project));
  renderTimeline();
  renderInspector();
  draw();
}

function wire() {
  // transport
  el.playPause.onclick = togglePlay;
  $('toStart').onclick = () => seek(0);
  $('toEnd').onclick = () => seek(projectDuration(state.project));

  $('timelineZoom').addEventListener('input', (e) => {
    state.pxPerSec = Number(e.target.value);
    renderTimeline();
  });

  // ruler scrubbing
  const scrub = (e) => {
    const rect = el.ruler.getBoundingClientRect();
    seek((e.clientX - rect.left) / state.pxPerSec);
  };
  el.ruler.addEventListener('pointerdown', (e) => {
    scrub(e);
    const move = (ev) => scrub(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // tracks
  for (const lane of [el.videoTrack, el.subtitleTrack, el.audioTrack]) setupTrackInteractions(lane);

  // timeline buttons
  $('addSubtitle').onclick = addSubtitle;
  $('addTitleCard').onclick = addTitleCard;
  $('splitClip').onclick = splitClip;
  $('deleteSelected').onclick = deleteSelected;
  $('snapToggle').addEventListener('change', (e) => (state.snap = e.target.checked));

  // project
  el.projectSelect.addEventListener('change', (e) => openProject(e.target.value));
  $('newProject').onclick = async () => {
    const name = prompt('Name for the new project?', 'Untitled');
    if (name === null) return;
    const created = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await loadProjectList(created.id);
    await openProject(created.id);
  };
  el.projectName.addEventListener('change', () => {
    mutate((p) => (p.name = el.projectName.value || 'Untitled'));
    loadProjectList(state.projectId);
  });

  // media
  $('addFiles').onclick = () => el.fileInput.click();
  el.fileInput.addEventListener('change', async (e) => {
    await uploadFiles([...e.target.files]);
    e.target.value = '';
  });
  el.mediaPanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.mediaPanel.classList.add('dragover');
  });
  el.mediaPanel.addEventListener('dragleave', () => el.mediaPanel.classList.remove('dragover'));
  el.mediaPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.mediaPanel.classList.remove('dragover');
    if (e.dataTransfer.files?.length) await uploadFiles([...e.dataTransfer.files]);
  });

  // dropping anywhere else still adds to the bin
  let veilDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    veilDepth++;
    el.dropVeil.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    veilDepth = Math.max(0, veilDepth - 1);
    if (!veilDepth) el.dropVeil.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    veilDepth = 0;
    el.dropVeil.hidden = true;
    if (e.dataTransfer.files?.length) await uploadFiles([...e.dataTransfer.files]);
  });

  // dialogs
  $('openSettings').onclick = openSettings;
  $('openExport').onclick = openExport;
  $('exportStart').onclick = startExport;
  wireSettings();

  // keyboard
  window.addEventListener('keydown', (e) => {
    const typing = /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === 's') {
      e.preventDefault();
      return saveNow();
    }
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (typing) return;

    const frame = 1 / state.project.fps;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        return togglePlay();
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return deleteSelected();
      case 'ArrowLeft':
        e.preventDefault();
        return seek(state.time - (e.shiftKey ? 1 : frame));
      case 'ArrowRight':
        e.preventDefault();
        return seek(state.time + (e.shiftKey ? 1 : frame));
      case 'Home':
        return seek(0);
      case 'End':
        return seek(projectDuration(state.project));
      case 's':
      case 'S':
        return splitClip();
      default:
        return;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      saveNow();
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function init() {
  wire();

  try {
    state.health = await api('/api/health');
    if (!state.health.ffmpeg) {
      toast('ffmpeg not found — export is disabled. See the README.', 'bad');
      $('openExport').disabled = true;
    }
  } catch {
    /* health is advisory */
  }

  const projects = await loadProjectList();
  const last = localStorage.getItem('video-studio:last');
  const pick = projects.find((p) => p.id === last) || projects[0];
  if (pick) {
    await openProject(pick.id);
  } else {
    const created = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My first video' }),
    });
    await loadProjectList(created.id);
    await openProject(created.id);
  }

  await refreshMedia();
  watchDisk();
  renderAll();
}

init();
