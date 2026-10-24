import type { CodexSubscriptionContext } from './subscription-context.ts';
import { codexSubscriptionContext, withCodexSubscription } from './subscription-context.ts';
import { SubscriptionAdmissionError } from './subscription-admission.ts';
import type { PrivateRole } from './private-roles.ts';
import { readPrivateCodexConfig, requirePrivateRole, privatePolicyFingerprint, PrivateRoutingError } from './private-policy.ts';

/** Pin activation and tier selection through retained-result reads and host effects,
 * including changes made while an asynchronous authority check is suspended. */
export function bindPrivateRoleScope(host: CodexSubscriptionContext, roles: readonly PrivateRole[], expectedFingerprint?: string): CodexSubscriptionContext {
  const policy = readPrivateCodexConfig();
  if (!policy) throw new PrivateRoutingError('role_scope:policy_missing');
  for (const role of roles) requirePrivateRole(policy, role);
  const fingerprint = privatePolicyFingerprint(policy);
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint)
    throw new PrivateRoutingError('role_scope:policy_changed');
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

/** Scope the whole feature, including cache reads and the last publication check. */
export async function withPrivateRoleScope<T>(roles: readonly PrivateRole[], run: () => Promise<T>): Promise<T> {
  if (!readPrivateCodexConfig()) return run();
  const host = codexSubscriptionContext();
  if (!host) throw new SubscriptionAdmissionError('subscription_required');
  const scope = bindPrivateRoleScope(host, roles);
  return withCodexSubscription(scope, async () => {
    await scope.checkAuthority?.();
    const result = await run();
    await scope.checkAuthority?.();
    return result;
  });
}
