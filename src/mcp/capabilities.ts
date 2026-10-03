import type {Pool} from "pg";
import {z} from "zod";
import {CapabilityRegistry} from "../capabilities/registry.js";
import {registerCoreCapabilities} from "../capabilities/core.js";
import {registerConfiguredCatalog} from "../catalog/source.js";
import {PajProvider} from "../providers/paj/provider.js";
import {configFromEnv} from "../providers/paj/client.js";
import {HumanTaskService} from "../human/service.js";
import {PlaywrightBrowserProvider,registerBrowser} from "../browser/provider.js";
/** Shared runtime/operator wiring, not another registry or execution path. */
export async function configuredCapabilities(pool:Pool,env:NodeJS.ProcessEnv=process.env){
 const registry=new CapabilityRegistry();registerCoreCapabilities(registry,{env});
 const paj=new PajProvider(pool,configFromEnv(env));await paj.register(registry);
 await registerConfiguredCatalog(registry,env);new HumanTaskService(pool).register(registry);
 if(env.AXIS_BROWSER_PROFILE_DIR)registerBrowser(registry,new PlaywrightBrowserProvider(pool,env.AXIS_BROWSER_PROFILE_DIR),z.enum(["LIVE","SANDBOX"]).parse(env.AXIS_BROWSER_MODE));
 return {registry,paj};
}
