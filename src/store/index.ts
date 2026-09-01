import { InMemorySessionStore, InMemoryConversationStore } from "./memory.js";
import type { SessionStore, ConversationStore } from "./types.js";

export const sessionStore: SessionStore = new InMemorySessionStore();
export const conversationStore: ConversationStore =
  new InMemoryConversationStore();

export type { SessionStore, ConversationStore } from "./types.js";
