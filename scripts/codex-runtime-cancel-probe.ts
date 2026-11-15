/** Credential-free cancellation check against one real Codex ELF. */
import { chmod, mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { assertProductionCodexHostBoundary, assertTrustedCodexExecutable } from '../src/core/ai/providers/codex-qualification.ts';
import { CodexProposalError } from '../src/core/ai/providers/codex-contract.ts';
import { codexProposalModelCatalog } from '../src/core/ai/providers/codex-model-catalog.ts';
import { runCodexProcess } from '../src/core/ai/providers/codex-process.ts';
import { CODEX_DENY_NATIVE_HOOK, CODEX_PROPOSAL_INSTRUCTIONS, codexProposalArgv } from '../src/core/ai/providers/codex-runtime.ts';

const [bin, model, mode = 'abort'] = process.argv.slice(2);
if (!bin || !isAbsolute(bin) || !model || !['abort', 'timeout'].includes(mode)) {
  console.error('Usage: bun scripts/codex-runtime-cancel-probe.ts /absolute/path/to/codex model-slug [abort|timeout]');
  process.exit(2);
}
await assertProductionCodexHostBoundary();
const runtime = await open(bin, 'r');
let root: string | undefined;
let settled = true;
let releaseResponse: ((response: Response) => void) | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  root = await mkdtemp(join(tmpdir(), 'gbrain-codex-cancel-'));
  await chmod(root, 0o700);
  const home = join(root, 'home');
  const scratch = join(root, 'scratch');
  await mkdir(home, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  let signalRequest!: () => void;
  const requestSeen = new Promise<void>(resolve => { signalRequest = resolve; });
  const heldResponse = new Promise<Response>(resolve => { releaseResponse = resolve; });
  let requests = 0;
  const toolCounts: number[] = [];
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const request = await req.json() as { tools?: unknown };
    requests++;
    toolCounts.push(Array.isArray(request.tools) ? request.tools.length : -1);
    signalRequest();
    return heldResponse;
  } });
  const schemaFile = join(scratch, 'schema.json');
  const answerFile = join(scratch, 'answer.json');
  const denyHook = join(scratch, 'deny-native');
  const instructionsFile = join(scratch, 'instructions.txt');
  const modelCatalogFile = join(scratch, 'model-catalog.json');
  await writeFile(schemaFile, JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } },
    required: ['ok'], additionalProperties: false }), { mode: 0o600 });
  await writeFile(answerFile, '', { mode: 0o600 });
  await writeFile(denyHook, CODEX_DENY_NATIVE_HOOK, { mode: 0o700 });
  await writeFile(instructionsFile, CODEX_PROPOSAL_INSTRUCTIONS, { mode: 0o600 });
  await writeFile(modelCatalogFile, codexProposalModelCatalog(model), { mode: 0o600 });
  await writeFile(join(scratch, '.gbrain-codex-root'), '', { mode: 0o600 });
  const args = codexProposalArgv({ cwd: scratch, model, schemaFile, answerFile, denyHook,
    instructionsFile, modelCatalogFile, imageFiles: [] });
  const providerIndex = args.indexOf('model_provider="openai"');
  if (providerIndex < 1) throw new Error('model provider setting absent');
  args[providerIndex] = 'model_provider="probe"';
  args.splice(providerIndex - 1, 0, '-c',
    `model_providers.probe={name="Probe",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",request_max_retries=0}`);
  const controller = new AbortController();
  const childEnv = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home,
    USER: 'gbrain-probe', TMPDIR: root, LANG: 'C.UTF-8' };
  const started = Date.now();
  const running = runCodexProcess({ runtimeFd: runtime.fd, isolation: 'pid-namespace', args,
    cwd: scratch, env: childEnv, prompt: 'Return {"ok":true}.', signal: controller.signal,
    timeoutMs: mode === 'timeout' ? 5_000 : 10_000, maxOutputBytes: 65_536 });
  const outcome = running.then(() => 'completed', error => {
    if (!(error instanceof CodexProposalError)) { settled = false; throw error; }
    settled = error.settled;
    return error.reason;
  });
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  const requestDeadline = new Promise<void>((_, reject) => {
    requestTimer = setTimeout(() => reject(new Error('mock request not reached')), 4_000);
  });
  try {
    await Promise.race([requestSeen, requestDeadline]);
  } catch (error) {
    controller.abort();
    await outcome;
    throw error;
  } finally { clearTimeout(requestTimer); }
  if (mode === 'abort') controller.abort();
  const reason = await outcome;
  let runtimeFileProtected = false;
  try { assertTrustedCodexExecutable(await runtime.stat()); runtimeFileProtected = true; } catch { /* diagnostic only */ }
  const result = { model, mode, requests, toolCounts, reason, settled, elapsedMs: Date.now() - started,
    runtimeFileProtected };
  console.log(JSON.stringify(result));
  if (requests < 1 || toolCounts.some(count => count !== 0)
    || reason !== (mode === 'abort' ? 'aborted' : 'timeout') || !settled) process.exitCode = 1;
} finally {
  releaseResponse?.(new Response(JSON.stringify({ error: { message: 'synthetic refusal' } }), { status: 401 }));
  server?.stop(true);
  await runtime.close();
  if (settled && root) await rm(root, { recursive: true, force: true });
}
