import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertFeature, assertWindows, clampTimeout, resolvePath, ToolError, truncateOutput } from '../guard.js';
import { runPowerShellJson } from '../exec.js';
import { defineTool, textResult } from './helpers.js';

const KNOWN_FOLDERS = ['Desktop', 'MyDocuments', 'MyPictures', 'MyMusic', 'MyVideos', 'UserProfile', 'ApplicationData', 'LocalApplicationData', 'ProgramFiles', 'CommonStartMenu', 'StartMenu'];

export function registerFileTools(server, ctx) {
  const { config } = ctx;

  defineTool(
    server,
    ctx,
    'file_list',
    {
      title: 'List a folder',
      description: 'List the entries in a folder on the Windows machine, with type, size and modified time.',
      inputSchema: {
        path: z.string(),
        pattern: z.string().optional().describe('Only names matching this glob, e.g. "*.pdf".'),
        recursive: z.boolean().optional(),
        limit: z.number().int().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ path: target, pattern, recursive, limit = 200 }) => {
      assertFeature(config, 'files');
      const dir = resolvePath(config, target, { mustExist: true });
      if (!fs.statSync(dir).isDirectory()) throw new ToolError(`${dir} is a file, not a folder.`);
      const matcher = pattern ? globToRegExp(pattern) : null;
      const entries = [];
      walk(dir, { recursive, limit: Math.min(limit, 2000), matcher, onEntry: (entry) => entries.push(entry) });
      return textResult({ path: dir, count: entries.length, entries });
    }
  );

  defineTool(
    server,
    ctx,
    'file_read',
    {
      title: 'Read a file',
      description: 'Read a file from the Windows machine as text, or as base64 for binary. Long files are truncated in the middle.',
      inputSchema: {
        path: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional(),
        maxBytes: z.number().int().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ path: target, encoding = 'utf8', maxBytes }) => {
      assertFeature(config, 'files');
      const file = resolvePath(config, target, { mustExist: true });
      const stat = fs.statSync(file);
      if (stat.isDirectory()) throw new ToolError(`${file} is a folder. Use file_list.`);
      const limit = Math.min(maxBytes ?? config.maxOutputBytes, 5 * 1024 * 1024);
      const buffer = fs.readFileSync(file);
      if (encoding === 'base64') {
        return textResult({ path: file, bytes: stat.size, base64: buffer.subarray(0, limit).toString('base64') });
      }
      return textResult(`${file} (${stat.size} bytes)\n\n${truncateOutput(buffer.toString('utf8'), limit)}`);
    }
  );

  defineTool(
    server,
    ctx,
    'file_write',
    {
      title: 'Write a file',
      description: 'Create, overwrite or append to a file on the Windows machine. Overwriting an existing file needs overwrite: true.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional(),
        mode: z.enum(['write', 'append']).optional(),
        overwrite: z.boolean().optional()
      },
      annotations: { destructiveHint: true }
    },
    async ({ path: target, content, encoding = 'utf8', mode = 'write', overwrite }) => {
      assertFeature(config, 'files');
      const file = resolvePath(config, target, { forWrite: true });
      if (mode === 'write' && fs.existsSync(file) && !overwrite) {
        throw new ToolError(`${file} already exists.`, { code: 'exists', hint: 'Pass overwrite: true to replace it.' });
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
      if (mode === 'append') fs.appendFileSync(file, data);
      else fs.writeFileSync(file, data);
      return textResult({ path: file, bytes: fs.statSync(file).size, mode });
    }
  );

  defineTool(
    server,
    ctx,
    'file_move',
    {
      title: 'Move or copy a file',
      description: 'Move, rename or copy a file or folder on the Windows machine.',
      inputSchema: {
        source: z.string(),
        destination: z.string(),
        copy: z.boolean().optional().describe('Copy instead of moving.'),
        overwrite: z.boolean().optional()
      },
      annotations: { destructiveHint: true }
    },
    async ({ source, destination, copy, overwrite }) => {
      assertFeature(config, 'files');
      const from = resolvePath(config, source, { mustExist: true });
      let to = resolvePath(config, destination, { forWrite: true });
      if (fs.existsSync(to) && fs.statSync(to).isDirectory()) to = path.join(to, path.basename(from));
      if (fs.existsSync(to) && !overwrite) {
        throw new ToolError(`${to} already exists.`, { code: 'exists', hint: 'Pass overwrite: true to replace it.' });
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (copy) fs.cpSync(from, to, { recursive: true, force: true });
      else fs.renameSync(from, to);
      return textResult({ from, to, operation: copy ? 'copy' : 'move' });
    }
  );

  defineTool(
    server,
    ctx,
    'file_delete',
    {
      title: 'Delete a file or folder',
      description: 'Delete a file or folder on the Windows machine. Needs confirm: true, and deleting a folder also needs recursive: true.',
      inputSchema: {
        path: z.string(),
        recursive: z.boolean().optional(),
        confirm: z.boolean().optional()
      },
      annotations: { destructiveHint: true }
    },
    async ({ path: target, recursive, confirm }) => {
      assertFeature(config, 'files');
      const file = resolvePath(config, target, { mustExist: true, forWrite: true });
      if (!confirm) throw new ToolError(`Deleting ${file} needs confirm: true.`, { code: 'confirmation_required' });
      const isDir = fs.statSync(file).isDirectory();
      if (isDir && !recursive) throw new ToolError(`${file} is a folder. Pass recursive: true to delete it and its contents.`);
      fs.rmSync(file, { recursive: Boolean(recursive), force: false });
      return textResult({ deleted: file, wasFolder: isDir });
    }
  );

  defineTool(
    server,
    ctx,
    'file_search',
    {
      title: 'Find files by name',
      description: 'Search a folder tree for files whose name matches a glob, e.g. every "*.pptx" under Documents.',
      inputSchema: {
        root: z.string(),
        pattern: z.string().describe('Glob against the file name, e.g. "invoice*.pdf".'),
        limit: z.number().int().optional(),
        maxDepth: z.number().int().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ root, pattern, limit = 100, maxDepth = 8 }) => {
      assertFeature(config, 'files');
      const dir = resolvePath(config, root, { mustExist: true });
      const matcher = globToRegExp(pattern);
      const matches = [];
      walk(dir, {
        recursive: true,
        maxDepth,
        limit: Math.min(limit, 1000),
        matcher,
        filesOnly: true,
        onEntry: (entry) => matches.push(entry)
      });
      return textResult({ root: dir, pattern, count: matches.length, matches });
    }
  );

  defineTool(
    server,
    ctx,
    'known_folders',
    {
      title: 'Locate the user folders',
      description: 'Return the real paths of Desktop, Documents, Downloads, AppData and similar, which are not always under the user profile.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      assertWindows();
      assertFeature(config, 'files');
      const script =
        `[PSCustomObject]@{ ` +
        KNOWN_FOLDERS.map((name) => `${name} = [Environment]::GetFolderPath('${name}')`).join('; ') +
        `; Downloads = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders')."{374DE290-123F-4565-9164-39C4925E467B}" ` +
        `; Temp = $env:TEMP }`;
      const folders = await runPowerShellJson(config, script, { timeoutMs: clampTimeout(config, 30_000) });
      return textResult(folders[0] ?? {});
    }
  );
}

/** Depth-limited directory walk that stops as soon as it has enough entries. */
function walk(dir, { recursive, limit, matcher, onEntry, filesOnly, maxDepth = recursive ? 32 : 1, depth = 0, counter = { n: 0 } }) {
  if (depth >= maxDepth || counter.n >= limit) return;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable folder: skip rather than fail the whole listing.
  }
  for (const dirent of dirents) {
    if (counter.n >= limit) return;
    const full = path.join(dir, dirent.name);
    const isDir = dirent.isDirectory();
    if ((!filesOnly || !isDir) && (!matcher || matcher.test(dirent.name))) {
      let size = null;
      let modified = null;
      try {
        const stat = fs.statSync(full);
        size = isDir ? null : stat.size;
        modified = stat.mtime.toISOString();
      } catch {
        // A file that vanished or is locked still deserves a line in the listing.
      }
      onEntry({ path: full, name: dirent.name, type: isDir ? 'folder' : 'file', sizeBytes: size, modified });
      counter.n += 1;
    }
    if (isDir && (recursive || depth + 1 < maxDepth)) {
      walk(full, { recursive, limit, matcher, onEntry, filesOnly, maxDepth, depth: depth + 1, counter });
    }
  }
}

export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
