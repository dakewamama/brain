import { plan } from "../planner/planner.js";
import type { ModelProvider } from "../model/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { PLANNER_CASES } from "./cases.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("eval.braintrust");

/**
 * Optional Braintrust reporting for the planner eval. Best-effort and env-gated:
 * does nothing unless BRAINTRUST_API_KEY is set AND the `braintrust` package is
 * installed (`npm i braintrust`). Uses the canonical `Eval(name, {data, task,
 * scores})` shape. Kept behind a dynamic import so brain builds and runs without
 * the dependency. NOTE: no PII in the dataset (see cases.ts); do not add prod
 * traces here without redacting phone/amount/account first.
 */
export async function reportToBraintrust(
  provider: ModelProvider,
  registry: SkillRegistry,
): Promise<void> {
  if (!process.env.BRAINTRUST_API_KEY) return;
  let bt: { Eval?: (...args: unknown[]) => unknown };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore optional dependency, not in package.json until enabled
    bt = await import("braintrust");
  } catch {
    log.warn("BRAINTRUST_API_KEY set but 'braintrust' not installed; run npm i braintrust");
    return;
  }
  if (typeof bt.Eval !== "function") {
    log.warn("braintrust SDK has no Eval export; skipping");
    return;
  }
  try {
    await bt.Eval("axis-planner", {
      data: () =>
        PLANNER_CASES.map((c) => ({ input: c.input, expected: c.expectedSkill })),
      task: async (input: string) => {
        const p = await plan(provider, `bt:${input}`, input, registry);
        return p.steps[0]?.skill ?? null;
      },
      scores: [
        ({ output, expected }: { output: unknown; expected: unknown }) => ({
          name: "skill_match",
          score: output === expected ? 1 : 0,
        }),
      ],
    });
    log.info("reported planner eval to braintrust");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "braintrust report failed");
  }
}
