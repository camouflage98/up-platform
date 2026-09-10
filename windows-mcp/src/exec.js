import { spawn, spawnSync } from 'node:child_process';
import { ToolError } from './guard.js';

let cachedShell = null;

/** Finds the PowerShell to drive: an explicit path, then pwsh 7, then Windows PowerShell. */
export function resolvePowerShell(config) {
  if (config.powershellPath) return config.powershellPath;
  if (cachedShell) return cachedShell;
  const candidates = config.preferPwsh === false ? ['powershell.exe', 'pwsh.exe'] : ['pwsh.exe', 'powershell.exe'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    });
    if (!probe.error && probe.status === 0) {
      cachedShell = candidate;
      return cachedShell;
    }
  }
  throw new ToolError('No PowerShell executable found (tried pwsh.exe and powershell.exe).', {
    code: 'no_powershell',
    hint: 'Set "powershellPath" in the config to the full path of your PowerShell binary.'
  });
}

/** UTF-16LE base64, which is what -EncodedCommand expects and sidesteps all quoting. */
export function encodePowerShellCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

/**
 * Runs a child process to completion, capturing output and enforcing a timeout.
 * Never rejects on a non-zero exit: the caller reports the code to the model.
 */
export function runProcess(file, args, { cwd, timeoutMs = 60_000, env, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(new ToolError(`Failed to start ${file}: ${error.message}`, { code: 'spawn_failed' }));
      return;
    }

    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ToolError(`Failed to run ${file}: ${error.message}`, { code: 'spawn_failed' }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        command: `${file} ${args.join(' ')}`
      });
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

const POWERSHELL_PRELUDE = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Continue';";

/** Runs a PowerShell command non-interactively and returns the captured result. */
export function runPowerShell(config, command, options = {}) {
  const shell = resolvePowerShell(config);
  const script = `${POWERSHELL_PRELUDE}${command}`;
  return runProcess(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)],
    options
  );
}

/** Runs a PowerShell snippet that emits JSON, and parses it. */
export async function runPowerShellJson(config, command, options = {}) {
  const wrapped = `${command} | ConvertTo-Json -Depth 6 -Compress`;
  const result = await runPowerShell(config, wrapped, options);
  if (result.timedOut) throw new ToolError('The PowerShell query timed out.', { code: 'timeout' });
  const text = result.stdout.trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new ToolError(`Could not parse PowerShell output as JSON.\n${result.stdout}\n${result.stderr}`.trim(), {
      code: 'bad_output'
    });
  }
}

export function runCmd(config, command, options = {}) {
  return runProcess('cmd.exe', ['/d', '/s', '/c', command], options);
}
