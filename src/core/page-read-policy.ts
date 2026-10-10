export interface NativeDiscoveryScope { allowedSlugPrefixes: readonly string[] }

/** v0.26.5 — opts for getPage / softDeletePage / restorePage. */
export interface PageReadScope {
  sourceId?: string;
  sourceIds?: string[];
  /** Resolved by the trusted operation layer, never from MCP parameters. */
  excludePrivate?: boolean;
  /** Untrusted chunk reads require a verified protected-body index, even with visibility opt-outs. */
  requireSafeChunks?: boolean;
  /** #5575 read floor: only pages at or above this tier; a chunk inherits its page's tier. */
  minTrust?: import('./trust/tier.ts').TrustTier;
  /** #5575 proactive reads: hide flagged unconfirmed agent-written pages. */
  suppressFlagged?: boolean;
}

export interface PageReadPolicy extends PageReadScope {
  nativeDiscovery?: NativeDiscoveryScope;
  /** Undefined is unrestricted; an empty list permits no holders. */
  takesHoldersAllowList?: string[];
}
