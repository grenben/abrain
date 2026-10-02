/**
 * AI SDK LanguageModelV2 adapter for the local Codex CLI. Authentication,
 * refresh, keyring/file storage, and managed-workspace policy remain wholly
 * owned by Codex; GBrain communicates only through `codex exec --json`.
 *
 * Each call is isolated in an empty scratch directory, ignores user config and
 * rules, disables agent tools and web search, and is ephemeral. The first
 * release is deliberately text-only: GBrain tools, files, images, streaming,
 * and resumed Codex threads are rejected rather than silently degraded.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2CallWarning,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
} from '@ai-sdk/provider';
import { AIConfigError, AITransientError, type AIServiceError } from '../errors.ts';
import { cwdDotenvAssignsKey } from '../../env-trust.ts';
import { privateCodexEnabled } from '../private-codex.ts';

export const CODEX_CLI_SCRATCH_PREFIX = 'gbrain-codex-cli-cwd-';
const STDOUT_LIMIT_BYTES = 4 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 256 * 1024;
const HARD_TIMEOUT_MS = 330_000;
const KILL_GRACE_MS = 3_000;

export type CodexCliFailureKind =
  | 'not_installed'
  | 'not_logged_in'
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'model'
  | 'unsupported_cli'
  | 'transport'
  | 'timeout'
  | 'aborted'
  | 'protocol'
  | 'private_disabled';

export class CodexCliProcessError extends Error {
  readonly apiErrorStatus: number | undefined;
  readonly exitCode: number | undefined;

  constructor(
    public readonly kind: CodexCliFailureKind,
    message: string,
    opts: { apiErrorStatus?: number; exitCode?: number } = {},
  ) {
    super(message);
    this.name = 'CodexCliProcessError';
    this.apiErrorStatus = opts.apiErrorStatus;
    this.exitCode = opts.exitCode;
  }
}

interface CodexExecResult {
  text: string;
  usage: {
    input_tokens: number;
    cached_input_tokens?: number;
    output_tokens: number;
    reasoning_output_tokens?: number;
  };
}

function codexBin(): string {
  return process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex';
}

function normalizeModel(model: string): string {
  return model.replace(/^codex-cli[:/]/i, '');
}

function unsupportedInput(message: string): never {
  throw new AIConfigError(
    `codex-cli ${message}`,
    'Use a text-only chat call without GBrain tools or file/image content.',
  );
}

function renderPrompt(prompt: LanguageModelV2Prompt): string {
  const system: string[] = [];
  const conversation: string[] = [];

  for (const message of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    if (message.role === 'tool') unsupportedInput('does not support tool-result messages yet.');

    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        parts.push(part.text);
        continue;
      }
      if (part.type === 'reasoning') continue;
      if (part.type === 'file') unsupportedInput('does not support file or image inputs yet.');
      if (part.type === 'tool-call' || part.type === 'tool-result') {
        unsupportedInput('does not support GBrain tool calls yet.');
      }
    }
    const text = parts.join('\n').trim();
    if (text) conversation.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }

  return [
    'Operate as a text-only language model for GBrain.',
    'Do not invoke shell commands, tools, web search, MCP servers, plugins, apps, or filesystem operations.',
    'Return only the assistant response requested by the conversation.',
    system.length > 0 ? `\n<System instructions>\n${system.join('\n')}\n</System instructions>` : '',
    `\n<Conversation>\n${conversation.join('\n\n')}\n</Conversation>`,
  ].filter(Boolean).join('\n');
}

function usageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function eventDiagnostic(event: Record<string, unknown>): string {
  const item = event.item as Record<string, unknown> | undefined;
  const candidates = [
    event.message,
    event.error,
    (event.error as Record<string, unknown> | undefined)?.message,
    item?.message,
  ];
  return candidates.filter((v): v is string => typeof v === 'string').join('\n').slice(0, 8192);
}

function classifyFailure(diagnostic: string, exitCode?: number): CodexCliProcessError {
  const d = diagnostic.toLowerCase();
  if (/not logged in|login required|run [`']?codex login|authentication required/.test(d)) {
    return new CodexCliProcessError('not_logged_in', 'Codex CLI is not authenticated.', {
      apiErrorStatus: 401,
      exitCode,
    });
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.*(?:credential|token)/.test(d)) {
    return new CodexCliProcessError('auth', 'Codex CLI authentication was rejected.', {
      apiErrorStatus: /\b403\b|forbidden/.test(d) ? 403 : 401,
      exitCode,
    });
  }
  if (/spend limit|billing|credit balance|insufficient quota|quota exhausted|payment required|billing_not_active|exceeded your (?:current )?quota/.test(d)) {
    return new CodexCliProcessError('billing', 'Codex CLI billing hard limit reached.', {
      apiErrorStatus: 402,
      exitCode,
    });
  }
  if (/\b429\b|rate.?limit(?:ed|_error)?\b|too many requests/.test(d)) {
    return new CodexCliProcessError('rate_limit', 'Codex CLI rate limit reached.', {
      apiErrorStatus: 429,
      exitCode,
    });
  }
  if (/model.*(?:not found|unavailable|unsupported|does not exist)|unknown model|invalid model/.test(d)) {
    return new CodexCliProcessError('model', 'Codex CLI rejected the requested model.', {
      apiErrorStatus: 404,
      exitCode,
    });
  }
  if (/ignored setting|unknown (?:config(?:uration)? )?(?:key|setting)|unknown (?:argument|option|feature)|unrecognized (?:argument|option)|unexpected argument|unsupported (?:argument|option|feature)/.test(d)) {
    return new CodexCliProcessError(
      'unsupported_cli',
      'Installed Codex CLI rejected a required execution setting.',
      { exitCode },
    );
  }
  return new CodexCliProcessError('transport', 'Codex CLI process failed.', { exitCode });
}

function toAIError(error: CodexCliProcessError): AIServiceError {
  let out: AIServiceError;
  switch (error.kind) {
    case 'not_installed':
      out = new AIConfigError(
        error.message,
        'Install Codex, then run `codex login` and `codex login status`.',
      );
      break;
    case 'not_logged_in':
    case 'auth':
      out = new AIConfigError(
        error.message,
        'Run `codex login`, confirm with `codex login status`, then retry.',
      );
      break;
    case 'model':
      out = new AIConfigError(
        error.message,
        'Choose a model available to the signed-in Codex account and retry.',
      );
      break;
    case 'unsupported_cli':
      out = new AIConfigError(
        error.message,
        'Upgrade Codex to a version supporting ephemeral exec, ignored config/rules, and feature disabling.',
      );
      break;
    case 'billing':
      out = new AIConfigError(
        error.message,
        'Check Codex plan usage, credits, and reset time before retrying.',
      );
      break;
    case 'private_disabled':
      out = new AIConfigError(error.message, 'This staged Codex adapter requires explicit private activation.');
      break;
    case 'rate_limit':
      out = new AITransientError(error.message);
      break;
    case 'aborted':
    case 'timeout':
    case 'transport':
    case 'protocol':
      out = new AITransientError(error.message);
      break;
  }
  if (error.apiErrorStatus !== undefined) out.apiErrorStatus = error.apiErrorStatus;
  Object.assign(out, { codexCliFailureKind: error.kind });
  return out;
}

function signalChild(child: ChildProcessWithoutNullStreams, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function processGroupAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessGroupExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(child)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

async function terminateSurvivingProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!processGroupAlive(child)) return;
  signalChild(child, 'SIGTERM');
  if (await waitForProcessGroupExit(child, KILL_GRACE_MS)) return;
  signalChild(child, 'SIGKILL');
  // SIGKILL is uncatchable; keep checking in bounded intervals until the OS
  // confirms the group is gone, rather than resolving with live descendants.
  while (!(await waitForProcessGroupExit(child, 1_000))) signalChild(child, 'SIGKILL');
}

function forbiddenActivity(event: Record<string, unknown>): boolean {
  const eventType = typeof event.type === 'string' ? event.type : '';
  const item = event.item as Record<string, unknown> | undefined;
  const itemType = typeof item?.type === 'string' ? item.type : '';
  if (itemType === 'error') return false;
  const lifecycleTypes = new Set(['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed']);
  if (!lifecycleTypes.has(eventType)) return true;
  const allowedEventFields = new Set(['type', 'thread_id', 'turn_id', ...(eventType.startsWith('item.') ? ['item'] : []), ...(eventType === 'turn.completed' ? ['usage'] : [])]);
  if (Object.keys(event).some(key => !allowedEventFields.has(key))) return true;
  if (eventType.startsWith('item.')) {
    if (!item || !['agent_message', 'reasoning'].includes(itemType)) return true;
    const allowedItemFields = new Set(['type', 'id', 'text', 'summary']);
    if (Object.keys(item).some(key => !allowedItemFields.has(key))) return true;
  } else if ('item' in event) {
    return true;
  }
  return false;
}

function parseJsonl(events: Record<string, unknown>[], stderr: string, exitCode: number | null): CodexExecResult {
  const failed = events.find(e => e.type === 'error' || e.type === 'turn.failed');
  const diagnostic = `${failed ? eventDiagnostic(failed) : ''}\n${stderr.slice(0, 8192)}`.slice(0, 16_384);
  if (exitCode !== 0 || failed) throw classifyFailure(diagnostic, exitCode ?? undefined);

  let text = '';
  let usage: CodexExecResult['usage'] | undefined;
  let completed = false;
  for (const event of events) {
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === 'item.completed') {
      if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
    }
    if (event.type === 'turn.completed') {
      if (completed) throw new CodexCliProcessError('protocol', 'Codex CLI returned multiple completed turns.');
      completed = true;
      const raw = event.usage as Record<string, unknown> | undefined;
      if (!raw || !usageNumber(raw.input_tokens) || !usageNumber(raw.output_tokens) ||
          (raw.cached_input_tokens !== undefined &&
            (!usageNumber(raw.cached_input_tokens) || raw.cached_input_tokens > raw.input_tokens)) ||
          (raw.reasoning_output_tokens !== undefined && !usageNumber(raw.reasoning_output_tokens))) {
        throw new CodexCliProcessError('protocol', 'Codex CLI returned invalid token usage.');
      }
      usage = {
        input_tokens: raw.input_tokens,
        output_tokens: raw.output_tokens,
        ...(raw.cached_input_tokens !== undefined ? { cached_input_tokens: raw.cached_input_tokens } : {}),
        ...(raw.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: raw.reasoning_output_tokens } : {}),
        // LanguageModelV2 has no cache-write-token field; preserve it nowhere and never synthesize zero.
      };
    }
  }
  if (!completed || !text || !usage) {
    throw new CodexCliProcessError('protocol', 'Codex CLI completed without a final agent message.', {
      exitCode: exitCode ?? undefined,
    });
  }
  return { text, usage };
}

function runCodex(
  prompt: string,
  model: string,
  signal: AbortSignal | undefined,
): Promise<CodexExecResult> {
  if (signal?.aborted) {
    return Promise.reject(toAIError(new CodexCliProcessError('aborted', 'Codex CLI request was aborted.')));
  }
  if (!privateCodexEnabled()) {
    return Promise.reject(toAIError(new CodexCliProcessError('private_disabled', 'Codex CLI adapter is not privately enabled.')));
  }

  const scratch = mkdtempSync(join(tmpdir(), CODEX_CLI_SCRATCH_PREFIX));
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'SystemRoot', 'WINDIR', 'PATHEXT', 'ComSpec',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LC_') && value !== undefined) env[key] = value;
  }
  if (process.env.CODEX_HOME !== undefined && !cwdDotenvAssignsKey('CODEX_HOME')) {
    env.CODEX_HOME = process.env.CODEX_HOME;
  }

  const args = [
    '--no-daemon',
    '--ask-for-approval', 'never',
    '--disable', 'shell_tool',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'computer_use',
    '--disable', 'hooks',
    '-c', 'web_search="disabled"',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', scratch,
    '--model', model,
    '-',
  ];

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      if (!privateCodexEnabled()) {
        try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
        reject(toAIError(new CodexCliProcessError('private_disabled', 'Codex CLI adapter is not privately enabled.')));
        return;
      }
      child = spawn(codexBin(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: scratch,
        env,
        detached: process.platform !== 'win32',
      });
    } catch {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      reject(toAIError(new CodexCliProcessError('not_installed', 'Codex CLI is not installed.')));
      return;
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const events: Record<string, unknown>[] = [];
    let stdoutLineBuffer = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let requestedStop: 'aborted' | 'timeout' | 'overflow' | 'protocol' | 'diagnostic' | null = null;
    let diagnosticFailure: CodexCliProcessError | undefined;
    let protocolFailure: CodexCliProcessError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const stop = (reason: 'aborted' | 'timeout' | 'overflow' | 'protocol' | 'diagnostic') => {
      if (requestedStop) return;
      requestedStop = reason;
      signalChild(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const hardTimer = setTimeout(() => stop('timeout'), HARD_TIMEOUT_MS);
    hardTimer.unref?.();

    const consumeStdout = (text: string, final = false) => {
      stdoutLineBuffer += text;
      let newline: number;
      while ((newline = stdoutLineBuffer.indexOf('\n')) !== -1) {
        const line = stdoutLineBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { stop('protocol'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { stop('protocol'); return; }
        const event = parsed as Record<string, unknown>;
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === 'error' || event.type === 'turn.failed' || item?.type === 'error') {
          diagnosticFailure = classifyFailure(eventDiagnostic(event));
          stop('diagnostic');
          return;
        }
        if (forbiddenActivity(event)) {
          protocolFailure = new CodexCliProcessError('protocol', item?.type === 'todo_list'
            ? 'Codex CLI returned unsupported native planning activity.'
            : 'Codex CLI attempted forbidden tool activity or returned an unknown event.');
          stop('protocol');
          return;
        }
        events.push(event);
      }
      if (final && !requestedStop && stdoutLineBuffer.trim()) {
        const line = stdoutLineBuffer.replace(/\r$/, '');
        stdoutLineBuffer = '';
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { stop('protocol'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { stop('protocol'); return; }
        const event = parsed as Record<string, unknown>;
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === 'error' || event.type === 'turn.failed' || item?.type === 'error') {
          diagnosticFailure = classifyFailure(eventDiagnostic(event));
          stop('diagnostic');
          return;
        }
        if (forbiddenActivity(event)) {
          protocolFailure = new CodexCliProcessError('protocol', item?.type === 'todo_list'
            ? 'Codex CLI returned unsupported native planning activity.'
            : 'Codex CLI attempted forbidden tool activity or returned an unknown event.');
          stop('protocol');
          return;
        }
        events.push(event);
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (requestedStop) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      consumeStdout(stdoutDecoder.write(bytes));
      if (stdoutBytes > STDOUT_LIMIT_BYTES) stop('overflow');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (requestedStop) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes <= STDERR_LIMIT_BYTES) stderr += stderrDecoder.write(bytes);
      if (stderrBytes > STDERR_LIMIT_BYTES) stop('overflow');
    });

    let finalizationStarted = false;
    let decoderEnded = false;
    let spawnFailure: CodexCliProcessError | undefined;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
    };
    const finalize = async (code: number | null) => {
      if (settled || finalizationStarted) return;
      finalizationStarted = true;
      let result: CodexExecResult | undefined;
      let failure: CodexCliProcessError | undefined = spawnFailure;
      if (!decoderEnded) {
        decoderEnded = true;
        consumeStdout(stdoutDecoder.end(), true);
        stderr += stderrDecoder.end();
      }
      if (!failure) {
        if (requestedStop === 'aborted') failure = new CodexCliProcessError('aborted', 'Codex CLI request was aborted.');
        else if (requestedStop === 'timeout') failure = new CodexCliProcessError('timeout', 'Codex CLI request timed out.');
        else if (requestedStop === 'overflow') failure = new CodexCliProcessError('protocol', 'Codex CLI output exceeded the safety limit.');
        else if (requestedStop === 'diagnostic') failure = diagnosticFailure ?? new CodexCliProcessError('transport', 'Codex CLI process failed.');
        else if (requestedStop === 'protocol') failure = protocolFailure ?? new CodexCliProcessError('protocol', 'Codex CLI returned an invalid response.');
        else {
          try { result = parseJsonl(events, stderr, code); }
          catch (error) {
            failure = error instanceof CodexCliProcessError
              ? error
              : new CodexCliProcessError('protocol', 'Codex CLI response could not be parsed.');
          }
        }
      }

      try { await terminateSurvivingProcessGroup(child); }
      catch {
        // Keep scratch and timers intact; do not settle if cleanup cannot be confirmed.
        finalizationStarted = false;
        setTimeout(() => { void finalize(code); }, 50);
        return;
      }

      // Cancellation during successful cleanup overrides the not-yet-committed result.
      if (!failure && requestedStop === 'aborted') failure = new CodexCliProcessError('aborted', 'Codex CLI request was aborted.');
      else if (!failure && requestedStop === 'timeout') failure = new CodexCliProcessError('timeout', 'Codex CLI request timed out.');
      // Timers/listeners and scratch are retained until process-group cleanup has been attempted.
      cleanup();
      settled = true;
      if (failure) reject(toAIError(failure));
      else if (result) resolve(result);
      else reject(toAIError(new CodexCliProcessError('protocol', 'Codex CLI response could not be parsed.')));
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnFailure = new CodexCliProcessError(
        error.code === 'ENOENT' ? 'not_installed' : 'transport',
        error.code === 'ENOENT' ? 'Codex CLI is not installed.' : 'Codex CLI process failed to start.',
      );
      void finalize(null);
    });
    child.on('close', (code) => { void finalize(code); });

    child.stdin.on('error', () => { /* surfaced by child error/close */ });
    try {
      child.stdin.end(prompt);
    } catch {
      stop('overflow');
    }
  });
}

