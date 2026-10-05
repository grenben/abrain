/**
 * #4318 — shared interactive [y/N] confirm.
 *
 * The old inline twins (sync-cost-gate.ts, reindex-code.ts) called
 * `rl.close()` BEFORE resolving the answer, and their unguarded
 * `rl.on('close', () => resolve(false))` listener fired synchronously during
 * that close — so the promise settled `false` before the real answer's
 * resolve ran and a typed "y" was read as a decline (the cost gate refused
 * every interactive approval).
 *
 * Rules pinned here (test/confirm-prompt.test.ts):
 *   - resolve the ANSWER first, then close the interface;
 *   - the 'close' listener resolves(false) ONLY when no answer arrived
 *     (true EOF / Ctrl-D — decline, matching the [y/N] default).
 */

import { createInterface } from 'node:readline';

export interface ConfirmStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signal?: AbortSignal;
}

/** Interactive [y/N] prompt. Resolves true on y/yes; false on anything else or EOF. */
export async function promptYesNo(question: string, streams: ConfirmStreams = {}): Promise<boolean> {
  if (streams.signal?.aborted) return false;
  return new Promise((resolve) => {
    const rl = createInterface({
      input: streams.input ?? process.stdin,
      output: streams.output ?? process.stdout,
    });
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      streams.signal?.removeEventListener('abort', onAbort);
      resolve(answer);
      rl.close();
    };
    const onAbort = (): void => finish(false);
    streams.signal?.addEventListener('abort', onAbort, { once: true });
    // Abort can race listener setup; still avoid opening a live prompt.
    if (streams.signal?.aborted) {
      finish(false);
      return;
    }
    rl.question(question, (answer) => {
      const a = answer.trim().toLowerCase();
      finish(a === 'y' || a === 'yes');
    });
    rl.on('close', () => {
      finish(false);
    });
  });
}
