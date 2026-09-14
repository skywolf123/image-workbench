# image-workbench 平台化改造方案

> 目标读者:在 `/root/projects/image-workbench` 工作的 Claude Code 会话
> 状态:**设计已定,代码未写**
> 日期:2026-09-14
> 前身:`/root/image-workbench-handoff/HANDOFF.md`(该文档有两处事实错误,见 §1,以本文为准)

---

## 0. 一句话

把 `88lin/gpt-image-studio` fork 成 `image-workbench`,加上两件上游没有的能力:

1. **平台级 API Key** —— key 由部署方持有,用户不可见、不可配
2. **自动备份到 NAS** —— 防止浏览器存储被驱逐导致数据丢失

**核心约束:对上游代码的入侵最小化。** 判断一个改动的唯一标准不是"写得漂不漂亮",而是"上游下次改这个文件时,我会不会撞车"。

---

## 1. ⚠️ 对前身文档的两处事实纠正

`HANDOFF.md` 有两处错误,已逐行核对代码确认。**以本节为准。**

### 错误一:上游隐藏的是 `apiUrl`,不是 `apiKey`

`HANDOFF.md` §2.9 称"把 API Key 走 inject 脚本注入 = 明文写进 bundle"。**这是错的。**

实测(`grep -rn "apiKey\|API_KEY\|Authorization" deploy/`)整个 `deploy/` 目录:

- **零个** `apiKey` / `Authorization` 相关字符串
- `deploy/nginx.conf` 只设 `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`,**没有** `proxy_set_header Authorization`
- `deploy/Dockerfile` 的 ENV 只有 `DEFAULT_API_URL` / `API_PROXY_URL`,无 key 相关

| 上游隐藏的 | 上游**从未**隐藏的 |
|---|---|
| `baseUrl`(上游地址) | **`apiKey`** |

上游的 `ENABLE_API_PROXY=true` + `LOCK_API_PROXY=true` 让前端请求同源 `/api-proxy/*`,nginx 转发到 `API_PROXY_URL`——**只藏了 URL**。`Authorization: Bearer <key>` 依然由浏览器发出(`openaiCompatibleImageApi.ts:91`、`agentApi.ts:105` 无条件构造),key 依然由用户在前端填写、存在 localStorage。

**推论:隐藏 key 没有现成机制可复用,必须新增服务端进程。**

### 错误二:`deploy/inject-api-url.sh` 不能删

`HANDOFF.md` 及后续讨论中曾提出"Node 接管后可删掉 inject 脚本"。**这是错的**,该脚本与 key 无关,它是**上游隐藏 apiUrl 的核心机制**(`DEFAULT_API_URL` → base64 → sed 进 `assets/*.js`)。

**保留它。** 隐藏 apiUrl 的实现方式维持上游原样。

### 其他被纠正的认知

| 曾经的误解 | 实际情况 |
|---|---|
| 备份需要给 `images` store 加 createdAt 索引 | **不需要**。`getAllImageIds()` 已是轻量接口,manifest 比对只需要 id;上传时用 `getImage(id)` 逐张读,天然避开 `getAllImages()` 的全量载入问题 |
| R1 的前端改造有 6 处(handoff §2.7) | **实际只有 3 处**。其余 11 个设置区块已被上游锁定机制覆盖,见 §5.2 |
| 平台配置需 `/api/config` 运行期下发 | **不必须**。沿用上游预置配置 JSON 机制即可,前端零改动。`/api/config` 是可选的后续增强 |

---

## 2. 需求

| # | 需求 | 优先级 |
|---|---|---|
| R1 | API Key 平台级,用户不可见、不可配;baseUrl / model 同样不可配 | 核心 |
| R2 | 自动备份图片、任务、设置到 NAS | 核心 |
| R3 | 浏览器存储被驱逐后能同步回来 | 核心 |
| R4 | 成员区分,短码即可,不需要用户名密码 | 次要 |
| R5 | 多设备共享"有更好,非目标" | 可选 |

**关键约束**:用户真实经历过一次浏览器驱逐导致数据丢失,R2/R3 是真实痛点。

---

## 3. 上游事实(已在代码中核对)

