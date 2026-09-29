import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { digest } from "../../core/digest.js";
import { AxisError, type Principal } from "../../grants/service.js";
import { CapabilityRegistry, type CapabilityDescriptor, type ProviderContext, type ProviderResult } from "../../capabilities/registry.js";
import { PajClient, type PajConfig, units, wire, validSolanaAddress } from "./client.js";

const text={type:"string",minLength:1,maxLength:200};
const minor={type:"string",pattern:"^[1-9][0-9]{0,12}$"};
const schema=(properties:Record<string,unknown>,required:string[])=>({type:"object",properties,required,additionalProperties:false});
const transaction=z.object({id:z.string().min(1),status:z.string(),transactionType:z.enum(["ON_RAMP","OFF_RAMP"]),chain:z.literal("SOLANA"),mint:z.string(),currency:z.literal("NGN"),usdcAmount:z.number().nonnegative().finite(),fiatAmount:z.number().nonnegative().finite(),fee:z.number().nonnegative().finite(),rate:z.number().positive(),recipient:z.string().optional(),accountNumber:z.string().optional(),accountName:z.string().optional(),bank:z.string().optional(),address:z.string().optional(),signature:z.string().optional(),createdAt:z.string().datetime()});
type Order={action_id:string;user_id:string;grant_id:string;direction:"on"|"off";provider_id:string|null;response:Record<string,unknown>|null;request:Record<string,unknown>;rate:Record<string,unknown>;expires_at:Date};
/** PAJ v2 adapter. Local identity is durable; the documented API has no
 * idempotency header or GET-order endpoint. Requery reads signed deliveries,
 * never invents a status URL and never repeats order creation. */
