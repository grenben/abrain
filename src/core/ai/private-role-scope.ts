import type { CodexSubscriptionContext } from './subscription-context.ts';
import { codexSubscriptionContext, withCodexSubscription } from './subscription-context.ts';
import { SubscriptionAdmissionError } from './subscription-admission.ts';
import type { PrivateRole } from './private-roles.ts';
import { readPrivateCodexConfig, requirePrivateRole, privatePolicyFingerprint, PrivateRoutingError } from './private-policy.ts';

/** Also usable for grant-free cache reads and inside an existing scratch scope. */
export function privatePolicyCheck(roles: readonly PrivateRole[] = []): () => void {
  const policy = readPrivateCodexConfig();
  if (!policy) return () => {};
  for (const role of roles) requirePrivateRole(policy, role);
  const fingerprint = privatePolicyFingerprint(policy);
  return () => {
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== fingerprint)
      throw new PrivateRoutingError('role_scope:policy_changed');
  };
}

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
export async function withPrivateRoleScope<T>(roles: readonly PrivateRole[], run: () => Promise<T>, requireGrant = true): Promise<T> {
  if (!readPrivateCodexConfig()) return run();
  const host = codexSubscriptionContext();
  if (!host) {
    if (requireGrant) throw new SubscriptionAdmissionError('subscription_required');
    // Legacy phase envelopes report missing admission through their own budget
    // result. They still cannot dispatch; keep policy-bound cache reads fenced.
    const check = privatePolicyCheck(roles);
    const result = await run(); check(); return result;
  }
  const scope = bindPrivateRoleScope(host, roles);
  return withCodexSubscription(scope, async () => {
    await scope.checkAuthority?.();
    const result = await run();
    await scope.checkAuthority?.();
    return result;
  });
}
