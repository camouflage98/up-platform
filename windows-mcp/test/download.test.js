import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const PAYLOAD = 'windows-mcp download test payload\n'.repeat(64);
const PAYLOAD_SHA256 = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

async function withFixture(run) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-mcp-test-'));
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/payload.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(PAYLOAD) });
      res.end(PAYLOAD);
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      allowedRoots: [workDir],
      downloadDir: path.join(workDir, 'downloads'),
      allowInsecureDownloads: true,
      auditLogPath: path.join(workDir, 'audit.jsonl')
    })
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, WINDOWS_MCP_CONFIG: configPath }
  });
  const client = new Client({ name: 'windows-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await run({ client, baseUrl, workDir });
  } finally {
    await client.close();
    httpServer.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test('a download lands in the download folder with a reported hash', async () => {
  await withFixture(async ({ client, baseUrl, workDir }) => {
    const result = await client.callTool({ name: 'download_file', arguments: { url: `${baseUrl}/payload.txt` } });
    assert.notEqual(result.isError, true, result.content[0].text);
    const info = JSON.parse(result.content[0].text);
    assert.equal(info.sha256, PAYLOAD_SHA256);
    assert.equal(info.bytes, Buffer.byteLength(PAYLOAD));
    assert.equal(info.path, path.join(workDir, 'downloads', 'payload.txt'));
    assert.equal(fs.readFileSync(info.path, 'utf8'), PAYLOAD);
  });
});

test('a hash mismatch deletes the file instead of leaving it behind', async () => {
  await withFixture(async ({ client, baseUrl, workDir }) => {
    const result = await client.callTool({
      name: 'download_file',
      arguments: { url: `${baseUrl}/payload.txt`, expectedSha256: 'f'.repeat(64) }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Hash mismatch/);
    assert.equal(fs.existsSync(path.join(workDir, 'downloads', 'payload.txt')), false);
  });
});

test('an existing file is not overwritten unless asked', async () => {
  await withFixture(async ({ client, baseUrl, workDir }) => {
    const target = path.join(workDir, 'saved.txt');
    fs.writeFileSync(target, 'keep me');
    const refused = await client.callTool({
      name: 'download_file',
      arguments: { url: `${baseUrl}/payload.txt`, destination: target }
    });
    assert.equal(refused.isError, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');

    const allowed = await client.callTool({
      name: 'download_file',
      arguments: { url: `${baseUrl}/payload.txt`, destination: target, overwrite: true }
    });
    assert.notEqual(allowed.isError, true, allowed.content[0].text);
    assert.equal(fs.readFileSync(target, 'utf8'), PAYLOAD);
  });
});

test('a download outside the allowed roots is refused', async () => {
  await withFixture(async ({ client, baseUrl }) => {
    const result = await client.callTool({
      name: 'download_file',
      arguments: { url: `${baseUrl}/payload.txt`, destination: '/etc/windows-mcp-should-not-exist.txt' }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /allowed roots/);
    assert.equal(fs.existsSync('/etc/windows-mcp-should-not-exist.txt'), false);
  });
});

test('a plain HTTP download is refused when the config does not allow it', async () => {
  await withFixture(async ({ client, baseUrl, workDir }) => {
    const configPath = path.join(workDir, 'strict.json');
    fs.writeFileSync(configPath, JSON.stringify({ allowedRoots: [workDir], allowInsecureDownloads: false }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, WINDOWS_MCP_CONFIG: configPath }
    });
    const strictClient = new Client({ name: 'windows-mcp-test', version: '0.0.0' });
    await strictClient.connect(transport);
    try {
      const result = await strictClient.callTool({ name: 'download_file', arguments: { url: `${baseUrl}/payload.txt` } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /HTTPS/);
    } finally {
      await strictClient.close();
    }
  });
});

test('the audit log records every call', async () => {
  await withFixture(async ({ client, baseUrl, workDir }) => {
    await client.callTool({ name: 'download_file', arguments: { url: `${baseUrl}/payload.txt` } });
    const lines = fs.readFileSync(path.join(workDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.tool === 'download_file');
    assert.ok(entry, 'no audit entry for download_file');
    assert.equal(entry.ok, true);
    assert.ok(entry.ts);
  });
});

test('a redirect to a host outside the allowlist is refused', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-mcp-redirect-'));
  const elsewhere = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('payload from somewhere else');
  });
  await new Promise((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${elsewhere.address().port}/payload.txt` });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));

  const configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      allowedRoots: [workDir],
      downloadDir: workDir,
      allowInsecureDownloads: true,
      allowedDownloadHosts: ['127.0.0.1'],
      auditLogPath: null
    })
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, WINDOWS_MCP_CONFIG: configPath }
  });
  const client = new Client({ name: 'windows-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'download_file',
      arguments: { url: `http://127.0.0.1:${redirector.address().port}/start` }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /redirected to localhost/);
  } finally {
    await client.close();
    redirector.close();
    elsewhere.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
