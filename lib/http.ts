export class HttpError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error(error);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}

const failures = new Map<string, { count: number; reset: number }>();
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export function loginRetryAfter(key: string, now = Date.now()) {
  const current = failures.get(key);
  if (!current) return 0;
  if (current.reset <= now) {
    failures.delete(key);
    return 0;
  }
  return current.count >= LOGIN_FAILURE_LIMIT ? Math.ceil((current.reset - now) / 1000) : 0;
}

export function recordLoginFailure(key: string, now = Date.now()) {
  for (const [storedKey, entry] of failures) {
    if (entry.reset <= now) failures.delete(storedKey);
  }
  const current = failures.get(key);
  if (current) current.count += 1;
  else failures.set(key, { count: 1, reset: now + LOGIN_WINDOW_MS });
  return loginRetryAfter(key, now);
}

export function clearLoginFailures(key: string) {
  failures.delete(key);
}
