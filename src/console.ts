import readline from "node:readline";
import { sessionStore, conversationStore } from "./store/index.js";
import { createPipeline } from "./router/pipeline.js";
import { flattenOutbound } from "./core/recorder.js";
import type { InboundMessage } from "./core/types.js";
const pipeline = createPipeline({
  sessions: sessionStore,
  conversations: conversationStore,
});
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "you > ",
});
const userId = "console-user";
async function handleLine(trimmed: string): Promise<void> {
  const msg: InboundMessage = {
    channel: "console",
    userId,
    text: trimmed,
    timestamp: Date.now(),
  };
  try {
    const replies = await pipeline.process(msg);
    for (const r of replies) {
      console.log(`axis> ${flattenOutbound(r)}`);
    }
  } catch (err) {
    console.error("error:", err);
  }
  console.log("");
}
console.log("Axis console. Type a message (or 'exit').\n");
rl.prompt();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "exit" || trimmed === "quit") {
    rl.close();
    return;
  }
  rl.pause();
  void handleLine(trimmed).then(() => {
    rl.resume();
    rl.prompt();
  });
});
rl.on("close", () => {
  console.log("bye");
  process.exit(0);
});
