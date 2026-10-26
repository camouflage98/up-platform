import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError, truncateOutput } from './guard.js';
import { encodePowerShellCommand, resolvePowerShell, runPowerShell } from './exec.js';
import { psQuote } from './tools/helpers.js';

/**
 * Start-Process cannot both elevate and redirect: -Verb RunAs needs
 * ShellExecute, and -RedirectStandardOutput needs the opposite. So the elevated
 * child redirects its own streams to files that the unelevated parent reads
 * back once it exits. That is also why output arrives as one combined stream
 * rather than separate stdout and stderr.
 */
export function buildElevationScripts({ command, shellPath, outFile, codeFile }) {
  const inner = [
    "$ProgressPreference='SilentlyContinue';",
    '$ErrorActionPreference=\'Continue\';',
    'try {',
    `  & { ${command} } *> ${psQuote(outFile)};`,
    '  $code = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 };',
    '} catch {',
    `  $_ | Out-String | Add-Content -LiteralPath ${psQuote(outFile)};`,
    '  $code = 1;',
    '}',
    `Set-Content -LiteralPath ${psQuote(codeFile)} -Value $code;`
  ].join('\n');

  const launcher = [
    '$ErrorActionPreference=\'Stop\';',
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(shellPath)} -ArgumentList @(`,
    `    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${psQuote(encodePowerShellCommand(inner))}`,
    '  ) -Verb RunAs -WindowStyle Hidden -PassThru -Wait;',
    '  "elevated process " + $p.Id + " exited";',
    '} catch {',
    // Declining the UAC prompt surfaces as Win32 error 1223, which deserves its
    // own message: nothing went wrong, the user said no.
    '  if ($_.Exception.Message -match \'canceled by the user\' -or $_.Exception.NativeErrorCode -eq 1223) {',
    '    "UAC_DECLINED";',
    '  } else {',
    '    "ELEVATION_FAILED: " + $_.Exception.Message;',
    '  }',
    '}'
  ].join('\n');

  return { inner, launcher };
}

/**
 * Runs a command with administrator rights.
 *
 * When the server itself is already elevated the command runs in-process with
 * no prompt. Otherwise it goes through a UAC prompt that only the person at the
 * keyboard can accept.
 */
export async function runElevated(config, command, { timeoutMs = 300_000, alreadyElevated } = {}) {
  const elevated = alreadyElevated ?? (await isServerElevated(config));
  if (elevated) {
    const result = await runPowerShell(config, command, { timeoutMs });
    return {
      mode: 'inherited',
      note: 'The server process is already elevated, so this ran as administrator with no UAC prompt.',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: truncateOutput(`${result.stdout}${result.stderr}`.trim(), config.maxOutputBytes)
    };
  }

  const stem = path.join(os.tmpdir(), `windows-mcp-elevated-${randomUUID().slice(0, 8)}`);
  const outFile = `${stem}.out.txt`;
  const codeFile = `${stem}.code.txt`;
  fs.writeFileSync(outFile, '');

  const { launcher } = buildElevationScripts({
    command,
    shellPath: resolvePowerShell(config),
    outFile,
    codeFile
  });

  try {
    const result = await runPowerShell(config, launcher, { timeoutMs });
    const launcherOutput = `${result.stdout}${result.stderr}`.trim();

    if (launcherOutput.includes('UAC_DECLINED')) {
      throw new ToolError('The UAC prompt was declined, so nothing ran.', {
        code: 'uac_declined',
        hint: 'Ask the user to accept the Windows prompt, or run the command yourself.'
      });
    }
    if (launcherOutput.includes('ELEVATION_FAILED')) {
      throw new ToolError(`Elevation failed: ${launcherOutput}`, { code: 'elevation_failed' });
    }
    if (result.timedOut) {
      return {
        mode: 'uac',
        exitCode: null,
        timedOut: true,
        note:
          'The wait timed out. The elevated process may still be running, and an unelevated server cannot stop it. ' +
          'Check on the machine before retrying.',
        output: truncateOutput(readIfPresent(outFile), config.maxOutputBytes)
      };
    }

    const code = readIfPresent(codeFile).trim();
    return {
      mode: 'uac',
      exitCode: code === '' ? null : Number.parseInt(code, 10),
      timedOut: false,
      note: 'Ran through a UAC prompt. Output is stdout and stderr combined, as the elevated child redirected both.',
      output: truncateOutput(readIfPresent(outFile), config.maxOutputBytes)
    };
  } finally {
    for (const file of [outFile, codeFile]) fs.rmSync(file, { force: true });
  }
}

/** True when the server's own process holds the Administrators role. */
export async function isServerElevated(config) {
  const result = await runPowerShell(
    config,
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    { timeoutMs: 20_000 }
  );
  return result.stdout.trim().toLowerCase() === 'true';
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
