import type { Metadata } from "next";
import { Player } from "@/components/Player";

export const metadata: Metadata = {
  title: "播放",
};

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Player playlistId={id} />;
}
