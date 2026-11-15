/** Source-checkout, file/env-only audit. Does not connect a database or call a model. */
import { auditPrivateRoutes } from '../src/core/ai/private-route-audit.ts';
try { process.stdout.write(JSON.stringify(await auditPrivateRoutes(),null,2)+'\n'); process.exitCode=1; }
catch { process.stdout.write(JSON.stringify({schema_version:1,status:'incomplete',error:'operator_configuration_unreadable'})+'\n'); process.exitCode=1; }
