import { Pool } from "pg";
import { AxisGateway } from "../../src/gateway/service.js";
import { CapabilityRegistry } from "../../src/capabilities/registry.js";
import { CaseWorker } from "../../src/cases/worker.js";
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const registry=new CapabilityRegistry();
registry.register({id:"test.crash.purchase",version:"1",provider:{id:"probe",kind:"external_api"},description:"crash recovery probe",inputSchema:{type:"object",additionalProperties:false},outputSchema:{type:"object"},mode:"MOCK",risk:"financial",requiredScopes:["purchase"],reversible:false,contextTypes:[],health:"healthy"},{
 money:()=>({asset:"TEST",amountMinor:"10"}),
 async execute(_args,ctx){await fetch(`${process.env.TEST_PROVIDER_URL}/purchase`,{method:"POST",body:ctx.idempotencyKey});return {outcome:"unknown",data:{}};},
 async requery(_args,ctx){const response=await fetch(`${process.env.TEST_PROVIDER_URL}/status`,{method:"POST",body:ctx.idempotencyKey});const data=await response.json() as Record<string,unknown>;return {outcome:"succeeded",data,moneyState:"SETTLED",providerRef:String(data.id),targetState:"delivered"};},
});
const gateway=new AxisGateway(pool,registry);
const worker=new CaseWorker(gateway.runner,gateway.store);
try {
 if(process.argv[2]==="purchase") {
  const issued=await gateway.grants.issue({clientId:"crash-client",clientName:"crash test",userId:"crash-user",authority:{scopes:["purchase"],capabilities:["test.crash.purchase"],contextTypes:[],resources:[],financial:{asset:"TEST",perActionMinor:"10",totalMinor:"10"},requireApproval:false,modes:["MOCK"]},expiresAt:new Date(Date.now()+60000)});
  const prep=await gateway.prepare(issued.token,{goal:"test",constraints:{capabilityId:"test.crash.purchase"}});
  await gateway.execute(issued.token,{preparationId:prep.preparationId});
  process.stdout.write(`${JSON.stringify({workId:prep.workId})}\n`);
 }
 await worker.tick();
}finally{await pool.end();}
