import { z } from "zod";
import { CapabilityRegistry, type CapabilityDescriptor, type ProviderResult } from "./registry.js";
import { AxisError } from "../grants/service.js";
const object=(properties:Record<string,unknown>={},required:string[]=[])=>({type:"object",properties,required,additionalProperties:false});
const text={type:"string",minLength:1,maxLength:300};
const output={type:"object"};
export interface LocationProvider { mode:"LIVE"|"SANDBOX"; search(query:string):Promise<Record<string,unknown>> }
export interface CommerceProvider {
 mode:"LIVE"|"SANDBOX";
 search(query:string):Promise<Record<string,unknown>>;
 /** Must return the merchant's current offer, not a search-engine price. */
 quote(input:{merchantId:string;productId:string;quantity:number}):Promise<{quoteId:string;merchantId:string;productId:string;quantity:number;asset:string;amountMinor:string;expiresAt:string}>;
}
export class PhotonProvider implements LocationProvider {
 readonly mode="LIVE" as const;
 constructor(private endpoint:string){}
 async search(query:string):Promise<Record<string,unknown>> {
  const url=new URL(this.endpoint);url.searchParams.set("q",query);url.searchParams.set("limit","5");
  const response=await fetch(url,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new AxisError("provider_unavailable");
  const body=z.object({features:z.array(z.object({geometry:z.object({coordinates:z.tuple([z.number(),z.number()])}),properties:z.object({name:z.string().optional(),city:z.string().optional(),country:z.string().optional(),osm_id:z.union([z.string(),z.number()]).optional()})})).max(100)}).parse(await response.json());
  return {places:body.features.slice(0,5),source:"OpenStreetMap / Photon",observedAt:new Date().toISOString()};
 }
}
export function registerCoreCapabilities(registry:CapabilityRegistry,options:{env?:NodeJS.ProcessEnv;location?:LocationProvider;commerce?:CommerceProvider}={}):void {
 const env=options.env??process.env;
 const payments=!!(env.ONBOARDING_URL&&env.INTERNAL_API_TOKEN);
 const paymentMode=payments&&["LIVE","SANDBOX"].includes(env.AXIS_ONBOARDING_MODE??"")?env.AXIS_ONBOARDING_MODE as "LIVE"|"SANDBOX":"UNAVAILABLE";
 const base=(id:string,description:string,inputSchema:unknown,mode:CapabilityDescriptor["mode"]="LIVE",risk:CapabilityDescriptor["risk"]="read",provider="axis"):CapabilityDescriptor=>({id,version:"1",provider:{id:provider,kind:provider==="axis"?"native":"external_api"},description,inputSchema,outputSchema:output,mode,risk,requiredScopes:[id],reversible:risk==="read",contextTypes:[],health:"healthy"});
 registry.register(base("location.context","Read authorized coarse or exact user location",object({precision:{type:"string",enum:["coarse","exact"]}},["precision"])),{
  requiredContext:a=>[`location.${a.precision}`],
  async execute(a,c){const item=c.context.find(i=>i.type===`location.${a.precision}`);if(!item)throw new AxisError("context_unavailable");return {outcome:"succeeded",data:{location:item.value,precision:a.precision,source:item.source,observedAt:item.observedAt,expiresAt:item.expiresAt}};},
 });
 const location=options.location??(env.AXIS_PHOTON_URL?new PhotonProvider(env.AXIS_PHOTON_URL):undefined);
 registry.register(base("location.search","Search public places; does not access user coordinates",object({query:text},["query"]),location?.mode??"UNAVAILABLE","read","photon"),{async execute(a){if(!location)throw new AxisError("provider_unavailable");return {outcome:"succeeded",data:await location.search(String(a.query))};}});
 const onboarding=async(path:string,body?:Record<string,unknown>)=>{
  const res=await fetch(`${env.ONBOARDING_URL!.replace(/\/$/,"")}${path}`,{method:body?"POST":"GET",headers:{authorization:`Bearer ${env.INTERNAL_API_TOKEN}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const data:unknown=await res.json().catch(()=>null);return {res,data};
 };
 registry.register({...base("money.balance","Read the user's authoritative spendable custody balance",object(),paymentMode,"read","onboarding"),metadata:{requiredResources:["wallet:self"]}},{
  resources:()=>["wallet:self"],async execute(_a,c){const {res,data}=await onboarding(`/wallet/balance?userId=${encodeURIComponent(c.userId)}`);if(!res.ok)throw new AxisError("provider_unavailable");
   const parsed=z.object({baseUnits:z.string().regex(/^\d+$/)}).parse(data);return {outcome:"succeeded",data:{asset:"USDC",availableMinor:parsed.baseUnits,state:"AVAILABLE",source:"onboarding",observedAt:new Date().toISOString()}};
  },
 });
 registry.register(base("money.transfer","Unavailable: custody transfer does not yet expose the required stable identity and settlement contract",object(),"UNAVAILABLE","financial","onboarding"),{async execute(){throw new AxisError("provider_unavailable");}});
 const normalize=(status:number,raw:unknown):ProviderResult=>{
  const parsed=z.object({status:z.string(),moneyState:z.enum(["IN_DOUBT","PENDING","SETTLED","RELEASED","REVERSED"]),requestId:z.string().optional(),chargedBaseUnits:z.string().regex(/^\d+$/).optional()}).safeParse(raw);
  if(status===402)return {outcome:"failed",data:{reason:"insufficient_balance"},moneyState:"RELEASED"};
  if(!parsed.success)return {outcome:"unknown",data:{}};
  const r=parsed.data;
  if(r.status==="delivered"&&r.moneyState==="SETTLED"&&r.requestId&&r.chargedBaseUnits)return {outcome:"succeeded",data:r,targetState:"delivered",providerRef:r.requestId,moneyState:"SETTLED"};
  if(r.status==="failed"&&["RELEASED","REVERSED"].includes(r.moneyState))return {outcome:"failed",data:r,moneyState:r.moneyState as "RELEASED"|"REVERSED"};
  return {outcome:r.status==="pending"?"pending":"unknown",data:r,moneyState:"IN_DOUBT"};
 };
 registry.register({...base("telecom.airtime.purchase","Purchase Nigerian airtime through existing custody; unknown outcomes reconcile under the original identity",object({network:{type:"string",enum:["mtn","glo","airtel","9mobile"]},phone:{type:"string",pattern:"^0[789][01][0-9]{8}$"},amount:{type:"integer",minimum:1,maximum:50000}},["network","phone","amount"]),paymentMode,"financial","onboarding/vtpass"),metadata:{requiredResources:["wallet:self"]}}, {
  resources:a=>["wallet:self",`telecom:${a.phone}`],money:a=>({asset:"NGN",amountMinor:(BigInt(String(a.amount))*100n).toString()}),
  async execute(a,c){const {res,data}=await onboarding("/airtime",{...a,owner:c.userId,idempotencyKey:c.idempotencyKey});return normalize(res.status,data);},
  async requery(_a,c){const {res,data}=await onboarding(`/airtime/status?idempotencyKey=${encodeURIComponent(c.idempotencyKey)}`);return normalize(res.status,data);},
 });
 const commerce=options.commerce;
 const serper=!!env.SERPER_API_KEY;
 registry.register(base("commerce.search","Search product observations; displayed prices are not authoritative merchant quotes",object({query:text},["query"]),commerce?.mode??(serper?"LIVE":"UNAVAILABLE"),"read",commerce?"commerce-provider":"serper"),{
  async execute(a){
   if(commerce)return {outcome:"succeeded",data:await commerce.search(String(a.query))};
   const res=await fetch(env.SERPER_SHOPPING_URL??"https://google.serper.dev/shopping",{method:"POST",headers:{"X-API-KEY":env.SERPER_API_KEY!,"content-type":"application/json"},body:JSON.stringify({q:a.query,gl:"ng",hl:"en",num:5}),signal:AbortSignal.timeout(8000)});
   if(!res.ok)throw new AxisError("provider_unavailable");
   const parsed=z.object({shopping:z.array(z.object({title:z.string(),link:z.string().url(),price:z.string().optional(),source:z.string().optional()}))}).parse(await res.json());
   return {outcome:"succeeded",data:{products:parsed.shopping.slice(0,5),authoritativeQuote:false,source:"serper",observedAt:new Date().toISOString()}};
  },
 });
 registry.register(base("commerce.quote","Obtain a current offer from an authorized merchant provider; unavailable without that provider",object({merchantId:text,productId:text,quantity:{type:"integer",minimum:1,maximum:100}},["merchantId","productId","quantity"]),commerce?.mode??"UNAVAILABLE","read","commerce-provider"),{
  resources:a=>[`merchant:${a.merchantId}`],async execute(a){if(!commerce)throw new AxisError("provider_unavailable");
   const quote=z.object({quoteId:z.string().min(1),merchantId:z.string(),productId:z.string(),quantity:z.number().int().positive(),asset:z.string(),amountMinor:z.string().regex(/^\d+$/),expiresAt:z.string().datetime()}).strict().parse(await commerce.quote({merchantId:String(a.merchantId),productId:String(a.productId),quantity:Number(a.quantity)}));
   if(Date.parse(quote.expiresAt)<=Date.now()||quote.merchantId!==a.merchantId||quote.productId!==a.productId||quote.quantity!==a.quantity)throw new AxisError("invalid_quote");
   return {outcome:"succeeded",data:{...quote,source:"merchant",authoritativeQuote:true},providerRef:quote.quoteId};
  },
 });
}
