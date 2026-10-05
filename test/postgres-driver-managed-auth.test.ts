import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';

const timeoutMs = 4_000;
const roots: string[] = [];
const servers: ProtocolServer[] = [];
const clients: Array<ReturnType<typeof postgres>> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (sql) => {
    await Promise.race([sql.end({ timeout: 0.2 }), delay(timeoutMs)]).catch(() => {});
  }));
  await Promise.all(servers.splice(0).map(async (server) => {
    const closing = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of server.openSockets) socket.destroy();
    await bounded(closing, timeoutMs, 'server close').catch(() => {});
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed postgres.js authentication', () => {
  test('uses the explicit full Unix socket filename and requests callback credentials for every challenge', async () => {
    const root = await makeSocketRoot();
    const socketPath = join(root, 'managed socket.s.PGSQL.55432');
    let callbacks = 0;
    const printed: string[] = [];
    const original = [console.log, console.info, console.warn, console.error];
    console.log = (...args) => printed.push(args.join(' '));
    console.info = (...args) => printed.push(args.join(' '));
    console.warn = (...args) => printed.push(args.join(' '));
    console.error = (...args) => printed.push(args.join(' '));

    const server = protocolServer(socketPath, async (socket, state) => {
      if (state.passwords.length < 2) {
        socket.write(authCleartext());
      } else {
        socket.write(errorResponse());
        socket.end();
      }
    });
    servers.push(server);
    await listen(server, socketPath);
    const sql = postgres({ path: socketPath, port: 55432, database: 'managed', user: 'managed', max: 1,
      connect_timeout: 5, idle_timeout: 0.1,
      pass: async () => `local-secret-${++callbacks}`,
    });
    clients.push(sql);

    try {
      await expect(Promise.race([sql`select 1`, delay(timeoutMs).then(() => { throw new Error('query timed out'); })]))
        .rejects.toBeDefined();
      expect(callbacks, `password replies: ${server.passwordMessages.join('|')}`).toBe(2);
      expect(server.lastSocketPath).toBe(socketPath);
      expect(server.passwordMessages).toEqual(['local-secret-1', 'local-secret-2']);
      expect(printed.join('\n')).not.toContain('local-secret');
    } finally {
      [console.log, console.info, console.warn, console.error] = original;
    }
  });

  test('settles and closes safely when the async credential callback rejects', async () => {
    const root = await makeSocketRoot();
    const socketPath = join(root, 'managed socket.s.PGSQL.55433');
    const sentinel = new Error('postgres://alice:ultra-secret@localhost/db raw-token\nsecond-line');
    const publicText: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const server = protocolServer(socketPath, (socket) => socket.write(authCleartext()));
    servers.push(server);
    await listen(server, socketPath);
    const sql = postgres({ path: socketPath, port: 55433, database: 'managed', user: 'managed', max: 1,
      connect_timeout: 5, idle_timeout: 0.1,
      pass: async () => { throw sentinel; },
    });
    clients.push(sql);

    try {
      const result = await Promise.race([
        sql`select 1`.then(() => 'resolved', (error: unknown) => {
          publicText.push(String(error));
          return 'rejected';
        }),
        delay(timeoutMs).then(() => 'timeout'),
      ]);
      await delay(50);
      expect(result).toBe('rejected');
      expect(server.closed).toBe(true);
      expect(unhandled).toEqual([]);
      expect(publicText.join('\n')).not.toContain('ultra-secret');
      expect(publicText.join('\n')).not.toContain('raw-token');
      expect(publicText.join('\n')).not.toContain('second-line');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  test('handles AuthenticationOk synchronously before readiness and query processing', async () => {
    const root = await makeSocketRoot();
    const socketPath = join(root, 'managed socket.s.PGSQL.55434');
    const unhandled: unknown[] = [];
    const publicText: string[] = [];
    let callbacks = 0;
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const server = protocolServer(socketPath, (socket) => {
      socket.write(authentication(0));
      socket.write(readyForQuery());
    }, (socket) => {
      socket.write(Buffer.concat([
        backendMessage(49), // ParseComplete
        backendMessage(50), // BindComplete
        backendMessage(110), // NoData
        backendMessage(67, Buffer.from('SELECT 0\0')),
        readyForQuery(),
      ]));
    });
    servers.push(server);
    await listen(server, socketPath);
    const sql = postgres({ path: socketPath, port: 55434, database: 'managed', user: 'managed', max: 1,
      connect_timeout: 5, idle_timeout: 0.1, fetch_types: false,
      pass: async () => { callbacks++; return 'unused-secret'; },
    });
    clients.push(sql);

    try {
      const result = await Promise.race([
        sql`select 1`.then(() => 'resolved', (error: unknown) => {
          publicText.push(String(error));
          return 'rejected';
        }),
        delay(timeoutMs).then(() => 'timeout'),
      ]);
      await delay(25);
      expect(result, `frontend messages: ${server.frontendTypes.join(',')}`).toBe('resolved');
      expect(callbacks).toBe(0);
      await bounded(sql.end({ timeout: 0.2 }), timeoutMs, 'client close');
      await bounded(waitForClose(server), timeoutMs, 'server close');
      expect(server.closed).toBe(true);
      expect(publicText.join('\n')).not.toContain('TypeError');
      expect(publicText.join('\n')).not.toContain('catch');
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

interface ProtocolState {
  buffer: Buffer;
  startup: boolean;
  passwords: string[];
}

type ProtocolServer = ReturnType<typeof createServer> & {
  lastSocketPath: string;
  passwordMessages: string[];
  closed: boolean;
  openSockets: Socket[];
  frontendTypes: number[];
};

function protocolServer(
  socketPath: string,
  onPassword: (socket: Socket, state: ProtocolState) => void,
  onQuery: (socket: Socket) => void = () => {},
): ProtocolServer {
  const server = Object.assign(createServer((socket) => {
    const state: ProtocolState = { buffer: Buffer.alloc(0), startup: false, passwords: [] };
    socket.on('data', (chunk: Buffer | string) => {
      state.buffer = Buffer.concat([state.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (!state.startup) {
        if (state.buffer.length < 4 || state.buffer.length < state.buffer.readInt32BE(0)) return;
        const length = state.buffer.readInt32BE(0);
        const startup = state.buffer.subarray(4, length);
        if (startup.readInt32BE(0) !== 196608) throw new Error('expected PostgreSQL StartupMessage');
        state.startup = true;
        state.buffer = state.buffer.subarray(length);
        onPassword(socket, state);
      }
      while (state.buffer.length >= 5) {
        const length = state.buffer.readInt32BE(1);
        if (state.buffer.length < length + 1) break;
        const message = state.buffer.subarray(0, length + 1);
        state.buffer = state.buffer.subarray(length + 1);
        server.frontendTypes.push(message[0]!);
        if (message[0] === 112) {
          const password = message.toString('utf8', 5, message.length - 1);
          state.passwords.push(password);
          server.passwordMessages.push(password);
          onPassword(socket, state);
        } else if (message[0] === 83) {
          onQuery(socket);
        }
      }
    });
    socket.on('close', () => { server.closed = true; });
  }), { lastSocketPath: '', passwordMessages: [] as string[], closed: false, openSockets: [] as Socket[], frontendTypes: [] as number[] }) as ProtocolServer;
  server.on('connection', () => { server.lastSocketPath = socketPath; });
  server.on('connection', (socket) => { server.openSockets.push(socket); });
  return server;
}

function authCleartext(): Buffer {
  return authentication(3);
}

function authentication(type: number): Buffer {
  const frame = Buffer.alloc(9);
  frame[0] = 82;
  frame.writeInt32BE(8, 1);
  frame.writeInt32BE(type, 5);
  return frame;
}

function readyForQuery(): Buffer {
  return backendMessage(90, Buffer.from('I'));
}

function backendMessage(type: number, payload = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = type;
  frame.writeInt32BE(4 + payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function errorResponse(): Buffer {
  const fields = Buffer.from('SERROR\0C28P01\0Mauthentication failed\0\0');
  const frame = Buffer.alloc(5 + fields.length);
  frame[0] = 69;
  frame.writeInt32BE(4 + fields.length, 1);
  fields.copy(frame, 5);
  return frame;
}

async function makeSocketRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'postgres managed auth '));
  roots.push(root);
  return root;
}

async function listen(server: ProtocolServer, socketPath: string): Promise<void> {
  await bounded(new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  }), timeoutMs, 'server readiness');
}

async function waitForClose(server: ProtocolServer): Promise<void> {
  if (server.closed) return;
  await new Promise<void>((resolve) => {
    const socket = server.openSockets[0];
    socket ? socket.once('close', () => resolve()) : resolve();
  });
}

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
