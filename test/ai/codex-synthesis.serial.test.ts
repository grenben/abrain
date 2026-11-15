import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexSynthesisContract } from '../helpers/codex-synthesis-contract.ts';
codexSynthesisContract(async()=>{const engine=new PGLiteEngine();await engine.connect({});return {engine};});
