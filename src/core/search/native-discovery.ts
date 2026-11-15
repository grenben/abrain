import type { NativeDiscoveryScope } from '../types.ts';
import { privatePagesFilterFragment } from './private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';

/** Host prefix grants are SQL predicates, not post-pagination result filters. */
export function nativeDiscoveryClause(alias: string, scope?: NativeDiscoveryScope): string {
  if (!scope) return '';
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('invalid_native_discovery_alias');
  const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const prefixes = scope.allowedSlugPrefixes;
  if (!Array.isArray(prefixes) || prefixes.length > 16 || prefixes.some(p => typeof p !== 'string' || p.length === 0 || p.length > 257 ||
      (p.includes('*') && (!p.endsWith('/*') || p.slice(0, -2).includes('*'))))) throw new Error('invalid_native_discovery_scope');
  const allowed = prefixes.map((p: string) => p.endsWith('/*')
    ? `${alias}.slug LIKE ${quote(p.slice(0, -1).replace(/[\\%_]/g, (c: string) => '\\' + c) + '%')} ESCAPE '\\'`
    : `${alias}.slug = ${quote(p)}`).join(' OR ') || 'false';
  return ` AND (${allowed}) AND COALESCE(${alias}.frontmatter->>'visibility','world')='world'
    AND ${privatePagesFilterFragment(alias)} AND ${quarantineFilterFragment(alias)}`;
}
