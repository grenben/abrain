import { cwdDotenvAssignsKey } from '../env-trust.ts';

/** Private, explicit opt-in. A cwd dotenv assignment is never operator intent. */
export function privateCodexEnabled(): boolean {
  return process.env.GBRAIN_PRIVATE_CODEX_CLI === '1' &&
    !cwdDotenvAssignsKey('GBRAIN_PRIVATE_CODEX_CLI');
}

export function isPrivateCodexModel(model: string): boolean {
  if (typeof model !== 'string' || !model) return false;
  const id = model.trim();
  const colon = id.indexOf(':');
  const separator = colon !== -1 ? colon : id.indexOf('/');
  if (separator <= 0 || separator === id.length - 1) return false;
  const provider = id.slice(0, separator).trim().toLowerCase();
  const modelId = id.slice(separator + 1).trim();
  return provider === 'codex-cli' && modelId.length > 0;
}

export function isQualifiedModelId(model: string, providerIds: Iterable<string>): boolean {
  const id = model.trim();
  const colon = id.indexOf(':');
  if (colon > 0 && colon < id.length - 1) return true;
  const slash = id.indexOf('/');
  return slash > 0 && slash < id.length - 1 &&
    (id.slice(0, slash).trim().toLowerCase() === 'codex-cli' ||
     new Set(providerIds).has(id.slice(0, slash).trim().toLowerCase()));
}

export function prefixWithProviderFrom(original: string, bare: string): string {
  const colon = original.indexOf(':');
  const slash = original.indexOf('/');
  const separator = colon !== -1 ? colon : slash;
  return separator === -1 ? bare : `${original.slice(0, separator)}${original[separator]}${bare}`;
}
