import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../codex-take-accept.serial.test.ts'));
