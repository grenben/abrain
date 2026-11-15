import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexFactsContract } from '../helpers/codex-facts-contract.ts';

codexFactsContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
