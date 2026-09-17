/**
 * MCP bootstrap — auto-register the tools of configured MCP servers as skills.
 *
 * Every tool an MCP server exposes becomes an atomic skill the Planner can pick
 * and the Executor can run, with zero custom integration code. Config comes from
 * MCP_SERVERS (JSON). Child processes get ONLY an allowlisted, non-secret base
 * env plus what each server explicitly declares (`env` values and `passEnv`
 * names) — brain's secrets (Paj key, internal token) are never handed to a
 * third-party MCP package. Tool output is sanitized before it can reach a user.
 * Inert when unconfigured; a failing server is skipped, never fatal.
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
  /** Explicit env values to hand this server (safe to specify secrets here). */
  env?: Record<string, string>;
  /** Names of parent-process env vars to forward to this server. Opt-in only —
   *  nothing from brain's env reaches a child unless it is on this list. */
  passEnv?: string[];
}

// The only parent env vars forwarded by default: non-secret system vars a child
// needs to actually launch (find node/npx, a home dir, locale, CA bundle). No
// application secret is ever on this list.
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_EXTRA_CA_CERTS",
  "SystemRoot",
  "APPDATA",
  "USERPROFILE",
];

/** Build the env for a child MCP process: allowlisted system vars + explicitly
 *  opted-in parent vars + the server's own declared values. Pure + testable. */
export function childEnv(
  server: McpServerConfig,
  parentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    const v = parentEnv[key];
    if (typeof v === "string") out[key] = v;
  }
  for (const key of server.passEnv ?? []) {
    const v = parentEnv[key];
    if (typeof v === "string") out[key] = v;
  }
  return { ...out, ...(server.env ?? {}) };
}

/** Neutralize MCP tool output before it can be shown to a user. An MCP server is
 *  untrusted: it must not be able to make the bot emit links or unbounded text.
 *  Strips URLs and control chars and caps length. Pure + testable. */
export function sanitizeMcpText(text: string): string {
  const MAX = 2000;
  return text
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, "[link removed]")
    .replace(/\bwww\.\S+/gi, "[link removed]")
    .slice(0, MAX)
    .trim();
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
  // data (parsed JSON) flows to dependent steps as code; the user-facing reply is
  // sanitized so an MCP server can't inject links or arbitrary unbounded text.
  const safe = sanitizeMcpText(joined);
  return {
    replies: safe ? [{ kind: "text", text: safe }] : [],
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
        env: childEnv(server, process.env),
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
