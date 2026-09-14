export type ChannelId = "whatsapp" | "telegram" | "console" | "web";
export type Vertical = "delivery" | "gifting" | "affiliate" | "unknown";
export interface InboundMessage {
  channel: ChannelId;
  userId: string;
  userName?: string;
  text: string;
  data?: Record<string, unknown>;
  messageId?: string;
  timestamp: number;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  address?: string;
  label?: string;
}

export type OutboundMessage =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "buttons";
      text: string;
      buttons: ReplyButton[];
    }
  | {
      kind: "list";
      text: string;
      header?: string;
      sections: ListSection[];
    }
  | {
      kind: "location_request";
      text: string;
    }
  | {
      kind: "link";
      text: string;
      url: string;
      label?: string;
    }
  | {
      kind: "products";
      text: string;
      products: ProductCard[];
    };

/** A real product found on a vendor: name, price and image as they appear on
 *  the page. Prices are extracted from the source, never computed by the model —
 *  if a price isn't clearly on the page, it's omitted rather than invented. */
export interface ProductCard {
  title: string;
  /** Display price exactly as shown on the source page, e.g. "₦12,500". */
  price?: string;
  imageUrl?: string;
  url: string;
  merchant: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface HandlerResult {
  replies: OutboundMessage[];
  sessionPatch?: Partial<SessionState>;
}

export interface SessionState {
  channel: ChannelId;
  userId: string;
  vertical: Vertical;
  step: string;
  context: Record<string, unknown>;
  savedLocations: GeoLocation[];
  /** Detected reply language for the whole conversation (a language code from
   *  SUPPORTED_LANGUAGES). Stored per-conversation, not per message. Undefined
   *  until first detection, treated as the fallback language. */
  language?: string;
  updatedAt: number;
}

export interface ConversationEvent {
  id: string;
  channel: ChannelId;
  userId: string;
  direction: "in" | "out";
  text: string;
  payload: InboundMessage | OutboundMessage;
  vertical?: Vertical;
  step?: string;
  timestamp: number;
}