### 3.1 存储架构:完全没有后端

服务端只做静态托管 + 可选 nginx 转发,**不存任何数据**。

**IndexedDB** —— 库名 `gpt-image-playground`,版本 3(`src/lib/db.ts`):

| Object store | 内容 | keyPath |
|---|---|---|
| `tasks` | 生成任务 | `id` |
| `images` | 原图(dataUrl 字符串) | `id` |
| `thumbnails` | webp 缩略图 | `id` |
| `agentConversations` | Agent 会话 | `id` |

**localStorage** —— zustand persist,`name: 'gpt-image-playground'`(`src/store.ts:974`)。持久化字段见 `src/lib/persistedState.ts:20-29`。

### 3.2 图片标识 = 内容哈希(备份方案能极简的根本原因)

`src/lib/db.ts` 的 `hashDataUrl()`:对 dataUrl 做 **SHA-256**,hex 作为 `StoredImage.id`。`crypto.subtle` 不可用时退化为 FNV-1a 双哈希(前缀 `fallback-`)。

**推论**:id 由内容唯一决定 → 同 id 即同内容,无需传输;内容变则 id 变 → **不存在"两边都改了"**。同步系统里 80% 的复杂度(冲突解决)在这里直接消失。

### 3.3 代理机制的接入点(前端已完整,只需换实现者)

所有 OpenAI 兼容请求(image + agent)汇聚到 `src/lib/devProxy.ts` 的两个函数:

```ts
buildApiUrl()        // :59  —— useApiProxy 时返回 `${prefix}/${endpointPath}`,不拼 baseUrl
shouldUseApiProxy()  // :104 —— 由 VITE_API_PROXY_AVAILABLE / VITE_API_PROXY_LOCKED 驱动
```

`isApiProxyLocked()` 已存在;`SettingsModal.tsx:238` 的 `apiProxyChecked` 已是 `apiProxyLocked || profile.apiProxy`。

**关键推论**:

> **谁接住 `/api-proxy/*` 是部署细节,前端代码一个字都不用改。**
> nginx 接 → 现状。Node 接 → 前端看到的路径、环境变量、锁定行为完全一致。

`src/lib/apiProfiles.ts:869` 的 `validateApiProfile` 也认这条路:`!profile.baseUrl.trim() && !shouldUseApiProxy(profile.apiProxy)` → 代理开启时不要求 baseUrl。

### 3.4 上游已有的锁定机制(可复用,覆盖 11 个设置区块)

`src/lib/presetConfig.ts`,三个由环境变量驱动的开关:

| 开关 | 作用 |
|---|---|
| `VITE_SHOW_PRESET_CONFIG_ONLY` | 只允许用预置配置,禁止增删改切换供应商 |
| `VITE_LOCK_PRESET_CONFIG_PARAMS` | 锁定预置配置除 apiKey 外的参数 |
| `VITE_PREVENT_PRESET_CONFIG_DELETION` | 禁止删除预置配置 |

**唯一缺口**:`enforcePresetConfigPolicy()` 里恒有 `apiKey: profile.apiKey` —— 上游**明确设计**为"API Key 始终可编辑"。这正是 R1 要打的补丁。

### 3.5 认证头构造点(仅两处)

- `src/lib/openaiCompatibleImageApi.ts:91` — `createRequestHeaders()`
- `src/lib/agentApi.ts:105` — `createHeaders()`

均无条件是 `Authorization: Bearer ${profile.apiKey}`。

### 3.6 apiKey 参与的其他逻辑(改 R1 时须一并检查)

| 位置 | 用途 |
|---|---|
| `apiProfiles.ts:928` | `getApiProfileDedupKey()` 把 apiKey 纳入 profile 身份指纹 |
| `apiProfiles.ts:940` | `getApiProfileConnectionKey()` 同类 |
| `store.ts:1033` | `getCodexCliPromptKey()` = `${baseUrl}\n${apiKey}` |
| `store.ts:1154` | `createSettingsForApiProfile()` 把 profile.apiKey 提升到顶层 settings |
| `store.ts:554-569` | `setSettings` 的 legacy override 合并路径 |

