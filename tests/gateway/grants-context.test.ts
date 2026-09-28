import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { GrantService, type Authority } from "../../src/grants/service.js";
import { ContextService } from "../../src/context/service.js";
import { migrate, closePool } from "../../src/db/pool.js";
import { resetConfigForTests } from "../../src/core/config.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) test("grants/context require PostgreSQL", { skip: true }, () => {});
else {
  const pool = new Pool({connectionString:url});
  const grants = new GrantService(pool);
  const context = new ContextService(pool);
  const authority: Authority = { scopes:["context:location.coarse"],capabilities:["location.context"],contextTypes:["location.coarse"],resources:[],financial:null,requireApproval:false,modes:["LIVE"] };
  before(async () => { process.env.DATABASE_URL=url; resetConfigForTests(); await migrate(); });
  after(async () => { await pool.end(); await closePool(); });
  const issue = () => grants.issue({clientId:randomUUID(),clientName:"test",userId:randomUUID(),authority,expiresAt:new Date(Date.now()+60000)});
  test("authentication derives the user; unknown, wrong-client, revoked and expired grants fail closed", async () => {
    await assert.rejects(grants.authenticate("x".repeat(40)));
    const credential=await issue();
    const p=await grants.authenticate(credential.token);
    await assert.rejects(grants.resolve(p.grantId,"different-client"));
    await grants.revoke(p.grantId);
    await assert.rejects(grants.authenticate(credential.token));
    const expired=await issue();
    await pool.query("UPDATE agent_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.grantId]);
    await assert.rejects(grants.authenticate(expired.token));
    const revokedClient=await issue();
    const client=await grants.authenticate(revokedClient.token);
    await pool.query("UPDATE agent_clients SET revoked_at=now() WHERE id=$1",[client.clientId]);
    await assert.rejects(grants.authenticate(revokedClient.token));
  });
  test("coarse is not exact; unauthorized, stale, other-user and other-case context stays hidden", async () => {
    const p=await grants.authenticate((await issue()).token);
    const common={source:"user",observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),sensitivity:"sensitive" as const,caseId:null};
    await context.put(p.userId,{...common,type:"location.coarse",value:{country:"NG",region:"Lagos"}});
    await context.put(p.userId,{...common,type:"location.exact",value:{latitude:6.5,longitude:3.3}});
    assert.deepEqual((await context.read(p,["location.coarse","location.exact"])).map(i=>i.type),["location.coarse"]);
    assert.deepEqual(await context.read(p,[]),[]);
    assert.deepEqual(await context.read({...p,userId:"other"},["location.coarse"]),[]);
    await assert.rejects(context.put(p.userId,{...common,type:"location.coarse",value:{country:"NG",region:"Lagos",latitude:6.5}}));
    await pool.query("UPDATE scoped_context SET expires_at=now()-interval '1 second' WHERE user_id=$1",[p.userId]);
    assert.deepEqual(await context.read(p,["location.coarse"]),[]);
  });
}
