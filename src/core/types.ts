export type ChannelId = "whatsapp" | "telegram" | "console";
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
    };

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
