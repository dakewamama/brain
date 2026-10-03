import { providerJson } from "../../core/provider-response.js";
import { z } from "zod";
import { AxisError } from "../../grants/service.js";

export const rateSchema=z.object({id:z.string().min(1),rate:z.number().positive().finite(),type:z.enum(["onRamp","offRamp"]),baseCurrency:z.literal("USD"),targetCurrency:z.string(),createdAt:z.union([z.string(),z.number()])});
export const ratesSchema=z.object({onRampRate:rateSchema,offRampRate:rateSchema});
export const bankSchema=z.object({id:z.string().min(1),accountName:z.string().min(1),accountNumber:z.string().min(1),bank:z.string().min(1),address:z.string().min(1)});
export type PajConfig={apiKey:string;environment:"production"|"staging";webhookSecret?:string;webhookOrigin?:string;mint:string;enabled:string[]};
export class PajClient {
 constructor(readonly config:PajConfig,private transport:typeof fetch=fetch){}
 async request(method:"GET"|"POST",path:string,body?:Record<string,unknown>):Promise<unknown>{
  const origin=this.config.environment==="production"?"https://api.paj.cash":"https://api-staging.paj.cash";
  const r=await this.transport(origin+path,{method,headers:{"x-api-key":this.config.apiKey,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,redirect:"error",signal:AbortSignal.timeout(15000)});
  // Never leak the API key or provider error bodies into client responses.
  if(!r.ok)throw new AxisError(`paj_http_${r.status}`);
  return providerJson(r);
 }
 async rates(currency:string){
  const rates=ratesSchema.parse(await this.request("GET",`/pub/v2/rate?currency=${encodeURIComponent(currency)}`));
  if(rates.onRampRate.targetCurrency!==currency||rates.offRampRate.targetCurrency!==currency||rates.onRampRate.type!=="onRamp"||rates.offRampRate.type!=="offRamp")throw new AxisError("paj_invalid_rate");
  return rates;
 }
 async resolve(accountNumber:string){
  const bank=bankSchema.parse(await this.request("GET",`/pub/v2/bank-account?accountNumber=${encodeURIComponent(accountNumber)}`));
  if(bank.accountNumber!==accountNumber)throw new AxisError("paj_bank_mismatch");return bank;
 }
}
export function configFromEnv(env:NodeJS.ProcessEnv):PajConfig|undefined{
 if(!env.PAJ_API_KEY)return undefined;
 const environment=z.enum(["production","staging"]).parse(env.PAJ_ENV);
 const enabled=(env.PAJ_ENABLED_CAPABILITIES??"ramp.quote,bank.resolve,ramp.status").split(",").filter(Boolean);
 if(enabled.some(id=>!["ramp.on","ramp.off","ramp.quote","ramp.status","bank.resolve"].includes(id)))throw new AxisError("paj_invalid_configuration");
 if(env.PAJ_WEBHOOK_ORIGIN&&new URL(env.PAJ_WEBHOOK_ORIGIN).protocol!=="https:")throw new AxisError("paj_webhook_requires_https");
 const mint=env.PAJ_MINT??(environment==="production"?"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v":"");
 if(environment==="production" && mint!=="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")throw new AxisError("paj_unsupported_mint");
 if(!mint)throw new AxisError("paj_staging_mint_required");
 return {apiKey:env.PAJ_API_KEY,environment,enabled,mint,webhookSecret:env.PAJ_WEBHOOK_SECRET,webhookOrigin:env.PAJ_WEBHOOK_ORIGIN};
}
/** Exact decimal boundary; never derive provider rates, fees or output amounts. */
export function units(value:unknown,decimals:number):bigint{
 const s=String(value);if(!/^\d+(\.\d+)?$/.test(s))throw new AxisError("paj_invalid_amount");
 const [whole,fraction=""]=s.split(".");if(fraction.length>decimals)throw new AxisError("paj_invalid_precision");
 return BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,"0"));
}
export function wire(minor:string,decimals:number):number{
 if(!/^\d+$/.test(minor)||BigInt(minor)<=0n||BigInt(minor)>1000000000000n)throw new AxisError("paj_invalid_amount");
 const scale=10n**BigInt(decimals),n=BigInt(minor);const value=Number(`${n/scale}.${(n%scale).toString().padStart(decimals,"0")}`);
 if(units(value,decimals)!==n)throw new AxisError("paj_invalid_precision");return value;
}

export function validSolanaAddress(value:string):boolean {
 const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
 let n=0n;
 for(const c of value){const i=alphabet.indexOf(c);if(i<0)return false;n=n*58n+BigInt(i);}
 let bytes=0;while(n>0n){bytes++;n>>=8n;}
 return bytes+(value.match(/^1*/)?.[0].length??0)===32;
}
