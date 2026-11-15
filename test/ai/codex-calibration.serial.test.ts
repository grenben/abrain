import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { codexCalibrationContract } from '../helpers/codex-calibration-contract.ts';
codexCalibrationContract(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); return { engine };
});