key 恒空后这些可能误判(如所有 profile 指纹相同)。**改完跑 `pnpm test`**,`apiProfiles.test.ts` 有 66KB,能抓出这类回归。

### 3.7 任务恢复的坑

`TaskRecord`(`src/types.ts:176-248`)含运行期字段:`falRequestId`、`falEndpoint`、`falRecoverable`、`customTaskId`、`customRecoverable`、`status`、`streamPartialImageIds`、`rawResponsePayload`。

从备份恢复的任务若 `status === 'running'`,这些字段已失效 → **必须标记为已中断**,否则 UI 显示永远转圈的僵尸任务。`store.ts` 已有 `createTaskErrorPatch` 可复用。

### 3.8 其他已确认事实

- **无 `navigator.storage.persist()` 调用** —— IndexedDB 是 best-effort,浏览器可自由驱逐
- PWA 资源齐全:`public/manifest.webmanifest`(display: standalone)、`public/sw.js`(仅 `import.meta.env.PROD` 注册,`src/main.tsx:13`)
- 本机**未安装 docker**;NAS 为 Unraid,x86_64
- 上游 CI:`.github/workflows/docker.yml` 在 `v*` tag 或 `workflow_dispatch` 时构建多架构镜像推 `ghcr.io/<owner>/gpt-image-studio`。**ghcr 包默认 private**

---

## 4. git remote 结构

```
origin         → github.com/skywolf123/image-workbench    (自己的 fork,日常 push)
upstream       → github.com/88lin/gpt-image-studio        (日常同步来源,54 个自有提交)
root-upstream  → github.com/CookSleep/gpt_image_playground (原始项目,溯源用)
```

依赖链已验证:`root-upstream/main ⊂ upstream/main ⊂ main`。

**`root-upstream` 相对 `upstream` 有 0 个独有提交** —— 日常同步**只需 merge `upstream/main`**,它已包含两层全部更新。

```bash
git fetch upstream
git merge upstream/main
git push origin main
```

⚠️ `deploy/`、`presetConfig.ts`、`DEFAULT_API_URL` 全部来自 **88lin 的 54 个提交**,CookSleep 里没有。**要紧盯的是 `upstream`。**

---

## 5. 架构决策

### D1. 双模式共存:同一份 `dist/`,运行期决定

保留上游纯前端能力,平台模式是**叠加**而非**替换**:

| 部署方式 | Key 隐藏 | 备份 | 说明 |
|---|---|---|---|
| 纯静态(Pages/Vercel/CF) | ❌ | ❌ | 上游现状,一行不改 |
| 静态 + nginx(上游方式) | ❌ | ❌ | 隐藏 apiUrl,非 key |
| **Node(仅备份)** | ❌ | ✅ | key 仍由用户填 |
| **Node(全量)** | ✅ | ✅ | 目标形态 |

**硬约束:平台模式不得依赖任何 `VITE_*` 构建期变量。** 一旦依赖就要单独 build,"一次构建到处部署"即失效。

### D2. Node 接管 `/api-proxy/*`(方案 N)

Key 必须注入在**带代理路由的那次请求**上。若 nginx 接 `/api-proxy/*`,Node 不在请求路径上,无法注入 key。

| | **方案 N(采用)** | 方案 X |
|---|---|---|
| key 注入位置 | Node 读 `PLATFORM_API_KEY` | nginx 2 行 `proxy_set_header` |
| 进程数 | **1 个** | 2 个(nginx + Node) |
| 前端改动 | 0 | 0 |
| nginx | 去掉 | 保留 |

**选 N 的理由不是"Node 更好",而是 Node 反正必须存在(备份用它)** —— 让它顺手接住代理是**少一个组件**。方案 X 技术可行(key 同样不进 bundle),但要跑两个容器,每加功能多一层配置同步。

前端隐藏 apiUrl 的**实现方式完全不变**(`devProxy.ts` 两个字面不改),只是换了个进程兑现 `/api-proxy/*`。

### D3. 平台配置沿用上游预置 JSON 机制

baseUrl / model 继续走 `DEFAULT_API_URL` → 挂载 JSON / 内嵌配置,**前端零改动**。其中不含 key —— key 只在 Node 的环境变量里。

