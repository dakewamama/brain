/** Local trusted operator interface. No administration or approval tools are exposed through MCP. */
import { readFileSync } from "node:fs";
import { getPool,migrate,closePool } from "../db/pool.js";
import { GrantService,authoritySchema } from "../grants/service.js";
import { ContextService,contextTypes } from "../context/service.js";
import { z } from "zod";
async function main():Promise<void>{
 const pool=getPool();if(!pool)throw new Error("DATABASE_URL required");await migrate();
 const [command,file]=process.argv.slice(2);if(!file)throw new Error("Usage: axis-admin issue|revoke|context|approve input.json");
 const raw:unknown=JSON.parse(readFileSync(file,"utf8"));const grants=new GrantService(pool);
 if(command==="issue") {
  const input=z.object({clientId:z.string(),clientName:z.string(),userId:z.string(),authority:authoritySchema,expiresAt:z.string().datetime()}).strict().parse(raw);
  const credential=await grants.issue({...input,expiresAt:new Date(input.expiresAt)});
  // Credential appears once on the operator's stdout; never in application logs.
  process.stdout.write(`${JSON.stringify(credential)}\n`);
 }else if(command==="revoke") {await grants.revoke(z.object({grantId:z.string()}).strict().parse(raw).grantId);}
 else if(command==="context") {
  const input=z.object({userId:z.string(),type:z.enum(contextTypes),value:z.unknown(),source:z.string(),observedAt:z.string().datetime(),expiresAt:z.string().datetime(),sensitivity:z.enum(["standard","sensitive"]),caseId:z.string().nullable()}).strict().parse(raw);
  const {userId,...item}=input;await new ContextService(pool).put(userId,{...item,value:input.value});
 }else if(command==="approve") {
  const input=z.object({preparationId:z.string(),userId:z.string(),digest:z.string()}).strict().parse(raw);
  const r=await pool.query(`INSERT INTO preparation_approvals(preparation_id,user_id,digest)
   SELECT id,user_id,digest FROM preparations WHERE id=$1 AND user_id=$2 AND digest=$3 AND expires_at>now() ON CONFLICT DO NOTHING RETURNING preparation_id`,[input.preparationId,input.userId,input.digest]);
  if(!r.rowCount)throw new Error("approval not recorded: check user, digest, expiry or existing approval");
 }else throw new Error("unknown operator command");
}
main().catch(error=>{console.error(error instanceof Error?error.message:"operator command failed");process.exitCode=1;}).finally(closePool);
