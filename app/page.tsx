import { LoginGate } from "@/components/LoginGate";
import { Player } from "@/components/Player";

export default function HomePage() {
  return (
    <LoginGate>
      <Player />
    </LoginGate>
  );
}
