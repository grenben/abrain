import type { ConfigReader } from '../config-snapshot.ts';
import { readPrivateCodexConfig, resolvePrivateModel, PrivateRoutingError } from './private-policy.ts';
import { PRIVATE_GENERATION_ROLES } from './private-roles.ts';

/** No SDKs, subprocesses, discovery, connection bootstrap or config mutation. */
export async function auditPrivateRoutes(engine?: ConfigReader) {
  const policy=readPrivateCodexConfig();
  const roles=[];
  for (const [role,configKey,tier,implementation] of PRIVATE_GENERATION_ROLES) {
    let resolution: {model:string;source:string} | undefined;
    let conflict: string | undefined;
    if (policy) {
      try { resolution=await resolvePrivateModel(engine ?? null,{configKey,tier,fallback:'unused',
        ...(role==='contextual-synopsis'?{envVar:'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL'}:{})},policy); }
      catch(error) { conflict=error instanceof PrivateRoutingError?error.source:'unreadable_config_plane'; }
    }
    roles.push({role,mode:role==='iterative-minions'?'host_structured_action':'bounded_proposal',
      policy_model:resolution?.model ?? null,selection_source:resolution?.source ?? null,
      conflict:conflict ?? null,implementation:implementation?`src/core/${implementation}`:null,actual_dispatch:'unverified' as const,
      // A transport test does not prove semantic validation/publication at the feature's caller.
      feature_acceptance:'unverified' as const});
  }
  return {schema_version:1,status:'incomplete' as const,private_opt_in:policy!==undefined,activated:false,
    runtime:{qualification:'unverified',live_verified:false},
    planes:{file:'inspected',environment:'inspected',database:engine?'inspected applicable model keys':'uninspected',workers:'uninspected',queued_jobs:'uninspected'},
    budgets:{subscription:'explicit durable envelope required',account_concurrency:1,monetary_cost_usd:null,remaining_quota:null,
      scheduled_job_allowances:policy?.scheduled_jobs ?? {},
      auxiliary_usd:'independent API admission required'},
    coverage:{complete:false,reason:'Feature semantics, worker/job pins and runtime isolation are not fully qualified.'},roles};
}
