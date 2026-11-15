import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexActionsContract } from '../helpers/codex-actions-contract.ts';
codexActionsContract(async () => { const engine = new PGLiteEngine(); await engine.connect({}); return { engine }; }, 'pglite');
