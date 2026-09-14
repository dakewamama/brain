/**
 * MCP bootstrap — auto-register the tools of configured MCP servers as skills.
 *
 * Every tool an MCP server exposes becomes an atomic skill the Planner can pick
 * and the Executor can run, with zero custom integration code. Config comes from
 * MCP_SERVERS (JSON); child processes inherit brain's env so secrets stay in
 * normal env vars. Inert when unconfigured; a failing server is skipped, never
 * fatal.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonSchema } from "../model/types.js";
import type {
  SkillManifest,
  SkillOutcome,
  SkillRegistry,
} from "../skills/registry.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("mcp");

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Parse MCP_SERVERS (JSON array). Bad JSON => [] (logged, not fatal). */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s): s is McpServerConfig =>
        !!s &&
        typeof (s as McpServerConfig).name === "string" &&
        typeof (s as McpServerConfig).command === "string",
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, "MCP_SERVERS is not valid JSON");
    return [];
  }
}

interface McpToolShape {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Pure adapter: wrap one MCP tool as a skill whose execute() calls it. */
export function toSkill(
  serverName: string,
  tool: McpToolShape,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): SkillManifest {
  return {
    id: `${serverName}.${tool.name}`,
    name: tool.name,
    description: tool.description ?? `${serverName} ${tool.name}`,
    parameters: (tool.inputSchema as JsonSchema) ?? { type: "object" },
    origin: "learned",
    execute: async (params): Promise<SkillOutcome> => {
      const result = await call(tool.name, params);
      return mcpResultToOutcome(result);
    },
  };
}

/** Convert an MCP callTool result into a SkillOutcome. */
export function mcpResultToOutcome(result: unknown): SkillOutcome {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })
    ?.content;
  const texts = Array.isArray(content)
    ? content.filter((c) => c?.type === "text" && c.text).map((c) => c.text as string)
    : [];
  const joined = texts.join("\n").trim();
  let data: unknown = undefined;
  if (joined) {
    try {
      data = JSON.parse(joined);
    } catch {
      data = joined;
    }
  }
  return {
    replies: joined ? [{ kind: "text", text: joined }] : [],
    data,
  };
}

/** Connect to each configured server and register its tools. Best-effort. */
export async function registerMcpTools(
  skills: SkillRegistry,
  servers: McpServerConfig[],
): Promise<number> {
  let registered = 0;
  for (const server of servers) {
    try {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
      });
      const client = new Client({ name: "axis-brain", version: "1.0.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      for (const tool of tools) {
        skills.register(
          toSkill(server.name, tool as McpToolShape, (name, args) =>
            client.callTool({ name, arguments: args }),
          ),
        );
        registered++;
      }
      log.info(
        { server: server.name, tools: tools.length },
        "registered MCP tools as skills",
      );
    } catch (err) {
      log.warn(
        { server: server.name, err: (err as Error).message },
        "MCP server unavailable; skipping",
      );
    }
  }
  return registered;
}
