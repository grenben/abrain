import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexThinkContract } from '../helpers/codex-think-contract.ts';
codexThinkContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
