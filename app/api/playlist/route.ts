import { toPublicPlaylist } from "@/lib/audio";
import { readManifest } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  const manifest = await readManifest();
  const payload = toPublicPlaylist(manifest, id);
  if (!payload) {
    return Response.json({ error: "找不到这个歌单" }, { status: 404 });
  }
  return Response.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
