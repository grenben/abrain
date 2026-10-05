import { spawn } from 'node:child_process';
import { registerCleanup } from '../process-cleanup.ts';

export interface ProcessResult { code: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean; truncated: boolean; }
export type ProcessRunner = (file: string, args: string[], options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: Buffer; outputLimit?: number; processGroup?: boolean; signal?: AbortSignal }) => Promise<ProcessResult>;

export class ProcessCancelledError extends Error {
  readonly code = 'PROCESS_CANCELLED';
  constructor() {
    super('Managed PostgreSQL process was cancelled.');
    this.name = 'ProcessCancelledError';
  }
}

export class ProcessTerminationUnconfirmedError extends ProcessCancelledError {
  constructor() {
    super();
    this.name = 'ProcessTerminationUnconfirmedError';
  }
}

const TERMINATION_GRACE_MS = 1_000;
const GROUP_TEARDOWN_WAIT_MS = 1_700;

export interface ProcessRunnerDependencies {
  readonly groupExists: (processGroupId: number) => boolean;
}

export function createProcessRunner(dependencies: ProcessRunnerDependencies): ProcessRunner {
  const groupExists = dependencies.groupExists;

/** Run bounded argv-only children with a deliberately small, clean PostgreSQL environment. */
  return (file, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    reject(new ProcessCancelledError());
    return;
  }

  const grouped = options.processGroup !== false && process.platform !== 'win32';
  const child = spawn(file, args, { env: sanitizedPgEnv(options.env), stdio: ['pipe', 'pipe', 'pipe'], detached: grouped });
  const chunks: Buffer[] = [], errors: Buffer[] = [];
  let bytes = 0, errorBytes = 0, timedOut = false, truncated = false, settled = false;
  let closeCode: number | null = null, closed = false, termination: 'timeout' | 'abort' | 'cleanup' | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationDone: Promise<void> | undefined;
  let finishTermination: (() => void) | undefined;
  let cleanupDeregister: (() => void) | undefined;
  let groupPoll: ReturnType<typeof setTimeout> | undefined;
  let groupPollStartedAt: number | undefined;
  let terminationFinalized = false, terminationConfirmed = false, terminationDoneResolved = false;
  const cap = Math.min(1024 * 1024, Math.max(1024, options.outputLimit ?? 256 * 1024));
  const clearLifecycle = () => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (groupPoll) clearTimeout(groupPoll);
    options.signal?.removeEventListener('abort', onAbort);
    cleanupDeregister?.();
  };
  const settle = () => {
    if (settled || !closed || (termination !== null && (killTimer !== undefined || !terminationFinalized))) return;
    settled = true;
    clearLifecycle();
    if (!terminationConfirmed && termination !== null) reject(new ProcessTerminationUnconfirmedError());
    else if (termination === 'abort' || termination === 'cleanup') reject(new ProcessCancelledError());
    else resolve({ code: closeCode, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors), timedOut, truncated });
  };
  const finishTerminationDone = () => {
    if (terminationDoneResolved) return;
    terminationDoneResolved = true;
    finishTermination?.();
  };
  const finishTerminationIfReady = () => {
    if (termination === null || terminationFinalized || killTimer !== undefined || !closed) return;
    if (grouped && child.pid && groupExists(child.pid)) {
      // SIGKILL is asynchronous; keep cleanup registered until the process group
      // has disappeared. The bounded poll also handles systems that reap orphaned
      // descendants asynchronously.
      groupPollStartedAt ??= Date.now();
      if (Date.now() - groupPollStartedAt >= GROUP_TEARDOWN_WAIT_MS) {
        // SIGKILL was delivered but the group is still observable. Do not
        // claim teardown; report the uncertainty while staying within cleanup's budget.
      } else {
        groupPoll ??= setTimeout(() => { groupPoll = undefined; finishTerminationIfReady(); }, 25);
        return;
      }
    } else {
      terminationConfirmed = true;
    }
    terminationFinalized = true;
    settle();
    // Schedule the caller's rejection/unwind before process-cleanup's awaiting
    // callback can resolve and begin its final process.exit().
    finishTerminationDone();
  };
  const signalChild = (name: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try { child.kill(name); } catch { /* process may already have exited */ }
      }
    }
  };
  const terminate = (reason: 'timeout' | 'abort' | 'cleanup') => {
    if (termination !== null) {
      // Cancellation supersedes timeout if cleanup/abort races escalation.
      if (reason !== 'timeout') termination = reason;
      return;
    }
    if (closed) return;
    termination = reason;
    terminationDone = new Promise<void>((done) => { finishTermination = done; });
    if (reason === 'timeout') timedOut = true;
    signalChild('SIGTERM');
    killTimer = setTimeout(() => {
      signalChild('SIGKILL');
      killTimer = undefined;
      finishTerminationIfReady();
    }, TERMINATION_GRACE_MS);
  };
  const onAbort = () => terminate('abort');
  const timer = setTimeout(() => terminate('timeout'), options.timeoutMs ?? 30_000);
  timer.unref?.();

  child.stdout.on('data', (chunk: Buffer) => { if (bytes < cap) { const kept = chunk.subarray(0, cap - bytes); chunks.push(kept); bytes += kept.length; if (kept.length !== chunk.length) truncated = true; } else truncated = true; });
  child.stderr.on('data', (chunk: Buffer) => { if (errorBytes < cap) { const kept = chunk.subarray(0, cap - errorBytes); errors.push(kept); errorBytes += kept.length; if (kept.length !== chunk.length) truncated = true; } else truncated = true; });
  child.once('error', (error) => {
    if (settled) return;
    if (termination !== null) {
      closed = true;
      finishTerminationIfReady();
      return;
    }
    settled = true;
    clearLifecycle();
    reject(error);
  });
  child.once('close', (code) => {
    closeCode = code;
    closed = true;
    if (termination === null) settle();
    else finishTerminationIfReady();
  });
  cleanupDeregister = registerCleanup('managed-postgres-child', async () => {
    if (settled) return;
    if (termination === null) terminate('cleanup');
    else termination = 'cleanup';
    await terminationDone;
  });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  // Close the small race between the initial preflight and listener registration.
  if (options.signal?.aborted) onAbort();
  child.stdin.end(options.input);
  });
}

function processGroupExists(processGroupId: number): boolean {
  try { process.kill(-processGroupId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export const runProcess: ProcessRunner = createProcessRunner({ groupExists: processGroupExists });

export function sanitizedPgEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: extra.PATH ?? '/usr/bin:/bin' };
  for (const key of ['HOME', 'PGPASSFILE', 'PGREQUIREAUTH', 'HOMEBREW_NO_AUTO_UPDATE', 'HOMEBREW_NO_INSTALL_CLEANUP', 'HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK'] as const) {
    if (extra[key] !== undefined) env[key] = extra[key];
  }
  env.LANG = 'C';
  env.LC_ALL = 'C';
  return env;
}

export function safeProcessError(action: string): Error { return new Error(`Managed PostgreSQL ${action} failed; diagnostic output was suppressed.`); }
