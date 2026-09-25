"use client";

import { useEffect, useState } from "react";
import { STORE_NAME } from "@/lib/audio";

export function LoginGate({
  children,
  title = "Log in",
  description = "Log in to play store music.",
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
}) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/admin/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setAuthed(Boolean(data.ok)))
      .catch(() => setAuthed(false));
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Couldn't log in");
      return;
    }
    setAuthed(true);
  }

  if (authed === null) return <main className="booting">Opening</main>;
  if (!authed) {
    return (
      <main className="login">
        <section className="login-card">
          <p className="eyebrow">{STORE_NAME}</p>
          <h1>{title}</h1>
          <p>{description}</p>
          <form onSubmit={login}>
            <input
              className="field"
              value={username}
              autoComplete="username"
              placeholder="Username"
              onChange={(event) => setUsername(event.target.value)}
            />
            <input
              className="field"
              type="password"
              value={password}
              autoComplete="current-password"
              placeholder="Password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="primary" type="submit">Log in</button>
            <p className="error">{error}</p>
          </form>
        </section>
      </main>
    );
  }
  return children;
}
