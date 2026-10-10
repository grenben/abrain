import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexVoiceContract } from '../helpers/codex-voice-contract.ts';
codexVoiceContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
