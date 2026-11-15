import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexPublicationContract } from '../helpers/codex-publication-contract.ts';
codexPublicationContract(async()=>{const engine=new PGLiteEngine();await engine.connect({});return {engine};});
