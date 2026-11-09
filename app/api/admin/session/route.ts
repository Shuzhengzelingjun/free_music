import { clearSessionCookie, accountRole, getSessionRole, setSessionCookie } from "@/lib/auth";
import { allowAttempt } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const role = await getSessionRole();
  if (role) await setSessionCookie(role);
  return Response.json({ ok: Boolean(role), role }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allowAttempt(`login:${ip}`)) {
    return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }
  const body = (await request.json().catch(() => null)) as { username?: string; password?: string } | null;
  const username = typeof body?.username === "string" ? body.username.slice(0, 80) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  const role = accountRole(username, password);
  if (!role) {
    return Response.json({ error: "Incorrect username or password" }, { status: 401 });
  }
  await setSessionCookie(role);
  return Response.json({ ok: true, role });
}

export async function DELETE() {
  await clearSessionCookie();
  return Response.json({ ok: true });
}
