import type { Metadata } from "next";
import { LoginGate } from "@/components/LoginGate";
import { Player } from "@/components/Player";

export const metadata: Metadata = {
  title: "Play",
};

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <LoginGate>
      <Player playlistId={id} />
    </LoginGate>
  );
}
