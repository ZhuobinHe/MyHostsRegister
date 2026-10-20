export interface AppConfig {
  recordTtlSeconds: number;
  registrationEnabled: boolean;
  queryEnabled: boolean;
  maxRecordsPerResponse: number;
}

const REQUIRED_KEYS = [
  "record_ttl_seconds",
  "registration_enabled",
  "query_enabled",
  "max_records_per_response",
] as const;

function parsePositiveInteger(value: string | undefined, key: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid configuration: ${key}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid configuration: ${key}`);
  return parsed;
}

function parseBoolean(value: string | undefined, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid configuration: ${key}`);
}

export async function readConfig(db: D1Database): Promise<AppConfig> {
  const placeholders = REQUIRED_KEYS.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...REQUIRED_KEYS)
    .all<{ key: string; value: string }>();
  const values = Object.fromEntries(result.results.map((row) => [row.key, row.value]));
  return {
    recordTtlSeconds: parsePositiveInteger(values.record_ttl_seconds, "record_ttl_seconds"),
    registrationEnabled: parseBoolean(values.registration_enabled, "registration_enabled"),
    queryEnabled: parseBoolean(values.query_enabled, "query_enabled"),
    maxRecordsPerResponse: Math.min(
      parsePositiveInteger(values.max_records_per_response, "max_records_per_response"),
      10_000,
    ),
  };
}
