import type {
  ConversationEvent,
  SessionState,
  ChannelId,
} from "../core/types.js";
import type { SessionStore, ConversationStore } from "./types.js";
function key(channel: ChannelId, userId: string): string {
  return `${channel}:${userId}`;
}
function freshSession(channel: ChannelId, userId: string): SessionState {
  return {
    channel,
    userId,
    vertical: "unknown",
    step: "idle",
    context: {},
    savedLocations: [],
    updatedAt: Date.now(),
  };
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionState>();
  async get(channel: ChannelId, userId: string): Promise<SessionState | null> {
    return this.sessions.get(key(channel, userId)) ?? null;
  }
  async save(state: SessionState): Promise<void> {
    state.updatedAt = Date.now();
    this.sessions.set(key(state.channel, state.userId), state);
  }
  async patch(
    channel: ChannelId,
    userId: string,
    patch: Partial<SessionState>,
  ): Promise<SessionState> {
    const existing =
      this.sessions.get(key(channel, userId)) ?? freshSession(channel, userId);
    const merged: SessionState = {
      ...existing,
      ...patch,
      context: { ...existing.context, ...(patch.context ?? {}) },
      channel,
      userId,
      updatedAt: Date.now(),
    };
    this.sessions.set(key(channel, userId), merged);
    return merged;
  }
  async clear(channel: ChannelId, userId: string): Promise<void> {
    const existing = this.sessions.get(key(channel, userId));
    const reset = freshSession(channel, userId);
    if (existing) reset.savedLocations = existing.savedLocations;
    this.sessions.set(key(channel, userId), reset);
  }
}

export class InMemoryConversationStore implements ConversationStore {
  private events: ConversationEvent[] = [];
  async append(event: ConversationEvent): Promise<void> {
    this.events.push(event);
  }
  async history(
    channel: ChannelId,
    userId: string,
    limit = 100,
  ): Promise<ConversationEvent[]> {
    const filtered = this.events.filter(
      (e) => e.channel === channel && e.userId === userId,
    );
    return filtered.slice(-limit);
  }
  async listUsers(limit = 100): Promise<
    Array<{
      channel: ChannelId;
      userId: string;
      lastActivity: number;
      eventCount: number;
    }>
  > {
    const map = new Map<
      string,
      {
        channel: ChannelId;
        userId: string;
        lastActivity: number;
        eventCount: number;
      }
    >();
    for (const e of this.events) {
      const k = key(e.channel, e.userId);
      const cur = map.get(k);
      if (cur) {
        cur.eventCount += 1;
        cur.lastActivity = Math.max(cur.lastActivity, e.timestamp);
      } else {
        map.set(k, {
          channel: e.channel,
          userId: e.userId,
          lastActivity: e.timestamp,
          eventCount: 1,
        });
      }
    }
    return [...map.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, limit);
  }
  async since(timestamp: number, limit = 200): Promise<ConversationEvent[]> {
    return this.events.filter((e) => e.timestamp > timestamp).slice(-limit);
  }
}
