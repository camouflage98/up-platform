import { z } from 'zod';
import { assertFeature, assertWindows, clampTimeout, ToolError } from '../guard.js';
import { runPowerShell, runPowerShellJson } from '../exec.js';
import { defineTool, formatRun, psQuote, textResult } from './helpers.js';

const UNINSTALL_KEYS = [
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
];

export function registerAppTools(server, ctx) {
  const { config } = ctx;

  defineTool(
    server,
    ctx,
    'app_open',
    {
      title: 'Open an application',
      description:
        'Launch an application, document, folder or URI on the Windows machine. Accepts an executable name on PATH ("notepad", "code"), ' +
        'a full path to an .exe or a file, a shell URI ("ms-settings:display"), or a URL to open in the default browser. ' +
        'Returns the new process id when there is one. Use app_find first if you are unsure what the app is called.',
      inputSchema: {
        app: z.string().describe('Executable name, full path, document, folder, URI or URL to open.'),
        args: z.array(z.string()).optional().describe('Arguments to pass to the application.'),
        cwd: z.string().optional().describe('Working directory for the new process.'),
        windowStyle: z.enum(['Normal', 'Minimized', 'Maximized', 'Hidden']).optional(),
        wait: z.boolean().optional().describe('Wait for the app to exit and return its exit code. Only for short-lived tools.'),
        elevated: z.boolean().optional().describe('Launch as administrator. Triggers a UAC prompt the user must accept in person.'),
        timeoutMs: z.number().int().optional(),
        confirm: z.boolean().optional().describe('Required when elevated is true.')
      },
      annotations: { openWorldHint: true }
    },
    async ({ app, args = [], cwd, windowStyle, wait, elevated, timeoutMs, confirm }) => {
      assertWindows();
      assertFeature(config, 'apps');
      if (elevated && !confirm) {
        throw new ToolError('Launching elevated needs confirm: true, and the user has to accept the UAC prompt themselves.', {
          code: 'confirmation_required'
        });
      }

      const parts = [`Start-Process -FilePath ${psQuote(app)}`];
      if (args.length > 0) parts.push(`-ArgumentList @(${args.map(psQuote).join(',')})`);
      if (cwd) parts.push(`-WorkingDirectory ${psQuote(cwd)}`);
      if (windowStyle) parts.push(`-WindowStyle ${windowStyle}`);
      if (elevated) parts.push('-Verb RunAs');
      if (wait) parts.push('-Wait');
      // -PassThru fails for shell verbs and URIs, so fall back to a plain launch.
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `try { $p = ${parts.join(' ')} -PassThru; if ($p) { "started pid=" + $p.Id + " name=" + $p.ProcessName } else { "started" } } ` +
        `catch { ${parts.join(' ')}; "started (no process handle: shell handler or URI)" }`;

      const result = await runPowerShell(config, script, { timeoutMs: clampTimeout(config, timeoutMs ?? (wait ? 120_000 : 20_000)) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes, label: 'launch' }));
    }
  );

  defineTool(
    server,
    ctx,
    'app_find',
    {
      title: 'Find an installed app by name',
      description:
        'Search the Start Menu and the registry App Paths for something the user named loosely ("spotify", "vs code") and return ' +
        'launchable targets. Use this to turn a request like "open my editor" into an exact path for app_open.',
      inputSchema: {
        query: z.string().describe('Part of the app name.'),
        limit: z.number().int().optional().describe('Maximum results. Defaults to 20.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit = 20 }) => {
      assertWindows();
      assertFeature(config, 'apps');
      const q = psQuote(`*${query}*`);
      const script = [
        '$results = @();',
        "$menus = @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu'));",
        '$results += Get-ChildItem -Path $menus -Recurse -Include *.lnk,*.url -ErrorAction SilentlyContinue |',
        `  Where-Object { $_.BaseName -like ${q} } |`,
        "  Select-Object -First 50 @{n='name';e={$_.BaseName}}, @{n='target';e={$_.FullName}}, @{n='source';e={'start-menu'}};",
        "$results += Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' -ErrorAction SilentlyContinue |",
        `  Where-Object { $_.PSChildName -like ${q} } |`,
        "  Select-Object @{n='name';e={$_.PSChildName}}, @{n='target';e={(Get-ItemProperty $_.PSPath).'(default)'}}, @{n='source';e={'app-paths'}};",
        `$results | Select-Object -First ${Math.max(1, Math.min(limit, 100))}`
      ].join(' ');
      const found = await runPowerShellJson(config, script, { timeoutMs: clampTimeout(config, 60_000) });
      return textResult(found.length === 0 ? `No installed app matched "${query}".` : found);
    }
  );

  defineTool(
    server,
    ctx,
    'app_list_installed',
    {
      title: 'List installed programs',
      description: 'List programs from the Windows uninstall registry, optionally filtered by name. Useful before installing something that may already be there.',
      inputSchema: {
        filter: z.string().optional().describe('Substring of the program name.'),
        limit: z.number().int().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ filter, limit = 100 }) => {
      assertWindows();
      assertFeature(config, 'apps');
      const where = filter ? `| Where-Object { $_.DisplayName -like ${psQuote(`*${filter}*`)} }` : '';
      const script =
        `Get-ItemProperty ${UNINSTALL_KEYS.map((k) => `'${k}'`).join(',')} -ErrorAction SilentlyContinue ` +
        '| Where-Object { $_.DisplayName } ' +
        `${where} ` +
        "| Select-Object @{n='name';e={$_.DisplayName}}, @{n='version';e={$_.DisplayVersion}}, @{n='publisher';e={$_.Publisher}}, @{n='location';e={$_.InstallLocation}} " +
        `| Sort-Object name -Unique | Select-Object -First ${Math.max(1, Math.min(limit, 500))}`;
      const apps = await runPowerShellJson(config, script, { timeoutMs: clampTimeout(config, 90_000) });
      return textResult(apps.length === 0 ? 'No matching installed programs.' : apps);
    }
  );

  defineTool(
    server,
    ctx,
    'process_list',
    {
      title: 'List running processes',
      description: 'List running processes with pid, memory and window title, optionally filtered by name. Sorted by memory use.',
      inputSchema: {
        filter: z.string().optional(),
        limit: z.number().int().optional(),
        windowsOnly: z.boolean().optional().describe('Only processes that own a visible window.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ filter, limit = 30, windowsOnly }) => {
      assertWindows();
      assertFeature(config, 'apps');
      const clauses = [];
      if (filter) clauses.push(`$_.ProcessName -like ${psQuote(`*${filter}*`)}`);
      if (windowsOnly) clauses.push('$_.MainWindowTitle');
      const where = clauses.length > 0 ? `| Where-Object { ${clauses.join(' -and ')} }` : '';
      const script =
        `Get-Process ${where} | Sort-Object WorkingSet64 -Descending | Select-Object -First ${Math.max(1, Math.min(limit, 200))} ` +
        "@{n='pid';e={$_.Id}}, @{n='name';e={$_.ProcessName}}, @{n='memoryMB';e={[math]::Round($_.WorkingSet64/1MB,1)}}, @{n='windowTitle';e={$_.MainWindowTitle}}";
      const processes = await runPowerShellJson(config, script, { timeoutMs: clampTimeout(config, 45_000) });
      return textResult(processes.length === 0 ? 'No matching processes.' : processes);
    }
  );

  defineTool(
    server,
    ctx,
    'process_stop',
    {
      title: 'Close a running program',
      description:
        'Close a program by pid or by name. Asks the window to close first and only forces it if force is set. ' +
        'Needs confirm: true, because unsaved work in that app is lost.',
      inputSchema: {
        pid: z.number().int().optional(),
        name: z.string().optional().describe('Process name without .exe. Stops every match.'),
        force: z.boolean().optional().describe('Kill the process instead of asking it to close.'),
        confirm: z.boolean().optional()
      },
      annotations: { destructiveHint: true }
    },
    async ({ pid, name, force, confirm }) => {
      assertWindows();
      assertFeature(config, 'apps');
      if (!pid && !name) throw new ToolError('Give either a pid or a process name.');
      if (!confirm) {
        throw new ToolError('Closing a program needs confirm: true, since anything unsaved in it is lost.', {
          code: 'confirmation_required'
        });
      }
      const selector = pid ? `Get-Process -Id ${pid} -ErrorAction Stop` : `Get-Process -Name ${psQuote(name)} -ErrorAction Stop`;
      const script = force
        ? `${selector} | Stop-Process -Force -PassThru | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String`
        : `$targets = ${selector}; foreach ($t in $targets) { if ($t.MainWindowHandle -ne 0) { [void]$t.CloseMainWindow(); "asked " + $t.ProcessName + " (" + $t.Id + ") to close" } else { Stop-Process -Id $t.Id; "stopped " + $t.ProcessName + " (" + $t.Id + ")" } }`;
      const result = await runPowerShell(config, script, { timeoutMs: clampTimeout(config, 30_000) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes }));
    }
  );

  defineTool(
    server,
    ctx,
    'window_focus',
    {
      title: 'Bring a window to the front',
      description: 'Restore and focus the main window of a process, by pid or by a substring of its window title.',
      inputSchema: {
        pid: z.number().int().optional(),
        titleContains: z.string().optional()
      },
      annotations: { openWorldHint: true }
    },
    async ({ pid, titleContains }) => {
      assertWindows();
      assertFeature(config, 'apps');
      if (!pid && !titleContains) throw new ToolError('Give either a pid or part of the window title.');
      const selector = pid
        ? `Get-Process -Id ${pid} -ErrorAction Stop`
        : `Get-Process | Where-Object { $_.MainWindowTitle -like ${psQuote(`*${titleContains}*`)} } | Select-Object -First 1`;
      const script = [
        'Add-Type -Namespace Win -Name Api -MemberDefinition @"',
        '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '"@;',
        `$p = ${selector};`,
        'if (-not $p) { "no matching window" } else { [void][Win.Api]::ShowWindow($p.MainWindowHandle, 9); [void][Win.Api]::SetForegroundWindow($p.MainWindowHandle); "focused " + $p.ProcessName + " (" + $p.Id + "): " + $p.MainWindowTitle }'
      ].join('\n');
      const result = await runPowerShell(config, script, { timeoutMs: clampTimeout(config, 30_000) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes }));
    }
  );
}
