import type { InboundMessage, OutboundMessage } from "../core/types.js";

export interface ChannelAdapter {
  readonly id: string;
  readonly live: boolean;
  send(userId: string, messages: OutboundMessage[]): Promise<void>;
}

export interface ParsedInbound {
  messages: InboundMessage[];
}
