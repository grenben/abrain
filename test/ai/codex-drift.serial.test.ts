import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexDriftContract } from '../helpers/codex-drift-contract.ts';

codexDriftContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
