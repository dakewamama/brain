import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMcpServers,
  toSkill,
  mcpResultToOutcome,
} from "../src/mcp/bootstrap.js";

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
