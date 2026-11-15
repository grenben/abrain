import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { CodexProposalError } from '../../core/ai/providers/codex-contract.ts';
import type { BrainstormEvalFixture, BrainstormEvalThresholds } from './metrics.ts';
import { digest } from '../../core/persistence/digest.ts';
export interface BrainstormEvalInput {
    path: string;
    source?: string;
    limit?: number;
    thresholds: BrainstormEvalThresholds;
}
const invalid = (): never => { throw new CodexProposalError('invalid_input'); };
/** Read one bounded regular file once; malformed rows never silently shrink a private evaluation. */
export function captureBrainstormFixtures(input: BrainstormEvalInput): {
    fixtures: BrainstormEvalFixture[];
    hash: string;
    total: number;
} {
    const t = input.thresholds;
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) ||
        !Number.isFinite(t.distance_min) || t.distance_min < 0 || t.distance_min > 1 || !Number.isFinite(t.usefulness_min) || t.usefulness_min < 1 || t.usefulness_min > 5 ||
        !Number.isFinite(t.grounding_min) || t.grounding_min < 0 || t.grounding_min > 1)
        invalid();
    const fd = openSync(input.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1048576)
            invalid();
        const buffer = Buffer.alloc(1048577);
        let n = 0, count = 0;
        while (n < buffer.length && (count = readSync(fd, buffer, n, buffer.length - n, null)) > 0)
            n += count;
        if (n > 1048576)
            invalid();
        bytes = buffer.subarray(0, n);
    }
    finally {
        closeSync(fd);
    }
    const fixtures: BrainstormEvalFixture[] = [];
    try {
        for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes!).split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['question', 'expected_far_prefixes', 'notes'].includes(k)) ||
                typeof value.question !== 'string' || !value.question.trim() || value.question.length > 16000 ||
                value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000) ||
                value.expected_far_prefixes !== undefined && (!Array.isArray(value.expected_far_prefixes) || value.expected_far_prefixes.length > 24 || value.expected_far_prefixes.some((p: unknown) => typeof p !== 'string' || !p.trim() || p.length > 300)))
                invalid();
            fixtures.push(value);
            if (fixtures.length > 1000)
                invalid();
        }
    }
    catch {
        invalid();
    }
    if (!fixtures.length)
        invalid();
    return { fixtures: fixtures.slice(0, input.limit), hash: digest(bytes!.toString('base64')), total: fixtures.length };
}
