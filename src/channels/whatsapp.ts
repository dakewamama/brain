import crypto from "node:crypto";
import type { InboundMessage, OutboundMessage } from "../core/types.js";
import type { ChannelAdapter, ParsedInbound } from "./types.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { buttonIdToText } from "../router/buttons.js";
const log = childLogger("whatsapp");
const GRAPH = "https://graph.facebook.com/v21.0";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = "whatsapp";
  readonly live: boolean;
  private token?: string;
  private phoneNumberId?: string;
  private appSecret?: string;
  private verifyToken: string;
  constructor() {
    const cfg = getConfig();
    this.token = cfg.WHATSAPP_TOKEN;
    this.phoneNumberId = cfg.WHATSAPP_PHONE_NUMBER_ID;
    this.appSecret = cfg.WHATSAPP_APP_SECRET;
    this.verifyToken = cfg.WHATSAPP_VERIFY_TOKEN;
    this.live = Boolean(this.token && this.phoneNumberId);
    if (!this.live) {
      log.warn(
        "WhatsApp not live — set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID.",
      );
    }
  }
  verifyChallenge(query: Record<string, unknown>): string | null {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];
    if (mode === "subscribe" && token === this.verifyToken) {
      return String(challenge ?? "");
    }
    return null;
  }
  verifySignature(rawBody: Buffer, signatureHeader?: string): boolean {
    if (!this.appSecret) return true;
    if (!signatureHeader) return false;
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", this.appSecret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signatureHeader),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }
  parseInbound(body: unknown): ParsedInbound {
    const messages: InboundMessage[] = [];
    const entries = (body as any)?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const contacts = value.contacts ?? [];
        const nameByWaId = new Map<string, string>();
        for (const c of contacts) {
          if (c.wa_id) nameByWaId.set(c.wa_id, c.profile?.name ?? "");
        }
        for (const m of value.messages ?? []) {
          const parsed = this.parseOne(m, nameByWaId.get(m.from));
          if (parsed) messages.push(parsed);
        }
      }
    }
    return { messages };
  }
  private parseOne(m: any, userName?: string): InboundMessage | null {
    const base = {
      channel: "whatsapp" as const,
      userId: m.from,
      userName,
      messageId: m.id,
      timestamp: m.timestamp ? Number(m.timestamp) * 1000 : Date.now(),
    };
    switch (m.type) {
      case "text":
        return { ...base, text: m.text?.body ?? "" };
      case "interactive": {
        const i = m.interactive ?? {};
        if (i.type === "button_reply") {
          return {
            ...base,
            text: buttonIdToText(i.button_reply?.id ?? ""),
            data: { buttonId: i.button_reply?.id },
          };
        }
        if (i.type === "list_reply") {
          return {
            ...base,
            text: buttonIdToText(i.list_reply?.id ?? ""),
            data: { listId: i.list_reply?.id },
          };
        }
        return { ...base, text: "" };
      }
      case "location":
        return {
          ...base,
          text: "",
          data: {
            location: {
              latitude: m.location?.latitude,
              longitude: m.location?.longitude,
              address: m.location?.address ?? m.location?.name,
            },
          },
        };
      case "button":
        return { ...base, text: m.button?.text ?? "" };
      default:
        log.info({ type: m.type }, "unhandled inbound type");
        return { ...base, text: "" };
    }
  }
  async send(userId: string, messages: OutboundMessage[]): Promise<void> {
    for (const msg of messages) {
      const payload = this.render(userId, msg);
      if (!this.live) {
        log.info({ to: userId, payload }, "[stub send] WhatsApp not live");
        continue;
      }
      await this.post(payload);
    }
  }
  private render(to: string, msg: OutboundMessage): Record<string, unknown> {
    switch (msg.kind) {
      case "text":
        return {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: msg.text },
        };
      case "link":
        return {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: `${msg.text}\n${msg.url}`, preview_url: true },
        };
      case "location_request":
        return {
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "location_request_message",
            body: { text: msg.text },
            action: { name: "send_location" },
          },
        };
      case "buttons":
        return {
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: msg.text },
            action: {
              buttons: msg.buttons.slice(0, 3).map((b) => ({
                type: "reply",
                reply: { id: b.id, title: b.title.slice(0, 20) },
              })),
            },
          },
        };
      case "list":
        return {
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "list",
            ...(msg.header
              ? { header: { type: "text", text: msg.header } }
              : {}),
            body: { text: msg.text },
            action: {
              button: "Choose",
              sections: msg.sections.map((s) => ({
                title: s.title,
                rows: s.rows.map((r) => ({
                  id: r.id,
                  title: r.title.slice(0, 24),
                  description: r.description?.slice(0, 72),
                })),
              })),
            },
          },
        };
    }
  }
  private async post(payload: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${GRAPH}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, errText }, "WhatsApp send failed");
    }
  }
}
