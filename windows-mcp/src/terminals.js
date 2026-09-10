import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ToolError, truncateOutput } from './guard.js';
import { resolvePowerShell } from './exec.js';

/**
 * Long-lived interactive shells. A one-shot `powershell_run` loses everything
 * between calls: the current directory, variables, an activated virtualenv, a
 * half-answered prompt. A terminal session keeps all of it, and lets the model
 * answer prompts that a non-interactive run would just hang on.
 */
export class TerminalManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweepIdle(), 60_000);
    this.sweeper.unref?.();
  }

  open({ shell = 'powershell', cwd } = {}) {
    if (this.sessions.size >= this.config.maxTerminals) {
      throw new ToolError(`Too many open terminals (limit ${this.config.maxTerminals}). Close one first.`, {
        code: 'terminal_limit'
      });
    }
    const id = `term_${randomUUID().slice(0, 8)}`;
    const { file, args } = this.#shellCommand(shell);
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw new ToolError(`Failed to start ${shell}: ${error.message}`, { code: 'spawn_failed' });
    }

    const session = {
      id,
      shell,
      file,
      pid: child.pid,
      child,
      cwd: cwd ?? null,
      buffer: '',
      exited: false,
      exitCode: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      waiter: null
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onData = (chunk) => {
      session.buffer += chunk;
      session.waiter?.check();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      session.exited = true;
      session.exitCode = code;
      session.waiter?.check();
    });
    child.on('error', (error) => {
      session.buffer += `\n[terminal error: ${error.message}]\n`;
      session.exited = true;
      session.waiter?.check();
    });

    this.sessions.set(id, session);
    return this.describe(session);
  }

  #shellCommand(shell) {
    if (shell === 'cmd') return { file: 'cmd.exe', args: ['/q', '/k'] };
    if (shell === 'powershell') {
      return {
        file: resolvePowerShell(this.config),
        args: ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-']
      };
    }
    throw new ToolError(`Unknown shell "${shell}". Use "powershell" or "cmd".`);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new ToolError(`No terminal with id ${id}. Call terminal_list to see open ones.`, { code: 'not_found' });
    if (session.exited) {
      throw new ToolError(`Terminal ${id} has exited (code ${session.exitCode}). Open a new one.`, { code: 'terminal_exited' });
    }
    return session;
  }

  /**
   * Runs a command and waits for a sentinel line that the shell prints once the
   * command has finished, which is what makes the output of one call complete.
   */
  async run(id, command, timeoutMs) {
    const session = this.get(id);
    if (session.waiter) throw new ToolError(`Terminal ${id} is still busy with an earlier command.`, { code: 'terminal_busy' });
    session.lastUsedAt = Date.now();
    session.buffer = '';

    const token = randomUUID().replace(/-/g, '').slice(0, 12);
    const marker = `__MCP_DONE_${token}__`;
    const script =
      session.shell === 'cmd'
        ? `${command}\r\necho ${marker}%ERRORLEVEL%\r\n`
        : `${command}\r\n$__mcp_code = if ($? ) { if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 } } else { 1 }; Write-Output "${marker}$__mcp_code"\r\n`;

    const output = await this.#waitFor(session, marker, timeoutMs, () => session.child.stdin.write(script));
    const markerIndex = output.indexOf(marker);
    if (markerIndex === -1) {
      return { output: truncateOutput(output, this.config.maxOutputBytes), exitCode: null, timedOut: true, terminalId: id };
    }
    const trailing = output.slice(markerIndex + marker.length);
    const exitCode = Number.parseInt(trailing.trim().split(/\s/)[0], 10);
    // cmd echoes the sentinel command itself; drop that line as well as the result.
    const body = output
      .slice(0, markerIndex)
      .replace(/(?:^|\r?\n)[^\r\n]*echo __MCP_DONE_[a-f0-9]+__[^\r\n]*$/i, '')
      .replace(/(?:^|\r?\n)[^\r\n]*Write-Output "__MCP_DONE_[a-f0-9]+__[^\r\n]*$/i, '');
    return {
      output: truncateOutput(body.trimEnd(), this.config.maxOutputBytes),
      exitCode: Number.isNaN(exitCode) ? null : exitCode,
      timedOut: false,
      terminalId: id
    };
  }

  /** Sends raw keystrokes, for answering an interactive prompt. */
  async write(id, text, { waitMs = 800, appendNewline = true } = {}) {
    const session = this.get(id);
    session.lastUsedAt = Date.now();
    session.buffer = '';
    session.child.stdin.write(appendNewline ? `${text}\r\n` : text);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const output = session.buffer;
    session.buffer = '';
    return { output: truncateOutput(output, this.config.maxOutputBytes), terminalId: id };
  }

  /** Drains whatever the shell has printed since the last read. */
  read(id) {
    const session = this.get(id);
    const output = session.buffer;
    session.buffer = '';
    session.lastUsedAt = Date.now();
    return { output: truncateOutput(output, this.config.maxOutputBytes), terminalId: id };
  }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) throw new ToolError(`No terminal with id ${id}.`, { code: 'not_found' });
    try {
      session.child.stdin.end();
      session.child.kill();
    } catch {
      // Already gone; nothing to clean up beyond the map entry.
    }
    this.sessions.delete(id);
    return { terminalId: id, closed: true };
  }

  list() {
    return [...this.sessions.values()].map((session) => this.describe(session));
  }

  describe(session) {
    return {
      terminalId: session.id,
      shell: session.shell,
      pid: session.pid,
      cwd: session.cwd,
      exited: session.exited,
      idleSeconds: Math.round((Date.now() - session.lastUsedAt) / 1000)
    };
  }

  #waitFor(session, marker, timeoutMs, kick) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.waiter = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(session.buffer), timeoutMs);
      session.waiter = {
        check: () => {
          if (session.buffer.includes(marker) || session.exited) finish(session.buffer);
        }
      };
      kick();
      session.waiter.check();
    });
  }

  sweepIdle() {
    const limit = this.config.terminalIdleTimeoutMs;
    if (!limit) return;
    for (const session of this.sessions.values()) {
      if (Date.now() - session.lastUsedAt > limit) this.close(session.id);
    }
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
    clearInterval(this.sweeper);
  }
}
