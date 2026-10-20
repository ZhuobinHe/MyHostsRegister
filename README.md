# Host IP Registry

一个部署在 Cloudflare Workers + D1 上的轻量个人公网 IP 注册中心。它支持 IPv4/IPv6 独立注册、TTL 逻辑过期、主机白名单、按用户授权、TXT/JSON 查询和一个无框架 Web 控制台。

实现遵循 [SPEC.md](./SPEC.md)，但按项目当前要求做了一项明确调整：`auth_users.password` 直接存储明文密码，不使用密码哈希。请严格限制 D1 Dashboard、备份和 Cloudflare 账号的访问权限，并始终通过 HTTPS 使用服务。

## API

所有请求（包括页面和静态资源）都需要 HTTP Basic Auth。

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/` | Web 操作控制台 |
| `POST` | `/register?hostname=home-nas` | 用 `CF-Connecting-IP` 注册来源地址 |
| `GET` | `/resolve?hostname=home-nas&type=v4&output=txt` | 查询单条记录 |
| `GET` | `/records?type=all&output=txt` | 查询全部有效记录 |

`resolve` 的 `type` 必须是 `v4` 或 `v6`。`records` 的 `type` 默认为 `all`。两个查询接口的 `output` 默认为 `txt`，也可设为 `json`。

## 前置条件

- Node.js 20 或更高版本
- npm
- 一个 Cloudflare 账号（免费计划即可）
- 首次创建/部署云资源时运行 `npx wrangler login`

## 本地开发

安装锁定依赖：

```bash
npm ci
```

创建本地 D1 schema：

```bash
npx wrangler d1 migrations apply host-ip-registry --local
```

向本地数据库写入账号、白名单和权限。下面的密码仅为示例：

```bash
npx wrangler d1 execute host-ip-registry --local --command \
  "INSERT INTO auth_users (username, password) VALUES ('admin', 'change-me');"

npx wrangler d1 execute host-ip-registry --local --command \
  "INSERT INTO hostname_whitelist (hostname, enabled, allow_ipv4, allow_ipv6) VALUES ('home-nas', 1, 1, 1);"

npx wrangler d1 execute host-ip-registry --local --command \
  "INSERT INTO user_host_permissions (user_id, hostname) SELECT id, 'home-nas' FROM auth_users WHERE username = 'admin';"
```

启动本地 Worker：

```bash
npm run dev
```

Wrangler 本地请求通常没有真实 Cloudflare 边缘注入的 `CF-Connecting-IP`。测试注册接口时可显式添加该请求头：

```bash
curl -u admin:change-me -X POST \
  -H 'CF-Connecting-IP: 203.0.113.10' \
  'http://localhost:8787/register?hostname=home-nas'
```

## Cloudflare 部署

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create host-ip-registry
```

将命令返回的 `database_id` 填入 `wrangler.jsonc`，替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。

### 2. 应用远端 Migration

```bash
npx wrangler d1 migrations apply host-ip-registry --remote
```

Migration 会创建 `system_config`、`auth_users`、`hostname_whitelist`、`user_host_permissions` 和 `host_records` 五张表，并写入默认系统配置。

### 3. 初始化用户和主机权限

推荐在 Cloudflare Dashboard 的 D1 SQL Console 中执行以下 SQL，避免密码出现在 shell 历史中：

```sql
INSERT INTO auth_users (username, password)
VALUES ('admin', 'replace-with-a-long-password');

INSERT INTO hostname_whitelist
  (hostname, enabled, allow_ipv4, allow_ipv6)
VALUES
  ('home-nas', 1, 1, 1);

INSERT INTO user_host_permissions (user_id, hostname)
SELECT id, 'home-nas'
FROM auth_users
WHERE username = 'admin';
```

如果使用命令行，也可执行 `npx wrangler d1 execute host-ip-registry --remote --file ./your-private-seed.sql`。不要提交包含真实密码的 seed 文件。

### 4. 部署 Worker

```bash
npm run deploy
```

部署后，Cloudflare 会在边缘为注册请求提供可信的 `CF-Connecting-IP`。不要在 Worker 前增加会让客户端直接控制该请求头的非 Cloudflare 入口。

### 5. 自定义域名

在 Cloudflare Dashboard 中打开对应 Worker，进入 **Settings → Domains & Routes**，添加已托管在同一账号中的自定义域名或 Route。保持 HTTPS 开启；本项目不支持明文 HTTP 凭据传输。

## 调用示例

```bash
# 注册当前连接对应的 IP
curl -u admin:your-password -X POST \
  'https://registry.example.com/register?hostname=home-nas'

# 极简 IPv4 查询（默认 TXT）
curl -u admin:your-password \
  'https://registry.example.com/resolve?hostname=home-nas&type=v4'

# JSON IPv6 查询
curl -u admin:your-password \
  'https://registry.example.com/resolve?hostname=home-nas&type=v6&output=json'

# 所有有效记录
curl -u admin:your-password \
  'https://registry.example.com/records?type=all&output=json'
```

## 业务配置

所有业务配置都在 D1 的 `system_config` 表中，更改后对后续请求生效：

| Key | 默认值 | 作用 |
|---|---:|---|
| `record_ttl_seconds` | `3600` | 注册记录有效期（秒） |
| `registration_enabled` | `true` | 是否允许注册 |
| `query_enabled` | `true` | 是否允许查询 |
| `max_records_per_response` | `1000` | `/records` 最大返回条数 |

示例：

```sql
UPDATE system_config SET value = '7200' WHERE key = 'record_ttl_seconds';
UPDATE system_config SET value = 'false' WHERE key = 'registration_enabled';
```

记录通过查询条件进行逻辑过期。无需 Cron Trigger；如需回收旧行，可偶尔在 D1 Console 执行：

```sql
DELETE FROM host_records WHERE expires_at <= unixepoch();
```

## 测试与检查

```bash
npm run typecheck
npm test
npm run check
```

自动化测试运行在 Cloudflare Workers 本地运行时，并使用隔离的本地 D1。覆盖认证、禁用用户、控制台保护、IPv4/IPv6 注册、重复刷新、白名单与用户权限、业务开关、过期过滤、TXT/JSON 输出、排序、记录上限和错误响应。

可在不部署的情况下验证 Wrangler 是否能完成打包：

```bash
npx wrangler deploy --dry-run
```

## 实现说明

- 只依赖 Cloudflare Workers、D1 和 Workers Static Assets，不使用 KV、R2、Durable Objects 或外部服务。
- API SQL 全部使用参数绑定。
- 动态响应和认证页面均设置 `Cache-Control: no-store`。
- 查询会过滤已过期记录以及已禁用/删除白名单对应的记录。
- `max_records_per_response` 在代码中另有 `10000` 的安全上限，避免误配置产生无界响应。
- TXT 查询错误只返回状态码和空 Body，防止脚本把错误文字误认为 IP。
