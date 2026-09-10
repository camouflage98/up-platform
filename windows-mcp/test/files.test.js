import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

async function withSandbox(run) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-mcp-files-'));
  const configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ allowedRoots: [workDir], auditLogPath: null }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, WINDOWS_MCP_CONFIG: configPath }
  });
  const client = new Client({ name: 'windows-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content[0].text };
  };
  try {
    await run({ call, workDir });
  } finally {
    await client.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test('write, list, read and search round-trip', async () => {
  await withSandbox(async ({ call, workDir }) => {
    const target = path.join(workDir, 'notes', 'todo.txt');
    const written = await call('file_write', { path: target, content: 'buy milk' });
    assert.equal(written.isError, false, written.text);

    const listed = await call('file_list', { path: path.join(workDir, 'notes') });
    assert.match(listed.text, /todo\.txt/);

    const read = await call('file_read', { path: target });
    assert.match(read.text, /buy milk/);

    const found = await call('file_search', { root: workDir, pattern: '*.txt' });
    assert.match(found.text, /todo\.txt/);
  });
});

test('an existing file is not overwritten by accident', async () => {
  await withSandbox(async ({ call, workDir }) => {
    const target = path.join(workDir, 'keep.txt');
    await call('file_write', { path: target, content: 'original' });
    const refused = await call('file_write', { path: target, content: 'replacement' });
    assert.equal(refused.isError, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    const allowed = await call('file_write', { path: target, content: 'replacement', overwrite: true });
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
  });
});

test('appending adds to the end of the file', async () => {
  await withSandbox(async ({ call, workDir }) => {
    const target = path.join(workDir, 'log.txt');
    await call('file_write', { path: target, content: 'one\n' });
    await call('file_write', { path: target, content: 'two\n', mode: 'append' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'one\ntwo\n');
  });
});

test('deleting needs confirmation, and a folder needs recursive', async () => {
  await withSandbox(async ({ call, workDir }) => {
    const file = path.join(workDir, 'gone.txt');
    fs.writeFileSync(file, 'x');
    const unconfirmed = await call('file_delete', { path: file });
    assert.equal(unconfirmed.isError, true);
    assert.ok(fs.existsSync(file));

    const confirmed = await call('file_delete', { path: file, confirm: true });
    assert.equal(confirmed.isError, false, confirmed.text);
    assert.equal(fs.existsSync(file), false);

    const dir = path.join(workDir, 'tree');
    fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
    const shallow = await call('file_delete', { path: dir, confirm: true });
    assert.equal(shallow.isError, true);
    assert.match(shallow.text, /recursive/);
    assert.ok(fs.existsSync(dir));
  });
});

test('moving and copying keep the caller inside the allowed roots', async () => {
  await withSandbox(async ({ call, workDir }) => {
    const source = path.join(workDir, 'a.txt');
    fs.writeFileSync(source, 'content');

    const copied = await call('file_move', { source, destination: path.join(workDir, 'b.txt'), copy: true });
    assert.equal(copied.isError, false, copied.text);
    assert.ok(fs.existsSync(source) && fs.existsSync(path.join(workDir, 'b.txt')));

    const moved = await call('file_move', { source, destination: path.join(workDir, 'c.txt') });
    assert.equal(moved.isError, false, moved.text);
    assert.equal(fs.existsSync(source), false);

    const escaped = await call('file_move', { source: path.join(workDir, 'c.txt'), destination: '/tmp/escape.txt' });
    assert.equal(escaped.isError, true);
    assert.match(escaped.text, /allowed roots/);
  });
});

test('an unknown terminal id is reported, not crashed on', async () => {
  await withSandbox(async ({ call }) => {
    const result = await call('terminal_read', { terminalId: 'term_nope' });
    assert.equal(result.isError, true);
    assert.match(result.text, /No terminal with id/);
  });
});
