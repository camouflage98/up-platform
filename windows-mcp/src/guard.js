import fs from 'node:fs';
import path from 'node:path';

/** An error whose message is safe and useful to show back to the model. */
export class ToolError extends Error {
  constructor(message, { code = 'invalid_request', hint } = {}) {
    super(hint ? `${message}\nHint: ${hint}` : message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function assertWindows() {
  if (process.platform !== 'win32') {
    throw new ToolError(
      `This tool controls a Windows machine, but the server is running on ${process.platform}.`,
      { code: 'wrong_platform', hint: 'Run the server on the Windows host you want to control.' }
    );
  }
}

export function assertFeature(config, feature) {
  if (config.features?.[feature] === false) {
    throw new ToolError(`The "${feature}" feature is disabled in this server's config.`, { code: 'feature_disabled' });
  }
}

/**
 * Classifies a shell command against the configured policy.
 * Returns { verdict: 'allow' | 'confirm' | 'block', pattern }.
 */
export function classifyCommand(config, command) {
  for (const regex of config.blockedCommandRegexes ?? []) {
    if (regex.test(command)) return { verdict: 'block', pattern: regex.source };
  }
  for (const regex of config.confirmCommandRegexes ?? []) {
    if (regex.test(command)) return { verdict: 'confirm', pattern: regex.source };
  }
  return { verdict: 'allow', pattern: null };
}

export function assertCommandAllowed(config, command, confirmed) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ToolError('The command is empty.');
  }
  const { verdict, pattern } = classifyCommand(config, command);
  if (verdict === 'block') {
    throw new ToolError(
      `Refused: this command matches a blocked pattern (${pattern}). These are destructive system operations the server will not run.`,
      { code: 'blocked_command', hint: 'Edit blockedCommandPatterns in the config if you genuinely need it, and run it yourself.' }
    );
  }
  if (verdict === 'confirm' && !confirmed) {
    throw new ToolError(
      `This command matches a pattern that needs confirmation (${pattern}).`,
      { code: 'confirmation_required', hint: 'Show the exact command to the user, get their agreement, then call again with confirm: true.' }
    );
  }
  return verdict;
}

/** Resolves a user-supplied path and checks it against the configured roots. */
export function resolvePath(config, inputPath, { mustExist = false, forWrite = false } = {}) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ToolError('A path is required.');
  }
  const resolved = path.resolve(inputPath);
  const normalized = resolved.replace(/\//g, '\\');

  for (const regex of config.deniedPathRegexes ?? []) {
    if (regex.test(normalized)) {
      throw new ToolError(`Refused: ${resolved} matches a denied path pattern (${regex.source}).`, { code: 'denied_path' });
    }
  }

  if (!config.unrestrictedPaths && config.allowedRoots.length > 0) {
    const inRoot = config.allowedRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!inRoot) {
      throw new ToolError(
        `Refused: ${resolved} is outside the allowed roots (${config.allowedRoots.join(', ')}).`,
        { code: 'path_outside_roots', hint: 'Add the folder to allowedRoots in the config to permit it.' }
      );
    }
  }

  if (forWrite && config.writeEnabled === false) {
    throw new ToolError('This server is configured read-only (writeEnabled: false).', { code: 'read_only' });
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new ToolError(`Path not found: ${resolved}`, { code: 'not_found' });
  }
  return resolved;
}

export function clampTimeout(config, requested) {
  const value = Number.isFinite(requested) ? requested : config.defaultTimeoutMs;
  return Math.max(1000, Math.min(value, config.maxTimeoutMs));
}

/** Keeps the head and tail of long output so both the command and its error survive. */
export function truncateOutput(text, maxBytes) {
  if (typeof text !== 'string') return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = buffer.subarray(0, half).toString('utf8');
  const tail = buffer.subarray(buffer.length - half).toString('utf8');
  const omitted = buffer.length - 2 * half;
  return `${head}\n\n...[${omitted} bytes omitted, ${buffer.length} total]...\n\n${tail}`;
}

let auditWarned = false;

/** Appends one JSON line per tool call so the user can audit what was run. */
export function audit(config, entry) {
  if (!config.auditLogPath) return;
  try {
    fs.mkdirSync(path.dirname(config.auditLogPath), { recursive: true });
    fs.appendFileSync(config.auditLogPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    if (!auditWarned) {
      auditWarned = true;
      process.stderr.write(`windows-mcp: audit log disabled (${error.message})\n`);
    }
  }
}
