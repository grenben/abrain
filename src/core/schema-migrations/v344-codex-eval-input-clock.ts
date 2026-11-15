import type { Migration } from './types.ts';

/** Tables that can change the retrieval candidates, pair evidence, or search routing of the private contradiction eval. */
export const CODEX_EVAL_INPUT_TABLES = [
  'sources', 'config', 'content_chunks', 'takes', 'facts', 'tags', 'links',
  'link_relationships', 'link_transitions', 'slug_aliases', 'page_aliases',
  'retrieval_weights', 'dream_verdicts', 'timeline_entries',
  'page_body_manifest', 'page_segment_texts',
] as const;

export const v344: Migration = {
  version: 344,
  name: 'codex_eval_input_clock',
  idempotent: true,
  sql: `
    CREATE SEQUENCE IF NOT EXISTS codex_eval_input_clock_seq;
    CREATE OR REPLACE FUNCTION bump_codex_eval_input_clock_fn() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $func$
    BEGIN
      PERFORM nextval('codex_eval_input_clock_seq');
      RETURN NULL;
    END;
    $func$;
    ${CODEX_EVAL_INPUT_TABLES.map(table => `
      DROP TRIGGER IF EXISTS bump_codex_eval_input_clock_trg ON ${table};
      CREATE TRIGGER bump_codex_eval_input_clock_trg
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION bump_codex_eval_input_clock_fn();
    `).join('\n')}
  `,
};
