import { constants, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, lstatSync, fstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export class ConfigPublicationUncertainError extends Error {
  constructor() {
    super('Config was renamed into place, but directory durability could not be confirmed');
    this.name = 'ConfigPublicationUncertainError';
  }
}

/** Safe, deliberately content-free refusal at the shared config boundary. */
export class ConfigPublicationRefusedError extends Error {
  constructor() {
    super('Config publication refused');
    this.name = 'ConfigPublicationRefusedError';
  }
}

export class ConfigPublicationFailedError extends Error {
  constructor() { super('Config publication failed before commit'); this.name = 'ConfigPublicationFailedError'; }
}

export class ConfigPublicationCommittedCleanupError extends Error {
  constructor() { super('Config was committed, but publication lock cleanup failed'); this.name = 'ConfigPublicationCommittedCleanupError'; }
}

export type ConfigPublicationLockDependencies = Partial<{
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  lstatSync: typeof lstatSync;
  closeSync: typeof closeSync;
  unlinkSync: typeof unlinkSync;
}>;

/** Serialize config read/validate/write sequences across processes. Existing locks are never stolen. */
export function withConfigPublicationLock<T>(
  directory: string,
  action: () => T extends PromiseLike<unknown> ? never : T,
  dependencies: Readonly<ConfigPublicationLockDependencies> = {},
): T {
  const lockPath = join(directory, '.config-publication.lock');
  const open = dependencies.openSync ?? openSync;
  const fstat = dependencies.fstatSync ?? fstatSync;
  const lstat = dependencies.lstatSync ?? lstatSync;
  const close = dependencies.closeSync ?? closeSync;
  const unlink = dependencies.unlinkSync ?? unlinkSync;
  let fd: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let actionFailed = false;
  let actionSucceeded = false;
  let cleanupFailed = false;
  try {
    try {
      fd = open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const descriptorStat = fstat(fd);
      identity = { dev: descriptorStat.dev, ino: descriptorStat.ino };
      const pathStat = lstat(lockPath);
      if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
        || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) throw new ConfigPublicationRefusedError();
    } catch {
      throw new ConfigPublicationRefusedError();
    }
    const current = lstat(lockPath);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new ConfigPublicationRefusedError();
    }
    try {
      const result = action();
      if (result && typeof result === 'object' && 'then' in result && typeof (result as { then?: unknown }).then === 'function') {
        actionFailed = true;
        throw new ConfigPublicationRefusedError();
      }
      actionSucceeded = true;
      return result as T;
    }
    catch (error) { actionFailed = true; throw error; }
  } finally {
    if (fd !== undefined) {
      try { close(fd); } catch { cleanupFailed = true; }
    }
    if (identity) {
      try {
        const stat = lstat(lockPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) unlink(lockPath);
        else cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed && actionSucceeded && !actionFailed) throw new ConfigPublicationCommittedCleanupError();
  }
}

export type ConfigPublicationDependencies = Partial<{
  randomBytes: (size: number) => Uint8Array;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}>;

export type ConfigPublicationOptions = Readonly<{
  directoryDurability?: 'strict' | 'allow-unsupported';
}>;

const UNSUPPORTED_DIRECTORY_CODES = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']);

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Durably replace one file; this leaf has no config or environment dependencies. */
export function publishConfigFile(
  destination: string,
  payload: Uint8Array,
  dependencies: Readonly<ConfigPublicationDependencies> = {},
  options: ConfigPublicationOptions = {},
): void {
  const dir = dirname(destination);
  const random = dependencies.randomBytes ?? randomBytes;
  const open = dependencies.openSync ?? openSync;
  const write = dependencies.writeSync ?? writeSync;
  const sync = dependencies.fsyncSync ?? fsyncSync;
  const close = dependencies.closeSync ?? closeSync;
  const rename = dependencies.renameSync ?? renameSync;
  const unlink = dependencies.unlinkSync ?? unlinkSync;
  const tmp = `${destination}.tmp-${Buffer.from(random(16)).toString('hex')}`;
  let fd: number | undefined;
  let createdTemp = false;
  let renamed = false;
  try {
    fd = open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    createdTemp = true;
    let offset = 0;
    while (offset < payload.byteLength) {
      const written = write(fd, payload, offset, payload.byteLength - offset);
      if (written <= 0) throw new Error('Config write made no progress');
      offset += written;
    }
    sync(fd);
    close(fd);
    fd = undefined;
    rename(tmp, destination);
    renamed = true;
    let dirFd: number | undefined;
    try {
      dirFd = open(dir, 0);
      sync(dirFd);
    } catch (error) {
      if (options.directoryDurability === 'allow-unsupported'
        && UNSUPPORTED_DIRECTORY_CODES.has(errorCode(error) ?? '')) return;
      throw new ConfigPublicationUncertainError();
    } finally {
      if (dirFd !== undefined) {
        try { close(dirFd); } catch { /* retain the fsync outcome */ }
      }
    }
  } finally {
    if (fd !== undefined) {
      try { close(fd); } catch { /* preserve publication failure */ }
    }
    if (createdTemp && !renamed) {
      try { unlink(tmp); } catch { /* remove only the temp created above */ }
    }
  }
}
