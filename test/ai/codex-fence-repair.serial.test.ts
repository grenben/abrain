import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexFenceRepairContract } from '../helpers/codex-fence-repair-contract.ts';
codexFenceRepairContract(async () => { const engine = new PGLiteEngine(); await engine.connect({}); return { engine }; });
