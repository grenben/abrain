import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexJobContract } from '../helpers/codex-job-contract.ts';

codexJobContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
