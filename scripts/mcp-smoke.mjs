import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const endpoint=new URL(process.env.AXIS_MCP_URL??'');
if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw new Error('HTTPS required');
if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Endpoint must not contain credentials, query or fragment');
const token=process.env.AXIS_SMOKE_TOKEN,key=process.env.AXIS_SMOKE_KEY;
if(!token||!key)throw new Error('AXIS_SMOKE_TOKEN and stable AXIS_SMOKE_KEY required');
const client=new Client({name:'axis-deployment-smoke',version:'1'});
async function call(name,args){const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(`Smoke failed: ${name}`);return r.structuredContent.result;}
try{
 await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{authorization:`Bearer ${token}`}}}));
 const tools=(await client.listTools()).tools.map(t=>t.name);
 const expected=['axis.prepare','axis.execute','axis.status','axis.cancel','axis.capabilities.search','axis.capabilities.invoke'];
 if(JSON.stringify([...tools].sort())!==JSON.stringify(expected.sort()))throw new Error('Unexpected MCP surface');
 const capabilities=await call('axis.capabilities.search',{query:'location.context'});
 if(!capabilities.some(c=>c.id==='location.context'))throw new Error('Smoke Grant lacks location.context');
 const input={capabilityId:'location.context',arguments:{precision:'coarse'},idempotencyKey:key};
 const first=await call('axis.capabilities.invoke',input);
 const replay=await call('axis.capabilities.invoke',input);
 if(first.workId!==replay.workId)throw new Error('Idempotency failed');
 let status;
 for(let i=0;i<60;i++){
  status=await call('axis.status',{workId:first.workId});
  if(status.status==='COMPLETED')break;
  if(['FAILED','IN_DOUBT','VERIFYING','CANCELLED'].includes(status.status))throw new Error('Read smoke did not complete');
  await new Promise(r=>setTimeout(r,1000));
 }
 if(status.status!=='COMPLETED'||status.verification!=='VERIFIED'||status.mode!=='LIVE')throw new Error('Missing live durable proof');
 console.log(JSON.stringify({workId:first.workId,status:status.status,verification:status.verification,mode:status.mode,stableRetry:true,tools}));
}finally{await client.close();}
