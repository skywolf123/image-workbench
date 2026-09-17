# 网关与上游代理彻底解耦

上游项目的 `/api-proxy` 是"纯转发、前端自带 Key"的功能；本 fork 曾在其上注入后端 Key，改变了上游语义。现拆分：`/api-proxy` 回归纯转发（Authorization 原样透传，上游 401 如实到达前端），本 fork 的"后端出 Key"转发走独立的 `/api/gateway`，环境变量 `GATEWAY_API_URL` / `GATEWAY_API_KEY`（含 `_FILE` 形式）独立配置，不复用 `API_PROXY_URL` / `DEFAULT_API_KEY`。前端传输判定顺序：空 Key 且网关可用 → 网关；profile 开了上游代理 → `/api-proxy`；否则直连。

把网关判定放在上游代理之前是迁移兼容的决定：存量平台部署的预置配置是"空 Key + 代理锁开"，按相反顺序升级后这些请求会落到不再注入 Key 的 `/api-proxy` 上直接 401。

## Consequences

- `DEFAULT_API_KEY` 改名失效：检测到旧变量时启动 warning 指引改名，不做静默迁移（静默迁移等于静默改变计费主体）。
- 平台部署不再需要 `ENABLE_API_PROXY`，该开关与其锁定语义回归纯上游功能。
