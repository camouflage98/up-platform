import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

async function withClient(run) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: 'windows-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

test('the server starts and advertises its tools', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ['powershell_run', 'terminal_open', 'app_open', 'download_file', 'package_install', 'file_read', 'server_policy']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    const powershell = tools.find((tool) => tool.name === 'powershell_run');
    assert.ok(powershell.description.length > 0);
    assert.ok(powershell.inputSchema.properties.command);
  });
});

test('server_policy reports what the server may do', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'server_policy', arguments: {} });
    const policy = JSON.parse(result.content[0].text);
    assert.equal(policy.platform, process.platform);
    assert.ok(policy.features.shell);
    assert.ok(Array.isArray(policy.blockedCommandPatterns));
  });
});

test('a blocked command is refused with an explanation, not a crash', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'powershell_run',
      arguments: { command: 'Format-Volume -DriveLetter C', confirm: true }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /blocked pattern/);
  });
});

test('a command needing confirmation says so before running', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'powershell_run',
      arguments: { command: 'Remove-Item C:\\temp\\build -Recurse' }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /confirm: true/);
  });
});

test('off-Windows the OS tools refuse instead of pretending', { skip: process.platform === 'win32' }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'system_info', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Windows/);
  });
});

test('reading a file outside the allowed roots is refused', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'file_read', arguments: { path: '/etc/hostname' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /allowed roots|denied path|not found/i);
  });
});
