import type {
  DeliveryProvider,
  DeliveryQuote,
  DeliveryOrder,
  DeliveryQuoteRequest,
  DeliveryCreateRequest,
  DeliveryStatus,
} from "./types.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { newId } from "../core/ids.js";
const log = childLogger("glovo");
interface GlovoAddress {
  lat: number;
  lon: number;
  type: "PICKUP" | "DELIVERY";
  label?: string;
  details?: string;
  contactPhone?: string | null;
  contactPerson?: string | null;
}
function mapStatus(state: string | undefined): DeliveryStatus {
  switch ((state ?? "").toUpperCase()) {
    case "SCHEDULED":
    case "CREATED":
      return "created";
    case "COURIER_ASSIGNED":
    case "ASSIGNED":
      return "assigned";
    case "PICKED_UP":
      return "picked_up";
    case "IN_TRANSIT":
    case "DELIVERING":
      return "in_transit";
    case "DELIVERED":
      return "delivered";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    default:
      return "unknown";
  }
}

export class GlovoProvider implements DeliveryProvider {
  readonly name = "glovo";
  readonly live: boolean;
  private base: string;
  private apiKey?: string;
  private apiSecret?: string;
  private token?: {
    value: string;
    expiresAt: number;
  };
  constructor() {
    const cfg = getConfig();
    this.base = cfg.GLOVO_API_BASE;
    this.apiKey = cfg.GLOVO_API_KEY;
    this.apiSecret = cfg.GLOVO_API_SECRET;
    this.live = Boolean(this.apiKey && this.apiSecret);
    if (!this.live) {
      log.warn(
        "Glovo credentials absent — provider constructed but not live. " +
          "Set GLOVO_API_KEY and GLOVO_API_SECRET to enable.",
      );
    }
  }
  async quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const body = {
      scheduleTime: null,
      description: req.packageDescription ?? "Axis order",
      addresses: this.buildAddresses(req),
    };
    const res = await this.request("POST", "/v2/laas/parcels/estimate", body);
    const data = (res as any).data ?? res;
    const feeKobo = nairaToKobo(
      data.estimatedPrice?.amount ?? data.price?.amount ?? 0,
    );
    return {
      quoteId: String(data.id ?? newId("q")),
      feeKobo,
      etaMinutes: data.estimatedTimeOfArrival ?? data.eta ?? undefined,
      currency: "NGN",
      provider: this.name,
      expiresAt: Date.now() + 5 * 60000,
    };
  }
  async createOrder(req: DeliveryCreateRequest): Promise<DeliveryOrder> {
    const body = {
      scheduleTime: null,
      description: req.packageDescription ?? "Axis order",
      addresses: this.buildAddresses(req),
      externalReference: req.externalReference,
    };
    const res = await this.request("POST", "/v2/laas/parcels", body);
    const data = (res as any).data ?? res;
    const quote: DeliveryQuote = {
      quoteId: req.quoteId,
      feeKobo: nairaToKobo(data.price?.amount ?? 0),
      currency: "NGN",
      provider: this.name,
    };
    return {
      orderId: String(data.id),
      provider: this.name,
      status: mapStatus(data.state),
      trackingUrl: data.trackingUrl ?? data.shareUrl,
      quote,
    };
  }
  async getOrder(orderId: string): Promise<DeliveryOrder> {
    const res = await this.request("GET", `/v2/laas/parcels/${orderId}`);
    const data = (res as any).data ?? res;
    return {
      orderId: String(data.id),
      provider: this.name,
      status: mapStatus(data.state),
      trackingUrl: data.trackingUrl ?? data.shareUrl,
      quote: {
        quoteId: String(data.id),
        feeKobo: nairaToKobo(data.price?.amount ?? 0),
        currency: "NGN",
        provider: this.name,
      },
    };
  }
  async cancelOrder(orderId: string): Promise<void> {
    await this.request("POST", `/v2/laas/parcels/${orderId}/cancel`);
  }
  private buildAddresses(req: DeliveryQuoteRequest): GlovoAddress[] {
    const pickupContact = (req as DeliveryCreateRequest).pickupContact;
    const dropoffContact = (req as DeliveryCreateRequest).dropoffContact;
    return [
      {
        lat: req.pickup.latitude,
        lon: req.pickup.longitude,
        type: "PICKUP",
        label: req.pickup.address,
        contactPhone: pickupContact?.phone ?? null,
        contactPerson: pickupContact?.name ?? null,
      },
      {
        lat: req.dropoff.latitude,
        lon: req.dropoff.longitude,
        type: "DELIVERY",
        label: req.dropoff.address,
        contactPhone: dropoffContact?.phone ?? null,
        contactPerson: dropoffContact?.name ?? null,
      },
    ];
  }
  private async ensureToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30000) {
      return this.token.value;
    }
    const res = await fetch(`${this.base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "client_credentials",
        clientId: this.apiKey,
        clientSecret: this.apiSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Glovo auth failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      accessToken: string;
      expiresIn: number;
    };
    this.token = {
      value: json.accessToken,
      expiresAt: Date.now() + json.expiresIn * 1000,
    };
    return this.token.value;
  }
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!this.live) {
      throw new Error(
        "GlovoProvider.request called without credentials — should have used stub.",
      );
    }
    const token = await this.ensureToken();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, path, text }, "Glovo request failed");
      throw new Error(`Glovo ${method} ${path} -> ${res.status}: ${text}`);
    }
    return res.json();
  }
}
function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}
