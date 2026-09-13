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
  AXIS_FEE_BPS: z.coerce.number().default(150),
  AXIS_FEE_FLAT_KOBO: z.coerce.number().default(0),
  RECOGNITION_BASE_URL: z.string().optional(),
  RECOGNITION_API_KEY: z.string().optional(),
  RECOGNITION_MODEL: z.string().default("gemini-1.5-flash"),
  // Model provider (Gemini). Key is server-only; never a NEXT_PUBLIC_ var, never
  // logged. Absent key => generate() throws a typed error, no silent fallback.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().default(8000),
  GEMINI_MAX_RETRIES: z.coerce.number().default(2),
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
