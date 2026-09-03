import express, { type Request, type Response } from "express";
import { getConfig } from "./core/config.js";
import { childLogger } from "./core/logger.js";
import { sessionStore, conversationStore } from "./store/index.js";
import { createPipeline } from "./router/pipeline.js";
import { WhatsAppAdapter } from "./channels/whatsapp.js";
import { TelegramAdapter } from "./channels/telegram.js";
import type { ChannelId } from "./core/types.js";
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
    res.sendStatus(200);
    try {
      const { messages } = whatsapp.parseInbound(req.body);
      for (const msg of messages) {
        const replies = await pipeline.process(msg);
        await whatsapp.send(msg.userId, replies);
      }
    } catch (err) {
      log.error({ err }, "error handling WhatsApp webhook");
    }
  });
  app.post("/webhooks/telegram", async (req: Request, res: Response) => {
    res.sendStatus(200);
    try {
      const { messages } = telegram.parseInbound(req.body);
      for (const msg of messages) {
        const replies = await pipeline.process(msg);
        await telegram.send(msg.userId, replies);
      }
    } catch (err) {
      log.error({ err }, "error handling Telegram webhook");
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
  return { app, cfg };
}
