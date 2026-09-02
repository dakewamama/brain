import type {
  Recognizer,
  RecognizedIntent,
  RecognizeInput,
  IntentAction,
} from "./types.js";
import type { Vertical } from "../core/types.js";
import { buildRecognitionMessages } from "./prompt.js";
import { RuleRecognizer } from "./rules.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("recognizer");

export interface ModelRecognizerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}
function actionToVertical(action: IntentAction): Vertical {
  switch (action) {
    case "order":
      return "delivery";
    case "gift":
      return "gifting";
    case "shop":
      return "affiliate";
    default:
      return "unknown";
  }
}

export class ModelRecognizer implements Recognizer {
  readonly name = "model";
  readonly live = true;
  private fallback = new RuleRecognizer();
  constructor(private opts: ModelRecognizerOptions) {}
  async recognize(input: RecognizeInput): Promise<RecognizedIntent> {
    try {
      const parsed = await this.callModel(input);
      if (parsed) return parsed;
      log.warn("model returned unparseable output; using rules");
    } catch (err) {
      log.warn({ err }, "model recognizer error; using rules");
    }
    return this.fallback.recognize(input);
  }
  private async callModel(
    input: RecognizeInput,
  ): Promise<RecognizedIntent | null> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? 4000,
    );
    try {
      const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: buildRecognitionMessages(input.text, input.previousText),
          temperature: 0,
          max_tokens: 200,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn({ status: res.status }, "recognizer HTTP error");
        return null;
      }
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return null;
      return this.parse(content);
    } finally {
      clearTimeout(timeout);
    }
  }
  private parse(content: string): RecognizedIntent | null {
    const clean = content.replace(/```json|```/g, "").trim();
    let obj: any;
    try {
      obj = JSON.parse(clean);
    } catch {
      return null;
    }
    const action: IntentAction = [
      "order",
      "gift",
      "shop",
      "track",
      "greet",
      "cancel",
      "help",
      "unknown",
    ].includes(obj.action)
      ? obj.action
      : "unknown";
    const confidence =
      typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0.5;
    return {
      action,
      vertical: actionToVertical(action),
      vendor: obj.vendor ?? undefined,
      item: obj.item ?? undefined,
      quantity: typeof obj.quantity === "number" ? obj.quantity : undefined,
      confidence,
      clarificationNeeded: Boolean(obj.clarification_needed),
      clarificationPrompt: obj.clarification_prompt ?? undefined,
      source: "model",
    };
  }
}
