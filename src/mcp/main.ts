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
 const gateway=new AxisGateway(pool,registry);
 const configs=z.array(z.unknown()).max(1).parse(JSON.parse(process.env.AXIS_UPSTREAM_MCP??"[]"));
 const upstreams:Awaited<ReturnType<typeof connectUpstream>>[]=[];
 for(const config of configs)upstreams.push(await connectUpstream(registry,config));
 const host=process.env.MCP_HOST??"127.0.0.1";const port=z.coerce.number().int().min(1).max(65535).parse(process.env.PORT??3000);
 const app=createMcpApp(gateway,{host,publicOrigin:process.env.MCP_PUBLIC_ORIGIN});
 const worker=new CaseWorker(gateway.runner,gateway.store);worker.start();
 const server=app.listen(port,host,()=>{console.log(`Axis MCP ready on ${host}:${port}/mcp`);});
 let stopping=false;
 const stop=async()=>{
  if(stopping)return;stopping=true;worker.stop();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const upstream of upstreams)await upstream.close();await closePool();
 };
 process.once("SIGTERM",()=>{void stop();});process.once("SIGINT",()=>{void stop();});
}
main().catch(async error=>{console.error(error instanceof Error?error.message:"Axis startup failed");await closePool();process.exitCode=1;});
