import { beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { codexPinDatabaseContract } from './helpers/codex-pin-database-contract.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); });
codexPinDatabaseContract(async () => ({ engine }), false);
afterAll(async () => { await engine?.disconnect(); });
