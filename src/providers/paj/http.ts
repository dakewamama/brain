import express from "express";
import type { PajProvider } from "./provider.js";
/** Mount before any JSON parser: signature verification uses exact raw bytes. */
export function pajWebhookRouter(provider:PajProvider){
 const router=express.Router();
 router.post("/webhooks/paj/:actionId/:token",express.raw({type:"application/json",limit:"64kb"}),async(req,res)=>{
  try{
   if(!Buffer.isBuffer(req.body)){res.status(400).json({error:"invalid_webhook"});return;}
   await provider.webhook(String(req.params.actionId),String(req.params.token),req.body,req.get("x-paj-signature")??"",req.get("x-paj-timestamp")??"");
   res.status(200).json({received:true});
  }catch{res.status(400).json({error:"invalid_webhook"});}
 });
 return router;
}
