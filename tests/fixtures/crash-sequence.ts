import {Pool} from "pg";
import {AxisGateway} from "../../src/gateway/service.js";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {CaseWorker} from "../../src/cases/worker.js";
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL}),registry=new CapabilityRegistry();
for(const step of ["first","second"]){
 registry.register({id:`test.sequence.${step}`,version:"1",provider:{id:"sequence-fixture",kind:"external_api"},description:step,inputSchema:{type:"object",additionalProperties:false},outputSchema:{type:"object"},mode:"SANDBOX",risk:"write",requiredScopes:["sequence"],reversible:false,contextTypes:[],health:"healthy"},{async execute(_args,c){
  const response=await fetch(`${process.env.TEST_PROVIDER_URL}/${step}`,{method:"POST",body:c.actionId});await response.json();
  return {outcome:"succeeded",data:{accepted:true},...(step==="second"||process.env.TEST_PROVEN==="true"?{providerRef:c.actionId,targetState:"fixture target observed"}:{})};
 }});
}
const gateway=new AxisGateway(pool,registry),worker=new CaseWorker(gateway.runner,gateway.store);
try{
 if(process.argv[2]==="execute"){
  const update=gateway.store.updateActionStatus.bind(gateway.store);
  gateway.store.updateActionStatus=async(...args)=>{
   await update(...args);
   if(args[1]==="settled"){
    process.stdout.write("ACTION_PERSISTED\n");
    await new Promise<void>(()=>{});
   }
  };
  const {token}=await gateway.grants.issue({clientId:"sequence-client",clientName:"sequence fixture",userId:"sequence-user",expiresAt:new Date(Date.now()+60000),authority:{scopes:["sequence"],capabilities:["test.sequence.first","test.sequence.second"],contextTypes:[],resources:[],financial:null,requireApproval:false,modes:["SANDBOX"]}});
  const p=await gateway.prepare(token,{goal:"sequence recovery",constraints:{taskShape:"sequence_recovery",parameters:{},steps:[{capabilityId:"test.sequence.first",bindings:{}},{capabilityId:"test.sequence.second",bindings:{}}]}});
  await gateway.execute(token,{preparationId:p.preparationId});
 }
 await worker.tick();
}finally{await pool.end();}
