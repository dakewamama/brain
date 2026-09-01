import type {
  DeliveryProvider,
  DeliveryQuote,
  DeliveryOrder,
  DeliveryQuoteRequest,
  DeliveryCreateRequest,
  DeliveryStatus,
} from "./types.js";
import type { GeoLocation } from "../core/types.js";
import { newId } from "../core/ids.js";
const BASE_FEE_KOBO = 60000;
const PER_KM_KOBO = 12000;
interface StoredOrder {
  order: DeliveryOrder;
  createdAt: number;
}

export class StubDeliveryProvider implements DeliveryProvider {
  readonly name = "stub";
  readonly live = false;
  private orders = new Map<string, StoredOrder>();
  private quotes = new Map<string, DeliveryQuote>();
  async quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const km = haversineKm(req.pickup, req.dropoff);
    const feeKobo = Math.round(BASE_FEE_KOBO + km * PER_KM_KOBO);
    const quote: DeliveryQuote = {
      quoteId: newId("q"),
      feeKobo,
      etaMinutes: Math.max(15, Math.round(km * 4 + 10)),
      currency: "NGN",
      provider: this.name,
      expiresAt: Date.now() + 5 * 60000,
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }
  async createOrder(req: DeliveryCreateRequest): Promise<DeliveryOrder> {
    const quote = this.quotes.get(req.quoteId) ?? (await this.quote(req));
    const order: DeliveryOrder = {
      orderId: newId("ord"),
      provider: this.name,
      status: "created",
      trackingUrl: `https://track.axis.local/${quote.quoteId}`,
      quote,
    };
    this.orders.set(order.orderId, { order, createdAt: Date.now() });
    return order;
  }
  async getOrder(orderId: string): Promise<DeliveryOrder> {
    const stored = this.orders.get(orderId);
    if (!stored) throw new Error(`Unknown order ${orderId}`);
    const elapsed = Date.now() - stored.createdAt;
    stored.order.status = simulateStatus(elapsed);
    return stored.order;
  }
  async cancelOrder(orderId: string): Promise<void> {
    const stored = this.orders.get(orderId);
    if (stored) stored.order.status = "cancelled";
  }
}
function simulateStatus(elapsedMs: number): DeliveryStatus {
  const s = elapsedMs / 1000;
  if (s < 20) return "created";
  if (s < 45) return "assigned";
  if (s < 90) return "picked_up";
  if (s < 150) return "in_transit";
  return "delivered";
}
function haversineKm(a: GeoLocation, b: GeoLocation): number {
  const R = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
