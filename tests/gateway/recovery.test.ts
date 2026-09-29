import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {Pool} from "pg";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const base=process.env.TEST_DATABASE_URL;
test("SIGKILL after provider accepts is recovered by a fresh process using requery, never repurchase",{skip:!base,timeout:60000},async()=>{
 const schema=`recovery_${randomUUID().replaceAll("-","")}`;
 const admin=new Pool({connectionString:base});await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(base!);url.searchParams.set("options",`-c search_path=${schema}`);
 process.env.DATABASE_URL=url.toString();resetConfigForTests();await migrate();await closePool();
 const db=new Pool({connectionString:url.toString()});let purchases=0,queries=0,requestId="";
 let accepted!:()=>void;const acceptedPromise=new Promise<void>(r=>{accepted=r;});
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const id=Buffer.concat(chunks).toString();
  if(req.url==="/purchase"){purchases++;requestId=id;accepted();/* accepted external effect; response deliberately lost */}
  else {queries++;assert.equal(id,requestId);res.setHeader("content-type","application/json");res.end(JSON.stringify({id,delivered:true}));}
 });await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const env={...process.env,TEST_DATABASE_URL:url.toString(),TEST_PROVIDER_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`};
 const child=spawn(process.execPath,["--import","tsx","tests/fixtures/crash-gateway.ts","purchase"],{env,stdio:["ignore","pipe","pipe"]});
 let output="";child.stdout.on("data",b=>{output+=b;});child.stderr.on("data",b=>{output+=b;});
 try{
  await acceptedPromise;const exit=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGKILL");await exit;
  const before=(await db.query("SELECT status FROM cases")).rows[0];assert.equal(before.status,"running");
  const recovery=spawn(process.execPath,["--import","tsx","tests/fixtures/crash-gateway.ts","recover"],{env,stdio:["ignore","pipe","pipe"]});
  recovery.stdout.on("data",b=>{output+=b;});recovery.stderr.on("data",b=>{output+=b;});
  assert.equal(await new Promise(resolve=>recovery.once("exit",resolve)),0,output);
  assert.equal((await db.query("SELECT status FROM cases")).rows[0].status,"completed");
  assert.equal(purchases,1);assert.equal(queries,1);assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM actions")).rows[0].n,1);
  assert.equal((await db.query("SELECT state FROM action_money")).rows[0].state,"SETTLED");
 }finally{child.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
