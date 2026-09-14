/**
 * The process-wide skill registry, seeded with the baseline commerce skills.
 * These wrap the existing vertical handlers so nothing about their flows changes;
 * the registry just makes them discoverable + gives them model-facing metadata.
 * The Learner agent will `skills.register(...)` new ones here at runtime.
 */
import { SkillRegistry } from "./registry.js";
import { DeliveryHandler } from "../handlers/delivery.js";
import { AffiliateHandler } from "../handlers/affiliate.js";
import { payPersonSkill, saveAddressSkill } from "./payments.js";

export const skills = new SkillRegistry();

// Atomic money skills (deterministic; call onboarding for custody + off-ramp).
skills.register(saveAddressSkill);
skills.register(payPersonSkill);

skills.register({
  id: "delivery",
  name: "Order food",
  description:
    "Order food from a vendor for delivery, e.g. 'chicken wings from Nadia'.",
  parameters: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      item: { type: "string" },
      quantity: { type: "number" },
    },
  },
  handler: new DeliveryHandler(),
});

skills.register({
  id: "affiliate",
  name: "Shop online",
  description:
    "Search and shop for products online, e.g. 'buy an oraimo powerbank'.",
  parameters: {
    type: "object",
    properties: { product: { type: "string" } },
  },
  handler: new AffiliateHandler(),
});

export { SkillRegistry } from "./registry.js";
export type { SkillManifest } from "./registry.js";
