import { chromium,type Page } from "playwright";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CapabilityRegistry,type ProviderContext,type ProviderResult } from "../capabilities/registry.js";
import { AxisError } from "../grants/service.js";
export const browserArgs=z.object({sessionId:z.string(),path:z.string().startsWith("/"),selector:z.string(),revision:z.number().int().nonnegative(),value:z.string().max(2000).optional(),clickSelector:z.string().optional(),expected:z.string().max(2000).optional(),verifySelector:z.string().optional()}).strict();
export type BrowserInput=z.infer<typeof browserArgs>;
export interface BrowserProvider { perform(operation:"observe"|"act"|"extract"|"verify",input:BrowserInput,context:ProviderContext):Promise<ProviderResult> }
interface Session {id:string;user_id:string;origin:string;paths:string[];selectors:string[];profile_path:string;mode:"LIVE"|"SANDBOX";revision:number;expires_at:Date;disabled:boolean}
/** Existing Playwright browser infrastructure. Profiles remain server-side;
 * agents get neither cookies, credential fields, nor arbitrary script execution. */
export class PlaywrightBrowserProvider implements BrowserProvider {
 constructor(private pool:Pool,private root:string,private timeoutMs=5000){}
 async createSession(input:{userId:string;origin:string;paths:string[];selectors:string[];mode:"LIVE"|"SANDBOX";expiresAt:Date}):Promise<string>{
  const origin=new URL(input.origin);if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password)throw new AxisError("invalid_browser_origin");
  if(input.mode==="LIVE"&&origin.protocol!=="https:")throw new AxisError("live_browser_requires_https");
  const id=randomUUID(),profile=join(this.root,id);await mkdir(profile,{recursive:true,mode:0o700});
  await this.pool.query("INSERT INTO browser_sessions(id,user_id,origin,paths,selectors,profile_path,mode,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[id,input.userId,origin.origin,JSON.stringify(input.paths),JSON.stringify(input.selectors),profile,input.mode,input.expiresAt]);return id;
 }
 async perform(operation:"observe"|"act"|"extract"|"verify",input:BrowserInput,c:ProviderContext):Promise<ProviderResult>{
  const db=await this.pool.connect();
  try{
   await db.query("BEGIN");const r=await db.query("SELECT * FROM browser_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE",[input.sessionId,c.userId]);const s=r.rows[0] as Session|undefined;
   if(!s||s.disabled||new Date(s.expires_at)<=new Date())throw new AxisError("browser_session_unavailable");
   if(c.executionMode && s.mode!==c.executionMode)throw new AxisError("browser_mode_mismatch");
   if(s.mode==="SANDBOX"&&process.env.NODE_ENV==="production")throw new AxisError("sandbox_browser_forbidden");
   if(s.revision!==input.revision)throw new AxisError("stale_browser_session");
   if(!s.paths.includes(input.path)||![input.selector,input.clickSelector,input.verifySelector].filter(Boolean).every(v=>s.selectors.includes(v!)))throw new AxisError("browser_surface_not_allowed");
   const url=new URL(input.path,s.origin);if(url.origin!==s.origin||url.username||url.password)throw new AxisError("browser_surface_not_allowed");
   const browser=await chromium.launchPersistentContext(s.profile_path,{headless:true,acceptDownloads:false,serviceWorkers:"block"});
   try{
    await browser.route("**/*",route=>{
     const request=route.request(),u=new URL(request.url());return u.origin===s.origin&&(!request.isNavigationRequest()||s.paths.includes(u.pathname+u.search))?route.continue():route.abort("blockedbyclient");
    });
    const page=await browser.newPage();page.setDefaultTimeout(this.timeoutMs);page.setDefaultNavigationTimeout(this.timeoutMs);
    await page.goto(url.href,{waitUntil:"domcontentloaded"});
    if(operation==="act"){
     if(input.value!==undefined){const field=page.locator(input.selector);if(await field.getAttribute("type")==="password")throw new AxisError("credential_access_forbidden");await field.fill(input.value);}
     if(input.clickSelector)await page.locator(input.clickSelector).click();
     // Independent target observation after reloading authoritative website state.
     await page.reload({waitUntil:"domcontentloaded"});
    }
    const selector=input.verifySelector??input.selector;
    const observation=await this.observe(page,selector,url.href);
    const verified=input.expected!==undefined&&observation.text===input.expected;
    const revision=operation==="act"?s.revision+1:s.revision;
    if(operation==="act")await db.query("UPDATE browser_sessions SET revision=$2 WHERE id=$1",[s.id,revision]);
    await db.query("COMMIT");
    const data={...observation,sessionId:s.id,revision,verified,providerMode:s.mode};
    if(operation==="verify"&&!verified)return {outcome:"failed",data};
    return {outcome:"succeeded",data,...(verified?{targetState:"observed expected website state",providerRef:`browser:${s.id}:${revision}`}:{})};
   }finally{await browser.close();}
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
 private async observe(page:Page,selector:string,url:string){
  if(page.url()!==url)throw new AxisError("browser_unexpected_navigation");
  const element=page.locator(selector);
  if(await element.getAttribute("type")==="password")throw new AxisError("credential_access_forbidden");
  const text=(await element.textContent())??"";if(text.length>8192)throw new AxisError("browser_evidence_too_large");
  return {url,selector,text,observedAt:new Date().toISOString()};
 }
}
export function registerBrowser(registry:CapabilityRegistry,provider:BrowserProvider,mode:"LIVE"|"SANDBOX"){
 const input={type:"object",properties:{sessionId:{type:"string"},path:{type:"string"},selector:{type:"string"},revision:{type:"integer",minimum:0},value:{type:"string",maxLength:2000},clickSelector:{type:"string"},expected:{type:"string",maxLength:2000},verifySelector:{type:"string"}},required:["sessionId","path","selector","revision"],additionalProperties:false};
 for(const operation of ["observe","act","extract","verify"] as const){
  const id=`browser.${operation}`;registry.register({id,version:"1",provider:{id:"playwright",kind:"native"},description:`Browser fallback: ${operation} on an explicitly allowed session surface; never bypass access controls`,inputSchema:input,outputSchema:{type:"object"},mode,risk:operation==="act"?"write":"read",requiredScopes:[id],reversible:operation!=="act",contextTypes:[],health:"healthy"},{resources:a=>[`browser:${a.sessionId}`],execute:(a,c)=>provider.perform(operation,browserArgs.parse(a),c)});
 }
}
