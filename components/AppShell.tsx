"use client";

import { usePathname } from "next/navigation";
import { LoginGate } from "@/components/LoginGate";
import { Player } from "@/components/Player";

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  const manage = path === "/admin" || path.startsWith("/admin/");
  const playlistId = path.startsWith("/play/")
    ? decodeURIComponent(path.slice("/play/".length).split("/")[0] || "")
    : undefined;

  return (
    <LoginGate>
      {manage ? <div className="manage-shell">{children}</div> : null}
      <Player presentation={manage ? "mini" : "full"} playlistId={playlistId || undefined} />
    </LoginGate>
  );
}
