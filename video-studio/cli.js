#!/usr/bin/env node
/**
 * Command line side of Video Studio - everything the editor UI can do, minus
 * the dragging. This is what makes the tool scriptable: an agent can write a
 * project JSON file and render it without ever opening a browser.
 *
 *   node cli.js doctor
 *   node cli.js new "My film"
 *   node cli.js info projects/my-film.json
 *   node cli.js render projects/my-film.json -o exports/my-film.mp4 --format mp4
 *   node cli.js srt projects/my-film.json
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadProjectFile, createProject, listProjects, ROOT, EXPORTS_DIR, ensureDirs, safeName } from './lib/store.js';
import { projectDuration, timelineSegments, formatTime } from './lib/project.js';
import { renderProject, writeSrt, FORMATS, QUALITY } from './lib/render.js';
import { ffmpegPath, ffmpegVersion, ffmpegHas, MISSING_FFMPEG_MESSAGE } from './lib/ffmpeg.js';

const argv = process.argv.slice(2);
const command = argv[0];

const flag = (name, fallback = null) => {
  const i = argv.findIndex((a) => a === `--${name}` || a === `-${name[0]}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  if (process.env.DEBUG && err.log) console.error(err.log);
  process.exit(1);
}

async function main() {
  switch (command) {
    case 'doctor':
      return doctor();
    case 'new':
      return newProject();
    case 'ls':
    case 'list':
      return list();
    case 'info':
      return info();
    case 'render':
      return render();
    case 'srt':
      return srt();
    default:
      return usage();
  }
}

function usage() {
  console.log(`
Video Studio

  node cli.js doctor                        check that ffmpeg is available
  node cli.js new "Name"                    create projects/name.json
  node cli.js ls                            list projects
  node cli.js info <project.json>           show the timeline as text
  node cli.js render <project.json> [opts]  render to MP4 or AVI
  node cli.js srt <project.json>            write a .srt next to the project

Render options:
  -o, --out <file>        output path        (default: exports/<name>.<ext>)
  --format <mp4|avi>      container          (default: mp4, or from --out)
  --quality <draft|good|best>                (default: good)
`);
}

function doctor() {
  const bin = ffmpegPath();
  if (!bin) {
    console.log(`✗ ${MISSING_FFMPEG_MESSAGE}`);
    process.exit(1);
  }
  console.log(`✓ ffmpeg: ${bin}`);
  console.log(`  ${ffmpegVersion()}`);

  const filters = ffmpegHas('filters', ['zoompan', 'subtitles', 'fade', 'amix', 'tpad']);
  const encoders = ffmpegHas('encoders', ['libx264', 'aac', 'mpeg4', 'libmp3lame']);

  const report = (label, map) => {
    for (const [name, ok] of Object.entries(map)) {
      console.log(`  ${ok ? '✓' : '✗'} ${label} ${name}`);
    }
  };
  report('filter ', filters);
  report('encoder', encoders);

  if (!filters.subtitles) console.log('\n  ! No libass: subtitles cannot be burned in by this build.');
  if (!encoders.libx264) console.log('\n  ! No libx264: MP4 export will not work with this build.');
  if (!encoders.mpeg4) console.log('\n  ! No mpeg4 encoder: AVI export will not work with this build.');
}

function newProject() {
  const name = argv[1] || 'Untitled';
  const { id } = createProject(name);
  console.log(`Created projects/${id}.json`);
}

function list() {
  const projects = listProjects();
  if (!projects.length) return console.log('No projects yet. Try: node cli.js new "My film"');
  for (const p of projects) console.log(`${p.id.padEnd(30)} ${p.name}`);
}

function resolveProjectArg() {
  const arg = argv[1];
  if (!arg) throw new Error('Which project? e.g. node cli.js render projects/my-film.json');
  const candidates = [arg, path.join(ROOT, arg), path.join(ROOT, 'projects', `${safeName(arg)}.json`)];
  const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!found) throw new Error(`Project not found: ${arg}`);
  return found;
}

function info() {
  const file = resolveProjectArg();
  const project = loadProjectFile(file);
  const total = projectDuration(project);

  console.log(`\n${project.name}  ${project.width}x${project.height} @ ${project.fps}fps  ${formatTime(total)}\n`);
  console.log('Timeline');
  for (const seg of timelineSegments(project)) {
    const c = seg.clip;
    const label = c ? `${c.type}  ${c.name}${c.effect !== 'none' ? `  [${c.effect} ${Math.round(c.amount * 100)}%]` : ''}` : '(empty)';
    console.log(`  ${formatTime(seg.start)} → ${formatTime(seg.end)}  ${label}`);
  }
  if (project.subtitles.length) {
    console.log('\nSubtitles');
    for (const s of project.subtitles) {
      console.log(`  ${formatTime(s.start)} → ${formatTime(s.end)}  ${String(s.text).replace(/\n/g, ' / ')}`);
    }
  }
  if (project.audio.length) {
    console.log('\nAudio');
    for (const a of project.audio) {
      console.log(`  ${formatTime(a.start)}  ${a.name}  vol ${a.volume}`);
    }
  }
  console.log();
}

async function render() {
  const file = resolveProjectArg();
  const project = loadProjectFile(file);

  let out = flag('out') || flag('output');
  let format = (flag('format') || '').toLowerCase();
  if (!format && out) format = path.extname(out).replace('.', '').toLowerCase();
  if (!FORMATS[format]) format = 'mp4';

  if (!out) {
    ensureDirs();
    out = path.join(EXPORTS_DIR, `${safeName(project.name, 'video')}.${FORMATS[format].ext}`);
  }
  out = path.resolve(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const quality = QUALITY[flag('quality')] ? flag('quality') : 'good';
  const total = projectDuration(project);

  console.log(`Rendering "${project.name}"  ${formatTime(total)}  →  ${path.relative(process.cwd(), out)}`);

  const started = Date.now();
  let lastLine = '';
  await renderProject(project, {
    outFile: out,
    format,
    quality,
    rootDir: ROOT,
    onProgress: ({ percent, message }) => {
      const line = `  ${String(Math.round(percent)).padStart(3)}%  ${message}`;
      if (line !== lastLine && process.stdout.isTTY) {
        process.stdout.write(`\r${line.padEnd(60)}`);
        lastLine = line;
      }
    },
  });

  if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(62) + '\r');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const size = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`✓ ${path.relative(process.cwd(), out)}  ${size} MB  in ${secs}s`);

  if (has('srt') && project.subtitles.length) {
    console.log(`✓ ${path.relative(process.cwd(), writeSrt(project, out))}`);
  }
}

function srt() {
  const file = resolveProjectArg();
  const project = loadProjectFile(file);
  const out = writeSrt(project, file.replace(/\.json$/, '.mp4'));
  console.log(`✓ ${path.relative(process.cwd(), out)}`);
}