`/api/config` 运行期下发是**可选的后续增强**,不影响任何已有代码,可随时后补。

### D4. Key 不进备份

备份范畴 = 用户数据(图片、任务、收藏、UI 偏好)。平台配置 = 部署数据,由服务端下发。

**红利**:两边字段不重叠 → 恢复时不需要字段级 merge,规则简化为「平台配置永远以服务端为准」。同时 `apiKey` 在 localStorage 是明文,**不进备份 = token 泄漏 ≠ key 泄漏**。

### D5. 备份服务 = 哑巴 blob 仓库

不做业务逻辑:不解析任务、不理解 prompt、无用户系统、无事务。三个概念:列举、按 id 存取 blob、整份状态快照。

### D6. 服务端 append-only,永不自动删除

本地删了图,服务器保留。**"删除传播"这个最难的同步问题被直接砍掉。** 代价是空间只增不减(v1 接受)。

### D7. 两条通道,不统一处理

| | 图片 | 任务 / 设置 |
|---|---|---|
| 位置 | IndexedDB | tasks 在 IDB;settings 在 localStorage |
| 体积 | 每张几 MB | 合计几 MB~几十 MB |
| 是否变化 | **不变** | 任务变状态;设置一直变 |
| 同步单位 | 按 id 逐个 blob | **整份快照** |
| 恢复规则 | 按 id **填缺,永不覆盖** | 单文档,**时间戳版本** |

### D8. 恢复语义 = 只补缺失

因 id 由内容决定,"填缺"天然幂等,**重复恢复完全无害**。驱逐场景下本地为空,填缺即全量恢复。

### D9. 成员码 = 命名空间,不是凭证

key 不在备份里 → 成员码职责只是"谁的图存哪"。**无用户名密码、无密码哈希、无 session**,服务端仅一个字符串比较。

安全边界:猜到成员码仍可**读取该成员图片、向其写入**。局域网友好,建议 8~12 位随机,勿用 `1234`。

**v1 采用预置白名单**(NAS 上 `members.json`),仅接受名单内成员码。

### D10. 服务端 Node 实现

理由:与仓库现有 `scripts/mock-image-api.mjs` 技术栈一致、同仓库同一次 fork、不引入第二种工具链、Unraid 部署简单。

### D11. v1 只支持同步 OpenAI 兼容上游

`isProfileApiProxyEligible()`(`SettingsModal.tsx:150`)对**异步供应商**(sub2api / 有 poll 配置的)返回 `false`。平台模式恒锁定代理 → **异步上游的代理路径走不通**,需单独设计。v1 明确不支持。

---

## 6. 分阶段实施

每个阶段都有**可独立验证的检查点**。

### 阶段 0 —— `navigator.storage.persist()`(约 5 行)

与后续完全正交,**可立刻做、立刻验证**。

位置:`src/main.tsx`,在 `import.meta.env.PROD` 分支内、注册 service worker 附近。

```ts
if (navigator.storage?.persist) {
  void navigator.storage.persist().then((granted) => {
    if (!granted) console.warn('[storage] 持久化存储未获授权,数据仍可能被浏览器驱逐')
  })
}
```

⚠️ 这是**缓解不是替代**:浏览器可拒绝,静默驱逐威胁不消失,只是概率降低。

> **不碰上游文件**:`main.tsx` 改动约 5 行。

### 阶段 1 —— Node 服务骨架 + key 注入(对应 R1)

**前端一行不改。**

新增 `server/index.mjs`(零依赖,复用仓库 Node 脚本风格):

| 端点 | 作用 |
|---|---|
| `GET /*` | 静态托管 `dist/` + SPA fallback |
| `POST /api/proxy/*` | 转发到 `PLATFORM_API_URL`,**覆盖 `Authorization` 头** |
| `/api/backup/*` | 阶段 3 填充 |

**环境变量**:

| 变量 | 说明 |
|---|---|
| `PLATFORM_API_URL` | 上游 API 地址 |
| `PLATFORM_API_KEY` | **平台 Key,只存在服务端** |
| `PLATFORM_API_KEY_FILE` | 从文件读 key(避免 `docker inspect` 泄漏) |
| `PORT` | 默认 3000 |
| `DATA_DIR` | 默认 `/data`(阶段 3 用) |