export class CodexCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-cli';
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    this.modelId = normalizeModel(modelId);
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop';
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens: number | undefined;
      reasoningTokens?: number | undefined;
    };
    warnings: LanguageModelV2CallWarning[];
  }> {
    if (options.tools && options.tools.length > 0) {
      unsupportedInput('does not support GBrain tools yet.');
    }
    if (options.responseFormat?.type === 'json') {
      unsupportedInput('does not support structured JSON output yet.');
    }
    const warnings: LanguageModelV2CallWarning[] = [];
    if (options.maxOutputTokens !== undefined) {
      warnings.push({
        type: 'unsupported-setting',
        setting: 'maxOutputTokens',
        details: 'Codex has no enforceable output-token cap; this requested target is advisory only.',
      });
    }
    for (const setting of ['temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'stopSequences', 'seed'] as const) {
      if (options[setting] !== undefined) warnings.push({ type: 'unsupported-setting', setting });
    }
    const prompt = renderPrompt(options.prompt);
    const result = await runCodex(prompt, this.modelId, options.abortSignal);
    const inputTokens = result.usage.input_tokens;
    const outputTokens = result.usage.output_tokens;
    return {
      content: [{ type: 'text', text: result.text }],
      finishReason: 'stop',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens: result.usage.cached_input_tokens,
        ...(result.usage.reasoning_output_tokens !== undefined
          ? { reasoningTokens: result.usage.reasoning_output_tokens }
          : {}),
      },
      warnings,
    };
  }

  async doStream(): Promise<never> {
    throw new AIConfigError('codex-cli does not support streaming yet.');
  }
}
