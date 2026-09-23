import { isAuthed } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { applyAction } from "@/lib/library";
import { persistentStorage, readManifest, storageMode } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthed())) return Response.json({ error: "未登录" }, { status: 401 });
  const manifest = await readManifest();
  return Response.json({
    manifest,
    storage: storageMode(),
    persistent: persistentStorage(),
  });
}

export async function POST(request: Request) {
  if (!(await isAuthed())) return Response.json({ error: "未登录" }, { status: 401 });
  if (!persistentStorage()) {
    return Response.json(
      { error: "请先在 Vercel 连接 Blob 存储，否则歌单无法保存。" },
      { status: 400 },
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const manifest = await applyAction(body);
    return Response.json({ manifest });
  } catch (error) {
    return jsonError(error);
  }
}
