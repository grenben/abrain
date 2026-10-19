import { test } from 'bun:test';
import { verifyCrashRecovery } from '../helpers/codex-actions-process-crash-runner.ts';

test('SIGKILL after private read retention resumes the same action on a new worker', () => verifyCrashRecovery('read'), 120_000);
test('SIGKILL before private write admission resumes one canonical effect on a new worker', () => verifyCrashRecovery('write-before'), 180_000);
test('SIGKILL after committed private write reconciles one canonical effect on a new worker', () => verifyCrashRecovery('write-after'), 180_000);
