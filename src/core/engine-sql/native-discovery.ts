import type { NativeDiscoveryScope } from '../page-read-policy.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { pageEligibleSql } from '../eligibility/sql.ts';
import { currentTextProjectionFilter, safeChunksFilter } from '../search/safe-chunks.ts';

/** Keep grant values bound in the shared listing query on both storage engines. */
export function nativeDiscoveryFilter(scope?: NativeDiscoveryScope) {
  if (!scope) return sqlFragment``;
  if (!Array.isArray(scope.allowedSlugPrefixes) || scope.allowedSlugPrefixes.length > 16 ||
      scope.allowedSlugPrefixes.some(p => typeof p !== 'string' || p.length === 0 || p.length > 257 ||
        (p.includes('*') && (!p.endsWith('/*') || p.slice(0, -2).includes('*'))))) throw new Error('invalid_native_discovery_scope');
  const exact = scope.allowedSlugPrefixes.filter(p => !p.endsWith('/*'));
  const globs = scope.allowedSlugPrefixes.filter(p => p.endsWith('/*')).map(p => p.slice(0, -1).replace(/[\\%_]/g, (c: string) => '\\' + c) + '%');
  return sqlFragment` AND (p.slug = ANY(${exact}::text[]) OR p.slug LIKE ANY(${globs}::text[]))
    AND COALESCE(p.frontmatter->>'visibility','world')='world'
    AND ${trustedSql(privatePagesFilterFragment('p'))} AND ${trustedSql(quarantineFilterFragment('p'))}
    AND ${trustedSql(pageEligibleSql('p', { floor: scope.minTrust, suppressFlagged: scope.suppressFlagged }))}
    ${scope.requireSafeChunks ? trustedSql(`AND ${safeChunksFilter('p')} AND ${currentTextProjectionFilter('p')}`) : sqlFragment``}`;
}