**部署配置**(前端侧,零代码改动):

```
VITE_API_PROXY_AVAILABLE=true
VITE_API_PROXY_LOCKED=true
VITE_LOCK_PRESET_CONFIG_PARAMS=true
VITE_SHOW_PRESET_CONFIG_ONLY=true
VITE_PREVENT_PRESET_CONFIG_DELETION=true
```

**`deploy/Dockerfile` 改动**:runtime 阶段 `nginx:alpine` → `node:20-alpine`,COPY `dist/` + `server/`。build 阶段的 `VITE_*` 占位符保留(apiUrl 仍走注入)。

**保留不动**:`deploy/inject-api-url.sh`、`deploy/nginx.conf`(后者不再被容器使用,但作为纯静态部署方案保留)、`src/lib/devProxy.ts` 全部。

**验证**:
1. 打开页面,**不填任何配置能直接生成图** ← R1 达成
2. F12 搜 bundle,确认 key 不存在 ← 真隐藏
3. `curl -X POST https://nas:3000/api/proxy/v1/images/generations` 无 Authorization 也能通

> **碰上游文件:0 处。**

### 阶段 2 —— 平台模式前端补齐

**只补 3 个缺口**,其余靠上游锁定机制。

#### 2.1 `src/lib/apiProfiles.ts:870` —— 必改

```ts
if (!profile.apiKey.trim()) return '缺少 API Key'
```

不改则每次点生成弹"请先完善请求 API 配置:缺少 API Key"(`store.ts:1626` 调用)。

#### 2.2 `src/components/SettingsModal.tsx:294` —— 必改(仅 Agent 模式受影响)

```ts
if (!profile.apiKey.trim()) return false
```

平台模式下 key 恒空 → 所有 profile 被过滤 → **Agent 模式不可用**。

#### 2.3 `src/components/SettingsModal.tsx:1504-1540` —— 隐藏 API Key 区块

**唯一的实质性界面改动。** 上游此处注释明确写"API Key 始终可编辑"。

**建议整块移除**(而非置灰):平台模式的意图就是"用户不需要知道 key 存在"。

移除后,区块底部的 `?apiKey=` 查询参数提示(`:1538`)一并消失。

#### 2.4 实现方式:扩展上游开关,不另起体系

不引入并行的 `platformMode` 概念体系 —— 那会和 `presetConfig` 竞争。而是在上游已有机制上**加一个开关**:

```ts
// src/lib/presetConfig.ts
const PLATFORM_MODE = readRuntimeEnv(import.meta.env.VITE_PLATFORM_MODE) === 'true'
```

让 `isPresetConfigOnlyEnabled()` 等函数把它当成"更强的锁定"处理。**单一出口**,其余代码只读函数。

⚠️ 这里 `VITE_PLATFORM_MODE` 是**用于 UI 形态**的,不涉及平台配置本身的数据。平台配置仍走运行期/预置 JSON,不违反 D1 的硬约束。

#### 2.5 ⚠️ 须一并检查的隐藏依赖

见 §3.6 —— `getApiProfileDedupKey`、`getApiProfileConnectionKey`、`getCodexCliPromptKey`、`createSettingsForApiProfile`、`setSettings` legacy override 路径。

**改完必须跑 `pnpm test`。**

#### 2.6 设置页最终形态

| # | 区块 | 平台模式 | 负责方 |
|---|---|---|---|
| 1 | 配置名称 | 锁定 | 上游 `LOCK_PRESET_CONFIG_PARAMS` |
| 2 | 服务商类型 | 锁定 | 上游 `SHOW_PRESET_CONFIG_ONLY` |
| 3 | API URL | 显示空值/占位 | 上游代理 |
| 4 | API 代理 | 锁定开启 | 上游 `LOCK_API_PROXY` |
| **5** | **API Key** | **不渲染** | ⚠️ **本方案改动** |
| 6 | API 接口 | 锁定 | 上游 |
| 7 | 模型 ID | 锁定 | 上游 |
| 8-12 | 流式/透明背景/Codex/超时 | 锁定 | 上游 |

