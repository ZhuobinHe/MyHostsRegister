import { readConfig } from "../config";
import { apiError, isoTimestamp, json, text } from "../response";
import type { Env, HostRecordRow } from "../types";
import { normalizeHostname, parseIpType, parseOutput } from "../validation";

export async function handleResolve(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const output = parseOutput(url.searchParams.get("output"));
  const txtError = output !== "json";
  if (!output) return apiError(400, "invalid_output", "Output must be txt or json", true);
  const hostname = normalizeHostname(url.searchParams.get("hostname"));
  const type = parseIpType(url.searchParams.get("type"));
  if (!hostname || !type) return apiError(400, "invalid_parameters", "Valid hostname and type are required", txtError);

  const config = await readConfig(env.DB);
  if (!config.queryEnabled) return apiError(403, "query_disabled", "Host queries are disabled", txtError);
  const version = type === "v4" ? 4 : 6;
  const now = Math.floor(Date.now() / 1000);
  const record = await env.DB
    .prepare(
      `SELECT r.hostname, r.ip_version, r.ip_address, r.expires_at
         FROM host_records r
         JOIN hostname_whitelist w ON w.hostname = r.hostname AND w.enabled = 1
        WHERE r.hostname = ? AND r.ip_version = ? AND r.expires_at > ?`,
    )
    .bind(hostname, version, now)
    .first<HostRecordRow>();
  if (!record) return apiError(404, "record_not_found", "Host IP record not found", txtError);
  if (output === "txt") return text(`${record.ip_address}\n`);
  return json({
    hostname: record.hostname,
    type,
    ip: record.ip_address,
    expires_at: isoTimestamp(record.expires_at),
  });
}
