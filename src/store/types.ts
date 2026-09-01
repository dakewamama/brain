import type {
  ConversationEvent,
  SessionState,
  ChannelId,
} from "../core/types.js";

export interface SessionStore {
  get(channel: ChannelId, userId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  patch(
    channel: ChannelId,
    userId: string,
    patch: Partial<SessionState>,
  ): Promise<SessionState>;
  clear(channel: ChannelId, userId: string): Promise<void>;
}

export interface ConversationStore {
  append(event: ConversationEvent): Promise<void>;
  history(
    channel: ChannelId,
    userId: string,
    limit?: number,
  ): Promise<ConversationEvent[]>;
  listUsers(limit?: number): Promise<
    Array<{
      channel: ChannelId;
      userId: string;
      lastActivity: number;
      eventCount: number;
    }>
  >;
  since(timestamp: number, limit?: number): Promise<ConversationEvent[]>;
}
