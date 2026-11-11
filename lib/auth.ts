import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

const COOKIE = "fm_session";
export type SessionRole = "admin" | "store";
const MAX_AGE = 60 * 60 * 24 * 14;

function secret(role: SessionRole) {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET;
  // Keep password-based sessions isolated by role. A store password must
  // never be sufficient to sign an administrator session.
  const password = role === "store" ? expectedAccount().password : process.env.ADMIN_PASSWORD;
  if (!password || (role === "admin" && !process.env.ADMIN_USERNAME)) {
    throw new Error("Administrator account is not configured");
  }
  return createHash("sha256").update(`fm-session-v2\0${role}\0${password}`).digest();
}

export function expectedAccount() {
  return {
    username: process.env.STORE_USERNAME || "Heychic",
    password: process.env.STORE_PASSWORD || "Heychic8888",
  };
}

export function accountRole(username: string, password: string): SessionRole | null {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD &&
      passwordsMatch(username.trim().toLowerCase(), process.env.ADMIN_USERNAME.trim().toLowerCase()) &&
      passwordsMatch(password, process.env.ADMIN_PASSWORD)) return "admin";
  const expected = expectedAccount();
  const userOk = passwordsMatch(username.trim().toLowerCase(), expected.username.trim().toLowerCase());
  const passOk = passwordsMatch(password, expected.password);
  return userOk && passOk ? "store" : null;
}

export function passwordsMatch(input: string, expected: string) {
  const left = createHash("sha256").update(input).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createSessionToken(role: SessionRole) {
  const payload = Buffer.from(
    JSON.stringify({ version: 2, role, exp: Date.now() + MAX_AGE * 1000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret(role)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function sessionRole(token?: string | null): SessionRole | null {
  if (!token || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      version?: number;
      role?: string;
      exp?: number;
    };
    if (data.version !== 2 || (data.role !== "admin" && data.role !== "store") ||
        typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    // The untrusted role selects a key, but grants no access until its
    // signature has been verified using that role's own credentials.
    const expected = createHmac("sha256", secret(data.role)).update(payload).digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    return data.role;
  } catch {
    return null;
  }
}

export function verifySessionToken(token?: string | null) { return sessionRole(token) !== null; }

export async function getSessionRole() {
  const jar = await cookies();
  return sessionRole(jar.get(COOKIE)?.value);
}

export async function isAuthed() { return (await getSessionRole()) !== null; }
export async function isAdmin() { return (await getSessionRole()) === "admin"; }

export async function setSessionCookie(role: SessionRole) {
  const jar = await cookies();
  jar.set(COOKIE, createSessionToken(role), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
