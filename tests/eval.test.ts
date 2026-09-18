import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlannerEval, formatReport } from "../src/eval/run.js";
import { scorePlan } from "../src/eval/score.js";
import type { EvalCase } from "../src/eval/cases.js";
import { SkillRegistry, type SkillOutcome } from "../src/skills/registry.js";
import type {
  GenerateResult,
  ModelMessage,
  ModelProvider,
  GenerateOptions,
} from "../src/model/types.js";

function registry(): SkillRegistry {
  const r = new SkillRegistry();
  for (const id of ["buy_airtime", "pay_person"]) {
    r.register({
      id,
      name: id,
      description: `does ${id}`,
      parameters: { type: "object" },
      async execute(): Promise<SkillOutcome> {
        return { replies: [] };
      },
    });
  }
  return r;
}

/** A provider that returns a canned plan based on the message text, so we can
 *  test the eval machinery deterministically without a real model. */
function scriptedProvider(
  route: (text: string) => { skill: string; params?: Record<string, unknown> } | null,
): ModelProvider {
  return {
    id: "scripted",
    defaultModelId: "scripted",
    async generate(messages: ModelMessage[], _o?: GenerateOptions): Promise<GenerateResult> {
      const text = messages[messages.length - 1]?.content ?? "";
      const hit = route(text);
      const steps = hit ? [{ skill: hit.skill, params: hit.params ?? {}, dependsOn: [] }] : [];
      return {
        text: "",
        toolCalls: [],
        json: { steps },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 1,
        modelId: "scripted",
        finishReason: "stop",
      };
    },
  };
}

test("scorePlan: skill + params match", () => {
  const c: EvalCase = { input: "x", expectedSkill: "buy_airtime", expectedParams: ["amount", "phone"] };
  const good = scorePlan({ steps: [{ skill: "buy_airtime", params: { amount: 500, phone: "080" }, dependsOn: [] }] }, c);
  assert.equal(good.skillOk, true);
  assert.equal(good.paramsOk, true);
  const missing = scorePlan({ steps: [{ skill: "buy_airtime", params: { amount: 500 }, dependsOn: [] }] }, c);
  assert.equal(missing.skillOk, true);
  assert.equal(missing.paramsOk, false);
});

test("scorePlan: empty plan matches a null-skill (social) case", () => {
  const c: EvalCase = { input: "hi", expectedSkill: null };
  assert.equal(scorePlan({ steps: [] }, c).skillOk, true);
});

test("runPlannerEval scores a perfect scripted model 100%", async () => {
  const provider = scriptedProvider((t) => {
    if (/airtime|top up|recharge/.test(t)) return { skill: "buy_airtime", params: { amount: 1, phone: "080" } };
    if (/send|pay|transfer/.test(t)) return { skill: "pay_person", params: { amount: 1, recipient: "x" } };
    return null; // greetings / unsupported -> empty
  });
  // Only the cases our scripted registry knows about + social; drop save_address.
  const cases: EvalCase[] = [
    { input: "buy 500 airtime for 08031234567", expectedSkill: "buy_airtime", expectedParams: ["amount", "phone"] },
    { input: "send 2000 to mum", expectedSkill: "pay_person", expectedParams: ["amount", "recipient"] },
    { input: "hi", expectedSkill: null },
    { input: "i want a tape", expectedSkill: null },
  ];
  const r = await runPlannerEval(provider, registry(), cases);
  assert.equal(r.total, 4);
  assert.equal(r.skillPass, 4);
  assert.equal(r.paramsPass, 4);
});

test("runPlannerEval catches a misrouting model (the regression net)", async () => {
  // A model that wrongly forces buy_airtime on a greeting.
  const provider = scriptedProvider(() => ({ skill: "buy_airtime", params: {} }));
  const cases: EvalCase[] = [{ input: "hi", expectedSkill: null }];
  const r = await runPlannerEval(provider, registry(), cases);
  assert.equal(r.skillPass, 0);
  assert.match(formatReport(r), /FAIL/);
});
