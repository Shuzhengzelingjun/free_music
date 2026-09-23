import { adminPassword, clearSessionCookie, isAuthed, passwordsMatch, setSessionCookie } from "@/lib/auth";
import { allowAttempt } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: await isAuthed(),
    devHint: !process.env.ADMIN_PASSWORD && process.env.NODE_ENV !== "production",
  });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!allowAttempt(`login:${ip}`)) {
    return Response.json({ error: "尝试次数太多，请稍后再试" }, { status: 429 });
  }
  const expected = adminPassword();
  if (!expected) {
    return Response.json({ error: "请先设置环境变量 ADMIN_PASSWORD" }, { status: 500 });
  }
  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!password || !passwordsMatch(password, expected)) {
    return Response.json({ error: "密码不正确" }, { status: 401 });
  }
  await setSessionCookie();
  return Response.json({ ok: true });
}

export async function DELETE() {
  await clearSessionCookie();
  return Response.json({ ok: true });
}
