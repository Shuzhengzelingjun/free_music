import { clearSessionCookie, accountRole, getSessionRole, setSessionCookie } from "@/lib/auth";
import { loginRetryAfter, recordLoginFailure, clearLoginFailures } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const role = await getSessionRole();
  if (role) await setSessionCookie(role);
  return Response.json({ ok: Boolean(role), role }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const body = (await request.json().catch(() => null)) as { username?: string; password?: string } | null;
  const username = typeof body?.username === "string" ? body.username.slice(0, 80) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  const key = JSON.stringify([ip, username.trim().toLowerCase()]);
  const retryAfter = loginRetryAfter(key);
  if (retryAfter) return rateLimited(retryAfter);
  const role = accountRole(username, password);
  if (!role) {
    const wait = recordLoginFailure(key);
    if (wait) return rateLimited(wait);
    return Response.json({ error: "Incorrect username or password" }, { status: 401 });
  }
  await setSessionCookie(role);
  clearLoginFailures(key);
  return Response.json({ ok: true, role });
}

export async function DELETE() {
  await clearSessionCookie();
  return Response.json({ ok: true });
}

function rateLimited(retryAfter: number) {
  const minutes = Math.floor(retryAfter / 60);
  const seconds = retryAfter % 60;
  const wait = minutes ? `${minutes} min ${seconds} sec` : `${seconds} sec`;
  return Response.json(
    { error: `Too many failed login attempts. Try again in ${wait}.`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}
