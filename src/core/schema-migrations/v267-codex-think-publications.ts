import type { Migration } from './types.ts';
import { THINK_PUBLICATION_SCHEMA_SQL } from '../think/publication-schema.ts';

export const v267: Migration = {
  version: 267, name: 'codex_think_publications', idempotent: true,
  sql: THINK_PUBLICATION_SCHEMA_SQL,
};
