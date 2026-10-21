var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/auth.ts
function decodeBase64(value) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
__name(decodeBase64, "decodeBase64");
function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
function verifyPassword(password, storedPassword) {
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(password), encoder.encode(storedPassword));
}
__name(verifyPassword, "verifyPassword");
function parseBasicCredentials(header) {
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
__name(parseBasicCredentials, "parseBasicCredentials");
async function authenticate(request, db) {
  const credentials = parseBasicCredentials(request.headers.get("Authorization"));
  if (!credentials) return null;
  const user = await db.prepare("SELECT id, username, password FROM auth_users WHERE username = ? AND enabled = 1").bind(credentials.username).first();
  if (!user || !verifyPassword(credentials.password, user.password)) return null;
  return { id: user.id, username: user.username };
}
__name(authenticate, "authenticate");

// src/config.ts
var REQUIRED_KEYS = [
  "record_ttl_seconds",
  "registration_enabled",
  "query_enabled",
  "max_records_per_response"
];
function parsePositiveInteger(value, key) {
  if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid configuration: ${key}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid configuration: ${key}`);
  return parsed;
}
__name(parsePositiveInteger, "parsePositiveInteger");
function parseBoolean(value, key) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid configuration: ${key}`);
}
__name(parseBoolean, "parseBoolean");
async function readConfig(db) {
  const placeholders = REQUIRED_KEYS.map(() => "?").join(",");
  const result = await db.prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`).bind(...REQUIRED_KEYS).all();
  const values = Object.fromEntries(result.results.map((row) => [row.key, row.value]));
  return {
    recordTtlSeconds: parsePositiveInteger(values.record_ttl_seconds, "record_ttl_seconds"),
    registrationEnabled: parseBoolean(values.registration_enabled, "registration_enabled"),
    queryEnabled: parseBoolean(values.query_enabled, "query_enabled"),
    maxRecordsPerResponse: Math.min(
      parsePositiveInteger(values.max_records_per_response, "max_records_per_response"),
      1e4
    )
  };
}
__name(readConfig, "readConfig");

// src/response.ts
var NO_STORE_HEADERS = { "Cache-Control": "no-store" };
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
__name(json, "json");
function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers
    }
  });
}
__name(text, "text");
function apiError(status, error, message, txtOnly = false, headers = {}) {
  return txtOnly ? text("", status, headers) : json({ error, message }, status, headers);
}
__name(apiError, "apiError");
function isoTimestamp(seconds) {
  return new Date(seconds * 1e3).toISOString().replace(".000Z", "Z");
}
__name(isoTimestamp, "isoTimestamp");

// src/validation.ts
var HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function normalizeHostname(value) {
  if (value === null) return null;
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (hostname.length < 1 || hostname.length > 253) return null;
  const labels = hostname.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) return null;
  return hostname;
}
__name(normalizeHostname, "normalizeHostname");
function parseIpType(value, allowAll = false) {
  if (value === "v4" || value === "v6") return value;
  if (allowAll && (value === null || value === "all")) return "all";
  return null;
}
__name(parseIpType, "parseIpType");
function parseOutput(value) {
  if (value === null || value === "txt") return "txt";
  if (value === "json") return "json";
  return null;
}
__name(parseOutput, "parseOutput");
function normalizeIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => /^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1);
  if (numbers.some((part) => part < 0 || part > 255)) return null;
  return numbers.join(".");
}
__name(normalizeIpv4, "normalizeIpv4");
function normalizeIp(value) {
  if (!value) return null;
  const candidate = value.trim();
  const ipv4 = normalizeIpv4(candidate);
  if (ipv4) return { ip: ipv4, version: 4 };
  if (!candidate.includes(":") || !/^[0-9a-f:.]+$/i.test(candidate)) return null;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
    return { ip: hostname.slice(1, -1).toLowerCase(), version: 6 };
  } catch {
    return null;
  }
}
__name(normalizeIp, "normalizeIp");

// src/handlers/records.ts
async function handleRecords(request, env) {
  const url = new URL(request.url);
  const output = parseOutput(url.searchParams.get("output"));
  const txtError = output !== "json";
  if (!output) return apiError(400, "invalid_output", "Output must be txt or json", true);
  const type = parseIpType(url.searchParams.get("type"), true);
  if (!type) return apiError(400, "invalid_type", "Type must be v4, v6, or all", txtError);
  const config = await readConfig(env.DB);
  if (!config.queryEnabled) return apiError(403, "query_disabled", "Host queries are disabled", txtError);
  const now = Math.floor(Date.now() / 1e3);
  const versionClause = type === "all" ? "" : "AND r.ip_version = ?";
  const statement = env.DB.prepare(
    `SELECT r.hostname, r.ip_version, r.ip_address, r.expires_at
       FROM host_records r
       JOIN hostname_whitelist w ON w.hostname = r.hostname AND w.enabled = 1
      WHERE r.expires_at > ? ${versionClause}
      ORDER BY r.hostname ASC, r.ip_version ASC
      LIMIT ?`
  );
  const bindings = type === "all" ? [now, config.maxRecordsPerResponse] : [now, type === "v4" ? 4 : 6, config.maxRecordsPerResponse];
  const result = await statement.bind(...bindings).all();
  if (output === "txt") {
    const body = result.results.map((record) => `${record.hostname} ${record.ip_address}`).join("\n");
    return text(body ? `${body}
` : "");
  }
  return json({
    records: result.results.map((record) => ({
      hostname: record.hostname,
      type: record.ip_version === 4 ? "v4" : "v6",
      ip: record.ip_address,
      expires_at: isoTimestamp(record.expires_at)
    }))
  });
}
__name(handleRecords, "handleRecords");

// src/handlers/register.ts
async function handleRegister(request, env, user) {
  const url = new URL(request.url);
  const hostname = normalizeHostname(url.searchParams.get("hostname"));
  if (!hostname) return apiError(400, "invalid_hostname", "A valid hostname is required");
  const config = await readConfig(env.DB);
  if (!config.registrationEnabled) {
    return apiError(403, "registration_disabled", "Host registration is disabled");
  }
  const source = normalizeIp(request.headers.get("CF-Connecting-IP"));
  if (!source) return apiError(400, "invalid_source_ip", "A valid source IP is required");
  const whitelist = await env.DB.prepare(
    `SELECT w.allow_ipv4, w.allow_ipv6,
              EXISTS(SELECT 1 FROM user_host_permissions p WHERE p.user_id = ? AND p.hostname = w.hostname) AS permitted
         FROM hostname_whitelist w
        WHERE w.hostname = ? AND w.enabled = 1`
  ).bind(user.id, hostname).first();
  if (!whitelist) return apiError(403, "hostname_not_allowed", "Hostname is not enabled in the whitelist");
  if (!whitelist.permitted) return apiError(403, "registration_forbidden", "User cannot register this hostname");
  if (source.version === 4 && !whitelist.allow_ipv4 || source.version === 6 && !whitelist.allow_ipv6) {
    return apiError(403, "ip_version_not_allowed", "This IP version is not allowed for the hostname");
  }
  const now = Math.floor(Date.now() / 1e3);
  const expiresAt = now + config.recordTtlSeconds;
  await env.DB.prepare(
    `INSERT INTO host_records (hostname, ip_version, ip_address, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hostname, ip_version) DO UPDATE SET
         ip_address = excluded.ip_address,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`
  ).bind(hostname, source.version, source.ip, now, expiresAt).run();
  return json({
    hostname,
    type: source.version === 4 ? "v4" : "v6",
    ip: source.ip,
    expires_at: isoTimestamp(expiresAt)
  });
}
__name(handleRegister, "handleRegister");

// src/handlers/resolve.ts
async function handleResolve(request, env) {
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
  const now = Math.floor(Date.now() / 1e3);
  const record = await env.DB.prepare(
    `SELECT r.hostname, r.ip_version, r.ip_address, r.expires_at
         FROM host_records r
         JOIN hostname_whitelist w ON w.hostname = r.hostname AND w.enabled = 1
        WHERE r.hostname = ? AND r.ip_version = ? AND r.expires_at > ?`
  ).bind(hostname, version, now).first();
  if (!record) return apiError(404, "record_not_found", "Host IP record not found", txtError);
  if (output === "txt") return text(`${record.ip_address}
`);
  return json({
    hostname: record.hostname,
    type,
    ip: record.ip_address,
    expires_at: isoTimestamp(record.expires_at)
  });
}
__name(handleResolve, "handleResolve");

// src/index.ts
var ROUTES = {
  "/register": "POST",
  "/resolve": "GET",
  "/records": "GET"
};
function isTxtQuery(url) {
  return (url.pathname === "/resolve" || url.pathname === "/records") && url.searchParams.get("output") !== "json";
}
__name(isTxtQuery, "isTxtQuery");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const txtError = isTxtQuery(url);
    try {
      const user = await authenticate(request, env.DB);
      if (!user) {
        return apiError(401, "unauthorized", "Authentication required", txtError, {
          "WWW-Authenticate": 'Basic realm="Host IP Registry", charset="UTF-8"'
        });
      }
      const expectedMethod = ROUTES[url.pathname];
      if (expectedMethod && request.method !== expectedMethod) {
        return apiError(405, "method_not_allowed", "Request method is not allowed", txtError, {
          Allow: expectedMethod
        });
      }
      if (url.pathname === "/register") return handleRegister(request, env, user);
      if (url.pathname === "/resolve") return handleResolve(request, env);
      if (url.pathname === "/records") return handleRecords(request, env);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return apiError(405, "method_not_allowed", "Request method is not allowed", false, { Allow: "GET, HEAD" });
      }
      const assetResponse = await env.ASSETS.fetch(request);
      const response = new Response(assetResponse.body, assetResponse);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      return apiError(500, "internal_error", "Internal server error", txtError);
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
