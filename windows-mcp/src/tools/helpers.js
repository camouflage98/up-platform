import { ToolError, audit } from '../guard.js';

/** Formats a value as the single text block MCP clients render. */
export function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: text === '' ? '(no output)' : text }] };
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Registers a tool with uniform error handling and audit logging, so no handler
 * has to repeat either and no stack trace leaks to the client.
 */
export function defineTool(server, ctx, name, spec, handler) {
  ctx.registeredTools?.push(name);
  server.registerTool(name, spec, async (args, extra) => {
    const startedAt = Date.now();
    try {
      const result = await handler(args ?? {}, extra);
      audit(ctx.config, { tool: name, args: redact(args), ok: true, ms: Date.now() - startedAt });
      return typeof result === 'object' && result !== null && 'content' in result ? result : textResult(result);
    } catch (error) {
      const message = error instanceof ToolError ? error.message : `${name} failed: ${error.message}`;
      audit(ctx.config, { tool: name, args: redact(args), ok: false, error: message, ms: Date.now() - startedAt });
      return errorResult(message);
    }
  });
}

const SECRET_KEYS = /password|secret|token|apikey|api_key/i;

function redact(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

/** Renders a finished process run into something readable in a chat transcript. */
export function formatRun(result, { maxBytes, label = 'command' } = {}) {
  const lines = [];
  lines.push(`exit code: ${result.exitCode ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}`);
  lines.push(`duration: ${result.durationMs} ms`);
  const stdout = truncate(result.stdout, maxBytes);
  const stderr = truncate(result.stderr, maxBytes);
  if (stdout.trim()) lines.push(`\n--- stdout ---\n${stdout.trimEnd()}`);
  if (stderr.trim()) lines.push(`\n--- stderr ---\n${stderr.trimEnd()}`);
  if (!stdout.trim() && !stderr.trim()) lines.push(`\n(the ${label} produced no output)`);
  return lines.join('\n');
}

function truncate(text, maxBytes) {
  if (!maxBytes) return text ?? '';
  const buffer = Buffer.from(text ?? '', 'utf8');
  if (buffer.length <= maxBytes) return text ?? '';
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[truncated, ${buffer.length} bytes total]`;
}

/** PowerShell single-quoted string literal: the only escape inside is a doubled quote. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
