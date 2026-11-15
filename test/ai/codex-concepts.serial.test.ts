import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexConceptsContract } from '../helpers/codex-concepts-contract.ts';
codexConceptsContract(async () => { const engine = new PGLiteEngine(); await engine.connect({}); return { engine }; });
