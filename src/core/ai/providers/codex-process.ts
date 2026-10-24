import { spawn } from '../../spawn.ts';
import { CodexProposalError, type CodexProposalFailure } from './codex-contract.ts';
import { codexNamespaceLaunch } from './codex-namespace.ts';

export interface CodexProcessInput {
  runtimeFd: number; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  prompt: string; signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number;
  isolation?: 'process-group' | 'pid-namespace';
}

/** Only explicitly named authentication-location and OS variables reach the CLI. */
export function codexEnvironment(snapshot: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'CODEX_HOME']
    .filter(key => typeof snapshot[key] === 'string').map(key => [key, snapshot[key]]));
}

/** Linux/macOS process groups. Windows is refused until native tree settlement is implemented. */
export function runCodexProcess(input: CodexProcessInput): Promise<string> {
  if (process.platform === 'win32') return Promise.reject(new CodexProposalError('unsupported_platform'));
  if (input.signal?.aborted) return Promise.reject(new CodexProposalError('aborted'));
  // fd 3 names the same open inode that qualification hashed. A rename or symlink
  // swap of the configured path cannot change the executable at the spawn edge.
  const pinnedBin = process.platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3';
  if (input.isolation === 'pid-namespace' && process.platform !== 'linux') {
    return Promise.reject(new CodexProposalError('unsupported_platform'));
  }
  // The real runtime is PID 1 inside a private namespace. Killing that init
  // tears down descendants even if a native child escaped our process group.
  const namespace = input.isolation === 'pid-namespace';
  const { command, args } = namespace ? codexNamespaceLaunch(pinnedBin, input.args)
    : { command: pinnedBin, args: input.args };
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, args, { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe', input.runtimeFd], detached: true }); }
    catch { reject(new CodexProposalError('spawn')); return; }
    let closed = false;
    let settled = false;
    let code: number | null = null;
    let failure: CodexProposalFailure | undefined;
    let bytes = 0;
    const output: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const groupAlive = (): boolean => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* absence is checked independently */ }
    };
    const finish = (reason?: CodexProposalFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(settleTimer); clearTimeout(pollTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (reason) reject(new CodexProposalError(reason));
      else resolve(Buffer.concat(output).toString('utf8'));
    };
    const check = (): void => {
      if (settled) return;
      if (closed && !groupAlive()) finish(failure ?? (code !== 0 ? 'exit' : undefined));
      else pollTimer = setTimeout(check, 20);
    };
    const stop = (reason: CodexProposalFailure): void => {
      failure ??= reason;
      if (settleTimer || settled) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 250);
      settleTimer = setTimeout(() => {
        if (!closed || groupAlive()) finish('termination_unconfirmed');
        else check();
      }, 2_000);
      check();
    };
    const onAbort = () => stop('aborted');
    const timeout = setTimeout(() => stop('timeout'), input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) stop('output_limit');
      else output.push(Buffer.from(chunk));
    });
    // Count stderr too, but never retain or return its provider-authored contents.
    child.stderr!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) stop('output_limit');
    });
    child.stdin!.on('error', () => stop('stdin'));
    child.on('error', () => { failure = 'spawn'; });
    child.on('close', exitCode => {
      closed = true; code = exitCode;
      if (groupAlive()) stop('native_action');
      else check();
    });
    if (input.signal?.aborted) onAbort();
    else { child.stdin!.write(input.prompt); child.stdin!.end(); }
  });
}
