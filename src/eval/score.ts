import type { Plan } from "../planner/planner.js";
import type { EvalCase } from "./cases.js";

/**
 * Pure scorers for a planner output against an expected case. Kept pure so they're
 * unit-testable and reusable as Braintrust scorers.
 */
export interface CaseScore {
  skillOk: boolean;
  /** Only meaningful when the skill matched and params were expected. */
  paramsOk: boolean;
  actualSkill: string | null;
}

export function scorePlan(plan: Plan, c: EvalCase): CaseScore {
  const actualSkill = plan.steps[0]?.skill ?? null;
  const skillOk = actualSkill === c.expectedSkill;

  const expectedParams = c.expectedParams ?? [];
  const params = (plan.steps[0]?.params ?? {}) as Record<string, unknown>;
  const paramsOk =
    !skillOk || expectedParams.length === 0
      ? skillOk // nothing to check beyond the skill
      : expectedParams.every((k) => params[k] != null && params[k] !== "");

  return { skillOk, paramsOk, actualSkill };
}

export interface EvalReport {
  total: number;
  skillPass: number;
  paramsPass: number;
  rows: Array<{
    input: string;
    expectedSkill: string | null;
    actualSkill: string | null;
    skillOk: boolean;
    paramsOk: boolean;
  }>;
}

export function summarize(
  results: Array<{ c: EvalCase; score: CaseScore }>,
): EvalReport {
  const rows = results.map(({ c, score }) => ({
    input: c.input,
    expectedSkill: c.expectedSkill,
    actualSkill: score.actualSkill,
    skillOk: score.skillOk,
    paramsOk: score.paramsOk,
  }));
  return {
    total: results.length,
    skillPass: rows.filter((r) => r.skillOk).length,
    paramsPass: rows.filter((r) => r.paramsOk).length,
    rows,
  };
}
