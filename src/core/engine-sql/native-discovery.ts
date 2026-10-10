import type { NativeDiscoveryScope } from '../page-read-policy.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';

/** Keep grant values bound in the shared listing query on both storage engines. */
export function nativeDiscoveryFilter(scope?: NativeDiscoveryScope) {
  if (!scope) return sqlFragment``;
  const exact = scope.allowedSlugPrefixes.filter(p => !p.endsWith('/*'));
  const globs = scope.allowedSlugPrefixes.filter(p => p.endsWith('/*')).map(p => p.slice(0, -1).replace(/[\\%_]/g, c => '\\' + c) + '%');
  return sqlFragment` AND (p.slug = ANY(${exact}::text[]) OR p.slug LIKE ANY(${globs}::text[]))
    AND COALESCE(p.frontmatter->>'visibility','world')='world'
    AND ${trustedSql(privatePagesFilterFragment('p'))} AND ${trustedSql(quarantineFilterFragment('p'))}`;
}
