import type { AuthUser } from "./types";

interface AuthUserRow extends AuthUser {
  password: string;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function verifyPassword(password: string, storedPassword: string): boolean {
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(password), encoder.encode(storedPassword));
}

function parseBasicCredentials(header: string | null): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(header.slice(6).trim()));
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (username.length > 128 || password.length > 1024) return null;
    return { username, password };
  } catch {
    return null;
  }
}

export async function authenticate(request: Request, db: D1Database): Promise<AuthUser | null> {
  const credentials = parseBasicCredentials(request.headers.get("Authorization"));
  if (!credentials) return null;
  const user = await db
    .prepare("SELECT id, username, password FROM auth_users WHERE username = ? AND enabled = 1")
    .bind(credentials.username)
    .first<AuthUserRow>();
  if (!user || !verifyPassword(credentials.password, user.password)) return null;
  return { id: user.id, username: user.username };
}
