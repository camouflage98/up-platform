import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { assertFeature, assertWindows, clampTimeout, resolvePath, ToolError } from '../guard.js';
import { runPowerShell, runPowerShellJson } from '../exec.js';
import { defineTool, formatRun, psQuote, textResult } from './helpers.js';

export function registerSystemTools(server, ctx) {
  const { config } = ctx;

  defineTool(
    server,
    ctx,
    'system_info',
    {
      title: 'Describe the machine',
      description: 'Report Windows version and build, CPU, memory, uptime, logged-in user and free space per drive.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      assertWindows();
      assertFeature(config, 'system');
      const script = [
        '$os = Get-CimInstance Win32_OperatingSystem;',
        '$cs = Get-CimInstance Win32_ComputerSystem;',
        '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1;',
        '$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |',
        "  ForEach-Object { [PSCustomObject]@{ drive = $_.DeviceID; freeGB = [math]::Round($_.FreeSpace/1GB,1); totalGB = [math]::Round($_.Size/1GB,1) } };",
        '[PSCustomObject]@{',
        '  computerName = $cs.Name;',
        '  user = $cs.UserName;',
        '  windows = $os.Caption;',
        '  build = $os.BuildNumber;',
        '  architecture = $os.OSArchitecture;',
        '  cpu = $cpu.Name;',
        '  cores = $cpu.NumberOfCores;',
        '  memoryGB = [math]::Round($cs.TotalPhysicalMemory/1GB,1);',
        '  freeMemoryGB = [math]::Round($os.FreePhysicalMemory/1MB,1);',
        '  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1);',
        '  powershell = $PSVersionTable.PSVersion.ToString();',
        '  elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);',
        '  disks = $disks',
        '}'
      ].join(' ');
      const info = await runPowerShellJson(config, script, { timeoutMs: clampTimeout(config, 60_000) });
      return textResult(info[0] ?? {});
    }
  );

  defineTool(
    server,
    ctx,
    'clipboard_read',
    {
      title: 'Read the clipboard',
      description: 'Read the text currently on the Windows clipboard.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      assertWindows();
      assertFeature(config, 'system');
      const result = await runPowerShell(config, 'Get-Clipboard -Raw', { timeoutMs: clampTimeout(config, 20_000) });
      return textResult(result.stdout.trim() === '' ? '(clipboard is empty or holds non-text data)' : result.stdout);
    }
  );

  defineTool(
    server,
    ctx,
    'clipboard_write',
    {
      title: 'Set the clipboard',
      description: 'Put text on the Windows clipboard, ready for the user to paste.',
      inputSchema: { text: z.string() },
      annotations: {}
    },
    async ({ text }) => {
      assertWindows();
      assertFeature(config, 'system');
      const result = await runPowerShell(config, `Set-Clipboard -Value ${psQuote(text)}`, { timeoutMs: clampTimeout(config, 20_000) });
      if (result.exitCode !== 0) return textResult(formatRun(result, { maxBytes: config.maxOutputBytes }));
      return textResult(`Copied ${text.length} characters to the clipboard.`);
    }
  );

  defineTool(
    server,
    ctx,
    'screenshot',
    {
      title: 'Take a screenshot',
      description:
        'Capture the screen to a PNG and return the image. Only works when the server runs in the user\'s interactive desktop session, ' +
        'not as a service or over a disconnected remote session.',
      inputSchema: {
        destination: z.string().optional().describe('Where to save the PNG. Defaults to a temp file.'),
        inline: z.boolean().optional().describe('Return the image itself as well as the path. Defaults to true.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ destination, inline = true }) => {
      assertWindows();
      assertFeature(config, 'system');
      const target = destination
        ? resolvePath(config, destination, { forWrite: true })
        : path.join(os.tmpdir(), `windows-mcp-screenshot-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });

      const script = [
        "Add-Type -AssemblyName System.Windows.Forms, System.Drawing;",
        '$area = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
        '$bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height;',
        '$graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
        '$graphics.CopyFromScreen($area.Location, [System.Drawing.Point]::Empty, $area.Size);',
        `$bitmap.Save(${psQuote(target)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
        '$graphics.Dispose(); $bitmap.Dispose();',
        `"saved " + ${psQuote(target)}`
      ].join(' ');

      const result = await runPowerShell(config, script, { timeoutMs: clampTimeout(config, 60_000) });
      if (!fs.existsSync(target)) {
        throw new ToolError(`Screenshot failed.\n${formatRun(result, { maxBytes: config.maxOutputBytes })}`, { code: 'screenshot_failed' });
      }
      const stat = fs.statSync(target);
      const content = [{ type: 'text', text: JSON.stringify({ path: target, bytes: stat.size }, null, 2) }];
      if (inline && stat.size <= 4 * 1024 * 1024) {
        content.push({ type: 'image', data: fs.readFileSync(target).toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    }
  );

  defineTool(
    server,
    ctx,
    'server_policy',
    {
      title: 'Show this server\'s policy',
      description:
        'Report what this server is allowed to do: config file in use, allowed folders, download folder, enabled features, ' +
        'timeouts and where the audit log is. Read this when a call is refused and you want to know why.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      textResult({
        configSource: config.configSource,
        platform: process.platform,
        allowedRoots: config.unrestrictedPaths ? 'unrestricted' : config.allowedRoots,
        downloadDir: config.downloadDir,
        writeEnabled: config.writeEnabled,
        features: config.features,
        packageManagers: config.packageManagers,
        allowedDownloadHosts: config.allowedDownloadHosts.length === 0 ? 'any HTTPS host' : config.allowedDownloadHosts,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        maxTerminals: config.maxTerminals,
        auditLogPath: config.auditLogPath,
        blockedCommandPatterns: config.blockedCommandPatterns,
        confirmCommandPatterns: config.confirmCommandPatterns
      })
  );
}
