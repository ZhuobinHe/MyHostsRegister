import { readConfig } from "../config";
import { apiError, isoTimestamp, json } from "../response";
import type { AuthUser, Env } from "../types";
import { normalizeHostname, normalizeIp } from "../validation";

interface WhitelistRow {
  allow_ipv4: number;
  allow_ipv6: number;
  permitted: number;
}

export async function handleRegister(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const url = new URL(request.url);
  const hostname = normalizeHostname(url.searchParams.get("hostname"));
  if (!hostname) return apiError(400, "invalid_hostname", "A valid hostname is required");

  const config = await readConfig(env.DB);
  if (!config.registrationEnabled) {
    return apiError(403, "registration_disabled", "Host registration is disabled");
  }

  const source = normalizeIp(request.headers.get("CF-Connecting-IP"));
  if (!source) return apiError(400, "invalid_source_ip", "A valid source IP is required");

  const whitelist = await env.DB
    .prepare(
      `SELECT w.allow_ipv4, w.allow_ipv6,
              EXISTS(SELECT 1 FROM user_host_permissions p WHERE p.user_id = ? AND p.hostname = w.hostname) AS permitted
         FROM hostname_whitelist w
        WHERE w.hostname = ? AND w.enabled = 1`,
    )
    .bind(user.id, hostname)
    .first<WhitelistRow>();
  if (!whitelist) return apiError(403, "hostname_not_allowed", "Hostname is not enabled in the whitelist");
  if (!whitelist.permitted) return apiError(403, "registration_forbidden", "User cannot register this hostname");
  if ((source.version === 4 && !whitelist.allow_ipv4) || (source.version === 6 && !whitelist.allow_ipv6)) {
    return apiError(403, "ip_version_not_allowed", "This IP version is not allowed for the hostname");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + config.recordTtlSeconds;
  await env.DB
    .prepare(
      `INSERT INTO host_records (hostname, ip_version, ip_address, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hostname, ip_version) DO UPDATE SET
         ip_address = excluded.ip_address,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .bind(hostname, source.version, source.ip, now, expiresAt)
    .run();

  return json({
    hostname,
    type: source.version === 4 ? "v4" : "v6",
    ip: source.ip,
    expires_at: isoTimestamp(expiresAt),
  });
}