**11 个区块零改动。**

可选:顶部加一句"本平台 API 配置由管理员统一管理"(新增渲染,最少行数)。

> **碰上游文件:2 个文件、3 处。**

### 阶段 3 —— 备份(对应 R2/R3)

#### 3.1 协议

```
GET  /api/backup/manifest        → {images:[id...], state:{version, updatedAt}}
HEAD /api/backup/images/:id      → 404 = 不存在(廉价存在性检查)
GET  /api/backup/images/:id
PUT  /api/backup/images/:id      → body: 原始字节
GET  /api/backup/state
PUT  /api/backup/state           → 服务端自增 version,If-Match 防覆盖
```

**成员标识**:`X-Member-Id` 请求头,服务端当目录名。**无用户表、无 session、无密码哈希**,字符串比较(hash 后比较,避免时序泄漏)。

**磁盘布局**:

```
/data/
  members.json              # 白名单
  <member>/
    images/ab/<sha256>      # 按 hash 前两位分目录
    state.json
    meta.json               # {version, updatedAt}
```

**实现要点**:
- `state.json` 用**写临时文件 + rename** 保证原子性
- 存**解码后的原始字节**(客户端 base64 解一次再传),比浏览器省约 1/3
- 单进程,**无并发控制**

#### 3.2 备份范围

| 数据 | 位置 | 备份 | 备注 |
|---|---|---|---|
| 原图 | IDB `images` | ✅ | 核心 |
| 缩略图 | IDB `thumbnails` | ❌ | 可本地重建,白占带宽 |
| 任务 | IDB `tasks` | ✅ | |
| Agent 会话 | IDB `agentConversations` | ✅ | 不带会断链 |
| settings / params / favoriteCollections / dismissed* | localStorage | ✅ **需剥离** | |
| `apiKey` / `baseUrl` / `model` | settings 内 | ❌ **必须剥离** | 平台级 |
| `codexCli` | settings 内 | ❌ 建议剥离 | 平台能力开关 |
| `profiles[].apiKey` / `profiles[].baseUrl` | settings 内 | ❌ **必须剥离** | ⚠️ 见下 |

⚠️ **平台配置同时存在于两处**:顶层 `settings.apiKey` **和** `settings.profiles[].apiKey`。剥离时必须**两处都处理**,否则 key 从 profiles 数组漏进备份。

#### 3.3 恢复时的三项清理

1. **僵尸任务**:`status === 'running'` 的,标记为已中断(复用 `createTaskErrorPatch`)
2. **孤儿引用**:任务/收藏引用了未上传成功的图片 id → 一致性扫描
3. **版本迁移**:下载的 state 可能来自旧版本 → 走 `normalizePersistedState` / `normalizeSettings` 归一化,别直接塞进 store

#### 3.4 自动上传的挂载点

`storeImageWithSize` 有 8 个调用点(`store.ts` 多处 + `MaskEditorModal.tsx:787`)。**不要逐点加** —— 在 `db.ts` 的 `storeImageWithSize` 内部注册 `onImageStored` 回调,由 `backupSync.ts` 注册。一处覆盖全部路径。

`db.ts` 是低变动文件,适合承载这一行。

#### 3.5 新增文件

```
server/index.mjs                                # 阶段 1 建立,阶段 3 扩展
src/lib/backupSync.ts                           # 同步客户端
src/lib/backupSanitize.ts                       # 剥离平台字段 + 恢复前清理
src/components/settings/BackupSettingsTab.tsx   # 设置面板(独立标签页)
```

**新增独立标签页,不往 `GeneralSettingsTab.tsx` 里塞** —— 前者是纯新增文件,上游永不动;后者是上游常改文件。代价是 `SettingsModal.tsx` 里注册标签的**一行**。

> **碰上游文件:1 处(`db.ts` 一行回调注册)+ 标签注册一行。**

---

## 7. 改动清单汇总

### 碰上游文件(全部)

