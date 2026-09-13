/**
 * Where things live on disk.
 *
 *   video-studio/projects/<name>.json   the videos (plain JSON, hand-editable)
 *   video-studio/media/                 images, video and audio you drop in
 *   video-studio/exports/               rendered MP4 / AVI files
 *
 * Clip `src` paths are stored relative to the video-studio folder, e.g.
 * "media/sunset.jpg", so a project folder stays portable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProject, defaultProject } from './project.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const MEDIA_DIR = path.join(ROOT, 'media');
export const EXPORTS_DIR = path.join(ROOT, 'exports');

export function ensureDirs() {
  for (const d of [PROJECTS_DIR, MEDIA_DIR, EXPORTS_DIR]) fs.mkdirSync(d, { recursive: true });
}

/** Turn any user-supplied name into a safe single path segment. */
export function safeName(name, fallback = 'untitled') {
  const base = String(name || '')
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return base || fallback;
}

export function projectPath(id) {
  return path.join(PROJECTS_DIR, `${safeName(id)}.json`);
}

export function listProjects() {
  ensureDirs();
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const id = f.replace(/\.json$/, '');
      let name = id;
      try {
        name = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8')).name || id;
      } catch {
        /* unreadable file still shows up, by filename */
      }
      const st = fs.statSync(path.join(PROJECTS_DIR, f));
      return { id, name, modified: st.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
}

export function loadProject(id) {
  const file = projectPath(id);
  const raw = fs.readFileSync(file, 'utf8');
  return normalizeProject(JSON.parse(raw));
}

/** Load from an arbitrary path (used by the CLI). */
export function loadProjectFile(file) {
  return normalizeProject(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function saveProject(id, project) {
  ensureDirs();
  const normalized = normalizeProject(project);
  const file = projectPath(id);
  // write-then-rename so a crash never leaves a half-written project
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { id: safeName(id), project: normalized, modified: fs.statSync(file).mtimeMs };
}

export function createProject(name) {
  const id = safeName(name, `video-${Date.now().toString(36)}`);
  return saveProject(id, defaultProject(name || id));
}

export function projectModified(id) {
  try {
    return fs.statSync(projectPath(id)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Everything currently sitting in media/. */
export function listMedia() {
  ensureDirs();
  return fs
    .readdirSync(MEDIA_DIR)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(MEDIA_DIR, f));
      return { name: f, src: `media/${f}`, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
}

/** A non-clobbering filename inside media/. */
export function uniqueMediaName(filename) {
  const clean = String(filename || 'file')
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9-_. ]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 120) || 'file';
  ensureDirs();
  let candidate = clean;
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let n = 1;
  while (fs.existsSync(path.join(MEDIA_DIR, candidate))) candidate = `${stem}-${n++}${ext}`;
  return candidate;
}
