import {digest} from "../core/digest.js";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {AxisError} from "../grants/service.js";
import {PgCaseStore} from "../cases/store.js";
import {CapabilityRegistry,type ProviderContext,type ProviderResult} from "../capabilities/registry.js";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export const humanResponse=z.object({decision:z.enum(["confirm","reject"]),evidence:z.object({reference:z.string().min(1).max(1000),description:z.string().min(1).max(2000)}).strict()}).strict();
/** Serialize an operator mutation with revocation; call after other blocking work. */
export async function lockOperatorAuthority(db:PoolClient,token:string):Promise<void>{
 // Acquire the lock before checking the clock: the lock wait itself may outlast expiry.
 await db.query("SELECT id FROM human_operators WHERE token_hash=$1 FOR SHARE",[hash(token)]);
 const r=await db.query("SELECT id FROM human_operators WHERE token_hash=$1 AND expires_at>clock_timestamp() AND NOT revoked",[hash(token)]);
 if(!r.rowCount)throw new AxisError("unauthorized_operator");
}
export class HumanTaskService {
 private store:PgCaseStore;
 constructor(private pool:Pool){this.store=new PgCaseStore(pool);}
 /** Trusted provisioning only; operator credentials are distinct from AgentClient tokens. */
 async issueOperator(userId:string,expiresAt:Date){
  if(!userId||expiresAt<=new Date())throw new AxisError("invalid_operator");
  const id=randomUUID(),token=randomBytes(32).toString("base64url");
  await this.pool.query("INSERT INTO human_operators(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)",[id,userId,hash(token),expiresAt]);return {id,token};
 }
 private async operator(token:string){const r=await this.pool.query("SELECT id,user_id FROM human_operators WHERE token_hash=$1 AND expires_at>now() AND NOT revoked",[hash(token)]);if(!r.rows[0])throw new AxisError("unauthorized_operator");return r.rows[0] as {id:string;user_id:string};}
 async read(token:string,id:string){const op=await this.operator(token);const r=await this.pool.query("SELECT id,case_id,purpose,allowed_context,status,deadline FROM human_tasks WHERE id=$1 AND user_id=$2 AND (assigned_operator IS NULL OR assigned_operator=$3)",[id,op.user_id,op.id]);if(!r.rows[0])throw new AxisError("not_found");return r.rows[0];}
 async resolve(token:string,id:string,raw:unknown):Promise<void>{
  const response=humanResponse.parse(raw),task=await this.read(token,id);
  await this.store.exclusive(task.case_id,async()=>{
   const fresh=await this.operator(token);const db=await this.pool.connect();
   try{
    await db.query("BEGIN");const row=await db.query("SELECT * FROM human_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,fresh.user_id]);const t=row.rows[0];
    if(!t||(t.assigned_operator&&t.assigned_operator!==fresh.id))throw new AxisError("not_found");
    if(t.status==="RESOLVED"){if(digest(t.response)!==digest(response))throw new AxisError("resolution_conflict");await db.query("COMMIT");return;}
    if(!["REQUESTED","ASSIGNED"].includes(t.status)||new Date(t.deadline)<=new Date())throw new AxisError("human_task_inactive");
    const c=await db.query("SELECT status FROM cases WHERE id=$1 FOR UPDATE",[t.case_id]);if(c.rows[0]?.status!=="waiting_human")throw new AxisError("human_task_inactive");
    await lockOperatorAuthority(db,token);
    await db.query("UPDATE human_tasks SET status='RESOLVED',assigned_operator=$2,response=$3,resolved_at=now() WHERE id=$1",[id,fresh.id,response]);
    await db.query("INSERT INTO human_audit(task_id,operator_id,operation,payload) VALUES ($1,$2,'resolved',$3)",[id,fresh.id,response]);
    await db.query("INSERT INTO evidence(id,case_id,action_id,kind,payload) VALUES ($1,$2,$3,'authenticated_participant_reply',$4)",[randomUUID(),t.case_id,t.action_id,{humanTaskId:id,operatorId:fresh.id,response}]);
    await db.query("UPDATE cases SET status='waiting_timeout',wake_at=now() WHERE id=$1 AND status='waiting_human'",[t.case_id]);await db.query("COMMIT");
   }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  });
 }
 private async request(a:Record<string,unknown>,c:ProviderContext):Promise<ProviderResult>{
  const row=await this.pool.query("SELECT case_id FROM actions WHERE id=$1",[c.actionId]);if(!row.rows[0])throw new AxisError("missing_durable_action");
  await this.pool.query("INSERT INTO human_tasks(id,case_id,action_id,user_id,purpose,allowed_context,status,deadline) VALUES ($1,$2,$1,$3,$4,$5,'REQUESTED',$6) ON CONFLICT DO NOTHING",[c.actionId,row.rows[0].case_id,c.userId,a.purpose,JSON.stringify(c.context),new Date(Date.now()+Number(a.timeoutSeconds??3600)*1000)]);
  return this.result(c);
 }
 private async result(c:ProviderContext):Promise<ProviderResult>{
  const r=await this.pool.query("SELECT * FROM human_tasks WHERE action_id=$1 AND user_id=$2",[c.actionId,c.userId]);const task=r.rows[0];if(!task)throw new AxisError("not_found");
  if(task.status==="RESOLVED")return {outcome:task.response.decision==="confirm"?"succeeded":"failed",data:{humanTaskId:task.id,response:task.response},providerRef:task.id,targetState:"authenticated human decision received"};
  if(new Date(task.deadline)<=new Date())await this.pool.query("UPDATE human_tasks SET status='EXPIRED' WHERE id=$1 AND status IN ('REQUESTED','ASSIGNED')",[task.id]);
  if(new Date(task.deadline)<=new Date()||task.status==="CANCELLED")return {outcome:"failed",data:{humanTaskId:task.id,status:task.status==="CANCELLED"?"CANCELLED":"EXPIRED"}};
  return {outcome:"waiting_human",data:{humanTaskId:task.id,deadline:new Date(task.deadline).toISOString()}};
 }
 register(registry:CapabilityRegistry){registry.register({id:"human.request",version:"1",provider:{id:"axis-human",kind:"native"},description:"Request a scoped human decision; it cannot independently prove an external postcondition",inputSchema:{type:"object",properties:{purpose:{type:"string",minLength:1,maxLength:2000},contextTypes:{type:"array",items:{type:"string"},maxItems:5},timeoutSeconds:{type:"integer",minimum:1,maximum:86400}},required:["purpose"],additionalProperties:false},outputSchema:{type:"object"},mode:"LIVE",risk:"write",requiredScopes:["human.request"],reversible:true,contextTypes:[],health:"healthy"},{requiredContext:a=>a.contextTypes as string[]??[],execute:(a,c)=>this.request(a,c),requery:(_a,c)=>this.result(c)});}
}
