import { readConfig } from "../config";
import { apiError, isoTimestamp, json, text } from "../response";
import type { Env, HostRecordRow } from "../types";
import { parseIpType, parseOutput } from "../validation";

export async function handleRecords(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const output = parseOutput(url.searchParams.get("output"));
  const txtError = output !== "json";
  if (!output) return apiError(400, "invalid_output", "Output must be txt or json", true);
  const type = parseIpType(url.searchParams.get("type"), true);
  if (!type) return apiError(400, "invalid_type", "Type must be v4, v6, or all", txtError);

  const config = await readConfig(env.DB);
  if (!config.queryEnabled) return apiError(403, "query_disabled", "Host queries are disabled", txtError);
  const now = Math.floor(Date.now() / 1000);
  const versionClause = type === "all" ? "" : "AND r.ip_version = ?";
  const statement = env.DB.prepare(
    `SELECT r.hostname, r.ip_version, r.ip_address, r.expires_at
       FROM host_records r
       JOIN hostname_whitelist w ON w.hostname = r.hostname AND w.enabled = 1
      WHERE r.expires_at > ? ${versionClause}
      ORDER BY r.hostname ASC, r.ip_version ASC
      LIMIT ?`,
  );
  const bindings = type === "all"
    ? [now, config.maxRecordsPerResponse]
    : [now, type === "v4" ? 4 : 6, config.maxRecordsPerResponse];
  const result = await statement.bind(...bindings).all<HostRecordRow>();

  if (output === "txt") {
    const body = result.results.map((record) => `${record.hostname} ${record.ip_address}`).join("\n");
    return text(body ? `${body}\n` : "");
  }
  return json({
    records: result.results.map((record) => ({
      hostname: record.hostname,
      type: record.ip_version === 4 ? "v4" : "v6",
      ip: record.ip_address,
      expires_at: isoTimestamp(record.expires_at),
    })),
  });
}