| 文件 | 位置 | 阶段 | 规模 |
|---|---|---|---|
| `src/main.tsx` | service worker 附近 | 0 | ~5 行 |
| `src/lib/apiProfiles.ts` | `:870` `validateApiProfile` | 2 | ~1 行 |
| `src/components/SettingsModal.tsx` | `:294` `agentProfiles` 过滤 | 2 | ~1 行 |
| `src/components/SettingsModal.tsx` | `:1504-1540` API Key 区块 | 2 | ~35 行(移除/条件渲染) |
| `src/components/SettingsModal.tsx` | 标签页注册 | 3 | ~1 行 |
| `src/lib/db.ts` | `storeImageWithSize` 内回调 | 3 | ~2 行 |
| `src/lib/presetConfig.ts` | 加 `PLATFORM_MODE` 单一出口 | 2 | ~5 行 |

**合计约 50 行。** 其余全是新增文件。

### 新增文件

```
server/index.mjs
src/lib/backupSync.ts
src/lib/backupSanitize.ts
src/components/settings/BackupSettingsTab.tsx
```

### 部署层

| 文件 | 改动 |
|---|---|
| `deploy/Dockerfile` | runtime 阶段 nginx → node |
| `deploy/inject-api-url.sh` | **保留不动** |
| `deploy/nginx.conf` | 保留(容器不再用,作为纯静态方案存档) |
| `package.json` | name → `image-workbench`,加 `start` 脚本 |

### 明确不做

- ❌ 删 `inject-api-url.sh`
- ❌ 改 `src/lib/devProxy.ts`
- ❌ 引入并行于 `presetConfig` 的平台模式体系
- ❌ 双向删除、增量日志、压缩、多用户体系、实时多端一致性

---

## 8. 风险与注意

### 8.1 ⚠️ 同源冲突

IndexedDB 与 localStorage **按 origin 隔离,不按路径**。fork 版与上游版部署在**同一 `host:port`**(哪怕不同路径)会共用 DB 名 `gpt-image-playground` 和同一 localStorage key,**直接互相污染**。

**必须分端口或分主机名。** 建议顺手把 DB 名也改为 `image-workbench`(需写迁移),或至少保证端口不同。

### 8.2 双模式维护成本

日常只跑 Node 全量模式,**用户模式这条路会腐烂**。上游改 `SettingsModal` 时可能没注意破坏它。

**缓解**:本地 `pnpm dev` 天然是用户模式(无 Node 服务),开发时被动覆盖;偶尔 `pnpm build && npx serve dist` 扫一眼。

### 8.3 阶段 3 工作量被低估

服务端约 200 行,**前端(同步管理器 + 设置面板 + 状态展示 + 错误重试)是 400~600 行**。

> 简单的是服务端,**难的是前端接入和恢复正确性**。

### 8.4 nginx 警告仍然适用

若日后仍用 nginx 代理,README 已警告:开启代理后任何人都能拿服务器当代理打上游。建议仅在有访问控制(IP 白名单)或本地网络中使用。Node 版同样适用。

---

## 9. 待决问题

| # | 问题 | 当前倾向 |
|---|---|---|
| 1 | API Key 区块:整块移除 vs 置灰+文案 | **移除** |
| 2 | 设置页顶部是否加"由管理员统一管理"说明 | 倾向加,用最少行数实现 |
| 3 | 成员码白名单的初始内容 | 待定 |
| 4 | 是否引入 `/api/config` 运行期下发 | v1 不做,可后补 |
| 5 | DB 名是否改为 `image-workbench` | 倾向改(需迁移) |

---

## 10. 实施顺序

1. **阶段 0** — `navigator.storage.persist()`,独立可验证
2. **阶段 1** — Node 服务 + `/api/proxy/*` key 注入,**前端零改动**,验证 key 真隐藏
3. **阶段 2** — 平台模式前端 3 处补齐,跑 `pnpm test`
4. **阶段 3** — 备份(工作量最大)

---

## 附:源码引用核对方法

本文档所有 `file:line` 均已核对 2026-09-14 的代码。若上游更新导致漂移,**用符号名搜索**(`validateApiProfile`、`hashDataUrl`、`buildApiUrl`、`shouldUseApiProxy`、`enforcePresetConfigPolicy`),不要依赖行号。
