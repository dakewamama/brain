/**
 * Phone/network helpers shared by the airtime intent parser and the airtime
 * playbook. Pure functions — nothing here talks to a provider or a model.
 */

/** Strip formatting; accept +234/234 and normalise to local 0-prefixed form. */
export function normalizePhone(raw: string): string {
  let p = raw.replace(/[^\d+]/g, "");
  if (p.startsWith("+234")) p = "0" + p.slice(4);
  else if (p.startsWith("234")) p = "0" + p.slice(3);
  return p;
}

export function validNigerianPhone(p: string): boolean {
  return /^0\d{10}$/.test(p);
}

// Best-effort network from the number's prefix (deterministic, not model-guessed).
// Number porting means this is a convenience, not a guarantee; an explicitly
// stated network always wins.
const PREFIXES: Record<string, string> = {};
for (const p of ["0803", "0806", "0703", "0706", "0813", "0816", "0810", "0814", "0903", "0906", "0913", "0916"]) PREFIXES[p] = "mtn";
for (const p of ["0805", "0807", "0705", "0815", "0811", "0905", "0915"]) PREFIXES[p] = "glo";
for (const p of ["0802", "0808", "0708", "0812", "0701", "0901", "0902", "0904", "0907", "0912"]) PREFIXES[p] = "airtel";
for (const p of ["0809", "0818", "0817", "0909", "0908"]) PREFIXES[p] = "9mobile";

export function networkFromPhone(phone: string): string | null {
  return PREFIXES[phone.slice(0, 4)] ?? null;
}
