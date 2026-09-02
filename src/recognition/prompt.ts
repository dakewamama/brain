export const RECOGNITION_SYSTEM_PROMPT = `You are the recognition layer for Axis, a WhatsApp commerce agent in Nigeria.
Your only job is to read one user message and output structured JSON describing what they want.
You do NOT reply to the user. You do NOT take actions. You only classify and extract.

Users write in casual Nigerian English and Pidgin. Examples of real phrasing:
"abeg", "wetin", "I wan", "gimme", "asap", "the one near", "biko", "sharp sharp".

Output ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{
  "action": "order" | "gift" | "shop" | "track" | "greet" | "cancel" | "help" | "unknown",
  "vendor": string | null,
  "item": string | null,
  "quantity": number | null,
  "confidence": number,        // 0.0 to 1.0, your confidence in the whole extraction
  "clarification_needed": boolean,
  "clarification_prompt": string | null  // a short question to ask if unsure
}

Rules:
- "order" = wants food/delivery. "gift" = sending to someone else. "shop" = buying a product.
- If they name a vendor and item clearly, confidence is high (>0.85).
- If vendor or item is vague or missing, lower confidence and set clarification_needed true.
- Never invent a vendor or item that isn't in the message.
- quantity defaults to 1 when an item is present and no number is given, else null.
- Keep clarification_prompt short, warm, and specific.`;

export const RECOGNITION_EXAMPLES: Array<{
  input: string;
  output: string;
}> = [
  {
    input: "chicken wings from Nadia",
    output:
      '{"action":"order","vendor":"Nadia","item":"chicken wings","quantity":1,"confidence":0.95,"clarification_needed":false,"clarification_prompt":null}',
  },
  {
    input: "abeg send me 2 packs of jollof from nadia asap",
    output:
      '{"action":"order","vendor":"Nadia","item":"jollof rice","quantity":2,"confidence":0.9,"clarification_needed":false,"clarification_prompt":null}',
  },
  {
    input: "i dey hungry",
    output:
      '{"action":"order","vendor":null,"item":null,"quantity":null,"confidence":0.4,"clarification_needed":true,"clarification_prompt":"What would you like to eat, and from where?"}',
  },
  {
    input: "send lunch to Ebele 08031234567",
    output:
      '{"action":"gift","vendor":null,"item":"lunch","quantity":1,"confidence":0.85,"clarification_needed":false,"clarification_prompt":null}',
  },
  {
    input: "buy an oraimo powerbank",
    output:
      '{"action":"shop","vendor":null,"item":"oraimo powerbank","quantity":1,"confidence":0.9,"clarification_needed":false,"clarification_prompt":null}',
  },
  {
    input: "where's my order",
    output:
      '{"action":"track","vendor":null,"item":null,"quantity":null,"confidence":0.85,"clarification_needed":false,"clarification_prompt":null}',
  },
  {
    input: "hi",
    output:
      '{"action":"greet","vendor":null,"item":null,"quantity":null,"confidence":0.95,"clarification_needed":false,"clarification_prompt":null}',
  },
];

export function buildRecognitionMessages(
  text: string,
  previousText?: string,
): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [{ role: "system", content: RECOGNITION_SYSTEM_PROMPT }];
  for (const ex of RECOGNITION_EXAMPLES) {
    messages.push({ role: "user", content: ex.input });
    messages.push({ role: "assistant", content: ex.output });
  }
  const contextPrefix = previousText
    ? `(previous message: "${previousText}")\n`
    : "";
  messages.push({ role: "user", content: contextPrefix + text });
  return messages;
}
