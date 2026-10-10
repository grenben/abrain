import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from '../persistence/digest.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
const fixtures = new AsyncLocalStorage<{
    grantId: string;
    runId: string;
}>();
/** Host-only evaluation identity. Native admission continues using the original grant. */
export function withBrainstormFixture<T>(grantId: string, key: string, run: () => Promise<T>): Promise<T> {
    if (fixtures.getStore() || !/^[a-f0-9]{64}$/.test(key))
        throw new SubscriptionAdmissionError('subscription_identity_conflict');
    return fixtures.run({ grantId, runId: `codex-brainstorm-fixture:${digest([grantId, key])}` }, run);
}
export function brainstormRunIdentity(grantId: string): string {
    const fixture = fixtures.getStore();
    if (fixture && fixture.grantId !== grantId)
        throw new SubscriptionAdmissionError('subscription_identity_conflict');
    return fixture?.runId ?? grantId;
}
