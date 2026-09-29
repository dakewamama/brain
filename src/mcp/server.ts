import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { AxisError } from "../grants/service.js";
import { AxisGateway,prepareSchema,executeSchema,statusSchema,cancelSchema,searchSchema,invokeSchema } from "../gateway/service.js";

export function createAxisMcpServer(gateway:AxisGateway,token:string):McpServer {
  const server=new McpServer({name:"axis",version:"1.0.0"});
  const call=async(fn:()=>Promise<unknown>)=>{
    try { const data=await fn();return {content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:{result:data}}; }
    catch(error) {return {isError:true,content:[{type:"text" as const,text:JSON.stringify({error:error instanceof AxisError?error.code:error instanceof z.ZodError?"invalid_arguments":"internal_error"})}]};}
  };
  server.registerTool("axis.prepare",{description:"Prepare an immutable Axis Case without external effects",inputSchema:prepareSchema},args=>call(()=>gateway.prepare(token,args)));
  server.registerTool("axis.execute",{description:"Authorize and queue an existing preparation",inputSchema:executeSchema},args=>call(()=>gateway.execute(token,args)));
  server.registerTool("axis.status",{description:"Read authorized durable status, evidence and verification",inputSchema:statusSchema},args=>call(()=>gateway.status(token,args)));
  server.registerTool("axis.cancel",{description:"Request truthful cancellation; irreversible effects may not be cancellable",inputSchema:cancelSchema},args=>call(()=>gateway.cancel(token,args)));
  server.registerTool("axis.capabilities.search",{description:"Find up to five authorized and available capabilities",inputSchema:searchSchema},args=>call(()=>gateway.searchCapabilities(token,args)));
  server.registerTool("axis.capabilities.invoke",{description:"Invoke via durable Axis execution; requires a stable idempotency key",inputSchema:invokeSchema},args=>call(()=>gateway.invokeCapability(token,args)));
  return server;
}
export function createMcpApp(gateway:AxisGateway,options:{host?:string;publicOrigin?:string}={}) {
  const host=options.host??"127.0.0.1";
  const origin=options.publicOrigin?new URL(options.publicOrigin):undefined;
  if(!["127.0.0.1","localhost","::1"].includes(host)&&!origin) throw new Error("public MCP listener requires MCP_PUBLIC_ORIGIN");
  if(process.env.NODE_ENV==="production"&&origin?.protocol!=="https:") throw new Error("production MCP requires HTTPS public origin");
  const app=createMcpExpressApp({host,...(origin?{allowedHosts:[origin.hostname]}:{})});
  app.use("/mcp",(req,res,next)=>{
    if(req.headers.origin && req.headers.origin!==(origin?.origin??`http://${req.headers.host}`)) {res.status(403).json({error:"origin_not_allowed"});return;}
    next();
  });
  app.use("/mcp",requireBearerAuth({verifier:{async verifyAccessToken(token){
    try {const p=await gateway.grants.authenticate(token);return {token,clientId:p.clientId,scopes:p.authority.scopes,expiresAt:Math.floor(p.expiresAt.getTime()/1000)};}
    catch {throw new InvalidTokenError("Invalid or inactive Axis Grant");}
  }}}));
  app.post("/mcp",async(req,res)=>{
    const server=createAxisMcpServer(gateway,req.auth!.token);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on("close",()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if(!res.headersSent) res.status(500).json({jsonrpc:"2.0",id:null,error:{code:-32603,message:"Internal error"}});}
  });
  app.get("/mcp",(_req,res)=>{res.status(405).end();});app.delete("/mcp",(_req,res)=>{res.status(405).end();});
  app.get("/health",(_req,res)=>{res.json({service:"axis-mcp",status:"ready"});});
  const errors:ErrorRequestHandler=(_error,_req,res,_next)=>{res.status(400).json({error:"invalid_request"});};app.use(errors);
  return app;
}
