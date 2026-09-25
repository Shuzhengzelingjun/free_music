import { toPublicPlaylist } from "@/lib/audio";
import { isAuthed } from "@/lib/auth";
import { readManifest } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: "Please log in" }, { status: 401 });
  }
  const id = new URL(request.url).searchParams.get("id");
  const manifest = await readManifest();
  const payload = toPublicPlaylist(manifest, id);
  if (!payload) {
    return Response.json({ error: "Playlist not found" }, { status: 404 });
  }
  return Response.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
