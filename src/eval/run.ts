import { plan } from "../planner/planner.js";
import type { ModelProvider } from "../model/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { PLANNER_CASES, type EvalCase } from "./cases.js";
import { scorePlan, summarize, type CaseScore, type EvalReport } from "./score.js";

/**
 * Run the planner over the eval dataset and score each case. Model + registry are
 * injected so this is testable with a stub and runnable against the real provider
 * (`npm run eval:planner`). This is our regression net for planner classification.
 */
export async function runPlannerEval(
  provider: ModelProvider,
  registry: SkillRegistry,
  cases: EvalCase[] = PLANNER_CASES,
): Promise<EvalReport> {
  const results: Array<{ c: EvalCase; score: CaseScore }> = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const p = await plan(provider, `eval:${i}`, c.input, registry);
    results.push({ c, score: scorePlan(p, c) });
  }
  return summarize(results);
}

export function formatReport(r: EvalReport): string {
  const lines = r.rows.map((row) => {
    const mark = row.skillOk ? "PASS" : "FAIL";
    const p = row.skillOk && !row.paramsOk ? " (params miss)" : "";
    return `  [${mark}] "${row.input}" -> ${row.actualSkill ?? "none"} (expected ${row.expectedSkill ?? "none"})${p}`;
  });
  return (
    `planner eval: ${r.skillPass}/${r.total} skill, ${r.paramsPass}/${r.total} params\n` +
    lines.join("\n")
  );
}

// CLI: run against the real provider. Optional Braintrust reporting when keyed.
async function main(): Promise<void> {
  const { modelProvider } = await import("../model/index.js");
  const { skills } = await import("../skills/index.js");
  const report = await runPlannerEval(modelProvider, skills);
  console.log(formatReport(report));
  if (process.env.BRAINTRUST_API_KEY) {
    const { reportToBraintrust } = await import("./braintrust.js");
    await reportToBraintrust(modelProvider, skills);
  }
  process.exit(report.skillPass === report.total ? 0 : 1);
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  void main();
}
