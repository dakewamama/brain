import {createHash} from "node:crypto";
function canonical(value:unknown):string {
 if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
 if(value!==null&&typeof value==="object")return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
 return JSON.stringify(value);
}
/** Deterministic JSON digest; never depends on property insertion order. */
export const digest=(value:unknown):string=>createHash("sha256").update(canonical(value)).digest("hex");
