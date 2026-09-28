import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { getConfig } from "./core/config.js";
import { childLogger } from "./core/logger.js";
import { sessionStore, conversationStore } from "./store/index.js";
import { createPipeline } from "./router/pipeline.js";
import { WhatsAppAdapter } from "./channels/whatsapp.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { WebAdapter, WebInboundError } from "./channels/web.js";
import { modelProvider } from "./model/index.js";
import { browse, browseEnabled } from "./browse/serper.js";
import { secretOk, bearer } from "./router/webhookAuth.js";
import { getAuth } from "./auth/index.js";
import { AuthError } from "./auth/auth.js";
import { getCaseStore, getCaseRunner } from "./cases/index.js";
import type { ChannelId, InboundMessage, OutboundMessage } from "./core/types.js";
const log = childLogger("server");

export function createServer() {
  const cfg = getConfig();
  const app = express();
  const pipeline = createPipeline({
    sessions: sessionStore,
    conversations: conversationStore,
  });
  const whatsapp = new WhatsAppAdapter();
  const telegram = new TelegramAdapter();
  const web = new WebAdapter();

  /**
   * Durable acceptance for push channels: PERSIST (dedupe) → ACK → process
   * async. A crash after the ack leaves the inbound row unprocessed; the sweep
   * below retries it until it is marked processed. Dedupe: a replayed message
   * id is dropped, never processed twice.
   */
  const acceptAsync = async (
    channel: string,
    messages: InboundMessage[],
    send: (userId: string, replies: OutboundMessage[]) => Promise<void>,
  ) => {
    const claimed: InboundMessage[] = [];
    for (const msg of messages) {
      const ok = await getCaseStore().claimInbound({
        id: `inb_${randomUUID()}`,
        channel,
        providerMessageId: msg.messageId ?? `anon-${randomUUID()}`,
        payload: msg as unknown as Record<string, unknown>,
      });
      if (ok) claimed.push(msg);
      else log.info({ channel, messageId: msg.messageId }, "duplicate inbound dropped");
    }
    void (async () => {
      for (const msg of claimed) {
        try {
          const replies = await pipeline.process(msg, { skipClaim: true });
          await send(msg.userId, replies);
        } catch (err) {
          // Row stays unprocessed; the sweep retries.
          log.error({ err, channel, messageId: msg.messageId }, "inbound processing failed; sweep will retry");
        }
      }
    })();
  };

  // Retry sweep for inbound events that were persisted but never processed
  // (crash between ack and completion). Runs on the worker cadence.
  const sweepUnprocessed = () => {
    void (async () => {
      try {
        const rows = await getCaseStore().listUnprocessedInbound(20);
        for (const row of rows) {
          const msg = row.payload as unknown as InboundMessage;
          if (!msg?.channel || !msg?.userId) {
            await getCaseStore().markInboundProcessed(row.id);
            continue;
          }
          try {
            const replies = await pipeline.process(msg, { skipClaim: true });
            const adapter = msg.channel === "whatsapp" ? whatsapp : msg.channel === "telegram" ? telegram : null;
            if (adapter) await adapter.send(msg.userId, replies);
            await getCaseStore().markInboundProcessed(row.id);
          } catch (err) {
            log.warn({ err: String(err), inboundId: row.id }, "sweep retry failed; will retry again");
          }
        }
      } catch (err) {
        log.error({ err: String(err) }, "unprocessed-inbound sweep failed");
      }
    })();
  };
  const sweepTimer = setInterval(sweepUnprocessed, Math.max(5000, cfg.CASE_WORKER_POLL_MS));
  sweepTimer.unref?.();

  // Warn once at boot if a public webhook is unauthenticated. Enforcement is
  // per-request below; this makes an unset token loud instead of silent.
  if (!cfg.WEB_WEBHOOK_TOKEN) {
    log.warn("WEB_WEBHOOK_TOKEN unset; POST /webhooks/web is unauthenticated");
  }
  if (telegram.live && !cfg.TELEGRAM_WEBHOOK_SECRET) {
    log.warn("TELEGRAM_WEBHOOK_SECRET unset; Telegram webhook is unverified");
  }

  // CORS for the browser channel — a single exact origin, never "*". If WEB_ORIGIN
  // is unset the browser channel simply gets no CORS headers (same-origin only).
  const webOrigin = cfg.WEB_ORIGIN;
  app.use((req: Request, res: Response, next) => {
    const origin = req.get("origin");
    if (webOrigin && origin === webOrigin) {
      res.setHeader("Access-Control-Allow-Origin", webOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      channels: {
        whatsapp: whatsapp.live,
        telegram: telegram.live,
      },
    });
  });
  app.get("/webhooks/whatsapp", (req: Request, res: Response) => {
    const challenge = whatsapp.verifyChallenge(
      req.query as Record<string, unknown>,
    );
    if (challenge !== null) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });
  app.post("/webhooks/whatsapp", async (req: Request, res: Response) => {
    const rawBody: Buffer = (req as any).rawBody ?? Buffer.from("");
    const sig = req.get("x-hub-signature-256") ?? undefined;
    if (!whatsapp.verifySignature(rawBody, sig)) {
      log.warn("WhatsApp signature verification failed");
      res.sendStatus(401);
      return;
    }
    try {
      const { messages } = whatsapp.parseInbound(req.body);
      res.sendStatus(200); // ack after durable claim (acceptAsync persisted first)
      await acceptAsync("whatsapp", messages, (userId, replies) => whatsapp.send(userId, replies));
    } catch (err) {
      log.error({ err }, "error handling WhatsApp webhook");
      res.sendStatus(200); // parse bugs shouldn't cause endless redelivery
    }
  });
  app.post("/webhooks/telegram", async (req: Request, res: Response) => {
    // Telegram echoes the secret_token set at webhook registration. When we've
    // configured one, reject anything that doesn't present it.
    if (cfg.TELEGRAM_WEBHOOK_SECRET) {
      const provided = req.get("x-telegram-bot-api-secret-token");
      if (!secretOk(provided, cfg.TELEGRAM_WEBHOOK_SECRET)) {
        res.sendStatus(401);
        return;
      }
    }
    try {
      const { messages } = telegram.parseInbound(req.body);
      res.sendStatus(200);
      await acceptAsync("telegram", messages, (userId, replies) => telegram.send(userId, replies));
    } catch (err) {
      log.error({ err }, "error handling Telegram webhook");
      res.sendStatus(200);
    }
  });
  app.post("/webhooks/web", async (req: Request, res: Response) => {
    // The browser never calls this directly — our same-origin proxy does, holding
    // the token server-side. Enforce it when configured. (CORS is not security.)
    if (cfg.WEB_WEBHOOK_TOKEN) {
      if (!secretOk(bearer(req.get("authorization")), cfg.WEB_WEBHOOK_TOKEN)) {
        res.sendStatus(401);
        return;
      }
    }
    try {
      const { messages } = web.parseInbound(req.body);
      const replies: OutboundMessage[] = [];
      for (const msg of messages) {
        // Web is a synchronous channel: claim, process inline, reply.
        const claimed = await getCaseStore().claimInbound({
          id: `inb_${randomUUID()}`,
          channel: msg.channel,
          providerMessageId: msg.messageId ?? `anon-${randomUUID()}`,
          payload: msg as unknown as Record<string, unknown>,
        });
        if (!claimed) continue; // replay
        const out = await pipeline.process(msg, { skipClaim: true });
        await web.send(msg.userId, out);
        replies.push(...out);
      }
      res.json({ replies });
    } catch (err) {
      if (err instanceof WebInboundError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.error({ err }, "error handling web webhook");
      res.sendStatus(500);
    }
  });
  app.get("/session/web/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    const session = await sessionStore.get("web", userId);
    res.json({
      vertical: session?.vertical ?? "unknown",
      step: session?.step ?? "",
    });
  });

  // Email + password accounts. Both return { webUserId, email } — the stable id the
  // account (and its wallet) is keyed by. Public routes (they ARE the sign-in).
  const authRoute =
    (kind: "signup" | "login") => async (req: Request, res: Response) => {
      const auth = getAuth();
      if (!auth) {
        res.status(503).json({ error: "auth not configured" });
        return;
      }
      const email = typeof req.body?.email === "string" ? req.body.email : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!email || !password) {
        res.status(400).json({ error: "email and password are required" });
        return;
      }
      try {
        const r = kind === "signup"
          ? await auth.signup(email, password)
          : await auth.login(email, password);
        res.json(r);
      } catch (err) {
        if (err instanceof AuthError) {
          res.status(err.code === "email_taken" ? 409 : 401).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        log.error({ err }, "auth error");
        res.sendStatus(500);
      }
    };
  app.post("/auth/signup", authRoute("signup"));
  app.post("/auth/login", authRoute("login"));
  // Persist the display name onto the account (keyed by the account's webUserId).
  app.post("/auth/name", async (req: Request, res: Response) => {
    const auth = getAuth();
    if (!auth) {
      res.status(503).json({ error: "auth not configured" });
      return;
    }
    const webUserId = typeof req.body?.webUserId === "string" ? req.body.webUserId : "";
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    if (!webUserId || !name.trim()) {
      res.status(400).json({ error: "webUserId and name are required" });
      return;
    }
    try {
      await auth.setName(webUserId, name);
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, "auth setName error");
      res.sendStatus(500);
    }
  });

  // Everything under /admin exposes user identities and full transcripts. Require a
  // bearer token; if ADMIN_TOKEN is unset, deny all (fail closed) rather than open.
  app.use("/admin", (req: Request, res: Response, next) => {
    const token = cfg.ADMIN_TOKEN;
    const header = req.get("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || provided !== token) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  // One live model call to see exactly why comprehension is (or isn't) working.
  app.get("/admin/model-check", async (req: Request, res: Response) => {
    const model =
      typeof req.query.model === "string" ? req.query.model : undefined;
    const tokens = Number(req.query.tokens) || 16;
    try {
      const r = await modelProvider.generate(
        [{ role: "user", content: "reply with the word ok" }],
        { modelId: model, maxOutputTokens: tokens, timeoutMs: 20000 },
      );
      res.json({
        ok: true,
        modelId: r.modelId,
        latencyMs: r.latencyMs,
        text: r.text.slice(0, 40),
      });
    } catch (err) {
      const e = err as { kind?: string; status?: number; message?: string };
      res.json({
        ok: false,
        kind: e?.kind ?? "unknown",
        status: e?.status ?? null,
        detail: String(e?.message ?? err).slice(0, 300),
      });
    }
  });
  // One live shopping search to confirm SERPER_API_KEY works and see what real
  // products come back. Returns configured=false (not an error) when no key is
  // set, so you can tell "not wired" apart from "wired but failing".
  app.get("/admin/browse-check", async (req: Request, res: Response) => {
    const q =
      typeof req.query.q === "string" && req.query.q.trim()
        ? req.query.q
        : "oraimo powerbank";
    if (!browseEnabled()) {
      res.json({ configured: false, hint: "set SERPER_API_KEY to enable browsing" });
      return;
    }
    try {
      const products = await browse(q);
      res.json({
        configured: true,
        query: q,
        count: products?.length ?? 0,
        products: (products ?? []).slice(0, 5),
      });
    } catch (err) {
      res.json({ configured: true, ok: false, detail: String(err).slice(0, 300) });
    }
  });
  app.get("/admin/users", async (_req, res) => {
    res.json(await conversationStore.listUsers());
  });
  app.get(
    "/admin/conversations/:channel/:userId",
    async (req: Request, res: Response) => {
      const channel = req.params.channel as ChannelId;
      const userId = String(req.params.userId);
      const events = await conversationStore.history(channel, userId, 500);
      res.json(events);
    },
  );
  app.get("/admin/feed", async (req: Request, res: Response) => {
    const since = Number(req.query.since ?? 0);
    res.json(await conversationStore.since(since));
  });
  // Case inspection for operations. Same admin bearer gate as above.
  app.get("/admin/cases/:id", async (req: Request, res: Response) => {
    const status = await getCaseRunner().status(String(req.params.id));
    if (!status) {
      res.sendStatus(404);
      return;
    }
    res.json(status);
  });
  return { app, cfg, adapters: { whatsapp, telegram } };
}
