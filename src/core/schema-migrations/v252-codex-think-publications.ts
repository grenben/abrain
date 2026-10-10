import type { Migration } from './types.ts';
import { THINK_PUBLICATION_SCHEMA_SQL } from '../think/publication-schema.ts';

export const v252: Migration = {
  version: 252, name: 'codex_think_publications', idempotent: true,
  sql: THINK_PUBLICATION_SCHEMA_SQL,
};
