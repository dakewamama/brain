import type { Vertical } from "../core/types.js";

export type IntentAction =
  "order" | "gift" | "shop" | "track" | "greet" | "cancel" | "help" | "unknown";

export interface RecognizedIntent {
  action: IntentAction;
  vertical: Vertical;
  vendor?: string;
  item?: string;
  quantity?: number;
  confidence: number;
  clarificationNeeded: boolean;
  clarificationPrompt?: string;
  source: "rules" | "model";
}

export interface Recognizer {
  readonly name: string;
  readonly live: boolean;
  recognize(input: RecognizeInput): Promise<RecognizedIntent>;
}

export interface RecognizeInput {
  text: string;
  previousText?: string;
  inFlow?: boolean;
  activeVertical?: Vertical;
}

export const CONFIDENCE_THRESHOLD = 0.55;
