import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMcpServers,
  toSkill,
  mcpResultToOutcome,
  childEnv,
  sanitizeMcpText,
} from "../src/mcp/bootstrap.js";

test("childEnv: never leaks parent secrets (P0 item 5)", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    PAJ_API_KEY: "secret-paj",
    INTERNAL_API_TOKEN: "secret-token",
  } as NodeJS.ProcessEnv;
  const env = childEnv({ name: "x", command: "npx" }, parent);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.PAJ_API_KEY, undefined);
  assert.equal(env.INTERNAL_API_TOKEN, undefined);
});

test("childEnv: forwards only opted-in vars + declared values", () => {
  const parent = {
    PATH: "/usr/bin",
    CHOWDECK_TOKEN: "abc",
    OTHER_SECRET: "nope",
  } as NodeJS.ProcessEnv;
  const env = childEnv(
    { name: "x", command: "npx", passEnv: ["CHOWDECK_TOKEN"], env: { EXTRA: "1" } },
    parent,
  );
  assert.equal(env.CHOWDECK_TOKEN, "abc");
  assert.equal(env.EXTRA, "1");
  assert.equal(env.OTHER_SECRET, undefined);
});

test("sanitizeMcpText: strips URLs so MCP output can't inject links (P0 item 6)", () => {
  const out = sanitizeMcpText("Deal: https://evil.example/x and www.evil.com now");
  assert.doesNotMatch(out, /https?:\/\//);
  assert.doesNotMatch(out, /www\./);
  assert.match(out, /\[link removed\]/);
});

test("sanitizeMcpText: caps length and strips control chars", () => {
  const out = sanitizeMcpText("a" + String.fromCharCode(7) + "b" + "x".repeat(5000));
  assert.ok(out.length <= 2000);
  assert.doesNotMatch(out, /[\x00-\x1f]/);
});

test("parseMcpServers: valid JSON array of servers", () => {
  const servers = parseMcpServers(
    '[{"name":"chowdeck","command":"npx","args":["-y","@thathman/chowdeck-mcp"]}]',
  );
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "chowdeck");
  assert.equal(servers[0].command, "npx");
});

test("parseMcpServers: bad/empty input yields []", () => {
  assert.deepEqual(parseMcpServers(undefined), []);
  assert.deepEqual(parseMcpServers("not json"), []);
  assert.deepEqual(parseMcpServers('{"name":"x"}'), []); // not an array
  assert.deepEqual(parseMcpServers('[{"name":"x"}]'), []); // missing command
});

test("toSkill wraps an MCP tool as a callable skill", async () => {
  let calledWith: unknown = null;
  const skill = toSkill(
    "mobility",
    { name: "estimate_fare", description: "estimate a fare", inputSchema: { type: "object" } },
    async (name, args) => {
      calledWith = { name, args };
      return { content: [{ type: "text", text: '{"fareNgn": 2500}' }] };
    },
  );
  assert.equal(skill.id, "mobility.estimate_fare");
  assert.equal(skill.origin, "learned");
  assert.ok(skill.execute);
  const outcome = await skill.execute!({ from: "yaba" }, {
    userId: "u",
    memory: undefined as never,
    priorResults: {},
  });
  assert.deepEqual(calledWith, { name: "estimate_fare", args: { from: "yaba" } });
  assert.deepEqual(outcome.data, { fareNgn: 2500 });
});

test("mcpResultToOutcome parses JSON text and falls back to raw", () => {
  const json = mcpResultToOutcome({ content: [{ type: "text", text: '{"ok":true}' }] });
  assert.deepEqual(json.data, { ok: true });
  const raw = mcpResultToOutcome({ content: [{ type: "text", text: "hello" }] });
  assert.equal(raw.data, "hello");
  assert.equal(raw.replies[0].kind === "text" && raw.replies[0].text, "hello");
});
