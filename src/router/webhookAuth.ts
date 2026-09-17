import { timingSafeEqual } from "crypto";

/** Constant-time equality for a provided secret against the expected one. Returns
 *  false if either is missing or lengths differ. Pure + testable. */
export function secretOk(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the token from an "Authorization: Bearer <token>" header. */
export function bearer(authHeader: string | undefined): string | undefined {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return undefined;
  return authHeader.slice("Bearer ".length);
}
