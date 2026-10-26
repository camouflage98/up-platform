#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { TerminalManager } from './terminals.js';
import { registerShellTools } from './tools/shell.js';
import { registerAppTools } from './tools/apps.js';
import { registerFileTools } from './tools/files.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerSystemTools } from './tools/system.js';
import { registerAdminTools } from './tools/admin.js';

const INSTRUCTIONS = `This server drives a real Windows machine that belongs to the user.

What it can do: run PowerShell and cmd commands, keep persistent interactive terminals,
launch and close applications, focus windows, read and write files, download files from the
web, and install packages through winget, Chocolatey or Scoop.

How to work with it:
- Prefer the specific tool over a raw shell command. app_open, download_file and file_read
  report structured results and are checked against the server's policy.
- powershell_run is non-interactive. Anything that prompts, or anything where state has to
  survive between commands, belongs in a terminal: terminal_open, then terminal_run, and
  terminal_send_input to answer a prompt.
- Some actions require confirm: true. That is the user's decision, not yours. Show them the
  exact command or package first, get an answer, then repeat the call with confirm: true.
- A refusal names the policy that caused it. server_policy shows the whole policy, including
  which folders are reachable and which commands are blocked outright.
- Administrator rights are not automatic. admin_status says what is possible on this machine;
  admin_run runs a single command as administrator. If the server was not started elevated, that
  raises a UAC prompt only the person at the keyboard can accept, and the call waits for them.
- Installing software and elevated launches may still raise a UAC prompt that only the person
  at the keyboard can accept.`;

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  const ctx = { config, terminals: new TerminalManager(config), registeredTools: [] };

  const server = new McpServer(
    { name: 'windows-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  registerShellTools(server, ctx);
  registerAppTools(server, ctx);
  registerFileTools(server, ctx);
  registerDownloadTools(server, ctx);
  registerSystemTools(server, ctx);
  registerAdminTools(server, ctx);

  if (args.includes('--doctor')) {
    await doctor(config, ctx);
    ctx.terminals.closeAll();
    return;
  }

  const shutdown = () => {
    ctx.terminals.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(`windows-mcp ready (config: ${config.configSource})\n`);
}

/** Prints a human-readable readiness report; run it before wiring the server into a client. */
async function doctor(config, ctx) {
  const lines = [];
  lines.push(`platform:        ${process.platform} (${process.arch})`);
  lines.push(`node:            ${process.version}`);
  lines.push(`config source:   ${config.configSource}`);
  lines.push(`allowed roots:   ${config.unrestrictedPaths ? 'unrestricted' : config.allowedRoots.join(', ')}`);
  lines.push(`download folder: ${config.downloadDir}`);
  lines.push(`audit log:       ${config.auditLogPath ?? 'disabled'}`);
  lines.push(`features:        ${Object.entries(config.features).filter(([, on]) => on).map(([name]) => name).join(', ')}`);

  if (process.platform !== 'win32') {
    lines.push('');
    lines.push('This is not Windows, so the tools that touch the OS will refuse to run.');
    lines.push('Install and start this server on the Windows machine you want to control.');
  } else {
    const { resolvePowerShell, runPowerShell } = await import('./exec.js');
    try {
      const shell = resolvePowerShell(config);
      const probe = await runPowerShell(config, '$PSVersionTable.PSVersion.ToString()', { timeoutMs: 20_000 });
      lines.push(`powershell:      ${shell} (${probe.stdout.trim()})`);
    } catch (error) {
      lines.push(`powershell:      NOT FOUND (${error.message})`);
    }
    for (const name of config.packageManagers) {
      const probe = await runPowerShell(
        config,
        `Get-Command ${name} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source`,
        { timeoutMs: 20_000 }
      );
      lines.push(`${`${name}:`.padEnd(16)} ${probe.stdout.trim() || 'not installed'}`);
    }
  }

  // A download folder outside the allowed roots means every download is refused.
  try {
    const { resolvePath } = await import('./guard.js');
    resolvePath(config, config.downloadDir, { forWrite: true });
  } catch (error) {
    lines.push('');
    lines.push(`WARNING: downloads will be refused. ${error.message}`);
  }

  lines.push('');
  lines.push(`${ctx.registeredTools.length} tools registered:`);
  lines.push(`  ${ctx.registeredTools.join(', ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`windows-mcp failed to start: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
