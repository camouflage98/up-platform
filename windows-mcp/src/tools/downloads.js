import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { assertFeature, assertWindows, clampTimeout, resolvePath, ToolError } from '../guard.js';
import { runPowerShell } from '../exec.js';
import { defineTool, formatRun, textResult } from './helpers.js';

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+@:\\/-]{0,127}$/;

const MANAGERS = {
  winget: {
    binary: 'winget',
    search: (q) => `winget search --query "${q}" --accept-source-agreements`,
    list: (q) => (q ? `winget list --query "${q}"` : 'winget list'),
    install: (id) => `winget install --id "${id}" --exact --silent --accept-package-agreements --accept-source-agreements`,
    uninstall: (id) => `winget uninstall --id "${id}" --exact --silent`
  },
  choco: {
    binary: 'choco',
    search: (q) => `choco search "${q}" --limit-output --page-size 25`,
    list: () => 'choco list --local-only --limit-output',
    install: (id) => `choco install "${id}" -y --no-progress`,
    uninstall: (id) => `choco uninstall "${id}" -y`
  },
  scoop: {
    binary: 'scoop',
    search: (q) => `scoop search "${q}"`,
    list: () => 'scoop list',
    install: (id) => `scoop install "${id}"`,
    uninstall: (id) => `scoop uninstall "${id}"`
  }
};

function manager(config, name) {
  if (!MANAGERS[name]) throw new ToolError(`Unknown package manager "${name}".`);
  if (!config.packageManagers.includes(name)) {
    throw new ToolError(`Package manager "${name}" is not enabled in this server's config.`, { code: 'feature_disabled' });
  }
  return MANAGERS[name];
}

function assertPackageId(id) {
  if (!PACKAGE_ID.test(id)) {
    throw new ToolError(`"${id}" is not a valid package id. Package ids may not contain shell metacharacters.`);
  }
  return id;
}

