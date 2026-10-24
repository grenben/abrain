import type { CodexSubscriptionContext } from './subscription-context.ts';
import type { PrivateRole } from './private-roles.ts';
import { readPrivateCodexConfig, requirePrivateRole, privatePolicyFingerprint, PrivateRoutingError } from './private-policy.ts';

/** Pin activation and tier selection through retained-result reads and host effects,
 * including changes made while an asynchronous authority check is suspended. */
export function bindPrivateRoleScope(host: CodexSubscriptionContext, roles: readonly PrivateRole[]): CodexSubscriptionContext {
  const policy = readPrivateCodexConfig();
  if (!policy) throw new PrivateRoutingError('role_scope:policy_missing');
  for (const role of roles) requirePrivateRole(policy, role);
  const fingerprint = privatePolicyFingerprint(policy);
  const check = () => {
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== fingerprint)
      throw new PrivateRoutingError('role_scope:policy_changed');
  };
  return { ...host,
    checkAuthority: async () => { check(); await host.checkAuthority?.(); check(); },
    checkAuthorityInTransaction: async tx => { check(); await host.checkAuthorityInTransaction?.(tx); check(); },
  };
}
