import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";
const server=new McpServer({name:"axis-upstream-test-fixture",version:"1"});
const read=server.registerTool("read",{inputSchema:{query:z.string()}},async({query})=>{
 if(query==="__change_schema__")read.update({paramsSchema:{changed:z.string()}});
 return {content:[{type:"text",text:query==="__oversize__"?"x".repeat(70000):query}]};
});
server.registerTool("slow",{inputSchema:{}},async()=>{await new Promise(r=>setTimeout(r,3000));return {content:[{type:"text",text:"too late"}]};});
server.registerTool("hidden",{inputSchema:{}},async()=>({content:[{type:"text",text:"must never be discovered by clients"}]}));
await server.connect(new StdioServerTransport());
