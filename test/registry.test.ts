import { env } from "cloudflare:workers";
import { applyD1Migrations, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const AUTH = `Basic ${btoa("admin:correct horse")}`;
const OTHER_AUTH = `Basic ${btoa("other:other password")}`;

async function seed(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM host_records"),
    env.DB.prepare("DELETE FROM user_host_permissions"),
    env.DB.prepare("DELETE FROM hostname_whitelist"),
    env.DB.prepare("DELETE FROM auth_users"),
    env.DB.prepare("UPDATE system_config SET value = '3600' WHERE key = 'record_ttl_seconds'"),
    env.DB.prepare("UPDATE system_config SET value = 'true' WHERE key IN ('registration_enabled', 'query_enabled')"),
    env.DB.prepare("UPDATE system_config SET value = '1000' WHERE key = 'max_records_per_response'"),
  ]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_users (username, password) VALUES (?, ?)").bind("admin", "correct horse"),
    env.DB.prepare("INSERT INTO auth_users (username, password) VALUES (?, ?)").bind("other", "other password"),
    env.DB.prepare(
      "INSERT INTO hostname_whitelist (hostname, allow_ipv4, allow_ipv6) VALUES ('home-nas', 1, 1), ('v4-only', 1, 0)",
    ),
  ]);
  const users = await env.DB.prepare("SELECT id, username FROM auth_users").all<{ id: number; username: string }>();
  const admin = users.results.find((user) => user.username === "admin")!;
  await env.DB.prepare("INSERT INTO user_host_permissions (user_id, hostname) VALUES (?, 'home-nas'), (?, 'v4-only')")
    .bind(admin.id, admin.id)
    .run();
}

function call(
  path: string,
  options: { method?: string; auth?: string | null; ip?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.auth !== null) headers.set("Authorization", options.auth ?? AUTH);
  if (options.ip) headers.set("CF-Connecting-IP", options.ip);
  return SELF.fetch(`http://example.test${path}`, { method: options.method ?? "GET", headers });
}

beforeEach(seed);

describe("authentication and console", () => {
  it("returns a Basic challenge when credentials are missing or wrong", async () => {
    const missing = await call("/", { auth: null });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toContain("Basic");
    expect((await call("/", { auth: `Basic ${btoa("admin:wrong")}` })).status).toBe(401);
  });

  it("rejects disabled users", async () => {
    await env.DB.prepare("UPDATE auth_users SET enabled = 0 WHERE username = 'admin'").run();
    expect((await call("/")).status).toBe(401);
  });

  it("serves the authenticated responsive web console", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("Host IP Registry");
    expect(body).toContain('data-operation="register"');
    expect(body).toContain('data-operation="resolve"');
    expect(body).toContain('data-operation="records"');
  });
});