export function registerDownloadTools(server, ctx) {
  const { config } = ctx;

  defineTool(
    server,
    ctx,
    'download_file',
    {
      title: 'Download a file',
      description:
        'Download a URL to the Windows machine and report where it landed, how big it is and its SHA-256. ' +
        'Defaults to the configured download folder. Pass expectedSha256 when you know the publisher hash and the file is deleted on mismatch.',
      inputSchema: {
        url: z.string().url().describe('HTTPS URL to download.'),
        destination: z.string().optional().describe('Full target path, or a folder. Defaults to the configured download folder.'),
        filename: z.string().optional().describe('Filename to use when destination is a folder or omitted.'),
        overwrite: z.boolean().optional(),
        expectedSha256: z.string().optional().describe('Hex digest to verify against.'),
        timeoutMs: z.number().int().optional()
      },
      annotations: { openWorldHint: true }
    },
    async ({ url, destination, filename, overwrite, expectedSha256, timeoutMs }) => {
      assertFeature(config, 'downloads');
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && !config.allowInsecureDownloads) {
        throw new ToolError(`Refused: ${url} is not an HTTPS URL.`, {
          code: 'insecure_download',
          hint: 'Set allowInsecureDownloads: true in the config if you really need plain HTTP.'
        });
      }
      if (config.allowedDownloadHosts.length > 0 && !config.allowedDownloadHosts.includes(parsed.hostname)) {
        throw new ToolError(`Refused: ${parsed.hostname} is not in allowedDownloadHosts.`, { code: 'host_not_allowed' });
      }

      const targetPath = resolveTarget(config, { destination, filename, parsed });
      if (fs.existsSync(targetPath) && !overwrite) {
        throw new ToolError(`${targetPath} already exists.`, { code: 'exists', hint: 'Pass overwrite: true to replace it.' });
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), clampTimeout(config, timeoutMs ?? 300_000));
      let response;
      try {
        response = await fetch(url, { redirect: 'follow', signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        throw new ToolError(`Download failed: ${error.message}`, { code: 'download_failed' });
      }
      // A redirect can land somewhere the original URL check would have refused,
      // so re-run the same checks against where the download actually came from.
      const finalUrl = new URL(response.url || url);
      if (finalUrl.protocol !== 'https:' && !config.allowInsecureDownloads) {
        clearTimeout(timer);
        throw new ToolError(`Refused: the download redirected to ${finalUrl.href}, which is not HTTPS.`, {
          code: 'insecure_download'
        });
      }
      if (config.allowedDownloadHosts.length > 0 && !config.allowedDownloadHosts.includes(finalUrl.hostname)) {
        clearTimeout(timer);
        throw new ToolError(`Refused: the download redirected to ${finalUrl.hostname}, which is not in allowedDownloadHosts.`, {
          code: 'host_not_allowed'
        });
      }
      if (!response.ok) {
        clearTimeout(timer);
        throw new ToolError(`Download failed: HTTP ${response.status} ${response.statusText}`, { code: 'download_failed' });
      }

      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > config.maxDownloadBytes) {
        clearTimeout(timer);
        throw new ToolError(`Refused: the file is ${declaredLength} bytes, over the ${config.maxDownloadBytes} byte limit.`, {
          code: 'too_large'
        });
      }

      const hash = crypto.createHash('sha256');
      let received = 0;
      const meter = createMeter(config.maxDownloadBytes, hash, (bytes) => { received = bytes; });

      try {
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(targetPath));
      } catch (error) {
        clearTimeout(timer);
        fs.rmSync(targetPath, { force: true });
        throw new ToolError(`Download failed: ${error.message}`, { code: 'download_failed' });
      }
      clearTimeout(timer);

      const digest = hash.digest('hex');
      if (expectedSha256 && digest.toLowerCase() !== expectedSha256.toLowerCase()) {
        fs.rmSync(targetPath, { force: true });
        throw new ToolError(`Hash mismatch: expected ${expectedSha256}, got ${digest}. The file was deleted.`, {
          code: 'hash_mismatch'
        });
      }

      return textResult({
        path: targetPath,
        bytes: received,
        sha256: digest,
        contentType: response.headers.get('content-type'),
        verified: Boolean(expectedSha256)
      });
    }
  );

  defineTool(
    server,
    ctx,
    'package_search',
    {
      title: 'Search for a package',
      description: 'Search winget, Chocolatey or Scoop for something to install, so you can pick an exact package id before installing.',
      inputSchema: {
        query: z.string(),
        manager: z.enum(['winget', 'choco', 'scoop']).optional().describe('Defaults to winget.'),
        timeoutMs: z.number().int().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, manager: name = 'winget', timeoutMs }) => {
      assertWindows();
      assertFeature(config, 'packages');
      const chosen = manager(config, name);
      const safeQuery = query.replace(/["`$;&|<>]/g, ' ').trim();
      if (!safeQuery) throw new ToolError('The search query is empty after removing shell metacharacters.');
      const result = await runPowerShell(config, chosen.search(safeQuery), { timeoutMs: clampTimeout(config, timeoutMs ?? 120_000) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes, label: 'search' }));
    }
  );

  defineTool(
    server,
    ctx,
    'package_install',
    {
      title: 'Install a package',
      description:
        'Install a package by exact id through winget, Chocolatey or Scoop. This changes the machine, so it needs confirm: true. ' +
        'Some installers still raise a UAC prompt the user has to accept in person.',
      inputSchema: {
        id: z.string().describe('Exact package id, e.g. "Microsoft.VisualStudioCode".'),
        manager: z.enum(['winget', 'choco', 'scoop']).optional(),
        confirm: z.boolean().optional(),
        timeoutMs: z.number().int().optional()
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ id, manager: name = 'winget', confirm, timeoutMs }) => {
      assertWindows();
      assertFeature(config, 'packages');
      const chosen = manager(config, name);
      assertPackageId(id);
      if (!confirm) {
        throw new ToolError(`Installing ${id} with ${name} needs confirm: true. Tell the user what will be installed first.`, {
          code: 'confirmation_required'
        });
      }
      const result = await runPowerShell(config, chosen.install(id), { timeoutMs: clampTimeout(config, timeoutMs ?? 600_000) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes, label: 'install' }));
    }
  );

  defineTool(
    server,
    ctx,
    'package_uninstall',
    {
      title: 'Uninstall a package',
      description: 'Remove a package installed through winget, Chocolatey or Scoop. Needs confirm: true.',
      inputSchema: {
        id: z.string(),
        manager: z.enum(['winget', 'choco', 'scoop']).optional(),
        confirm: z.boolean().optional(),
        timeoutMs: z.number().int().optional()
      },
      annotations: { destructiveHint: true }
    },
    async ({ id, manager: name = 'winget', confirm, timeoutMs }) => {
      assertWindows();
      assertFeature(config, 'packages');
      const chosen = manager(config, name);
      assertPackageId(id);
      if (!confirm) throw new ToolError(`Uninstalling ${id} needs confirm: true.`, { code: 'confirmation_required' });
      const result = await runPowerShell(config, chosen.uninstall(id), { timeoutMs: clampTimeout(config, timeoutMs ?? 600_000) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes, label: 'uninstall' }));
    }
  );

  defineTool(
    server,
    ctx,
    'package_list',
    {
      title: 'List installed packages',
      description: 'List packages the chosen package manager knows about on this machine.',
      inputSchema: {
        manager: z.enum(['winget', 'choco', 'scoop']).optional(),
        query: z.string().optional(),
        timeoutMs: z.number().int().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ manager: name = 'winget', query, timeoutMs }) => {
      assertWindows();
      assertFeature(config, 'packages');
      const chosen = manager(config, name);
      const safeQuery = query ? query.replace(/["`$;&|<>]/g, ' ').trim() : '';
      const result = await runPowerShell(config, chosen.list(safeQuery), { timeoutMs: clampTimeout(config, timeoutMs ?? 180_000) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes, label: 'list' }));
    }
  );
}

function resolveTarget(config, { destination, filename, parsed }) {
  const urlName = decodeURIComponent(path.posix.basename(parsed.pathname || '')) || 'download.bin';
  const safeName = sanitizeFilename(filename ?? urlName);
  let target;
  if (!destination) {
    target = path.join(config.downloadDir, safeName);
  } else {
    const resolved = path.resolve(destination);
    const looksLikeDir = fs.existsSync(resolved) ? fs.statSync(resolved).isDirectory() : !path.extname(resolved);
    target = looksLikeDir ? path.join(resolved, safeName) : resolved;
  }
  return resolvePath(config, target, { forWrite: true });
}

function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return cleaned === '' ? 'download.bin' : cleaned.slice(0, 180);
}

/** Streams bytes through, hashing them and refusing to exceed the size limit. */
function createMeter(maxBytes, hash, onProgress) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error(`exceeded the ${maxBytes} byte download limit`));
        return;
      }
      hash.update(chunk);
      onProgress(total);
      callback(null, chunk);
    }
  });
}
