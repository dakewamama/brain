import type { GeoLocation } from "../core/types.js";

export type Kobo = number;
export interface DeliveryQuote {
  quoteId: string;
  feeKobo: Kobo;
  etaMinutes?: number;
  currency: "NGN";
  provider: string;
  expiresAt?: number;
}

export interface DeliveryOrder {
  orderId: string;
  provider: string;
  status: DeliveryStatus;
  trackingUrl?: string;
  quote: DeliveryQuote;
}

export type DeliveryStatus =
  | "created"
  | "assigned"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "unknown";
export interface DeliveryQuoteRequest {
  pickup: GeoLocation;
  dropoff: GeoLocation;
  packageDescription?: string;
  declaredValueKobo?: Kobo;
}

export interface DeliveryCreateRequest extends DeliveryQuoteRequest {
  quoteId: string;
  pickupContact?: Contact;
  dropoffContact?: Contact;
  externalReference?: string;
}

export interface Contact {
  name?: string;
  phone?: string;
}

export interface DeliveryProvider {
  readonly name: string;
  readonly live: boolean;
  quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote>;
  createOrder(req: DeliveryCreateRequest): Promise<DeliveryOrder>;
  getOrder(orderId: string): Promise<DeliveryOrder>;
  cancelOrder(orderId: string): Promise<void>;
}

export interface AffiliateProduct {
  title: string;
  priceKobo?: Kobo;
  url: string;
  merchant: string;
  imageUrl?: string;
}

export interface AffiliateProvider {
  readonly name: string;
  search(query: string): Promise<AffiliateProduct[]>;
  tag(url: string): string;
}
