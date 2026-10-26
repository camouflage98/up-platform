import { z } from 'zod';
import { assertCommandAllowed, assertFeature, assertWindows, clampTimeout, ToolError } from '../guard.js';
import { runPowerShellJson } from '../exec.js';
import { isServerElevated, runElevated } from '../elevate.js';
import { defineTool, textResult } from './helpers.js';

const PROMPT_BEHAVIOR = {
  0: 'elevate silently, with no prompt (UAC effectively off for admins)',
  1: 'prompt for credentials on the secure desktop',
  2: 'prompt for consent on the secure desktop',
  3: 'prompt for credentials',
  4: 'prompt for consent',
  5: 'prompt for consent for non-Windows binaries (the Windows default)'
};

export function registerAdminTools(server, ctx) {
  const { config } = ctx;

  defineTool(
    server,
    ctx,
    'admin_status',
    {
      title: 'Check what administrator rights are available',
      description:
        'Report whether this server is already running elevated, whether the signed-in account could elevate at all, and how ' +
        'UAC is configured. Call this before promising the user an action that needs administrator rights.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      assertWindows();
      assertFeature(config, 'admin');
      const script = [
        '$id = [Security.Principal.WindowsIdentity]::GetCurrent();',
        '$principal = [Security.Principal.WindowsPrincipal]$id;',
        "$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');",
        "$policy = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue;",
        '[PSCustomObject]@{',
        '  user = $id.Name;',
        '  serverProcessElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);',
        '  accountCanElevate = [bool]($id.Groups | Where-Object { $_ -eq $adminSid });',
        '  uacEnabled = [bool]$policy.EnableLUA;',
        '  consentPromptBehaviorAdmin = $policy.ConsentPromptBehaviorAdmin;',
        '  secureDesktopPrompt = [bool]$policy.PromptOnSecureDesktop',
        '}'
      ].join(' ');

      const rows = await runPowerShellJson(config, script, { timeoutMs: clampTimeout(config, 30_000) });
      const status = rows[0] ?? {};
      return textResult({
        ...status,
        promptBehaviorMeaning: PROMPT_BEHAVIOR[status.consentPromptBehaviorAdmin] ?? 'unknown',
        whatThisMeans: describe(status)
      });
    }
  );

  defineTool(
    server,
    ctx,
    'admin_run',
    {
      title: 'Run a command as administrator',
      description:
        'Run a PowerShell command with administrator rights and return its combined output and exit code. ' +
        'If the server itself was started elevated this runs with no prompt; otherwise it raises a UAC prompt that only the ' +
        'person at the keyboard can accept, and the call waits for them. Blocked commands stay blocked even here. ' +
        'Needs confirm: true, and the user should see the exact command first.',
      inputSchema: {
        command: z.string().describe('PowerShell command to run as administrator.'),
        timeoutMs: z.number().int().optional().describe('How long to wait, including the time the user spends at the UAC prompt.'),
        confirm: z.boolean().optional()
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ command, timeoutMs, confirm }) => {
      assertFeature(config, 'admin');
      assertCommandAllowed(config, command, confirm);
      if (!confirm) {
        throw new ToolError('Running as administrator needs confirm: true. Show the user the exact command and ask first.', {
          code: 'confirmation_required'
        });
      }
      assertWindows();
      const result = await runElevated(config, command, { timeoutMs: clampTimeout(config, timeoutMs ?? 300_000) });
      return textResult(result);
    }
  );
}

function describe({ serverProcessElevated, accountCanElevate, uacEnabled, consentPromptBehaviorAdmin }) {
  if (serverProcessElevated) {
    return 'The server is already elevated, so every tool call runs as administrator with no prompt. Nothing here is sandboxed.';
  }
  if (!accountCanElevate) {
    return 'This account is not an administrator, so nothing can be elevated. Administrator actions need a different account.';
  }
  if (uacEnabled === false || consentPromptBehaviorAdmin === 0) {
    return 'The account can elevate and UAC will not prompt, so admin_run will succeed unattended. That is a weak configuration.';
  }
  return 'The account can elevate, and admin_run will raise a UAC prompt the user has to accept in person.';
}
