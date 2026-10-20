# Host IP Registry — 需求与技术设计规格

**版本：** v1.0  
**状态：** 需求确认，待开发  
**目标平台：** Cloudflare Workers + D1  
**开发语言：** TypeScript  
**部署目标：** Cloudflare Free Plan

---

## 1. 项目概述

开发一个轻量级的个人主机名与公网 IP 注册、查询服务（Host IP Registry），类似私有 DDNS 注册中心。

主要用于家庭网络、NAS、个人服务器、开发设备等场景。

客户端可以定期通过 HTTP API 注册当前公网 IPv4 或 IPv6 地址，其他客户端通过主机名查询对应的 IP。

系统提供一个简单的 Web 控制台，方便通过浏览器手动执行注册和查询操作。

### 核心要求

1. 完全部署在 Cloudflare 免费服务上，不依赖自建服务器。
2. 使用 HTTP Basic Authentication 进行统一访问控制。
3. 支持 IPv4 和 IPv6 独立注册、查询。
4. 自动识别注册请求的来源公网 IP。
5. IP 映射具有可配置的有效期，重复注册刷新有效期。
6. 仅允许注册白名单中的主机名。
7. 支持 JSON 和极简 TXT 查询结果。
8. 提供根路径 Web 操作控制台。
9. 所有业务配置通过 D1 数据库表管理。
10. 尽量减少依赖、资源消耗和维护成本。

## 2. 技术架构

### 2.1 技术选型

| 组件 | 技术 | 用途 |
|---|---|---|
| 运行平台 | Cloudflare Workers | HTTP API 和业务逻辑 |
| 数据库 | Cloudflare D1 (SQLite) | IP 记录及业务配置 |
| Web 前端 | HTML + CSS + Vanilla JavaScript | 简单操作控制台 |
| 静态资源 | Workers Static Assets | 托管 Web 页面 |
| 身份认证 | HTTP Basic Auth | 所有接口访问控制 |
| 开发语言 | TypeScript | Worker 服务端 |
| 部署工具 | Wrangler | 本地开发、数据库迁移及部署 |

只使用一个 Worker 和一个 D1 数据库。

不使用独立服务器、KV、R2、Durable Objects 或第三方数据库。

### 2.2 系统架构

```text
客户端 / 浏览器 / Shell / NAS / 路由器
                  |
             HTTPS + Basic Auth
                  |
           Cloudflare Workers
                  |
       +----------+-----------+
       |          |           |
   Web Console   API       Auth
       |          |           |
       +----------+-----------+
                  |
             D1 Binding
                  |
          Cloudflare D1
                  |
       +----------+-----------+
       |          |           |
     配置       白名单       IP记录
```

## 3. HTTP API 规范

### 3.1 通用约定

API 不使用版本前缀。

