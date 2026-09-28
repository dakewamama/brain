import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { CaseRunner } from "../cases/runtime.js";
import { PgCaseStore } from "../cases/store.js";
import type { Transition } from "../cases/types.js";
import { CapabilityRegistry, permitted, rejectAuthorityControls, type Dispatch, type CapabilityDescriptor, type Invocation, type MoneyRequirement, type ProviderResult } from "../capabilities/registry.js";
import { GrantService, AxisError, type Principal } from "../grants/service.js";
import { ContextService } from "../context/service.js";
import { authorizeExecution } from "../policy/execution.js";

const argsSchema=z.record(z.unknown());
export const prepareSchema=z.object({goal:z.string().min(1).max(2000),constraints:z.object({capabilityId:z.string().optional(),arguments:argsSchema.optional(),region:z.string().optional(),maxCost:z.object({asset:z.string(),amountMinor:z.string().regex(/^\d+$/)}).strict().optional()}).strict().optional()}).strict();
export const executeSchema=z.object({preparationId:z.string().min(1)}).strict();
export const statusSchema=z.object({workId:z.string().min(1)}).strict();
export const cancelSchema=z.object({workId:z.string().min(1)}).strict();
export const searchSchema=z.object({query:z.string().max(500).optional(),region:z.string().optional(),limit:z.number().int().min(1).max(5).optional(),modes:z.array(z.enum(["LIVE","SANDBOX","MOCK","HANDOFF","UPSTREAM_MCP"])).optional(),risks:z.array(z.enum(["read","write","financial","external_commitment"])).optional()}).strict();
export const invokeSchema=z.object({capabilityId:z.string(),arguments:argsSchema,idempotencyKey:z.string().min(1).max(200)}).strict();
function canonical(v: unknown): string {
  if(Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if(v!==null && typeof v==="object") return `{${Object.entries(v).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(v);
}
export const digest=(v:unknown) => createHash("sha256").update(canonical(v)).digest("hex");
interface Proposal {
  understoodGoal:string; constraints:z.infer<typeof prepareSchema>["constraints"]; actions:{capabilityId:string;version:string;arguments:Record<string,unknown>;descriptorDigest:string}[];
  requiredApprovals:string[];missingInformation:string[];knownCost:null;executionPossible:boolean;
  successCriteria:string[];contextIds:string[];money?:MoneyRequirement;
}
interface Preparation {id:string;case_id:string;grant_id:string;client_id:string;user_id:string;digest:string;request_digest:string;proposal:Proposal;expires_at:Date}
/** Business boundary shared by MCP and future clients. One bounded action per
 * preparation in V1; no LLM planner, queue engine, or provider credentials here. */
export class AxisGateway {
  readonly store:PgCaseStore;
  readonly runner:CaseRunner;
  readonly grants:GrantService;
  readonly context:ContextService;
  private dispatch:Dispatch;
  constructor(readonly pool:Pool,readonly registry:CapabilityRegistry) {
    this.store=new PgCaseStore(pool);this.runner=new CaseRunner(this.store,"LIVE",registry);this.grants=new GrantService(pool);this.context=new ContextService(pool);
    this.dispatch=registry.bindExecution((p,i)=>this.invokeFor(p,i));
    this.runner.registerPlaybook({id:"gateway-v1",initialState:"execute",states:{execute:{onEnter:ctx=>this.runAction(ctx.caseId)}}});
    this.runner.registerReconciler("gateway-v1",async id=>{
      const r=await pool.query("UPDATE cases SET status='running' WHERE id=$1 AND status='in_doubt' RETURNING id",[id]);
      if(r.rowCount) await this.runner.advance(id);
    });
  }
  private async owned(p:Principal,field:"id"|"case_id",id:string):Promise<Preparation> {
    const r=await this.pool.query(`SELECT * FROM preparations WHERE ${field}=$1 AND grant_id=$2 AND client_id=$3 AND user_id=$4`,[id,p.grantId,p.clientId,p.userId]);
    if(!r.rows[0]) throw new AxisError("not_found");return r.rows[0] as Preparation;
  }
  async searchCapabilities(token:string,raw:unknown):Promise<CapabilityDescriptor[]> {
    const p=await this.grants.authenticate(token);const filters=searchSchema.parse(raw);
    const context=await this.context.read(p,p.authority.contextTypes);
    return this.registry.search(p,filters,context.map(c=>c.type));
  }
  async prepare(token:string,raw:unknown):Promise<Record<string,unknown>> {
    const p=await this.grants.authenticate(token);return this.prepareFor(p,prepareSchema.parse(raw));
  }
  private async prepareFor(p:Principal,input:z.infer<typeof prepareSchema>,key?:string):Promise<Record<string,unknown>> {
    rejectAuthorityControls(input);
    const requestDigest=digest(input);
    if(key) {
      const old=await this.pool.query("SELECT * FROM preparations WHERE grant_id=$1 AND invocation_key=$2",[p.grantId,key]);
      if(old.rows[0]) {
        const prior=old.rows[0] as Preparation;
        if(prior.request_digest!==requestDigest) throw new AxisError("idempotency_conflict");
        return this.preparedView(prior);
      }
    }
    const context=await this.context.read(p,p.authority.contextTypes);
    const explicit=input.constraints?.capabilityId;
    const descriptor=explicit ? this.registry.get(explicit) : this.registry.search(p,{query:input.goal,region:input.constraints?.region,limit:1},context.map(c=>c.type))[0];
    if(explicit && (!descriptor || !permitted(p,descriptor))) throw new AxisError("capability_unavailable");
    const arguments_=input.constraints?.arguments??{};
    const missing:string[]=[];
    let needed:string[]=[];let money:MoneyRequirement|undefined;
    if(!descriptor) missing.push("Select an authorized capability");
    else {
      try { this.registry.validate(descriptor.id,arguments_); const req=this.registry.requirements(descriptor.id,arguments_);needed=req.context;money=req.money;
        if(!req.resources.every(r=>p.authority.resources.includes(r))) throw new AxisError("resource_not_allowed");
        authorizeExecution(p,descriptor,context,needed,money,input.constraints?.region);
        this.checkCost(input.constraints,money);
      } catch(error) { missing.push(error instanceof AxisError ? error.code : "invalid_arguments"); }
    }
    const proposal:Proposal={understoodGoal:input.goal,constraints:input.constraints,actions:descriptor?[{capabilityId:descriptor.id,version:descriptor.version,arguments:arguments_,descriptorDigest:digest(descriptor)}]:[],
      requiredApprovals:p.authority.requireApproval?["user_confirmation"]:[],missingInformation:missing,knownCost:null,executionPossible:missing.length===0,
      successCriteria:descriptor?[descriptor.risk==="read"?"validated provider response":"authoritative target state",...(descriptor.risk==="financial"?["settled internal money state"]:[])]:[],
      contextIds:context.filter(c=>needed.includes(c.type)).map(c=>c.id),...(money?{money}:{})};
    const id=randomUUID(),workId=randomUUID(),expires=new Date(Date.now()+300000),version=digest(proposal);
    const db=await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("INSERT INTO cases(id,user_id,channel,goal,playbook,state,status,context) VALUES ($1,$2,'mcp',$3,'gateway-v1','execute','prepared',$4)",[workId,p.userId,input.goal,{preparationId:id}]);
      await db.query("INSERT INTO preparations(id,case_id,grant_id,client_id,user_id,invocation_key,request_digest,digest,proposal,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,workId,p.grantId,p.clientId,p.userId,key??null,requestDigest,version,proposal,expires]);
      await db.query("COMMIT");
    } catch(error) {
      await db.query("ROLLBACK");
      if(key && (error as {code?:string}).code==="23505") return this.prepareFor(p,input,key);
      throw error;
    } finally {db.release();}
    await this.store.appendEvent(workId,"prepared",{digest:version});
    return this.preparedView({id,case_id:workId,grant_id:p.grantId,client_id:p.clientId,user_id:p.userId,digest:version,request_digest:requestDigest,proposal,expires_at:expires});
  }
  private preparedView(p:Preparation):Record<string,unknown> { return {preparationId:p.id,workId:p.case_id,...p.proposal,version:1,digest:p.digest,expiresAt:new Date(p.expires_at).toISOString()}; }
  private checkCost(constraints:Proposal["constraints"],money?:MoneyRequirement):void {
    if(constraints?.maxCost && (!money || money.asset!==constraints.maxCost.asset || BigInt(money.amountMinor)>BigInt(constraints.maxCost.amountMinor))) throw new AxisError("case_budget_exceeded");
  }
  /** Trusted user/admin approval path. Never exposed on MCP. The approving user
   * must be obtained from an authenticated first-party session or operator CLI. */
  async approve(preparationId:string,authenticatedUserId:string):Promise<void> {
    const r=await this.pool.query("SELECT digest FROM preparations WHERE id=$1 AND user_id=$2 AND expires_at>now()",[preparationId,authenticatedUserId]);
    if(!r.rows[0]) throw new AxisError("not_found");
    await this.pool.query("INSERT INTO preparation_approvals(preparation_id,user_id,digest) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[preparationId,authenticatedUserId,r.rows[0].digest]);
  }
  private async approval(prep:Preparation,p:Principal):Promise<boolean> {
    if(!p.authority.requireApproval) return true;
    return !!(await this.pool.query("SELECT 1 FROM preparation_approvals WHERE preparation_id=$1 AND user_id=$2 AND digest=$3",[prep.id,p.userId,prep.digest])).rowCount;
  }
  private async validatePreparation(prep:Preparation,p:Principal) {
    const proposal=prep.proposal;
    if(digest(proposal)!==prep.digest || !proposal.executionPossible || new Date(prep.expires_at)<=new Date()) throw new AxisError("stale_preparation");
    const action=proposal.actions[0];const descriptor=this.registry.get(action.capabilityId);
    if(!descriptor || digest(descriptor)!==action.descriptorDigest) throw new AxisError("stale_preparation");
    this.registry.validate(descriptor.id,action.arguments);
    const requirements=this.registry.requirements(descriptor.id,action.arguments);
    if(!requirements.resources.every(r=>p.authority.resources.includes(r))) throw new AxisError("resource_not_allowed");
    const context=await this.context.read(p,requirements.context,prep.case_id);
    if(proposal.contextIds.some(id=>!context.some(c=>c.id===id))) throw new AxisError("stale_context");
    authorizeExecution(p,descriptor,context,requirements.context,requirements.money,proposal.constraints?.region);
    this.checkCost(proposal.constraints,requirements.money);
    return {action,descriptor,requirements,context};
  }
  async execute(token:string,raw:unknown):Promise<Record<string,unknown>> {
    const p=await this.grants.authenticate(token);const input=executeSchema.parse(raw);const prep=await this.owned(p,"id",input.preparationId);
    await this.queue(prep,p);
    return this.statusFor(p,prep);
  }
  private async queue(prep:Preparation,p:Principal):Promise<void> {
    await this.store.exclusive(prep.case_id,async()=>{
      const c=await this.store.getCase(prep.case_id);
      if(c?.status!=="prepared" && c?.status!=="waiting_user") return;
      const {descriptor,requirements}=await this.validatePreparation(prep,p);
      if(!await this.approval(prep,p)) { await this.store.updateCase(prep.case_id,{status:"waiting_user"}); return; }
      const db=await this.pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT id FROM agent_grants WHERE id=$1 FOR UPDATE",[p.grantId]);
        const fresh=await this.grants.resolve(p.grantId,p.clientId,db);
        const {context}=await this.validatePreparation(prep,fresh);
        authorizeExecution(fresh,descriptor,context,requirements.context,requirements.money,prep.proposal.constraints?.region);
        const id=`action_${digest(prep.id)}`;
        const money=requirements.money;
        if(money) {
          const total=await db.query("SELECT COALESCE(SUM(amount_minor),0)::text AS total FROM action_money WHERE grant_id=$1 AND state NOT IN ('RELEASED','REVERSED','REFUNDED')",[p.grantId]);
          if(!fresh.authority.financial || BigInt(total.rows[0].total)+BigInt(money.amountMinor)>BigInt(fresh.authority.financial.totalMinor)) throw new AxisError("financial_limit");
        }
        await db.query("INSERT INTO actions(id,case_id,capability,status,input,idempotency_key) VALUES ($1,$2,$3,'authorized',$4,$1)",[id,prep.case_id,descriptor.id,{arguments:prep.proposal.actions[0].arguments,verificationRisk:descriptor.risk}]);
        if(money) {
          await db.query("INSERT INTO action_money(action_id,grant_id,asset,amount_minor,state) VALUES ($1,$2,$3,$4,'RESERVED')",[id,p.grantId,money.asset,money.amountMinor]);
          await db.query("INSERT INTO reservations(id,action_id,owner,amount_minor,asset,status) VALUES ($1,$1,$2,$3,$4,'reserved')",[id,p.userId,money.amountMinor,money.asset]);
        }
        await db.query("UPDATE cases SET status='waiting_timeout',wake_at=now() WHERE id=$1",[prep.case_id]);
        await db.query("COMMIT");
      } catch(error) {await db.query("ROLLBACK");throw error;} finally{db.release();}
      await this.store.appendEvent(prep.case_id,"queued",{preparationId:prep.id});
    });
  }
  async invokeCapability(token:string,raw:unknown):Promise<unknown> {
    const p=await this.grants.authenticate(token);return this.registry.invoke(p,invokeSchema.parse(raw));
  }
  private async invokeFor(principal:Principal,input:Invocation):Promise<unknown> {
    const p=await this.grants.resolve(principal.grantId,principal.clientId);
    const view=await this.prepareFor(p,{goal:input.capabilityId,constraints:{capabilityId:input.capabilityId,arguments:input.arguments}},input.idempotencyKey);
    const prep=await this.owned(p,"id",String(view.preparationId));
    if(!prep.proposal.executionPossible) throw new AxisError(prep.proposal.missingInformation[0]??"invalid_arguments");
    await this.queue(prep,p);return this.statusFor(p,prep);
  }
  async status(token:string,raw:unknown):Promise<Record<string,unknown>> {
    const p=await this.grants.authenticate(token);const input=statusSchema.parse(raw);return this.statusFor(p,await this.owned(p,"case_id",input.workId));
  }
  private async statusFor(p:Principal,prep:Preparation):Promise<Record<string,unknown>> {
    const c=await this.store.getCase(prep.case_id);if(!c) throw new AxisError("not_found");
    const descriptor=this.registry.get(prep.proposal.actions[0]?.capabilityId);
    if(descriptor && !permitted(p,descriptor)) throw new AxisError("not_found");
    const actions=await this.store.listActions(c.id);const action=actions[0];
    const evidence=await this.store.listEvidence(c.id);
    const money=action?(await this.pool.query("SELECT asset,amount_minor::text,state FROM action_money WHERE action_id=$1",[action.id])).rows[0]:null;
    const mapping:Record<string,string>={prepared:"PREPARED",waiting_user:"WAITING_APPROVAL",waiting_timeout:action?.status==="authorized"?"QUEUED":"WAITING_EXTERNAL",running:"EXECUTING",in_doubt:"IN_DOUBT",verifying:"VERIFYING",completed:"COMPLETED",failed:"FAILED",cancelled:"CANCELLED"};
    const requirements=descriptor?this.registry.requirements(descriptor.id,prep.proposal.actions[0].arguments).context:[];
    const visible=requirements.every(t=>p.authority.contextTypes.includes(t)&&p.authority.scopes.includes(`context:${t}`));
    return {workId:c.id,preparationId:prep.id,status:mapping[c.status],summary:c.goal,mode:descriptor?.mode??"UNAVAILABLE",providerMode:descriptor?.metadata?.executionMode??descriptor?.mode??"UNAVAILABLE",actionId:action?.id,
      money:money??null,verification:evidence.some(e=>e.kind==="verification")?"VERIFIED":"UNVERIFIED",
      evidence:evidence.map(e=>({kind:e.kind,at:e.at.toISOString()})),
      result:visible && c.status==="completed" ? action?.result?.data ?? null : null,
      nextRequiredAction:c.status==="waiting_user"?"User approval required":c.status==="in_doubt"?"Reconcile the original provider request":c.status==="verifying"?"Obtain authoritative evidence":null};
  }
  async cancel(token:string,raw:unknown):Promise<Record<string,unknown>> {
    const p=await this.grants.authenticate(token);const input=cancelSchema.parse(raw);const prep=await this.owned(p,"case_id",input.workId);
    return this.store.exclusive(prep.case_id,async()=>{
      await this.grants.resolve(p.grantId,p.clientId);
      const c=await this.store.getCase(prep.case_id);const actions=await this.store.listActions(prep.case_id);
      if(c?.status==="cancelled") return {workId:prep.case_id,result:"CANCELLED"};
      if(c?.status==="completed" || actions.some(a=>!["proposed","authorized","rejected"].includes(a.status))) return {workId:prep.case_id,result:"CANNOT_CANCEL",nextRequiredAction:"Provider reconciliation or compensation is required; no external effect was undone"};
      for(const action of actions) {await this.money(action.id,"RELEASED");await this.store.updateActionStatus(action.id,"released");}
      await this.store.updateCase(prep.case_id,{status:"cancelled",wakeAt:null});await this.store.appendEvent(prep.case_id,"case_cancelled",{reason:"authorized cancellation before dispatch"});
      return {workId:prep.case_id,result:"CANCELLED"};
    });
  }
  private async money(actionId:string,state:"IN_FLIGHT"|"IN_DOUBT"|"SETTLED"|"RELEASED"|"REVERSED"):Promise<void> {
    await this.pool.query("UPDATE action_money SET state=$2 WHERE action_id=$1",[actionId,state]);
    await this.store.setReservationStatus(actionId,state==="SETTLED"?"captured":state==="RELEASED"?"released":state==="REVERSED"?"reversed":state==="IN_DOUBT"?"in_doubt":"reserved");
  }
  private async runAction(workId:string):Promise<Transition> {
    const row=await this.pool.query("SELECT * FROM preparations WHERE case_id=$1",[workId]);const prep=row.rows[0] as Preparation;
    const action=(await this.store.listActions(workId))[0];
    if(!prep||!action) return {fail:{reason:"missing durable action"}};
    if(action.status==="settled") return {complete:{summary:prep.proposal.understoodGoal}};
    const started=(await this.store.attemptsFor(action.id)).length>0;
    let p:Principal;let validated:Awaited<ReturnType<AxisGateway["validatePreparation"]>>;
    try {
      p=await this.grants.resolve(prep.grant_id,prep.client_id);
      // An in-flight intent retains its immutable identity past preparation TTL.
      validated=await this.validatePreparation(started?{...prep,expires_at:new Date(Date.now()+1000)}:prep,p);
      if(!await this.approval(prep,p)) throw new AxisError("approval_required");
    } catch(error) {
      if(started) return {inDoubt:{reason:"Authority or context unavailable; operator reconciliation required"}};
      await this.money(action.id,"RELEASED");await this.store.updateActionStatus(action.id,"rejected");
      return {fail:{reason:error instanceof AxisError?error.code:"policy_rejected"}};
    }
    const {descriptor,context}=validated;
    await this.store.updateActionStatus(action.id,"executing");await this.money(action.id,"IN_FLIGHT");
    await this.store.appendAttempt({id:randomUUID(),actionId:action.id,provider:descriptor.provider.id,mode:descriptor.mode,request:{requery:started},outcome:"submitted"});
    let result:ProviderResult;
    try { await this.grants.resolve(prep.grant_id,prep.client_id); result=await this.dispatch(descriptor.id,prep.proposal.actions[0].arguments,{actionId:action.id,idempotencyKey:action.idempotencyKey,userId:p.userId,context},started); }
    catch { result={outcome:descriptor.risk==="read"?"failed":"unknown",data:{}}; }
    await this.store.appendAttempt({id:randomUUID(),actionId:action.id,provider:descriptor.provider.id,mode:descriptor.mode,request:{requery:started},outcome:result.outcome==="succeeded"?"ok":result.outcome==="failed"?"failed":"unknown",response:{...result},providerRef:result.providerRef});
    await this.store.addEvidence({id:randomUUID(),caseId:workId,actionId:action.id,kind:"provider_receipt",payload:{...result,provider:descriptor.provider.id,mode:descriptor.mode}});
    if(result.outcome==="succeeded") {
      if(descriptor.risk==="financial" && (result.moneyState!=="SETTLED" || !result.providerRef || !result.targetState)) {
        await this.money(action.id,"IN_DOUBT");await this.store.updateActionStatus(action.id,"in_doubt");return {inDoubt:{reason:"Financial result lacks final proof"}};
      }
      await this.money(action.id,"SETTLED");await this.store.updateActionStatus(action.id,"settled",{...result});
      return {complete:{summary:prep.proposal.understoodGoal}};
    }
    if(result.outcome==="failed" && (descriptor.risk!=="financial" || ["RELEASED","REVERSED"].includes(result.moneyState??""))) {
      await this.money(action.id,result.moneyState==="REVERSED"?"REVERSED":"RELEASED");await this.store.updateActionStatus(action.id,"failed",{...result});
      return {fail:{reason:"provider confirmed failure"}};
    }
    await this.money(action.id,"IN_DOUBT");await this.store.updateActionStatus(action.id,"in_doubt",{...result});
    return {inDoubt:{reason:result.outcome==="handoff"?"Handoff is not completion":"Provider outcome requires reconciliation"}};
  }
}
