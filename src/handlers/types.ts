import type {
  InboundMessage,
  SessionState,
  HandlerResult,
} from "../core/types.js";

export interface VerticalHandler {
  readonly vertical: SessionState["vertical"];
  start(msg: InboundMessage, session: SessionState): Promise<HandlerResult>;
  handle(msg: InboundMessage, session: SessionState): Promise<HandlerResult>;
}

export function text(...lines: string[]): HandlerResult {
  return { replies: [{ kind: "text", text: lines.join("\n") }] };
}