export class PajProvider {
 constructor(readonly pool:Pool,readonly config:PajConfig|undefined,readonly client=config?new PajClient(config):undefined){}
 async register(registry:CapabilityRegistry):Promise<void>{
  // Production and staging authenticate against their own PAJ origin. A failing
  // auth/rate probe prevents startup; it never silently selects a mock.
  if(this.client)await this.client.rates("NGN");
  const mode=(id:string):CapabilityDescriptor["mode"]=>!this.config?.enabled.includes(id)?"UNAVAILABLE":this.config.environment==="production"?"LIVE":"SANDBOX";
  const base=(id:string,description:string,inputSchema:unknown,risk:CapabilityDescriptor["risk"]="read"):CapabilityDescriptor=>({id,version:"1",provider:{id:"paj",kind:"external_api"},description,inputSchema,outputSchema:{type:"object"},mode:mode(id),risk,requiredScopes:[id],reversible:risk==="read",contextTypes:[],health:"healthy",metadata:{statusSource:"signature-verified webhooks; no public GET-order API",rateIsLocked:false}});
  registry.register(base("ramp.quote","PAJ authoritative current indicative FX rate, including business spread; not a locked order quote or calculated payout",schema({currency:{const:"NGN"}},["currency"])),{execute:async a=>({outcome:"succeeded",data:{...await this.client!.rates(String(a.currency)),source:"paj",binding:false,observedAt:new Date().toISOString()}})});
  registry.register(base("bank.resolve","Look up an existing PAJ bank account by account number; does not register a new beneficiary",schema({accountNumber:{type:"string",pattern:"^[0-9]{10}$"}},["accountNumber"])),{resources:a=>[`bank:${a.accountNumber}`],execute:async a=>({outcome:"succeeded",data:await this.client!.resolve(String(a.accountNumber))})});
  registry.register(base("ramp.status","Read this Grant's persisted PAJ order and signature-verified webhook status; not a fresh remote poll",schema({actionId:text},["actionId"])),{execute:async(a,c)=>{const order=await this.order(String(a.actionId),c);const result=await this.result(order);return {outcome:"succeeded",data:{actionId:order.action_id,providerId:order.provider_id,state:result.outcome,moneyState:result.moneyState??null,source:"persisted PAJ response / signed webhook",details:result.data}};}});
  for(const direction of ["on","off"] as const){
   const id=`ramp.${direction}`;
   const fields:Record<string,unknown>={asset:{const:"USDC"},network:{const:"SOLANA"},currency:{const:"NGN"},amountMinor:minor,maxDebitMinor:minor,quoteId:text};
   if(direction==="on")fields.recipient={type:"string",pattern:"^[1-9A-HJ-NP-Za-km-z]{32,44}$"};else {fields.accountNumber={type:"string",pattern:"^[0-9]{10}$"};fields.bankCode={type:"string",pattern:"^[0-9]{3,10}$"};}
   const d=base(id,direction==="on"?"PAJ fiat-to-USDC onramp to an authorized Solana wallet. Requires external bank funding; order creation is not completion.":"PAJ USDC-to-NGN offramp to an authorized bank account. Requires external token funding; not a generic bank transfer.",schema(fields,["asset","network","currency","amountMinor","maxDebitMinor",...(direction==="on"?["recipient"]:["accountNumber","bankCode"])]),"financial");
   if(!this.config?.webhookSecret||!this.config.webhookOrigin)d.mode="UNAVAILABLE";
   registry.register(d,{
    resources:a=>[direction==="on"?`wallet:SOLANA:${a.recipient}`:`bank:${a.accountNumber}`],
    money:a=>({asset:direction==="on"?"NGN":"USDC",amountMinor:String(a.maxDebitMinor),tokenAsset:"USDC",currency:"NGN",destination:direction==="on"?String(a.recipient):`${a.bankCode}:${a.accountNumber}`}),
    prepare:(a,p)=>this.prepare(direction,a,p),
    execute:(a,c)=>this.create(direction,a,c),
    requery:async(_a,c)=>this.result(await this.order(c.actionId,c)),
   });
  }
  registry.register({...base("money.transfer.bank","Unavailable: PAJ's documented bank payout is crypto offramp; no independent balance-to-bank transfer contract exists",schema({},[]),"financial"),mode:"UNAVAILABLE"},{execute:async()=>{throw new AxisError("paj_direct_transfer_unsupported");}});
 }
 private async prepare(direction:"on"|"off",args:Record<string,unknown>,p:Principal){
  if(direction==="on"&&!validSolanaAddress(String(args.recipient)))throw new AxisError("paj_invalid_wallet");
  if(BigInt(String(args.amountMinor))>BigInt(String(args.maxDebitMinor)))throw new AxisError("financial_limit");
  // Validate exact conversion before any external request. Support only the
  // inspected USDC/Solana/NGN contract; no inferred token/network support.
  wire(String(args.amountMinor),direction==="on"?2:6);
  if(direction==="off")await this.client!.resolve(String(args.accountNumber));
  const rates=await this.client!.rates("NGN"),rate=direction==="on"?rates.onRampRate:rates.offRampRate;
  const request={...args};delete request.quoteId;
  const id=randomUUID();await this.pool.query("INSERT INTO paj_quotes(id,user_id,grant_id,request,rate,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '2 minutes')",[id,p.userId,p.grantId,{...request,direction},rate]);
  return {...request,quoteId:id};
 }
 private async create(direction:"on"|"off",a:Record<string,unknown>,c:ProviderContext):Promise<ProviderResult>{
  const found=await this.pool.query("SELECT * FROM paj_quotes WHERE id=$1 AND user_id=$2 AND grant_id=$3",[a.quoteId,c.userId,c.grantId]);
  const quote=found.rows[0];const request={...a};delete request.quoteId;
  if(!quote||digest(quote.request)!==digest({...request,direction})||new Date(quote.expires_at)<=new Date())return {outcome:"failed",data:{reason:"expired_or_invalid_quote"},moneyState:"RELEASED"};
  const rates=await this.client!.rates("NGN");
  if(digest(direction==="on"?rates.onRampRate:rates.offRampRate)!==digest(quote.rate))return {outcome:"failed",data:{reason:"rate_changed_prepare_again"},moneyState:"RELEASED"};
  if(direction==="off")await this.client!.resolve(String(a.accountNumber));
  const created=await this.pool.query("INSERT INTO paj_orders(action_id,user_id,grant_id,direction,quote_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING action_id",[c.actionId,c.userId,c.grantId,direction,a.quoteId]);
  if(!created.rowCount)return this.result(await this.order(c.actionId,c));
  const webhookURL=`${this.config!.webhookOrigin!.replace(/\/$/,"")}/webhooks/paj/${c.actionId}/${this.callbackToken(c.actionId)}`;
  const body:Record<string,unknown>={currency:"NGN",chain:"SOLANA",mint:this.config!.mint,webhookURL,businessUSDCFee:0,...(direction==="on"?{fiatAmount:wire(String(a.amountMinor),2),recipient:a.recipient}:{amount:wire(String(a.amountMinor),6),accountNumber:a.accountNumber,bankCode:a.bankCode})};
  // Commit the submission tombstone BEFORE HTTP. Even a timeout or process
  // crash after acceptance cannot cause another POST for this Action.
  const raw=await this.client!.request("POST",`/pub/v2/${direction}ramp`,body);
  const identity=z.object({id:z.string().min(1)}).parse(raw);
  await this.pool.query("UPDATE paj_orders SET provider_id=$2,response=$3 WHERE action_id=$1 AND (provider_id IS NULL OR provider_id=$2)",[c.actionId,identity.id,raw]);
  return this.result(await this.order(c.actionId,c));
 }
 private async order(actionId:string,c:ProviderContext):Promise<Order>{
  const r=await this.pool.query("SELECT o.*,q.request,q.rate,q.expires_at FROM paj_orders o JOIN paj_quotes q ON q.id=o.quote_id WHERE o.action_id=$1 AND o.user_id=$2 AND o.grant_id=$3",[actionId,c.userId,c.grantId]);
  if(!r.rows[0])throw new AxisError("not_found");return r.rows[0] as Order;
 }
 private async result(order:Order):Promise<ProviderResult>{
  const events=await this.pool.query("SELECT payload,digest FROM paj_webhooks WHERE action_id=$1 ORDER BY received_at,digest",[order.action_id]);
  const finals=events.rows.filter(e=>["COMPLETED","ERROR"].includes(e.payload.status));
  if(new Set(finals.map(e=>e.payload.status)).size>1)return {outcome:"unknown",data:{reason:"conflicting_provider_events"},moneyState:"IN_DOUBT"};
  const event=finals.at(-1)??events.rows.at(-1);
  const raw=event?.payload??order.response;const parsed=transaction.safeParse(raw);
  if(!parsed.success)return {outcome:"unknown",data:{providerId:order.provider_id},moneyState:"IN_DOUBT"};
  const t=parsed.data,r=order.request;
  if(t.id!==order.provider_id||t.mint!==this.config!.mint||t.transactionType!==(order.direction==="on"?"ON_RAMP":"OFF_RAMP")||
    (order.direction==="on"?t.recipient!==r.recipient:t.accountNumber!==r.accountNumber))return {outcome:"unknown",data:{reason:"provider_identity_mismatch"},moneyState:"IN_DOUBT"};
  const debit=order.direction==="on"?units(t.fiatAmount,2):units(t.usdcAmount,6)+units(t.fee,6);
  if((order.direction==="off" && units(t.usdcAmount,6)!==BigInt(String(r.amountMinor))) || (order.direction==="on" && units(t.fiatAmount,2)!==BigInt(String(r.amountMinor))) || debit>BigInt(String(r.maxDebitMinor))||debit<=0n)return {outcome:"unknown",data:{reason:"provider_debit_outside_grant_bound"},moneyState:"IN_DOUBT"};
  const data:Record<string,unknown>={providerId:t.id,status:t.status,currency:t.currency,usdcAmount:t.usdcAmount,fiatAmount:t.fiatAmount,fee:t.fee,rate:t.rate,chain:t.chain,mint:t.mint,source:event?"signed_webhook":"order_response"};
  const initial=transaction.safeParse(order.response);
  const expectedDelivery=order.direction!=="on" || !initial.success || units(t.usdcAmount,6)===units(initial.data.usdcAmount,6);
  if(event&&t.status==="COMPLETED"&&t.signature&&units(t.usdcAmount,6)>0n&&expectedDelivery){
   return {outcome:"succeeded",providerRef:t.id,targetState:order.direction==="on"?"crypto_delivered":"fiat_paid_out",moneyState:"SETTLED",data:{...data,signature:t.signature,eventDigest:event.digest}};
  }
  // ERROR confirms unsuccessful processing, NOT a refund or zero economic
  // effect. PAJ's public contract gives no safe release proof; retain the hold.
  if(!["INIT","PROCESSING"].includes(t.status))return {outcome:"unknown",providerRef:t.id,moneyState:"IN_DOUBT",data};
  const deadline=new Date(t.createdAt).getTime()+(order.direction==="on"?72:2)*3600000;
  if(deadline<=Date.now())return {outcome:"unknown",providerRef:t.id,moneyState:"IN_DOUBT",data:{...data,reason:"funding_window_elapsed"}};
  if(order.direction==="on") {
   if(!t.accountNumber||!t.accountName||!t.bank)return {outcome:"unknown",data,moneyState:"IN_DOUBT"};
   Object.assign(data,{paymentInstructions:{accountNumber:t.accountNumber,accountName:t.accountName,bank:t.bank,amount:t.fiatAmount,currency:t.currency}});
  }else{
   if(!t.address)return {outcome:"unknown",data,moneyState:"IN_DOUBT"};
   Object.assign(data,{paymentInstructions:{address:t.address,chain:t.chain,mint:t.mint,amount:t.usdcAmount},funding:"external; no custody signer invoked"});
  }
  return {outcome:"pending",providerRef:t.id,moneyState:"IN_FLIGHT",data:{...data,fundingInstructionsExpireAt:new Date(deadline).toISOString()}};
 }
 private callbackToken(actionId:string):string{return createHmac("sha256",this.config!.webhookSecret!).update(`paj-order:${actionId}`).digest("hex");}
 async webhook(actionId:string,token:string,raw:Buffer,signature:string,timestamp:string):Promise<void>{
  const secret=this.config?.webhookSecret;
  if(!secret||!/^\d+$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||!/^v1=[a-f0-9]{64}$/i.test(signature)||! /^[a-f0-9]{64}$/.test(token))throw new AxisError("invalid_webhook");
  const expected=createHmac("sha256",secret).update(timestamp+".").update(raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature.slice(3),"hex"))||!timingSafeEqual(Buffer.from(token,"hex"),Buffer.from(this.callbackToken(actionId),"hex")))throw new AxisError("invalid_webhook");
  const body=transaction.parse(JSON.parse(raw.toString("utf8")));
  const eventDigest=digest({actionId,body});const db=await this.pool.connect();
  try{
   await db.query("BEGIN");
   const row=await db.query("SELECT * FROM paj_orders WHERE action_id=$1 FOR UPDATE",[actionId]);const order=row.rows[0];
   if(!order||(order.provider_id&&order.provider_id!==body.id))throw new AxisError("unknown_provider_order");
   // Per-order unguessable callback token correlates a response lost in transit.
   await db.query("UPDATE paj_orders SET provider_id=$2 WHERE action_id=$1",[actionId,body.id]);
   await db.query("INSERT INTO paj_webhooks(digest,action_id,provider_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",[eventDigest,actionId,body.id,body]);
   await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  // The existing worker reconciles pending/in-doubt Cases through the same
  // Grant/Policy/Action/Evidence/Proof pipeline. No webhook execution bypass.
 }
}
