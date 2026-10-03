import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {providerJson} from "../src/core/provider-response.js";
import {ComposioSource} from "../src/catalog/source.js";
import {PajClient} from "../src/providers/paj/client.js";

test("provider JSON limits declared and streamed bytes and cancels oversized streams",async()=>{
 let cancelled=false;
 const body=()=>new ReadableStream<Uint8Array>({pull(c){c.enqueue(new TextEncoder().encode("12345678"));},cancel(){cancelled=true;}});
 await assert.rejects(providerJson(new Response(body()),10),/provider_response_too_large/);
 assert.equal(cancelled,true);cancelled=false;
 await assert.rejects(providerJson(new Response(body(),{headers:{"content-length":"100"}}),10),/provider_response_too_large/);
 assert.equal(cancelled,true);
 assert.deepEqual(await providerJson(Response.json({ok:true})),{ok:true});
 await assert.rejects(providerJson(new Response("private malformed response")),/provider_response_invalid/);
});

test("authenticated provider requests never follow redirects to a credential receiver",async()=>{
 let forwarded=0;
 const server=createServer((req,res)=>{
  if(req.url==="/receiver"){forwarded++;res.end("{}");return;}
  res.writeHead(307,{location:"/receiver"});res.end();
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address() as {port:number};
 // Exercise real fetch redirect semantics against a local provider fixture.
 const transport:typeof fetch=(_input,init)=>fetch(`http://127.0.0.1:${address.port}/provider`,init);
 try{
  await assert.rejects(new ComposioSource("test-secret",transport).connection("account"));
  const paj=new PajClient({apiKey:"test-secret",environment:"staging",mint:"test-mint",enabled:[]},transport);
  await assert.rejects(paj.rates("NGN"));
  assert.equal(forwarded,0,"API-key-bearing requests must not reach redirected endpoints");
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
