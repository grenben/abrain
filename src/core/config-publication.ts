import { constants, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export class ConfigPublicationUncertainError extends Error {
  constructor() {
    super('Config was renamed into place, but directory durability could not be confirmed');
    this.name = 'ConfigPublicationUncertainError';
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
