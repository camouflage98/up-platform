import { z } from 'zod';
import { assertCommandAllowed, assertFeature, assertWindows, clampTimeout, resolvePath } from '../guard.js';
import { runCmd, runPowerShell } from '../exec.js';
import { defineTool, formatRun, textResult } from './helpers.js';

export function registerShellTools(server, ctx) {
  const { config, terminals } = ctx;

  defineTool(
    server,
    ctx,
    'powershell_run',
    {
      title: 'Run a PowerShell command',
      description:
        'Run a PowerShell command on the Windows machine and return its stdout, stderr and exit code. ' +
        'Non-interactive: a command that waits for input will hang until the timeout, so use terminal_open for anything interactive. ' +
        'Destructive or system-wide commands need confirm: true.',
      inputSchema: {
        command: z.string().describe('PowerShell command or script to run.'),
        cwd: z.string().optional().describe('Working directory. Defaults to the server process directory.'),
        timeoutMs: z.number().int().optional().describe('Timeout in milliseconds.'),
        confirm: z.boolean().optional().describe('Set true after the user has agreed to a command flagged as needing confirmation.')
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ command, cwd, timeoutMs, confirm }) => {
      // Policy first: a refusal should explain the policy, whatever the platform.
      assertFeature(config, 'shell');
      assertCommandAllowed(config, command, confirm);
      assertWindows();
      const workingDir = cwd ? resolvePath(config, cwd, { mustExist: true }) : undefined;
      const result = await runPowerShell(config, command, { cwd: workingDir, timeoutMs: clampTimeout(config, timeoutMs) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes }));
    }
  );

  defineTool(
    server,
    ctx,
    'cmd_run',
    {
      title: 'Run a cmd.exe command',
      description:
        'Run a command through cmd.exe, for legacy batch syntax and tools that misbehave under PowerShell. ' +
        'Same policy checks as powershell_run.',
      inputSchema: {
        command: z.string().describe('Command line to run through cmd.exe.'),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().optional(),
        confirm: z.boolean().optional()
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ command, cwd, timeoutMs, confirm }) => {
      // Policy first: a refusal should explain the policy, whatever the platform.
      assertFeature(config, 'shell');
      assertCommandAllowed(config, command, confirm);
      assertWindows();
      const workingDir = cwd ? resolvePath(config, cwd, { mustExist: true }) : undefined;
      const result = await runCmd(config, command, { cwd: workingDir, timeoutMs: clampTimeout(config, timeoutMs) });
      return textResult(formatRun(result, { maxBytes: config.maxOutputBytes }));
    }
  );

  defineTool(
    server,
    ctx,
    'terminal_open',
    {
      title: 'Open a persistent terminal',
      description:
        'Start a long-lived shell that keeps its state between calls: current directory, variables, an activated environment, ' +
        'a program waiting at a prompt. Returns a terminalId to use with terminal_run, terminal_send_input, terminal_read and terminal_close.',
      inputSchema: {
        shell: z.enum(['powershell', 'cmd']).optional().describe('Which shell to start. Defaults to powershell.'),
        cwd: z.string().optional().describe('Directory to start in.')
      },
      annotations: { openWorldHint: true }
    },
    async ({ shell, cwd }) => {
      assertWindows();
      assertFeature(config, 'terminals');
      const workingDir = cwd ? resolvePath(config, cwd, { mustExist: true }) : undefined;
      return textResult(terminals.open({ shell, cwd: workingDir }));
    }
  );

  defineTool(
    server,
    ctx,
    'terminal_run',
    {
      title: 'Run a command in a terminal',
      description:
        'Run a command inside an open terminal and wait for it to finish. State from earlier commands in that terminal is still there. ' +
        'If the command stops at a prompt instead of finishing, this returns what was printed so far; answer it with terminal_send_input.',
      inputSchema: {
        terminalId: z.string(),
        command: z.string(),
        timeoutMs: z.number().int().optional(),
        confirm: z.boolean().optional()
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ terminalId, command, timeoutMs, confirm }) => {
      assertFeature(config, 'terminals');
      assertCommandAllowed(config, command, confirm);
      assertWindows();
      return textResult(await terminals.run(terminalId, command, clampTimeout(config, timeoutMs)));
    }
  );

  defineTool(
    server,
    ctx,
    'terminal_send_input',
    {
      title: 'Send input to a terminal',
      description:
        'Send raw keystrokes to a terminal that is waiting for input, such as answering Y to a prompt or typing into a REPL. ' +
        'Returns whatever the terminal printed in the following moment.',
      inputSchema: {
        terminalId: z.string(),
        text: z.string().describe('Text to type. A newline is appended unless appendNewline is false.'),
        appendNewline: z.boolean().optional(),
        waitMs: z.number().int().optional().describe('How long to collect output afterwards. Defaults to 800 ms.')
      },
      annotations: { openWorldHint: true }
    },
    async ({ terminalId, text, appendNewline, waitMs }) => {
      assertWindows();
      assertFeature(config, 'terminals');
      return textResult(await terminals.write(terminalId, text, { appendNewline, waitMs }));
    }
  );

  defineTool(
    server,
    ctx,
    'terminal_read',
    {
      title: 'Read pending terminal output',
      description: 'Drain whatever an open terminal has printed since the last read, without sending anything.',
      inputSchema: { terminalId: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ terminalId }) => textResult(terminals.read(terminalId))
  );

  defineTool(
    server,
    ctx,
    'terminal_list',
    {
      title: 'List open terminals',
      description: 'List the terminals this server has open, with their shell, pid and how long they have been idle.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => textResult(terminals.list())
  );

  defineTool(
    server,
    ctx,
    'terminal_close',
    {
      title: 'Close a terminal',
      description: 'Close an open terminal and end the process running in it.',
      inputSchema: { terminalId: z.string() },
      annotations: { destructiveHint: true }
    },
    async ({ terminalId }) => textResult(terminals.close(terminalId))
  );
}
