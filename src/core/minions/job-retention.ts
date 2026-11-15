/**
 * Permanent private Codex records bind recovery/acceptance identities to a
 * queue row. They intentionally do not cascade on deletion, so every queue
 * retention path must use this predicate before removing a job.
 *
 * Keep this predicate shared by previews and mutations: a preview must never
 * promise a deletion that the corresponding write cannot perform (or omit a
 * row that an automatic cleanup path can delete).
 */
export function jobHasPermanentPrivateIdentitySql(jobAlias: string): string {
  return `(
    EXISTS (SELECT 1 FROM codex_parked_jobs p
            WHERE p.job_id = ${jobAlias}.id OR p.replacement_job_id = ${jobAlias}.id)
    OR EXISTS (SELECT 1 FROM codex_skillopt_rollouts r WHERE r.job_id = ${jobAlias}.id)
    OR EXISTS (SELECT 1 FROM codex_skillopt_submissions s WHERE s.job_id = ${jobAlias}.id)
    OR EXISTS (SELECT 1 FROM codex_skillopt_bootstraps b WHERE b.job_id = ${jobAlias}.id)
    OR EXISTS (SELECT 1 FROM codex_skillopt_batch_submissions s WHERE s.job_id = ${jobAlias}.id)
  )`;
}

/** Shared queue-retention eligibility predicate. */
export function jobRetentionEligibleSql(jobAlias: string): string {
  return `NOT ${jobHasPermanentPrivateIdentitySql(jobAlias)}`;
}
