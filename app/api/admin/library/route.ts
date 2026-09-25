import { isAuthed } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { applyAction } from "@/lib/library";
import { persistentStorage, readManifest, storageMode } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthed())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const manifest = await readManifest();
  return Response.json({
    manifest,
    storage: storageMode(),
    persistent: persistentStorage(),
  });
}

export async function POST(request: Request) {
  if (!(await isAuthed())) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!persistentStorage()) {
    return Response.json(
      { error: "Connect Vercel Blob storage first, or playlists will not be saved." },
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
