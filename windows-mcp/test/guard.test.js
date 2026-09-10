import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { assertCommandAllowed, classifyCommand, resolvePath, truncateOutput, ToolError } from '../src/guard.js';
import { globToRegExp } from '../src/tools/files.js';
import { encodePowerShellCommand } from '../src/exec.js';

const config = loadConfig({ overrides: { allowedRoots: [os.tmpdir()], auditLogPath: null } });

test('destructive system commands are blocked outright', () => {
  for (const command of ['Format-Volume -DriveLetter C', 'vssadmin delete shadows /all', 'bcdedit /set safeboot minimal']) {
    assert.equal(classifyCommand(config, command).verdict, 'block', command);
    assert.throws(() => assertCommandAllowed(config, command, true), ToolError);
  }
});

test('risky commands need confirmation but are allowed with it', () => {
  const command = 'Remove-Item C:\\Users\\me\\old -Recurse';
  assert.equal(classifyCommand(config, command).verdict, 'confirm');
  assert.throws(() => assertCommandAllowed(config, command, false), /confirm: true/);
  assert.equal(assertCommandAllowed(config, command, true), 'confirm');
});

test('ordinary commands pass without confirmation', () => {
  for (const command of ['Get-Process', 'Get-ChildItem C:\\Users', 'winget list']) {
    assert.equal(assertCommandAllowed(config, command, false), 'allow', command);
  }
});

test('paths outside the allowed roots are refused', () => {
  const inside = path.join(os.tmpdir(), 'notes.txt');
  assert.equal(resolvePath(config, inside), path.resolve(inside));
  assert.throws(() => resolvePath(config, '/etc/shadow'), /outside the allowed roots/);
});

test('denied path patterns win even inside an allowed root', () => {
  const scoped = loadConfig({
    overrides: { allowedRoots: [os.tmpdir()], deniedPathPatterns: ['secrets'], auditLogPath: null }
  });
  assert.throws(() => resolvePath(scoped, path.join(os.tmpdir(), 'secrets', 'key.txt')), /denied path pattern/);
});

test('an explicitly empty allowedRoots is the only way to reach the whole filesystem', () => {
  const restricted = loadConfig({ overrides: { allowedRoots: [], auditLogPath: null } });
  assert.deepEqual(restricted.allowedRoots, [path.resolve(os.homedir()), path.resolve(os.tmpdir())]);
  assert.equal(restricted.unrestrictedPaths, false);
});

test('read-only mode refuses writes', () => {
  const readOnly = loadConfig({ overrides: { allowedRoots: [os.tmpdir()], writeEnabled: false, auditLogPath: null } });
  assert.throws(() => resolvePath(readOnly, path.join(os.tmpdir(), 'x.txt'), { forWrite: true }), /read-only/);
});

test('long output keeps its head and its tail', () => {
  const text = `${'a'.repeat(500)}TAIL`;
  const truncated = truncateOutput(text, 100);
  assert.ok(truncated.startsWith('a'));
  assert.ok(truncated.endsWith('TAIL'));
  assert.ok(truncated.includes('omitted'));
});

test('globs match file names case-insensitively', () => {
  assert.ok(globToRegExp('*.pdf').test('Invoice.PDF'));
  assert.ok(!globToRegExp('*.pdf').test('invoice.pdf.txt'));
  assert.ok(globToRegExp('report?.docx').test('report1.docx'));
});

test('PowerShell commands are encoded as UTF-16LE base64', () => {
  assert.equal(Buffer.from(encodePowerShellCommand('echo hi'), 'base64').toString('utf16le'), 'echo hi');
});
