import type { BrainEngine } from '../engine.ts';
import type { AutoThinkRun } from './auto-think-store.ts';
import { autoThinkConflict, recheckAutoThink } from './auto-think-store.ts';
import { OperationError } from '../ops/contract.ts';
/** Serialize batch acceptance with topology changes and other cycle owners. */
export async function acceptAutoThinkBatch(engine: BrainEngine, candidate: AutoThinkRun, cooldownDays: number): Promise<AutoThinkRun | null> {
    return engine.transaction(async (tx) => {
        await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
        await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        await recheckAutoThink(tx, candidate);
        const [existing] = await tx.executeRaw<AutoThinkRun>('SELECT * FROM codex_auto_think_runs WHERE run_id=$1 AND source_id=$2', [candidate.run_id, candidate.source_id]);
        if (existing) {
            if (existing.input_hash !== candidate.input_hash)
                autoThinkConflict();
            // A new lease cannot silently reinterpret the original retained authority.
            await recheckAutoThink(tx, existing);
            return existing;
        }
        const pending = await tx.executeRaw("SELECT 1 FROM codex_auto_think_runs WHERE source_id=$1 AND state='accepted' LIMIT 1", [candidate.source_id]);
        if (pending.length)
            throw new OperationError('write_pending', 'Automatic think has an unfinished batch.', 'Resume its original subscription request and reconcile retained answers before starting another batch.');
        const cooldown = await tx.executeRaw("SELECT 1 FROM codex_auto_think_runs WHERE source_id=$1 AND state='complete' AND completed_at>now()-($2::double precision*interval '1 day') LIMIT 1", [candidate.source_id, cooldownDays]);
        if (cooldown.length)
            return null;
        await tx.executeRaw('INSERT INTO codex_auto_think_runs(run_id,source_id,source_incarnation,input_hash,binding) VALUES($1,$2,$3::uuid,$4,$5::text::jsonb)', [candidate.run_id, candidate.source_id, candidate.source_incarnation, candidate.input_hash, JSON.stringify(candidate.binding)]);
        return candidate;
    });
}
