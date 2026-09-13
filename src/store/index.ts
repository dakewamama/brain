import { InMemorySessionStore, InMemoryConversationStore } from "./memory.js";
import type { SessionStore, ConversationStore } from "./types.js";
import {
  InMemoryProfileStore,
  FileProfileStore,
  type ProfileStore,
} from "./profile.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("store");

export const sessionStore: SessionStore = new InMemorySessionStore();
export const conversationStore: ConversationStore =
  new InMemoryConversationStore();

function selectProfileStore(): ProfileStore {
  const dir = getConfig().PROFILE_STORE_DIR;
  if (dir) {
    log.info(`Using durable file profile store at ${dir}.`);
    return new FileProfileStore(dir);
  }
  log.info("Using in-memory profile store (set PROFILE_STORE_DIR to persist).");
  return new InMemoryProfileStore();
}

export const profileStore: ProfileStore = selectProfileStore();

export type { SessionStore, ConversationStore } from "./types.js";
export type { ProfileStore } from "./profile.js";
