/** Legacy channel compatibility helpers. Automatic upstream execution is
 * disabled. The governed SDK client lives in upstream.ts; MCP handlers call
 * AxisGateway. Keep childEnv's explicit secret allowlist for stdio children. */
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
  _call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): SkillManifest {
  return {
    id: `${serverName}.${tool.name}`,
    name: tool.name,
    description: tool.description ?? `${serverName} ${tool.name}`,
    parameters: (tool.inputSchema as JsonSchema) ?? { type: "object" },
    origin: "learned",
    execute: async (): Promise<SkillOutcome> => {
      throw new Error("MCP invocation requires an Axis Gateway Grant");
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

/** @deprecated Discovery cannot authorize execution. Configure AXIS_UPSTREAM_MCP
 * on the MCP entrypoint instead. Legacy channel bootstrap never starts providers. */
export async function registerMcpTools(_skills: SkillRegistry, servers: McpServerConfig[]): Promise<number> {
  if(servers.length) log.warn("Legacy MCP_SERVERS disabled; use the governed Axis MCP Gateway");
  return 0;
}
