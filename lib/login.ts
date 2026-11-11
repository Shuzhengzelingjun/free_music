export async function submitLogin(username: string, password: string) {
  let response: Response;
  try {
    response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("无法连接登录服务，请检查网络后重试。");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || (response.status >= 500
      ? "登录服务异常，请检查服务器的账号和 ADMIN_SECRET 配置。"
      : "登录失败，请稍后重试。"));
  }
  if (!data?.ok || (data.role !== "admin" && data.role !== "store")) {
    throw new Error("登录服务返回异常，请刷新页面后重试。");
  }
  return data as { ok: true; role: "admin" | "store" };
}
