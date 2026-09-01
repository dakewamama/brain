import type {
  InboundMessage,
  SessionState,
  HandlerResult,
  GeoLocation,
} from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { deliveryProvider } from "../providers/index.js";
import {
  findVendor,
  findItem,
  searchItemEverywhere,
  type Vendor,
  type CatalogItem,
} from "./catalog.js";
import { formatNaira, orderTotal } from "../core/money.js";
import { extractLocation } from "../core/location.js";
interface DeliveryContext {
  vendorId?: string;
  vendorName?: string;
  itemName?: string;
  itemPriceKobo?: number;
  quantity?: number;
  dropoff?: GeoLocation;
  quoteId?: string;
  deliveryKobo?: number;
}
const AFFIRMATIVE = [
  "yes",
  "yeah",
  "yep",
  "sure",
  "ok",
  "okay",
  "y",
  "confirm",
];
const NEGATIVE = ["no", "nope", "nah", "n"];

export class DeliveryHandler implements VerticalHandler {
  readonly vertical = "delivery" as const;
  async start(
    msg: InboundMessage,
    _session: SessionState,
  ): Promise<HandlerResult> {
    const parsed = this.parseVendorAndItem(msg.text);
    if (parsed?.vendor && parsed.item) {
      return this.answerAvailability(parsed.vendor, parsed.item);
    }
    if (parsed?.vendor && !parsed.item) {
      return {
        replies: [
          {
            kind: "text",
            text: `${parsed.vendor.name} it is. What would you like to order?`,
          },
        ],
        sessionPatch: {
          vertical: "delivery",
          step: "awaiting_item",
          context: {
            vendorId: parsed.vendor.id,
            vendorName: parsed.vendor.name,
          },
        },
      };
    }
    return {
      replies: [
        {
          kind: "text",
          text: 'Sure — what would you like, and from where? (e.g. "chicken wings from Nadia")',
        },
      ],
      sessionPatch: {
        vertical: "delivery",
        step: "awaiting_item",
        context: {},
      },
    };
  }
  async handle(
    msg: InboundMessage,
    session: SessionState,
  ): Promise<HandlerResult> {
    const ctx = session.context as DeliveryContext;
    switch (session.step) {
      case "awaiting_item":
        return this.onItem(msg, ctx);
      case "awaiting_location":
        return this.onLocation(msg, session, ctx);
      case "awaiting_confirm":
        return this.onConfirm(msg, ctx);
      default:
        return this.start(msg, session);
    }
  }
  private onItem(msg: InboundMessage, ctx: DeliveryContext): HandlerResult {
    const parsed = this.parseVendorAndItem(msg.text, ctx.vendorId);
    if (!parsed?.vendor) {
      return {
        replies: [
          {
            kind: "text",
            text: 'Which vendor? Try e.g. "chicken wings from Nadia".',
          },
        ],
      };
    }
    if (!parsed.item) {
      return {
        replies: [
          {
            kind: "text",
            text: `I couldn't find that on ${parsed.vendor.name}'s menu. What would you like?`,
          },
        ],
      };
    }
    return this.answerAvailability(parsed.vendor, parsed.item);
  }
  private answerAvailability(vendor: Vendor, item: CatalogItem): HandlerResult {
    if (!item.inStock) {
      const elsewhere = searchItemEverywhere(item.name).filter(
        (r) => r.item.inStock,
      );
      const alt =
        elsewhere.length > 0
          ? ` It's available at ${elsewhere[0].vendor.name} though — want that instead?`
          : "";
      return {
        replies: [
          {
            kind: "text",
            text: `Sorry, ${item.name} is out of stock at ${vendor.name} right now.${alt}`,
          },
        ],
        sessionPatch: { step: "awaiting_item" },
      };
    }
    return {
      replies: [
        {
          kind: "buttons",
          text: `Yes! ${cap(item.name)} at ${vendor.name} is ${formatNaira(item.priceKobo)}. Want to order it?`,
          buttons: [
            { id: "confirm_item", title: "Order it" },
            { id: "cancel", title: "Cancel" },
          ],
        },
      ],
      sessionPatch: {
        step: "awaiting_location",
        context: {
          vendorId: vendor.id,
          vendorName: vendor.name,
          itemName: item.name,
          itemPriceKobo: item.priceKobo,
          quantity: 1,
        },
      },
    };
  }
  private async onLocation(
    msg: InboundMessage,
    session: SessionState,
    ctx: DeliveryContext,
  ): Promise<HandlerResult> {
    if (isNegative(msg.text)) {
      return {
        replies: [{ kind: "text", text: "No problem — cancelled." }],
        sessionPatch: { step: "idle", vertical: "unknown", context: {} },
      };
    }
    const loc =
      extractLocation(msg) ?? this.matchSavedLocation(msg.text, session);
    if (!loc) {
      return {
        replies: [
          {
            kind: "location_request",
            text: "Where should I deliver it? Share your live location, or type an address.",
          },
        ],
      };
    }
    const vendor = findVendor(ctx.vendorId ?? "");
    if (!vendor) {
      return {
        replies: [
          {
            kind: "text",
            text: "Something went wrong finding the vendor. Let's start over.",
          },
        ],
        sessionPatch: { step: "idle", vertical: "unknown", context: {} },
      };
    }
    const quote = await deliveryProvider.quote({
      pickup: vendor.location,
      dropoff: loc,
      packageDescription: ctx.itemName,
    });
    const subtotalKobo = (ctx.itemPriceKobo ?? 0) * (ctx.quantity ?? 1);
    const { feeKobo, totalKobo } = orderTotal({
      subtotalKobo,
      deliveryKobo: quote.feeKobo,
    });
    const eta = quote.etaMinutes ? ` (~${quote.etaMinutes} min)` : "";
    return {
      replies: [
        {
          kind: "buttons",
          text:
            `Here's your order:\n` +
            `• ${cap(ctx.itemName ?? "item")} — ${formatNaira(subtotalKobo)}\n` +
            `• Delivery${eta} — ${formatNaira(quote.feeKobo)}\n` +
            `• Service — ${formatNaira(feeKobo)}\n` +
            `Total: ${formatNaira(totalKobo)}\n\n` +
            `Deliver to: ${loc.address ?? "shared location"}. Confirm?`,
          buttons: [
            { id: "confirm_order", title: "Confirm & pay" },
            { id: "cancel", title: "Cancel" },
          ],
        },
      ],
      sessionPatch: {
        step: "awaiting_confirm",
        context: {
          dropoff: loc,
          quoteId: quote.quoteId,
          deliveryKobo: quote.feeKobo,
        },
      },
    };
  }
  private async onConfirm(
    msg: InboundMessage,
    ctx: DeliveryContext,
  ): Promise<HandlerResult> {
    if (isNegative(msg.text)) {
      return {
        replies: [{ kind: "text", text: "Cancelled — nothing charged." }],
        sessionPatch: { step: "idle", vertical: "unknown", context: {} },
      };
    }
    if (!isAffirmative(msg.text)) {
      return {
        replies: [
          {
            kind: "text",
            text: 'Reply "yes" to confirm the order, or "cancel" to stop.',
          },
        ],
      };
    }
    const vendor = findVendor(ctx.vendorId ?? "");
    if (!vendor || !ctx.dropoff || !ctx.quoteId) {
      return {
        replies: [
          { kind: "text", text: "That order expired. Let's start again." },
        ],
        sessionPatch: { step: "idle", vertical: "unknown", context: {} },
      };
    }
    const order = await deliveryProvider.createOrder({
      pickup: vendor.location,
      dropoff: ctx.dropoff,
      quoteId: ctx.quoteId,
      packageDescription: ctx.itemName,
      externalReference: `axis_${Date.now()}`,
      pickupContact: { name: vendor.name },
    });
    const replies: HandlerResult["replies"] = [
      {
        kind: "text",
        text: `Order placed! 🎉 ${cap(ctx.itemName ?? "your order")} from ${vendor.name} is on the way.`,
      },
    ];
    if (order.trackingUrl) {
      replies.push({
        kind: "link",
        text: "Track your order here:",
        url: order.trackingUrl,
        label: "Track order",
      });
    }
    return {
      replies,
      sessionPatch: {
        step: "idle",
        vertical: "unknown",
        context: { lastOrderId: order.orderId },
      },
    };
  }
  private parseVendorAndItem(
    text: string,
    fallbackVendorId?: string,
  ): {
    vendor: Vendor | null;
    item: CatalogItem | null;
  } | null {
    const vendor = findVendor(text) ?? findVendor(fallbackVendorId ?? "");
    if (!vendor) return { vendor: null, item: null };
    const item = findItem(vendor, text);
    return { vendor, item };
  }
  private matchSavedLocation(
    text: string,
    session: SessionState,
  ): GeoLocation | null {
    const t = text.toLowerCase();
    return (
      session.savedLocations.find(
        (l) => l.label && t.includes(l.label.toLowerCase()),
      ) ?? null
    );
  }
}
function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return AFFIRMATIVE.includes(t) || t === "confirm & pay" || t === "order it";
}
function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase();
  return NEGATIVE.includes(t) || t === "cancel";
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
