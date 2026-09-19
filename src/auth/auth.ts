/**
 * Email + password auth backed by Postgres. Sign up and log in return the user's
 * stable `webUserId` — the id everything (wallet, balance, chat) keys off, so a
 * user's account (and its wallet) follows them across devices. Passwords are
 * scrypt-hashed with a per-user salt; the plaintext is never stored or logged.
 */
import { Pool } from "pg";
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from "crypto";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "email_taken" | "not_found" | "bad_password" | "invalid",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(email: string, password: string): void {
  if (!EMAIL_RE.test(email.trim())) {
    throw new AuthError("Enter a valid email address.", "invalid");
  }
  if (password.length < 8) {
    throw new AuthError("Password must be at least 8 characters.", "invalid");
  }
}

export class AuthService {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        email text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
  }

  async signup(email: string, password: string): Promise<{ webUserId: string; email: string }> {
    validateCredentials(email, password);
    const e = email.trim().toLowerCase();
    const id = `web_${randomUUID()}`;
    try {
      await this.pool.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
        [id, e, hashPassword(password)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new AuthError("That email is already registered. Log in instead.", "email_taken");
      }
      throw err;
    }
    return { webUserId: id, email: e };
  }

  async login(email: string, password: string): Promise<{ webUserId: string; email: string }> {
    const e = email.trim().toLowerCase();
    const r = await this.pool.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM users WHERE email = $1`,
      [e],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError("No account with that email. Sign up first.", "not_found");
    if (!verifyPassword(password, row.password_hash)) {
      throw new AuthError("Wrong password.", "bad_password");
    }
    return { webUserId: row.id, email: e };
  }
}
