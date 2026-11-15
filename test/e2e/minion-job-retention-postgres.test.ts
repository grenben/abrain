import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';

const suite = hasDatabase() ? describe : describe.skip;

suite('Postgres private recovery job retention', () => {
  let queue: MinionQueue;
  beforeAll(async () => {
    await setupDB();
    await runMigrations(getEngine());
    queue = new MinionQueue(getEngine());
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  async function retainAsBootstrap(jobId: number): Promise<void> {
    const requestId = crypto.randomUUID();
    const runId = `codex-job:${jobId}:retention-fixture:${requestId}`;
    await getEngine().transaction(async tx => {
      await tx.executeRaw(
        `INSERT INTO codex_subscription_runs(run_id,account_lane,max_attempts,max_turns,deadline)
         VALUES($1,'codex-subscription',1,1,now() + interval '1 hour')`,
        [runId]
      );
      await tx.executeRaw(
        `INSERT INTO codex_skillopt_bootstraps(run_id,protocol,input,input_hash,request_id,job_id)
         VALUES($1,1,'{}'::jsonb,$2,$3::uuid,$4)`,
        [runId, 'a'.repeat(64), requestId, jobId]
      );
    });
  }

  async function claim(jobId: number, name: string, token: string): Promise<void> {
    const claimed = await queue.claim(token, 60_000, 'default', [name]);
    expect(claimed?.id).toBe(jobId);
  }

  async function failAsDead(jobId: number, name: string, token: string): Promise<void> {
    await claim(jobId, name, token);
    expect(await queue.failJob(jobId, token, 'retention fixture', 'dead')).not.toBeNull();
  }

  test('prune preview and mutation share retention eligibility', async () => {
    const protectedJob = await queue.add('retention-prune-protected', {});
    const ordinaryJob = await queue.add('retention-prune-ordinary', {});
    await failAsDead(protectedJob.id, protectedJob.name, 'retention-prune-protected-token');
    await failAsDead(ordinaryJob.id, ordinaryJob.name, 'retention-prune-ordinary-token');
    await getEngine().executeRaw(
      `UPDATE minion_jobs SET updated_at=now()-interval '60 days'
       WHERE id=ANY($1::bigint[])`,
      [[protectedJob.id, ordinaryJob.id]]
    );
    await retainAsBootstrap(protectedJob.id);
    const olderThan = new Date(Date.now() - 30 * 86400000);

    expect(await queue.prune({ olderThan, dryRun: true })).toBe(1);
    expect(await queue.prune({ olderThan })).toBe(1);
    expect(await queue.getJob(protectedJob.id)).not.toBeNull();
    expect(await queue.getJob(ordinaryJob.id)).toBeNull();
  });

  test('explicit removal refuses permanent private identities', async () => {
    const job = await queue.add('retention-remove', {});
    await failAsDead(job.id, job.name, 'retention-remove-token');
    await retainAsBootstrap(job.id);

    expect(await queue.removeJob(job.id)).toBe(false);
    expect(await queue.getJob(job.id)).not.toBeNull();
  });

  test('remove_on_complete does not erase a permanently referenced job', async () => {
    const job = await queue.add('retention-complete', {}, { remove_on_complete: true });
    const token = 'retention-complete-token';
    await claim(job.id, job.name, token);
    await retainAsBootstrap(job.id);

    expect(await queue.completeJob(job.id, token, {})).not.toBeNull();
    expect((await queue.getJob(job.id))?.status).toBe('completed');
  });

  test('remove_on_fail does not erase a permanently referenced job', async () => {
    const job = await queue.add('retention-fail', {}, { remove_on_fail: true });
    const token = 'retention-fail-token';
    await claim(job.id, job.name, token);
    await retainAsBootstrap(job.id);

    expect(await queue.failJob(job.id, token, 'fixture failure', 'dead')).not.toBeNull();
    expect((await queue.getJob(job.id))?.status).toBe('dead');
  });
});
