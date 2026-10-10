import type { ThinkResult } from './index.ts';
import type { WriteAdmission } from '../persistence/journal.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
export interface ThinkEvidence {
    sourceId: string;
    incarnation: string;
    slug: string;
    id: number;
    revision: string;
    private: boolean;
    authority: WriteAuthority;
    takes: Array<{
        id: number;
        row: number;
        hash: string;
    }>;
}
export interface ThinkPublicationPayload {
    version: 1;
    inputHash: string;
    result: ThinkResult;
    evidence: ThinkEvidence[];
    fence?: CodexSubscriptionContext['publicationFence'];
    actions: Array<{
        kind: 'page' | 'take';
        expectedRevision: string | null;
        admission: WriteAdmission;
    }>;
}
export interface ThinkPublicationPlan {
    plan_id: string;
    run_id: string;
    request_key: string;
    source_id: string;
    source_incarnation: string;
    payload: ThinkPublicationPayload;
    payload_hash: string;
    admitted: number[];
    state: 'accepted' | 'complete';
}
