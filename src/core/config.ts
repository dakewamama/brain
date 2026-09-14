import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().default("axis-verify"),
  WHATSAPP_APP_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  GLOVO_API_BASE: z.string().default("https://api.glovoapp.com"),
  GLOVO_API_KEY: z.string().optional(),
  GLOVO_API_SECRET: z.string().optional(),
  JUMIA_AFFILIATE_TAG: z.string().optional(),
  ORAIMO_AFFILIATE_TAG: z.string().optional(),
  // Live product browsing. When SERPER_API_KEY is set, shop queries return real
  // products (title, price, image, link) instead of a search-URL fallback.
  SERPER_API_KEY: z.string().optional(),
  SERPER_SHOPPING_URL: z.string().default("https://google.serper.dev/shopping"),
  AXIS_FEE_BPS: z.coerce.number().default(150),
  AXIS_FEE_FLAT_KOBO: z.coerce.number().default(0),
  RECOGNITION_BASE_URL: z.string().optional(),
  RECOGNITION_API_KEY: z.string().optional(),
  RECOGNITION_MODEL: z.string().default("gemini-1.5-flash"),
  // Model provider (Gemini). Key is server-only; never a NEXT_PUBLIC_ var, never
  // logged. Absent key => generate() throws a typed error, no silent fallback.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  GEMINI_TIMEOUT_MS: z.coerce.number().default(8000),
  GEMINI_MAX_RETRIES: z.coerce.number().default(2),
  // Alternative: any OpenAI-compatible endpoint (Groq, OpenRouter free models,
  // DeepSeek, a local server). Set OPENAI_API_KEY (+ base/model) to use it. Which
  // provider runs is chosen by MODEL_PROVIDER, defaulting to openai when an
  // OPENAI_API_KEY is present, else gemini.
  // Ordered, comma-separated provider list for failover, e.g. "openai,gemini"
  // (try Groq/OpenRouter first, fall back to Gemini). Single value = no failover.
  MODEL_PROVIDER: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  OPENAI_MODEL: z.string().default("deepseek/deepseek-chat-v3-0324:free"),
  // Language set is CONFIG, not code. "code:Name" pairs; adding a language is an
  // env change, no code change. FALLBACK is the source language of handler text.
  SUPPORTED_LANGUAGES: z
    .string()
    .default("en:English,pcm:Nigerian Pidgin,yo:Yoruba,ha:Hausa,ig:Igbo"),
  FALLBACK_LANGUAGE: z.string().default("en"),
  // A detected language only replaces the conversation's language at or above
  // this confidence — so one ambiguous message does not flip the reply language.
  LANGUAGE_SWITCH_MIN_CONFIDENCE: z.coerce.number().default(0.8),
  // Durable learning profiles. Set to a mounted volume path (e.g. /data) to keep
  // per-user learning across redeploys; unset => in-memory (resets on restart).
  PROFILE_STORE_DIR: z.string().optional(),
  // Postgres (+ pgvector) for the memory substrate. Unset => in-memory memory.
  DATABASE_URL: z.string().optional(),
  // MCP servers to auto-register as skills, as a JSON array:
  // [{"name":"chowdeck","command":"npx","args":["-y","@thathman/chowdeck-mcp"]}].
  // Child processes inherit brain's env, so put secrets in normal env vars.
  MCP_SERVERS: z.string().optional(),
  // The onboarding service base URL (custody + Paj off-ramp) for money skills,
  // and the shared token that authenticates brain -> onboarding calls.
  ONBOARDING_URL: z.string().optional(),
  INTERNAL_API_TOKEN: z.string().optional(),
  // Opt-in: run the Planner -> Executor runtime for fresh turns. Off by default;
  // when off, the proven understand -> dispatch flow is used unchanged.
  AGENT_RUNTIME: z.coerce.boolean().default(false),
  // Exact browser origin allowed to call the web channel (never "*").
  WEB_ORIGIN: z.string().optional(),
  // Bearer token guarding /admin/*. Unset => admin routes are denied (fail closed).
  ADMIN_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof schema>;
let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
