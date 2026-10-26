import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Patterns that are refused outright. These are commands whose whole purpose is
 * to destroy the machine, its backups, or its boot configuration; there is no
 * plausible reason for an assistant to run one on a user's desktop.
 */
const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  'Format-Volume',
  '\\bformat\\s+[a-z]:',
  '\\bdiskpart\\b',
  '\\bbcdedit\\b',
  'vssadmin\\s+delete\\s+shadows',
  'wbadmin\\s+delete',
  'cipher\\s+/w',
  'Remove-Item[^\\n]*\\b[cC]:\\\\(Windows|Program Files)\\b',
  'r(?:em)?d(?:ir)?\\s+/s[^\\n]*\\b[cC]:\\\\Windows\\b',
  'del\\s+/[fsq][^\\n]*\\b[cC]:\\\\(\\s|$|Windows)',
  'Set-MpPreference[^\\n]*DisableRealtimeMonitoring[^\\n]*\\$true',
  'Add-MpPreference[^\\n]*ExclusionPath',
  '\\bsc\\b[^\\n]*\\bdelete\\b\\s+(WinDefend|wuauserv)',
  'netsh\\s+advfirewall\\s+set[^\\n]*state\\s+off'
];

/**
 * Patterns that are allowed but only with an explicit `confirm: true` on the
 * call, so a destructive or system-wide action is never a side effect of a
 * vaguely worded request.
 */
const DEFAULT_CONFIRM_COMMAND_PATTERNS = [
  '\\bshutdown\\b',
  'Restart-Computer',
  'Stop-Computer',
  'Remove-Item[^\\n]*(-Recurse|/s)',
  '\\brmdir\\s+/s',
  '\\bdel\\s+/[fsq]',
  'Stop-Service',
  'Set-Service',
  'Uninstall-',
  'Remove-.*(Item|Service|LocalUser|LocalGroup|Printer|PSDrive)',
  'New-LocalUser',
  'Add-LocalGroupMember',
  '\\bnet\\s+user\\b',
  '\\bnet\\s+localgroup\\b',
  '\\breg\\b\\s+(add|delete)',
  'Set-ItemProperty[^\\n]*HK(LM|CU):',
  'New-ItemProperty[^\\n]*HK(LM|CU):',
  'Remove-ItemProperty[^\\n]*HK(LM|CU):',
  'Set-ExecutionPolicy',
  'Invoke-Expression|\\biex\\b',
  'Start-Process[^\\n]*-Verb\\s+RunAs'
];

const DEFAULT_DENIED_PATH_PATTERNS = [
  '\\\\Windows\\\\System32\\\\config\\\\',
  '\\\\Windows\\\\SysWOW64\\\\',
  '\\\\System Volume Information\\\\',
  '\\.ssh\\\\id_',
  '\\\\AppData\\\\Local\\\\Microsoft\\\\Credentials\\\\',
  '\\\\AppData\\\\Roaming\\\\Microsoft\\\\Crypto\\\\'
];

export const DEFAULT_CONFIG = {
  // Filesystem reach of the file_* tools. Empty array means "no restriction",
  // which is deliberate but should be a choice the user makes.
  allowedRoots: ['%USERPROFILE%', '%TEMP%', '%PUBLIC%'],
  deniedPathPatterns: DEFAULT_DENIED_PATH_PATTERNS,
  writeEnabled: true,

  downloadDir: '%USERPROFILE%\\Downloads',
  allowedDownloadHosts: [],
  allowInsecureDownloads: false,
  maxDownloadBytes: 2 * 1024 * 1024 * 1024,

  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 200_000,
  maxTerminals: 8,
  terminalIdleTimeoutMs: 30 * 60_000,

  powershellPath: null,
  preferPwsh: true,

  packageManagers: ['winget', 'choco', 'scoop'],

  blockedCommandPatterns: DEFAULT_BLOCKED_COMMAND_PATTERNS,
  confirmCommandPatterns: DEFAULT_CONFIRM_COMMAND_PATTERNS,

  features: {
    shell: true,
    terminals: true,
    apps: true,
    files: true,
    downloads: true,
    packages: true,
    system: true,
    admin: true
  },

  auditLogPath: '%LOCALAPPDATA%\\windows-mcp\\audit.jsonl'
};

/** Expands %VAR%, $env:VAR and a leading ~ against the real environment. */
export function expandPath(value) {
  if (typeof value !== 'string' || value === '') return value;
  let out = value
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name) => process.env[name] ?? whole)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => process.env[name] ?? whole);
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return out;
}

function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value) && typeof value === 'object' && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      merged[key] = { ...base[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function configPathCandidates() {
  const candidates = [];
  if (process.env.WINDOWS_MCP_CONFIG) candidates.push(process.env.WINDOWS_MCP_CONFIG);
  candidates.push(path.join(packageRoot, 'config.json'));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) candidates.push(path.join(localAppData, 'windows-mcp', 'config.json'));
  candidates.push(path.join(os.homedir(), '.windows-mcp.json'));
  return candidates;
}

/**
 * Loads config from the first file that exists, layering it over the defaults.
 * A malformed file is a hard error: silently falling back to defaults would
 * quietly widen the permissions the user thought they had set.
 */
export function loadConfig({ overrides } = {}) {
  let fileConfig = {};
  let source = 'defaults';
  for (const candidate of configPathCandidates()) {
    const expanded = expandPath(candidate);
    if (!expanded || !fs.existsSync(expanded)) continue;
    try {
      fileConfig = JSON.parse(fs.readFileSync(expanded, 'utf8'));
    } catch (error) {
      throw new Error(`Config file ${expanded} is not valid JSON: ${error.message}`);
    }
    source = expanded;
    break;
  }

  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), overrides);
  config.configSource = source;
  // Only an explicit empty list in the user's own config means "the whole
  // filesystem". An empty list that falls out of failed expansion does not.
  config.unrestrictedPaths = Array.isArray(fileConfig.allowedRoots) && fileConfig.allowedRoots.length === 0;
  // A root whose %VAR% did not expand (wrong env, or not Windows) is dropped
  // rather than resolved into a nonsense relative path.
  config.allowedRoots = (config.allowedRoots ?? [])
    .map(expandPath)
    .filter((p) => typeof p === 'string' && p.length > 0 && !p.includes('%'))
    .map((p) => path.resolve(p));
  if (config.allowedRoots.length === 0 && !config.unrestrictedPaths) {
    config.allowedRoots = [path.resolve(os.homedir()), path.resolve(os.tmpdir())];
  }
  config.downloadDir = expandPath(config.downloadDir);
  if (!config.downloadDir || config.downloadDir.includes('%')) {
    config.downloadDir = path.join(os.homedir(), 'Downloads');
  }
  config.auditLogPath = config.auditLogPath ? expandPath(config.auditLogPath) : null;
  if (config.auditLogPath && config.auditLogPath.includes('%')) {
    config.auditLogPath = path.join(os.tmpdir(), 'windows-mcp', 'audit.jsonl');
  }
  config.blockedCommandRegexes = config.blockedCommandPatterns.map((p) => new RegExp(p, 'i'));
  config.confirmCommandRegexes = config.confirmCommandPatterns.map((p) => new RegExp(p, 'i'));
  config.deniedPathRegexes = config.deniedPathPatterns.map((p) => new RegExp(p, 'i'));
  return config;
}

export { packageRoot };