所有接口必须经过 HTTP Basic Auth 认证，包括根路径。

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/` | Web 操作控制台 |
| POST | `/register` | 注册或刷新主机 IP |
| GET | `/resolve` | 查询指定主机 IP |
| GET | `/records` | 查询全部有效 IP 记录 |

所有查询参数使用 Query String 传递。

两个查询接口支持 `output` 参数：

- `txt`：默认值，返回极简纯文本。
- `json`：返回结构化 JSON。

注册接口固定返回 JSON。

响应统一使用 UTF-8，所有动态接口设置 `Cache-Control: no-store`。

### 3.2 POST /register

**用途：** 注册或刷新主机 IP。

请求示例：

```http
POST /register?hostname=home-nas
Authorization: Basic <credentials>
```

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| hostname | 是 | 要注册的主机名 |

处理流程：

1. 验证 HTTP Basic Auth。
2. 校验 hostname 格式并进行规范化。
3. 检查系统是否允许注册。
4. 检查 hostname 是否在启用的白名单中。
5. 检查当前用户是否具有该主机名的注册权限。
6. 获取客户端来源公网 IP。
7. 自动识别 IPv4 或 IPv6。
8. 根据 `(hostname, ip_version)` 执行 UPSERT。
9. 保存 IP、更新时间及过期时间。
10. 返回注册结果。

响应示例：

```json
{
  "hostname": "home-nas",
  "type": "v4",
  "ip": "203.0.113.10",
  "expires_at": "2026-10-21T03:00:00Z"
}
```

注册规则：

- 不接受客户端指定 IP。
- 通过 Cloudflare 提供的 `CF-Connecting-IP` 获取来源地址。
- 同一个主机名最多维护一个 IPv4 和一个 IPv6 映射。
- 重复注册相同类型的地址时覆盖旧 IP 并刷新 TTL。
- 即使 IP 未变化，也刷新过期时间。
- 通过 IPv4 连接时注册 IPv4，通过 IPv6 连接时注册 IPv6。
- 注册接口不需要 Request Body。

### 3.3 GET /resolve

**用途：** 查询指定主机名对应的 IPv4 或 IPv6。

请求示例：

```http
GET /resolve?hostname=home-nas&type=v4
```

参数：

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| hostname | 是 | 无 | 主机名 |
| type | 是 | 无 | v4 / v6 |
| output | 否 | txt | txt / json |

默认 TXT 输出：

```text
203.0.113.10
```

指定 JSON：

```http
GET /resolve?hostname=home-nas&type=v4&output=json
```

响应：

```json
{
  "hostname": "home-nas",
  "type": "v4",
  "ip": "203.0.113.10",
  "expires_at": "2026-10-21T03:00:00Z"
}
```

规则：

- 仅返回尚未过期的记录。
- 主机名不存在、记录不存在或记录已过期，返回 HTTP 404。
- TXT 仅输出 IP 地址，末尾包含一个换行符。
- TXT 不输出其他说明或字段。

### 3.4 GET /records

**用途：** 查询全部有效 IP 映射。

请求示例：

```http
GET /records?type=all
```

参数：

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| type | 否 | all | v4 / v6 / all |
| output | 否 | txt | txt / json |

默认 TXT 输出：

```text
home-nas 203.0.113.10
home-nas 2001:db8::10
server-01 198.51.100.20
```

每行格式：

```text
hostname ip
```

字段之间使用一个空格，每条记录使用 `\n` 换行。

指定 JSON：

```http
GET /records?type=all&output=json
```

响应：

```json
{
  "records": [
    {
      "hostname": "home-nas",
      "type": "v4",
      "ip": "203.0.113.10",
      "expires_at": "2026-10-21T03:00:00Z"
    },
    {
      "hostname": "home-nas",
      "type": "v6",
      "ip": "2001:db8::10",
      "expires_at": "2026-10-21T03:00:00Z"
    },
    {
      "hostname": "server-01",
      "type": "v4",
      "ip": "198.51.100.20",
      "expires_at": "2026-10-21T04:00:00Z"
    }
  ]
}
```

规则：

- 仅返回未过期记录。
- `type=all` 返回 IPv4 和 IPv6。
- `type=v4` 仅返回 IPv4。
- `type=v6` 仅返回 IPv6。
- 按 `hostname ASC, ip_version ASC` 排序。
- 无有效记录时，JSON 返回 `{"records":[]}`，TXT 返回空 Body。
- JSON 必须包含每条记录的 `expires_at`。

### 3.5 HTTP 错误处理

| 场景 | HTTP 状态 |
|---|---|
| 请求成功 | 200 |
| 参数无效或缺失 | 400 |
| 未认证或认证失败 | 401 |
| 已认证但无操作权限 | 403 |
| 主机记录不存在或已过期 | 404 |
| 请求方法不支持 | 405 |
| 服务端异常 | 500 |

JSON 格式错误响应：

```json
{
  "error": "record_not_found",
  "message": "Host IP record not found"
}
```

TXT 格式发生错误时，仅通过 HTTP 状态码表达失败，Body 为空，避免脚本将错误文本误认为 IP 地址。

认证失败应返回 `WWW-Authenticate` 响应头。

## 4. Web 控制台

### 4.1 访问入口

```http
GET /
```

返回一个静态 HTML 页面。

页面通过原生 JavaScript `fetch()` 调用同域名 API。

不使用 React、Vue 等前端框架。

### 4.2 页面功能

页面提供三个独立操作区域，可以使用 Tab 或卡片切换。

**主机注册**

- hostname 文本输入框。
- 注册按钮。
- 调用 `POST /register?hostname=...`。
- 显示 HTTP 状态码及返回 JSON。

**主机 IP 查询**

- hostname 文本输入框。
- IP 类型选择框：IPv4 / IPv6。
- 输出格式选择框：TXT / JSON。
- 查询按钮。
- 显示查询结果。

**全部 IP 记录**

- IP 类型选择框：All / IPv4 / IPv6。
- 输出格式选择框：TXT / JSON。
- 查询按钮。
- 显示全部有效记录。

### 4.3 页面交互要求

1. 页面简洁，支持桌面和移动端。
2. 使用原生 HTML 表单元素。
3. 提供请求 URL 和 HTTP Method 预览。
4. 点击执行后直接发起真实 HTTP 请求。
5. 显示 HTTP 状态码、响应耗时和响应 Body。
6. JSON 自动格式化缩进。
7. TXT 保持原始格式。
8. 支持复制请求指令及响应结果。
9. 显示加载状态和错误提示。
10. 不在页面中保存认证密码。

Web 控制台与 API 使用相同域名，避免 CORS 配置。

根页面及其静态资源也必须经过 Basic Auth，不能因静态资源优先路由而绕过认证。

### 4.4 管理功能范围

Web 控制台仅负责注册和查询操作。

不提供以下管理功能：

- 创建或删除用户。
- 修改用户密码。
- 修改系统配置。
- 修改主机白名单。
- 直接编辑数据库记录。

这些操作统一通过 Cloudflare D1 Dashboard SQL Console 完成。

## 5. 数据库设计

使用 Cloudflare D1。

建议建立五张表。

### 5.1 system_config

系统全局配置。

| 字段 | 类型 | 说明 |
|---|---|---|
| key | TEXT PRIMARY KEY | 配置名称 |
| value | TEXT NOT NULL | 配置值 |

初始配置：

| key | 默认值 |
|---|---|
| record_ttl_seconds | 3600 |
| registration_enabled | true |
| query_enabled | true |
| max_records_per_response | 1000 |

配置通过数据库修改，在后续请求中生效。

`record_ttl_seconds` 控制所有 IP 记录的有效期。

### 5.2 auth_users

HTTP Basic Auth 用户。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PRIMARY KEY | 用户 ID |
| username | TEXT UNIQUE | 用户名 |
| password_hash | TEXT | 密码哈希 |
| enabled | INTEGER | 是否启用 |
| created_at | INTEGER | 创建时间 |

密码不能明文存储。

建议采用 PBKDF2-SHA256，使用独立随机盐和足够的迭代次数。

哈希格式需要包含算法版本、迭代次数和盐，以便后续升级。

### 5.3 hostname_whitelist

允许注册的主机名。

| 字段 | 类型 | 说明 |
|---|---|---|
| hostname | TEXT PRIMARY KEY | 主机名 |
| enabled | INTEGER | 是否启用 |
| allow_ipv4 | INTEGER | 是否允许 IPv4 |
| allow_ipv6 | INTEGER | 是否允许 IPv6 |

主机名采用精确匹配。

统一转为小写，限制合法字符及长度。

### 5.4 user_host_permissions

用户与主机名的注册权限。

| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | INTEGER | 用户 ID |
| hostname | TEXT | 主机名 |

联合主键：

```sql
PRIMARY KEY (user_id, hostname)
```

用于限制不同客户端可以注册的主机。

建议所有认证用户默认具有查询权限，但仅能注册被授权的主机名。

### 5.5 host_records

保存 IP 映射。

| 字段 | 类型 | 说明 |
|---|---|---|
| hostname | TEXT | 主机名 |
| ip_version | INTEGER | 4 / 6 |
| ip_address | TEXT | IP 地址 |
| updated_at | INTEGER | 最近注册时间 |
| expires_at | INTEGER | 过期时间 |

联合主键：

```sql
PRIMARY KEY (hostname, ip_version)
```

时间字段采用 Unix Timestamp（秒）存储，API 输出转换为 ISO 8601 UTC 字符串。

建议建立 `expires_at` 索引，优化过期记录清理。

数据库应启用适当的外键约束。

## 6. IP 有效期与过期策略

使用逻辑过期机制。

注册时：

```text
expires_at = current_timestamp + record_ttl_seconds
```

查询时：

```sql
WHERE expires_at > current_timestamp
```

因此即使过期数据仍在数据库中，也不会通过 API 返回。

重复注册时，更新 IP 地址、`updated_at` 和 `expires_at`。

初期不要求配置 Cron Trigger。

可选增加定期清理任务：

```sql
DELETE FROM host_records
WHERE expires_at <= unixepoch();
```

如果白名单被禁用或删除，建议注册操作立即拒绝；查询接口是否继续返回该主机已有的未过期记录，建议统一按启用状态过滤，避免停用主机继续暴露。

## 7. 安全设计

### 7.1 认证

- 所有接口必须认证。
- 强制 HTTPS。
- 使用 HTTP Basic Auth。
- 用户凭据保存在 D1。
- 密码使用带盐的安全哈希。
- 禁止在日志中输出 Authorization Header。
- 不使用 Cookie、Session 或 JWT。

### 7.2 注册权限

- 注册主机名必须存在于白名单中。
- 用户只能注册具有权限的主机。
- IPv4 和 IPv6 注册权限受白名单配置限制。
- 禁止通过参数指定任意 IP。

### 7.3 来源 IP

优先使用 Cloudflare Workers 请求中的 `CF-Connecting-IP`。

只信任经过 Cloudflare 边缘处理的请求信息。

必须校验 IP 格式，支持标准 IPv4 和 IPv6。

客户端使用代理、VPN 或 NAT 时，记录的是 Cloudflare 观察到的公网出口 IP。

### 7.4 输入与数据库安全

- 所有 SQL 使用参数绑定。
- 禁止拼接用户输入生成 SQL。
- 校验 hostname、type、output。
- 限制输入长度。
- 统一处理异常。
- 限制全量查询最大记录数量。
- 不返回数据库内部错误或敏感配置。

### 7.5 缓存控制

所有 API 响应使用：

```http
Cache-Control: no-store
```

认证保护的页面也应禁用共享缓存。

## 8. 建议项目结构

```text
host-ip-registry/
├── src/
│   ├── index.ts
│   ├── auth.ts
│   ├── config.ts
│   ├── db.ts
│   ├── ip.ts
│   ├── response.ts
│   └── handlers/
│       ├── register.ts
│       ├── resolve.ts
│       └── records.ts
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── migrations/
│   └── 0001_init.sql
├── scripts/
│   └── generate-password-hash.mjs
├── test/
│   ├── auth.test.ts
│   ├── register.test.ts
│   ├── resolve.test.ts
│   └── records.test.ts
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── README.md
```

具体目录可以由 Codex 根据实际实现适当调整。

## 9. 测试与验收标准

至少覆盖以下场景。

### 认证

- 未认证请求返回 401。
- 错误密码返回 401。
- 禁用用户无法访问。
- 正确账号可以访问根页面及 API。

### 注册

- 白名单主机注册成功。
- 非白名单主机注册失败。
- 无权限用户不能注册其他主机。
- IPv4 和 IPv6 可以分别注册。
- 重复注册刷新过期时间。
- IP 变化时更新原记录。
- 无效 hostname 返回 400。
- 注册关闭时拒绝注册。

### 查询

- 正确查询 IPv4。
- 正确查询 IPv6。
- 已过期记录不可查询。
- 不存在的主机返回 404。
- 默认 TXT 格式正确。
- JSON 包含过期时间。
- records 支持 v4、v6、all。
- records 默认输出每行 `hostname ip`。
- 无有效记录时返回空结果。
- 非法参数返回 400。

### Web 控制台

- 根路径可以访问。
- 页面受到 Basic Auth 保护。
- 三种操作均可正常执行。
- 参数输入和选择正确。
- JSON/TXT 展示正确。
- 错误信息展示正确。
- 页面在移动端可用。

## 10. 部署要求

使用 Wrangler 完成开发与部署。

应提供：

1. 本地开发运行命令。
2. D1 数据库创建命令。
3. D1 Migration 执行命令。
4. 初始管理员账号创建流程。
5. 密码哈希生成工具。
6. 白名单配置 SQL 示例。
7. 用户权限配置 SQL 示例。
8. Worker 部署命令。
9. 自定义域名绑定说明。
10. curl 调用示例。

项目必须可以在 Cloudflare Free Plan 下部署和运行。

不得要求购买付费 Workers、D1 或其他 Cloudflare 服务。

## 11. 开发原则

- 优先使用 Cloudflare 原生能力。
- 保持代码简洁、模块化。
- 不引入不必要的第三方框架。
- 不增加额外基础设施。
- 所有业务配置保存在 D1。
- 不在代码中硬编码用户密码、主机白名单和 TTL。
- 保持 API 协议稳定。
- 提供清晰的 README。
- 对核心业务逻辑编写自动化测试。
- 先保证正确性和安全性，再考虑性能优化。

## 12. Codex 开发任务

请根据上述规格完成项目开发。

建议分阶段执行：

**阶段一：** 初始化 TypeScript Workers 项目、D1 数据库 Schema 和 Migration。

**阶段二：** 实现配置读取、HTTP Basic Auth、白名单及用户权限校验。

**阶段三：** 实现 register、resolve、records 三个 API。

**阶段四：** 实现根路径静态 Web 操作控制台。

**阶段五：** 编写自动化测试，覆盖认证、IP 注册、过期、查询和错误处理。

**阶段六：** 完善 README、初始化流程和 Cloudflare 部署配置。

开发过程中优先遵守本文档中的 API 参数、HTTP Method、默认值、JSON 字段和 TXT 格式，不要擅自更改对外协议。

对于未明确的实现细节，选择简单、安全、适合 Cloudflare 免费计划的方案，并在 README 中记录设计决策。
