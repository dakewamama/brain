import type { InboundMessage, OutboundMessage } from "../core/types.js";
import type { ChannelAdapter, ParsedInbound } from "./types.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { buttonIdToText } from "../router/buttons.js";
const log = childLogger("telegram");

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly live: boolean;
  private token?: string;
  constructor() {
    const cfg = getConfig();
    this.token = cfg.TELEGRAM_BOT_TOKEN;
    this.live = Boolean(this.token);
    if (!this.live) {
      log.warn("Telegram not live — set TELEGRAM_BOT_TOKEN.");
    }
  }
  parseInbound(body: unknown): ParsedInbound {
    const messages: InboundMessage[] = [];
    const update = body as any;
    if (update?.message) {
      const m = update.message;
      const userId = String(m.chat?.id ?? m.from?.id);
      const base = {
        channel: "telegram" as const,
        userId,
        userName: m.from?.first_name,
        messageId: String(m.message_id),
        timestamp: m.date ? m.date * 1000 : Date.now(),
      };
      if (m.location) {
        messages.push({
          ...base,
          text: "",
          data: {
            location: {
              latitude: m.location.latitude,
              longitude: m.location.longitude,
            },
          },
        });
      } else {
        messages.push({ ...base, text: m.text ?? "" });
      }
    }
    if (update?.callback_query) {
      const cq = update.callback_query;
      const userId = String(cq.message?.chat?.id ?? cq.from?.id);
      messages.push({
        channel: "telegram",
        userId,
        userName: cq.from?.first_name,
        messageId: String(cq.id),
        text: buttonIdToText(cq.data ?? ""),
        data: { buttonId: cq.data },
        timestamp: Date.now(),
      });
    }
    return { messages };
  }
  async send(userId: string, messages: OutboundMessage[]): Promise<void> {
    for (const msg of messages) {
      const payload = this.render(userId, msg);
      if (!this.live) {
        log.info({ to: userId, payload }, "[stub send] Telegram not live");
        continue;
      }
      await this.post("sendMessage", payload);
    }
  }
  private render(
    chatId: string,
    msg: OutboundMessage,
  ): Record<string, unknown> {
    switch (msg.kind) {
      case "text":
        return { chat_id: chatId, text: msg.text };
      case "location_request":
        return {
          chat_id: chatId,
          text: msg.text,
          reply_markup: {
            keyboard: [[{ text: "📍 Share location", request_location: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        };
      case "buttons":
        return {
          chat_id: chatId,
          text: msg.text,
          reply_markup: {
            inline_keyboard: msg.buttons.map((b) => [
              { text: b.title, callback_data: b.id },
            ]),
          },
        };
      case "list":
        return {
          chat_id: chatId,
          text: msg.text,
          reply_markup: {
            inline_keyboard: msg.sections.flatMap((s) =>
              s.rows.map((r) => [{ text: r.title, callback_data: r.id }]),
            ),
          },
        };
      case "products": {
        const lines = msg.products
          .map((p) => `• ${p.title}${p.price ? ` — ${p.price}` : ""}\n${p.url}`)
          .join("\n\n");
        return { chat_id: chatId, text: `${msg.text}\n\n${lines}` };
      }
    }
  }
  private async post(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      log.error(
        { status: res.status, text: await res.text() },
        "Telegram send failed",
      );
    }
  }
}