describe("register", () => {
  it("registers IPv4 and IPv6 independently", async () => {
    const v4 = await call("/register?hostname=HOME-NAS", { method: "POST", ip: "203.0.113.10" });
    expect(v4.status).toBe(200);
    expect(await v4.json()).toMatchObject({ hostname: "home-nas", type: "v4", ip: "203.0.113.10" });

    const v6 = await call("/register?hostname=home-nas", { method: "POST", ip: "2001:db8::10" });
    expect(v6.status).toBe(200);
    expect(await v6.json()).toMatchObject({ hostname: "home-nas", type: "v6", ip: "[2001:db8::10]".slice(1, -1) });

    const rows = await env.DB.prepare("SELECT ip_version FROM host_records ORDER BY ip_version").all();
    expect(rows.results).toHaveLength(2);
  });

  it("updates the IP and refreshes expiration on repeated registration", async () => {
    await call("/register?hostname=home-nas", { method: "POST", ip: "203.0.113.10" });
    await env.DB.prepare("UPDATE host_records SET expires_at = 1 WHERE hostname = 'home-nas'").run();
    const response = await call("/register?hostname=home-nas", { method: "POST", ip: "198.51.100.20" });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT ip_address, expires_at FROM host_records WHERE hostname = 'home-nas'")
      .first<{ ip_address: string; expires_at: number }>();
    expect(row?.ip_address).toBe("198.51.100.20");
    expect(row!.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("enforces whitelist, user permission, hostname, IP version, and registration switch", async () => {
    expect((await call("/register?hostname=unknown", { method: "POST", ip: "203.0.113.1" })).status).toBe(403);
    expect((await call("/register?hostname=home-nas", { method: "POST", auth: OTHER_AUTH, ip: "203.0.113.1" })).status).toBe(403);
    expect((await call("/register?hostname=bad_host", { method: "POST", ip: "203.0.113.1" })).status).toBe(400);
    expect((await call("/register?hostname=v4-only", { method: "POST", ip: "2001:db8::1" })).status).toBe(403);
    await env.DB.prepare("UPDATE system_config SET value = 'false' WHERE key = 'registration_enabled'").run();
    expect((await call("/register?hostname=home-nas", { method: "POST", ip: "203.0.113.1" })).status).toBe(403);
  });

  it("rejects a missing or invalid Cloudflare source IP", async () => {
    expect((await call("/register?hostname=home-nas", { method: "POST" })).status).toBe(400);
    expect((await call("/register?hostname=home-nas", { method: "POST", ip: "999.1.1.1" })).status).toBe(400);
  });
});

describe("resolve", () => {
  it("returns exact default TXT and structured JSON for IPv4 and IPv6", async () => {
    await call("/register?hostname=home-nas", { method: "POST", ip: "203.0.113.10" });
    await call("/register?hostname=home-nas", { method: "POST", ip: "2001:db8::10" });

    const txt = await call("/resolve?hostname=home-nas&type=v4");
    expect(txt.status).toBe(200);
    expect(await txt.text()).toBe("203.0.113.10\n");
    const json = await call("/resolve?hostname=home-nas&type=v6&output=json");
    const body = await json.json<{ hostname: string; type: string; ip: string; expires_at: string }>();
    expect(body).toMatchObject({ hostname: "home-nas", type: "v6", ip: "2001:db8::10" });
    expect(body.expires_at).toMatch(/Z$/);
  });

  it("hides expired, missing, and disabled whitelist records", async () => {
    await call("/register?hostname=home-nas", { method: "POST", ip: "203.0.113.10" });
    await env.DB.prepare("UPDATE host_records SET expires_at = 1").run();
    const expired = await call("/resolve?hostname=home-nas&type=v4");
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe("");
    expect((await call("/resolve?hostname=missing&type=v4&output=json")).status).toBe(404);
  });

  it("returns empty TXT errors and JSON errors according to output", async () => {
    const txt = await call("/resolve?hostname=home-nas&type=nope");
    expect(txt.status).toBe(400);
    expect(await txt.text()).toBe("");
    const json = await call("/resolve?hostname=home-nas&type=nope&output=json");
    expect(json.status).toBe(400);
    expect(await json.json()).toMatchObject({ error: "invalid_parameters" });
  });
});

describe("records", () => {
  beforeEach(async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO host_records VALUES ('home-nas', 6, '2001:db8::10', ?, ?)").bind(now, now + 1000),
      env.DB.prepare("INSERT INTO host_records VALUES ('home-nas', 4, '203.0.113.10', ?, ?)").bind(now, now + 1000),
      env.DB.prepare("INSERT INTO host_records VALUES ('v4-only', 4, '198.51.100.20', ?, ?)").bind(now, now + 1000),
    ]);
  });

  it("returns sorted lines by default and filters by type", async () => {
    const all = await call("/records");
    expect(await all.text()).toBe(
      "home-nas 203.0.113.10\nhome-nas 2001:db8::10\nv4-only 198.51.100.20\n",
    );
    expect(await (await call("/records?type=v6")).text()).toBe("home-nas 2001:db8::10\n");
  });

  it("returns JSON expiration fields and honors the configured maximum", async () => {
    await env.DB.prepare("UPDATE system_config SET value = '2' WHERE key = 'max_records_per_response'").run();
    const body = await (await call("/records?type=all&output=json")).json<{ records: Array<Record<string, unknown>> }>();
    expect(body.records).toHaveLength(2);
    expect(body.records[0]).toHaveProperty("expires_at");
  });

  it("returns the specified empty representations", async () => {
    await env.DB.prepare("UPDATE host_records SET expires_at = 1").run();
    expect(await (await call("/records")).text()).toBe("");
    expect(await (await call("/records?output=json")).json()).toEqual({ records: [] });
  });
});

describe("routing and query switch", () => {
  it("returns 405 with Allow for unsupported methods", async () => {
    const response = await call("/register", { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("refuses queries when query_enabled is false", async () => {
    await env.DB.prepare("UPDATE system_config SET value = 'false' WHERE key = 'query_enabled'").run();
    expect((await call("/records?output=json")).status).toBe(403);
  });
});
