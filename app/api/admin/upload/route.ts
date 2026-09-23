import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { contentTypeFor, extensionOf, isAudioFilename } from "@/lib/audio";
import { isAuthed } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { addSong } from "@/lib/library";
import { persistentStorage, storageMode } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 100 * 1024 * 1024;

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  if (!value || typeof value === "string") return false;
  return typeof value.arrayBuffer === "function" && typeof value.name === "string";
}

export async function POST(request: Request) {
  if (!(await isAuthed())) return Response.json({ error: "未登录" }, { status: 401 });
  if (!persistentStorage()) {
    return Response.json({ error: "请先连接 Vercel Blob 再上传" }, { status: 400 });
  }
  if (storageMode() === "blob") {
    return Response.json({ error: "当前环境请使用直传到 Blob" }, { status: 400 });
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!isUploadedFile(file)) return Response.json({ error: "请选择音频文件" }, { status: 400 });
    if (!isAudioFilename(file.name)) {
      return Response.json({ error: "只支持 mp3、m4a、wav、aac、ogg、flac" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return Response.json({ error: "文件需要小于 100MB" }, { status: 400 });
    }
    const extension = extensionOf(file.name);
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
    const directory = path.join(process.cwd(), "public", "uploads");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), Buffer.from(await file.arrayBuffer()));
    const title = typeof form.get("title") === "string" ? String(form.get("title")) : file.name;
    const artist = typeof form.get("artist") === "string" ? String(form.get("artist")) : "";
    const playlistId = typeof form.get("playlistId") === "string" ? String(form.get("playlistId")) : "";
    const manifest = await addSong({
      title,
      artist,
      url: `/uploads/${filename}`,
      playlistId: playlistId || null,
    });
    return Response.json({ manifest, contentType: contentTypeFor(extension) });
  } catch (error) {
    return jsonError(error);
  }
}
