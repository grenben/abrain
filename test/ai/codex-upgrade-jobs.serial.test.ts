import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexUpgradeJobsContract } from '../helpers/codex-upgrade-jobs-contract.ts';
codexUpgradeJobsContract(async () => { const engine = new PGLiteEngine(); await engine.connect({}); return { engine }; });
