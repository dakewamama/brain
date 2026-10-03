import {lockOperatorAuthority} from "../human/service.js";
import {createHash,randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {z} from "zod";
import {digest} from "../core/digest.js";
import {AxisError,type Principal} from "../grants/service.js";
import {CapabilityRegistry,permitted} from "../capabilities/registry.js";
import {PgCaseStore} from "../cases/store.js";
import {hasCurrentProof} from "../proof/gate.js";
const identifier=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
export const stepSchema=z.object({capabilityId:z.string().optional(),query:z.string().max(200).optional(),bindings:z.record(identifier),fallback:z.array(z.string()).max(3).optional()}).strict();
export type ProposedStep=z.infer<typeof stepSchema>;
interface Step {capabilityId:string;bindings:Record<string,string>;schemaDigest:string;postcondition:string;fallbackReason:string|null}
export interface ExperiencePlan {shape:string;structure:Step[];level:"DISCOVERY"|"PLAYBOOK"|"COMPILED";searches:number;reasonerCalls:number;playbookId?:string}
export class ExperienceService {
 private store:PgCaseStore;
 constructor(private pool:Pool,private registry:CapabilityRegistry){this.store=new PgCaseStore(pool);}
 private compatible(step:Step,p:Principal){const d=this.registry.get(step.capabilityId);return !!d&&permitted(p,d)&&digest({input:d.inputSchema,output:d.outputSchema,version:d.version,provider:d.provider,mode:d.mode})===step.schemaDigest;}
 async plan(p:Principal,shape:string,parameters:Record<string,unknown>,proposed?:ProposedStep[]):Promise<ExperiencePlan>{
  identifier.parse(shape);await this.capturePending(p.userId);
  const existing=await this.pool.query("SELECT * FROM experience_playbooks WHERE user_id=$1 AND shape=$2 AND stage<>'CANDIDATE' ORDER BY CASE stage WHEN 'COMPILED' THEN 0 WHEN 'COMPILED_CANDIDATE' THEN 1 WHEN 'PROVEN' THEN 2 ELSE 3 END,created_at DESC",[p.userId,shape]);
  for(const row of existing.rows){const structure=row.structure as Step[];
   if(structure.every(s=>this.compatible(s,p)&&Object.values(s.bindings).every(k=>Object.hasOwn(parameters,k))))return {shape,structure,level:row.stage==="COMPILED"?"COMPILED":"PLAYBOOK",searches:0,reasonerCalls:0,playbookId:row.id};
  }
  if(!proposed?.length)throw new AxisError("procedure_requires_discovery");
  const structure:Step[]=[];let searches=0;
  for(const step of proposed){
   let d=step.capabilityId?this.registry.get(step.capabilityId):undefined;
   if(step.query){searches++;d=this.registry.search(p,{query:step.query,limit:5}).sort((a,b)=>rank(a.id,a.provider.kind)-rank(b.id,b.provider.kind))[0];}
   let fallbackReason:string|null=null;
   if(!d||!permitted(p,d)){
    const fallbacks=(step.fallback??[]).map(id=>this.registry.get(id)).filter(d=>d&&permitted(p,d));
    d=fallbacks.sort((a,b)=>rank(a!.id,a!.provider.kind)-rank(b!.id,b!.provider.kind))[0];fallbackReason="preferred_surface_unavailable";
   }
   if(!d)throw new AxisError("procedure_capability_unavailable");
   if(d.risk==="financial")throw new AxisError("financial_sequence_not_supported");
   if(!Object.values(step.bindings).every(k=>Object.hasOwn(parameters,k)))throw new AxisError("procedure_parameter_missing");
   structure.push({capabilityId:d.id,bindings:step.bindings,schemaDigest:digest({input:d.inputSchema,output:d.outputSchema,version:d.version,provider:d.provider,mode:d.mode}),postcondition:d.risk==="read"?"validated response":d.id==="human.request"?"authenticated decision":"authoritative target state",fallbackReason});
  }
  if(structure.length<2||structure.length>8)throw new AxisError("procedure_length");
  return {shape,structure,level:"DISCOVERY",searches,reasonerCalls:0};
 }
 arguments(step:Step,parameters:Record<string,unknown>):Record<string,unknown>{return Object.fromEntries(Object.entries(step.bindings).map(([key,param])=>[key,parameters[param]]));}
 async capture(caseId:string):Promise<void>{
  const row=await this.pool.query("SELECT c.*,p.proposal FROM cases c JOIN preparations p ON p.case_id=c.id WHERE c.id=$1 AND c.status='completed'",[caseId]);const c=row.rows[0];const plan=c?.proposal?.experience as ExperiencePlan|undefined;
  if(!plan||!await hasCurrentProof(this.store,caseId))return;
  const actions=await this.store.listActions(caseId),events=await this.store.listEvents(caseId),evidence=await this.store.listEvidence(caseId);
  const attempts=await Promise.all(actions.map(a=>this.store.attemptsFor(a.id)));
  const trace={capabilities:plan.structure.map(s=>s.capabilityId),contextClasses:[...new Set(c.proposal.contextClasses??[])],providers:attempts.map(a=>[...new Set(a.map(p=>p.provider))]),executionModes:attempts.map(a=>[...new Set(a.map(p=>p.mode))]),failures:attempts.flat().filter(a=>a.outcome==="failed").length,retries:attempts.flat().filter(a=>a.request.requery===true&&a.outcome==="submitted").length,humanIntervention:actions.some(a=>a.capability==="human.request"),evidenceKinds:[...new Set(evidence.map(e=>e.kind))],proof:"VERIFIED",branches:plan.structure.map(s=>s.fallbackReason),transitions:events.map(e=>e.type),costs:null};
  const duration=new Date(c.updated_at).getTime()-new Date(c.created_at).getTime();
  const structureHash=digest(plan.structure),metrics={plannerCalls:plan.reasonerCalls,capabilitySearches:plan.searches,executionSteps:actions.length,durationMs:duration>=0?duration:null,clockSkewDetected:duration<0,level:plan.level};
  const db=await this.pool.connect();try{await db.query("BEGIN");
   await db.query("INSERT INTO experience_traces(case_id,user_id,shape,structure_hash,structure,metrics,trace) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",[caseId,c.user_id,plan.shape,structureHash,JSON.stringify(plan.structure),metrics,trace]);
   await db.query("INSERT INTO experience_playbooks(id,user_id,shape,structure_hash,structure,stage) VALUES ($1,$2,$3,$4,$5,'CANDIDATE') ON CONFLICT DO NOTHING",[randomUUID(),c.user_id,plan.shape,structureHash,JSON.stringify(plan.structure)]);await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
 async capturePending(userId:string){const rows=await this.pool.query("SELECT c.id FROM cases c JOIN preparations p ON p.case_id=c.id LEFT JOIN experience_traces t ON t.case_id=c.id WHERE c.user_id=$1 AND c.status='completed' AND p.proposal ? 'experience' AND t.case_id IS NULL LIMIT 100",[userId]);for(const r of rows.rows)await this.capture(r.id);}
 async list(token:string){
  const op=await this.pool.query("SELECT user_id FROM human_operators WHERE token_hash=$1 AND expires_at>now() AND NOT revoked",[createHash("sha256").update(token).digest("hex")]);if(!op.rows[0])throw new AxisError("unauthorized_operator");
  return (await this.pool.query("SELECT id,shape,stage,structure FROM experience_playbooks WHERE user_id=$1 ORDER BY created_at DESC",[op.rows[0].user_id])).rows;
 }
 async promote(token:string,id:string,to:"VERIFIED"|"PROVEN"|"COMPILED_CANDIDATE"|"COMPILED"){
  const op=await this.pool.query("SELECT id,user_id FROM human_operators WHERE token_hash=$1 AND expires_at>now() AND NOT revoked",[createHash("sha256").update(token).digest("hex")]);if(!op.rows[0])throw new AxisError("unauthorized_operator");
  const db=await this.pool.connect();try{await db.query("BEGIN");const r=await db.query("SELECT * FROM experience_playbooks WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,op.rows[0].user_id]);const p=r.rows[0];if(!p)throw new AxisError("not_found");
   const stages=["CANDIDATE","VERIFIED","PROVEN","COMPILED_CANDIDATE","COMPILED"];if(stages.indexOf(to)!==stages.indexOf(p.stage)+1)throw new AxisError("invalid_promotion");
   const runs=await db.query("SELECT case_id FROM experience_traces WHERE user_id=$1 AND shape=$2 AND structure_hash=$3",[p.user_id,p.shape,p.structure_hash]);let verified=0;
   for(const run of runs.rows)if((await this.store.getCase(run.case_id))?.status==="completed"&&await hasCurrentProof(this.store,run.case_id))verified++;
   const needed=to==="VERIFIED"?1:to==="PROVEN"?2:3;if(verified<needed)throw new AxisError("insufficient_verified_runs");
   for(const step of p.structure as Step[]){const d=this.registry.get(step.capabilityId);if(!d||digest({input:d.inputSchema,output:d.outputSchema,version:d.version,provider:d.provider,mode:d.mode})!==step.schemaDigest||!step.postcondition)throw new AxisError("incompatible_procedure");}
   await lockOperatorAuthority(db,token);
   await db.query("UPDATE experience_playbooks SET stage=$2 WHERE id=$1",[id,to]);await db.query("INSERT INTO experience_promotions(playbook_id,operator_id,from_stage,to_stage,verified_runs) VALUES ($1,$2,$3,$4,$5)",[id,op.rows[0].id,p.stage,to,verified]);await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
}
function rank(id:string,provider:string){return id.startsWith("human.")?3:id.startsWith("browser.")?2:provider==="native"?0:1;}
