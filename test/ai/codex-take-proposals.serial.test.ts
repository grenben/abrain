import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexTakeProposalsContract } from '../helpers/codex-take-proposals-contract.ts';

codexTakeProposalsContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
