import { describe, expect, test } from 'bun:test';
import { buildCJKKeywordSql, type CjkKeywordCtx } from '../src/core/search/cjk-keyword-sql.ts';
import { buildSearchTitlesStatement } from '../src/core/search/title-statement.ts';

const cjkCtx: CjkKeywordCtx = {
  limit: 5,
  offset: 0,
  innerLimit: 15,
  sourceFactorCase: '1.0',
  hardExcludeClause: '',
  visibilityClause: '',
  detailFilter: '',
  opts: undefined,
  dedup: true,
};

const titleDialect = { relaxedPrefersIndex: false, staleProbe: false };

describe('search SQL date bounds and indexed NBSP title recovery', () => {
  test('CJK keyword SQL binds date-only bounds at UTC midnight', () => {
    const statement = buildCJKKeywordSql('東京', {
      ...cjkCtx,
      opts: { afterDate: '2030-06-15', beforeDate: '2030-06-16' },
    })!;

    expect(statement.params).toContain('2030-06-15T00:00:00Z');
    expect(statement.params).toContain('2030-06-16T00:00:00Z');
    expect(statement.sql).toContain('COALESCE(p.effective_date, p.updated_at, p.created_at)');
  });

  test('title SQL binds date-only bounds at UTC while retaining title filters', () => {
    const statement = buildSearchTitlesStatement('acme', {
      afterDate: '2030-06-15',
      beforeDate: '2030-06-16',
      types: ['company'],
      exclude_slugs: ['companies/acme-example'],
      sourceIds: ['source-a'],
    }, titleDialect);

    expect(statement.params).toContain('2030-06-15T00:00:00Z');
    expect(statement.params).toContain('2030-06-16T00:00:00Z');
    expect(statement.sql).toContain('p.type = ANY(');
    expect(statement.sql).toContain('p.slug != ALL(');
    expect(statement.sql).toContain('p.source_id = ANY(');
    expect(statement.sql).toContain('COALESCE(p.effective_date, p.updated_at, p.created_at)');
  });

  test('plain ASCII title queries get a trailing-NBSP probe through the indexed vector', () => {
    const statement = buildSearchTitlesStatement('acme', undefined, titleDialect);

    expect(statement.sql).toContain("p.search_vector @@ (websearch_to_tsquery(");
    expect(statement.sql).toContain("gbrain_fts_input($1 || chr(160))");
    expect(statement.sql).toContain('ORDER BY exact_title DESC, score DESC, p.id ASC');
    expect(statement.params[0]).toBe('acme');
  });

  test('multi-token title queries do not add an NBSP probe', () => {
    const statement = buildSearchTitlesStatement('acme example', undefined, titleDialect);
    expect(statement.sql).not.toContain('gbrain_fts_input($1 || chr(160))');
  });
});
