import express from "express";
import { PajProvider } from "../providers/paj/provider.js";
import { configFromEnv } from "../providers/paj/client.js";
import { pajWebhookRouter } from "../providers/paj/http.js";
import type { Server } from "node:http";
import { z } from "zod";
import { getPool,migrate,closePool } from "../db/pool.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { registerCoreCapabilities } from "../capabilities/core.js";
import { AxisGateway } from "../gateway/service.js";
import { CaseWorker } from "../cases/worker.js";
import { createMcpApp } from "./server.js";
import { connectUpstream } from "./upstream.js";

async function main():Promise<void> {
 const pool=getPool();if(!pool)throw new Error("Axis MCP requires DATABASE_URL; no in-memory production fallback");
 await migrate();
 const registry=new CapabilityRegistry();registerCoreCapabilities(registry);
 const paj=new PajProvider(pool,configFromEnv(process.env));await paj.register(registry);
 const gateway=new AxisGateway(pool,registry);
 const configs=z.array(z.unknown()).max(1).parse(JSON.parse(process.env.AXIS_UPSTREAM_MCP??"[]"));
 const upstreams:Awaited<ReturnType<typeof connectUpstream>>[]=[];
 const host=process.env.MCP_HOST??"127.0.0.1";const port=z.coerce.number().int().min(1).max(65535).parse(process.env.PORT??3000);
 const app=express();app.use(pajWebhookRouter(paj));app.use(createMcpApp(gateway,{host,publicOrigin:process.env.MCP_PUBLIC_ORIGIN}));
 const worker=new CaseWorker(gateway.runner,gateway.store);
 try {
  for(const config of configs)upstreams.push(await connectUpstream(registry,config));
  const server=await new Promise<Server>((resolve,reject)=>{
    const instance=app.listen(port,host,()=>resolve(instance));instance.once("error",reject);
  });
  worker.start();console.log(`Axis MCP ready on ${host}:${port}/mcp`);
  let stopping=false;
  const stop=async()=>{
   if(stopping)return;stopping=true;worker.stop();
   await new Promise<void>(resolve=>server.close(()=>resolve()));
   await worker.stopAndDrain();
   for(const upstream of upstreams)await upstream.close();await closePool();
  };
  process.once("SIGTERM",()=>{void stop();});process.once("SIGINT",()=>{void stop();});
 }catch(error){await worker.stopAndDrain();for(const upstream of upstreams)await upstream.close();throw error;}

}
main().catch(async error=>{console.error(error instanceof Error?error.message:"Axis startup failed");await closePool();process.exitCode=1;});
