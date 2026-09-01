import type { Vertical } from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { DeliveryHandler } from "./delivery.js";
import { GiftingHandler } from "./gifting.js";
import { AffiliateHandler } from "./affiliate.js";
const handlers: Partial<Record<Vertical, VerticalHandler>> = {
  delivery: new DeliveryHandler(),
  gifting: new GiftingHandler(),
  affiliate: new AffiliateHandler(),
};

export function handlerFor(vertical: Vertical): VerticalHandler | null {
  return handlers[vertical] ?? null;
}
