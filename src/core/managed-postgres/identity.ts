import { join } from 'node:path';
import type { ManagedPaths, OwnerMetadata } from './ownership.ts';

export interface LiveIdentity {
  data_directory: string;
  server_version_num: number;
  port: number;
  database: string;
  role: string;
  system_identifier: string;
  listen_addresses: string;
  socket_directories: string;
  config_file: string;
  hba_file: string;
  password_encryption: string;
}

export const MANAGED_IDENTITY_QUERY = `SELECT json_build_object('data_directory',current_setting('data_directory'),'server_version_num',current_setting('server_version_num')::int,'port',current_setting('port')::int,'database',current_database(),'role',current_user,'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),'listen_addresses',current_setting('listen_addresses'),'socket_directories',current_setting('unix_socket_directories'),'config_file',current_setting('config_file'),'hba_file',current_setting('hba_file'),'password_encryption',current_setting('password_encryption'))::text AS identity`;

function configLiteral(value: string): string { return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`; }

export function renderManagedPostgresConfig(owner: OwnerMetadata, paths: ManagedPaths): { config: string; hba: string } {
  const hba = join(paths.data, 'pg_hba.conf');
  return {
    config: [
      `listen_addresses = '127.0.0.1'`, `port = ${owner.port}`, `unix_socket_directories = ${configLiteral(owner.socketPath)}`,
      "unix_socket_permissions = 0700", "password_encryption = 'scram-sha-256'", `hba_file = ${configLiteral(hba)}`,
      `logging_collector = on`, `log_directory = ${configLiteral(paths.log)}`, "log_filename = 'postgresql.log'", 'log_file_mode = 0600', 'ssl = off', 'max_connections = 20', '',
    ].join('\n'),
    hba: 'local all all scram-sha-256\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\nhost replication all 0.0.0.0/0 reject\nhost replication all ::/0 reject\n',
  };
}

export function parseLiveIdentity(value: unknown): LiveIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const live = value as Partial<LiveIdentity>;
  const strings: Array<keyof LiveIdentity> = ['data_directory', 'database', 'role', 'system_identifier', 'listen_addresses', 'socket_directories', 'config_file', 'hba_file', 'password_encryption'];
  if (strings.some(key => typeof live[key] !== 'string' || !live[key]!.trim()) ||
      typeof live.server_version_num !== 'number' || !Number.isFinite(live.server_version_num) || !Number.isInteger(live.server_version_num) ||
      typeof live.port !== 'number' || !Number.isFinite(live.port) || !Number.isInteger(live.port)) return null;
  return live as LiveIdentity;
}

export function verifyManagedPostgresLiveIdentity(value: unknown, owner: OwnerMetadata, paths: ManagedPaths, expectedDatabase: string): LiveIdentity | null {
  const live = parseLiveIdentity(value);
  if (!live || live.data_directory !== owner.dataPath || live.server_version_num < 170000 || live.server_version_num >= 180000 ||
      live.port !== owner.port || live.database !== expectedDatabase || live.role !== owner.role ||
      live.system_identifier !== owner.systemIdentifier || live.listen_addresses !== '127.0.0.1' ||
      live.socket_directories !== owner.socketPath || live.config_file !== join(paths.data, 'postgresql.conf') ||
      live.hba_file !== join(paths.data, 'pg_hba.conf') || live.password_encryption !== 'scram-sha-256') return null;
  return live;
}
