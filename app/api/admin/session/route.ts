import { clearSessionCookie, credentialsMatch, isAuthed, setSessionCookie } from "@/lib/auth";
import { allowAttempt } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: await isAuthed() });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allowAttempt(`login:${ip}`)) {
    return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }
  const body = (await request.json().catch(() => null)) as { username?: string; password?: string } | null;
  const username = typeof body?.username === "string" ? body.username.slice(0, 80) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!credentialsMatch(username, password)) {
    return Response.json({ error: "Incorrect username or password" }, { status: 401 });
  }
  await setSessionCookie();
  return Response.json({ ok: true });
}

export async function DELETE() {
  await clearSessionCookie();
  return Response.json({ ok: true });
}
