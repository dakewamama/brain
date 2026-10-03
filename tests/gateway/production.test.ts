import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {createServer as tlsServer,request as tlsRequest} from 'node:https';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {GrantService} from '../../src/grants/service.js';
import {ContextService} from '../../src/context/service.js';
const base=process.env.TEST_DATABASE_URL;
const exec=promisify(execFile);
async function port(){const s=httpServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
test('production compiled MCP behind HTTPS authenticates, proves a native read and retains identity after restart',{skip:!base,timeout:90000},async()=>{
 const schema=`prod_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:base});await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(base!);url.searchParams.set('options',`-c search_path=${schema}`);const db=new Pool({connectionString:url.toString()});
 const dir=await mkdtemp(join(tmpdir(),'axis-production-')),key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
 const servicePort=await port(),proxyPort=await port(),origin=`https://127.0.0.1:${proxyPort}`;
 const runtime=process.env.AXIS_TEST_RUNTIME_DIR??process.cwd();let child:ChildProcess|undefined;
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost']);
 const ca=await readFile(cert);
 const proxy=tlsServer({key:await readFile(key),cert:ca},(req,res)=>{
  const upstream=httpRequest({host:'127.0.0.1',port:servicePort,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});
  upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);
 });
 await new Promise<void>(r=>proxy.listen(proxyPort,'127.0.0.1',r));
 async function start(){
  const c=spawn(process.execPath,[join(runtime,'dist/mcp/main.js')],{cwd:runtime,env:{PATH:process.env.PATH,NODE_ENV:'production',DATABASE_URL:url.toString(),MCP_HOST:'0.0.0.0',MCP_PUBLIC_ORIGIN:origin,PORT:String(servicePort),CASE_WORKER_POLL_MS:'100'},stdio:['ignore','pipe','pipe']});child=c;let logs='';
  await new Promise<void>((ok,no)=>{const timer=setTimeout(()=>no(new Error(`startup timeout: ${logs}`)),20000);c.stdout!.on('data',b=>{logs+=b;if(logs.includes('Axis MCP ready')){clearTimeout(timer);ok();}});c.stderr!.on('data',b=>{logs+=b;});c.once('exit',code=>{clearTimeout(timer);no(new Error(`startup exit ${code}: ${logs}`));});});
 }
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const c=child;const exit=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await exit;}}
 async function status(path:string,host?:string,originHeader?:string){return new Promise<number>((ok,no)=>{const r=tlsRequest(`${origin}${path}`,{ca,servername:'localhost',headers:{...(host?{host}:{}),...(originHeader?{origin:originHeader}:{})}},s=>{s.resume();ok(s.statusCode!);});r.on('error',no);r.end();});}
 try{
  await start();
  assert.equal(await status('/health','healthcheck.railway.app'),200);
  assert.equal(await status('/mcp'),401);
  assert.equal(await status('/mcp','evil.example'),403);
  assert.equal(await status('/mcp',undefined,'https://evil.example'),403);
  const grants=new GrantService(db),userId=randomUUID();
  const {token}=await grants.issue({clientId:randomUUID(),clientName:'production smoke',userId,expiresAt:new Date(Date.now()+600000),authority:{scopes:['location.context','context:location.coarse'],capabilities:['location.context'],contextTypes:['location.coarse'],resources:[],financial:null,requireApproval:false,modes:['LIVE']}});
  await new ContextService(db).put(userId,{type:'location.coarse',value:{country:'NG',region:'Lagos'},source:'production test fixture',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),sensitivity:'standard',caseId:null});
  const smoke=async()=>{const {stdout}=await exec(process.execPath,[resolve(runtime,'scripts/mcp-smoke.mjs')],{cwd:runtime,env:{PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:cert,AXIS_MCP_URL:`${origin}/mcp`,AXIS_SMOKE_TOKEN:token,AXIS_SMOKE_KEY:'production-stable-read'},timeout:30000});assert.ok(!stdout.includes(token));assert.ok(!stdout.includes('Lagos'));return JSON.parse(stdout) as {workId:string;verification:string};};
  const first=await smoke();assert.equal(first.verification,'VERIFIED');await stop();await start();
  const second=await smoke();assert.equal(second.workId,first.workId);
  assert.equal((await db.query('SELECT count(*)::int n FROM actions')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM provider_attempts')).rows[0].n,2);
 }finally{await stop();proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
