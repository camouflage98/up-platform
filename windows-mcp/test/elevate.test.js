import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { buildElevationScripts } from '../src/elevate.js';
import { encodePowerShellCommand } from '../src/exec.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

test('the elevated child redirects its own output, since RunAs cannot', () => {
  const { inner, launcher } = buildElevationScripts({
    command: 'Get-Service -Name W32Time',
    shellPath: 'pwsh.exe',
    outFile: 'C:\\Temp\\out.txt',
    codeFile: 'C:\\Temp\\code.txt'
  });

  assert.match(inner, /Get-Service -Name W32Time/);
  assert.match(inner, /\*> 'C:\\Temp\\out\.txt'/);
  assert.match(inner, /Set-Content -LiteralPath 'C:\\Temp\\code\.txt'/);

  // The launcher must elevate, wait, and carry the inner script encoded, not inline.
  assert.match(launcher, /-Verb RunAs/);
  assert.match(launcher, /-Wait/);
  assert.match(launcher, /-EncodedCommand/);
  assert.ok(!launcher.includes('Get-Service -Name W32Time'), 'the command should travel encoded');
  assert.ok(launcher.includes(encodePowerShellCommand(inner)));

  // Start-Process rejects redirection together with -Verb, so it must not appear.
  assert.ok(!launcher.includes('-RedirectStandardOutput'));
});

test('a declined UAC prompt is distinguished from a failure', () => {
  const { launcher } = buildElevationScripts({
    command: 'whoami',
    shellPath: 'pwsh.exe',
    outFile: 'o',
    codeFile: 'c'
  });
  assert.match(launcher, /UAC_DECLINED/);
  assert.match(launcher, /1223/);
  assert.match(launcher, /ELEVATION_FAILED/);
});

test('single quotes in paths cannot break out of the generated script', () => {
  const { inner } = buildElevationScripts({
    command: 'whoami',
    shellPath: 'pwsh.exe',
    outFile: "C:\\Temp\\it's here.txt",
    codeFile: 'C:\\Temp\\code.txt'
  });
  assert.match(inner, /'C:\\Temp\\it''s here\.txt'/);
});

async function withClient(run, { configPath } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: configPath ? { ...process.env, WINDOWS_MCP_CONFIG: configPath } : { ...process.env }
  });
  const client = new Client({ name: 'windows-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

test('admin_run will not run without confirmation', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'admin_run', arguments: { command: 'Get-Service' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /confirm: true/);
  });
});

test('blocked commands stay blocked when run as administrator', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'admin_run',
      arguments: { command: 'vssadmin delete shadows /all', confirm: true }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /blocked pattern/);
  });
});

test('admin tools refuse off-Windows rather than pretending', { skip: process.platform === 'win32' }, async () => {
  await withClient(async (client) => {
    const status = await client.callTool({ name: 'admin_status', arguments: {} });
    assert.equal(status.isError, true);
    assert.match(status.content[0].text, /Windows/);

    const run = await client.callTool({ name: 'admin_run', arguments: { command: 'whoami', confirm: true } });
    assert.equal(run.isError, true);
    assert.match(run.content[0].text, /Windows/);
  });
});

test('turning off the admin feature disables both tools', async () => {
  const fs = await import('node:fs');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-mcp-admin-'));
  const configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ features: { admin: false }, auditLogPath: null }));
  try {
    await withClient(async (client) => {
      const result = await client.callTool({ name: 'admin_run', arguments: { command: 'whoami', confirm: true } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /disabled in this server's config/);
    }, { configPath });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the admin feature flag is on by default and visible in the policy', async () => {
  const config = loadConfig({ overrides: { auditLogPath: null } });
  assert.equal(config.features.admin, true);
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'server_policy', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).features.admin, true);
  });
});
