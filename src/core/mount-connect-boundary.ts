/**
 * Generic ordering seam for connecting a mounted brain. Registry construction
 * validates the mount before host configuration or gateway work can happen;
 * the host gateway is then configured before getBrain performs the actual
 * engine connection. Keeping getBrain last also preserves lazy registry init.
 */
export async function connectMountEngineBoundary<TConfig, THandle>(
  brainId: string,
  dependencies: {
    loadRegistry: () => { getBrain(id: string): Promise<THandle> };
    loadHostConfig: () => TConfig | null;
    configureGateway: (config: TConfig) => void | Promise<void>;
  },
): Promise<THandle> {
  const registry = dependencies.loadRegistry();
  const config = dependencies.loadHostConfig();
  if (config !== null) await dependencies.configureGateway(config);
  return registry.getBrain(brainId);
}
