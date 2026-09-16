<div align="center">

# 🖼️ Image Workbench

**可自部署的图片生成工作台**

图片与任务自动备份到你的服务器，浏览器存储被清空后一键取回。

</div>

<br>

> [!NOTE]
> 本项目是 [88lin/gpt-image-studio](https://github.com/88lin/gpt-image-studio) 的二次开发版本。
> 完整继承其全部功能，并在此基础上增加了**后端兜底配置**与**自动备份**两项能力。
> 同时也保留了纯静态部署（GitHub Pages / Vercel / Cloudflare）的完整能力，此时行为与原版一致。

---

## 🔗 项目谱系

本项目位于三层 fork 链的末端。以下按由近及远排列，说明每一层各自增加了什么。

### image-workbench（本项目）

在 `88lin/gpt-image-studio` 基础上，增加了**自部署服务端**与**自动备份**两件事：

- **自动备份到服务器**：图片、任务、收藏、Agent 会话在后台自动上传到同一容器内的备份服务。浏览器存储被清空后，填入成员码即可一键取回。
- **成员空间**：一个成员码对应服务器上的一个数据空间，同组成员共用一个码即可共享备份，不同成员之间互不干扰。
- **浏览器存储持久化申请**：主动向浏览器申请持久化存储权限，降低数据被自动清理的概率。
- **存储命名隔离**：IndexedDB 与 localStorage 改用本项目自己的名字，与原版即便部署在同一 `host:port` 也不会互相污染（旧数据会自动迁移）。
- **后端兜底配置**：部署方可在服务端持有 API Key 与上游地址，作为前端配置缺失时的兜底。前端配置优先，只有在用户没有配置、或部署方用开关关掉了前端配置入口时才启用。配合隐藏配置页与锁定 Key 两个开关，可让 Key 完全不出现在前端产物里。

### 88lin/gpt-image-studio（上一层）

在 `CookSleep/gpt_image_playground` 基础上做了面向国内使用者的增强：

- **593 个内置提示词模板**：聚合厚十方精选、prompts.kkkm.cn、GPT-Image-2 案例观摩馆与多个社区来源，支持按标题、描述、来源与标签检索。
- **Docker 部署方案**：提供 `Dockerfile`、Nginx 同源 `/api-proxy/` 转发、环境变量注入构建产物的整套方案。
- **预置配置机制**：`DEFAULT_API_URL` / `VITE_DEFAULT_API_URL` 支持三种填写方式，并配套锁定与防删除开关。

### CookSleep/gpt_image_playground（最上游）

本项目的原始起点，提供了整个应用的基础能力：

- 基于 OpenAI `gpt-image-2.5` 的图片生成与编辑（`Images API` 与 `Responses API`）
- 参考图与可视化遮罩编辑器
- Agent 多轮对话模式（含并发批量生成、分支与重新生成、可选 Web 搜索）
- 多配置与多供应商管理（OpenAI 兼容、sub2api 异步、fal.ai、自定义 HTTP 供应商）
- 全本地存储（IndexedDB），支持一键打包导出 ZIP

---

## ✨ 功能

### 新增能力

#### 🔐 后端兜底配置

部署方可以在服务端持有 API Key 与上游地址，作为前端配置缺失时的兜底。请求经同源 `/api-proxy/` 转发时，服务端补上前端没有提供的那部分。

**前端配置优先**：只要前端填了值就一律使用前端的——无论是用户在设置页填的，还是通过 `DEFAULT_API_URL` 预置进去的。后端只在空缺处兜底。

```bash
-e API_PROXY_URL=https://your-upstream.example.com/v1 \
-e DEFAULT_API_KEY=sk-xxxx
```

想让 Key 完全不出现在前端，用这两个开关关掉前端配置入口：

| 开关 | 作用 |
|---|---|
| `HIDE_API_SETTINGS=true` | 隐藏设置页的「API 配置」标签。Agent 配置里的配置选择会收窄到预置项，只剩一条时不可切换。 |
| `LOCK_PRESET_KEY=true` | 锁定预置配置的 API Key 字段，并清空本地已存的 Key，强制走后端。与上游的 `LOCK_PRESET_CONFIG_PARAMS` 恰好互补——那个锁除 Key 外的全部参数，这个只锁 Key。 |

- **Key 不进前端**：后端持有的 Key 只存在于 Node 进程的环境变量（或挂载文件）里，构建产物中搜不到
- **不覆盖上游语义**：上游预置配置的三种填写方式、变更传播、锁定与防删除开关全部原样保留，后端兜底只是另一条路
- **纯静态部署不受影响**：不部署 Node 服务时这套机制完全不参与，行为与上游一致

#### 💾 自动备份

图片生成后自动上传到同一容器内的备份服务，任务、收藏、Agent 会话以整份快照同步：

- **后台进行**，不阻塞继续生成
- **按内容哈希去重**，已备份的图片不会重复上传
- **服务器只增不删**，本地误删不会波及备份
- **状态快照原子写入**，进程被中断不会留下损坏文件

#### 🔄 一键同步

浏览器存储被清空后，填入成员码即可把数据取回：

- 同步语义是**用服务器数据替换本地**，本地未备份的内容会丢失（操作前有二次确认）
- 同步前会先把服务器上的图片全部下载到内存，全部成功后才清空本地——中途失败不会把本地清成半截状态
- 备份中运行中的任务会被标记为已中断，不会留下永远转圈的僵尸任务
- 备份中引用到不存在图片的记录会被自动清理

#### 👥 成员空间

成员码是服务器上的数据空间名字，不含认证语义：

- 首次打开时自动生成一个随机码，可自行修改后告诉同组成员
- 修改成员码时：服务器上已有该码则同步其数据，没有则新建并把本设备的内容备份过去
- 成员码不是凭证——后端持有的 Key 不在备份里，即便被猜到也只会看到该成员的图片

### 继承自上游的能力

<details>
<summary><b>展开查看完整功能列表</b></summary>

#### 🎨 图像生成与编辑
- **参考图与遮罩**：支持上传最多 16 张参考图（支持剪贴板和拖拽）。内置可视化遮罩编辑器，自动预处理以符合官方分辨率限制。
- **批量与迭代**：支持单次多图生成；一键将满意结果转为参考图，无缝开启下一轮修改。
- **流式生成预览**：`Images API` 与 `Responses API` 模式均支持流式接收中间步骤图像，缓解连接超时问题。
- **透明背景（API 原生 / 本地后处理双模式）**：画廊模式下选择 PNG 或 WebP 格式后可开启透明背景功能，每个 API 配置可独立选择实现方式。API 原生模式会直接请求模型返回透明通道；本地后处理模式则会要求模型使用纯绿色或纯洋红色背景，并在结果返回后于浏览器中去除背景色。

> [!NOTE]
> 本地后处理流程适用于图标、贴纸、单主体素材等场景；若主体边缘存在复杂发丝、半透明材质、强反光或与背景色接近的颜色，可能出现边缘残留或误抠。若使用 API 原生模式时接口返回"不支持透明背景"类错误，应用会提示切换为本地后处理。

#### 🧠 提示词模板库
- **593 内置精选模板**：聚合厚十方精选、prompts.kkkm.cn、GPT-Image-2 案例观摩馆与多个社区精选来源，覆盖电商图、海报、封面、产品图、摄影风格和视觉概念图等场景。
- **搜索与套用**：支持按标题、描述、来源和标签检索，一键填入输入框并继续二次编辑。
- **示例图辅助判断**：部分模板保留示例图，便于快速判断构图、画风和适用场景。

#### 🤖 Agent 多轮对话模式
- **多轮对话与上下文记忆**：基于 Responses API 的对话式生成，Agent 会理解上下文并按需调用图像工具；支持 `@` 引用参考图或前面轮次生成的图片。
- **并发批量生成**：内置 `generate_image_batch` 工具，让 Agent 在一次轮次中并发生成多张关联图像。
- **分支与重新生成**：编辑某轮消息重新发送或重新生成某轮消息会产生可切换的分支，引用解析严格限定在当前分支路径内。
- **画廊同步与隔离删除**：Agent 生成的图片会同步到画廊；删除对话默认保留画廊记录，删除画廊任务时也会自动清理对话中残留的图片引用。
- **可选 Web 搜索**：可开启 `web_search` 工具，Agent 会在需要时搜索网络信息并附带引用链接。

#### ⚙️ 精细化参数追踪
- **智能尺寸控制**：提供 1K/2K/4K 快速预设，自定义宽高时会自动规整至模型安全范围（16 的倍数、总像素校验等）。
- **实际参数对比**：自动提取 API 响应中真实生效的尺寸、质量、耗时以及**模型改写后的提示词**，与你的请求参数高亮对比。

#### 📁 高效历史管理
- **瀑布流与画廊**：历史任务自动保存，支持按状态过滤、全屏大图预览与快捷下载。
- **多收藏夹管理**：支持创建多个命名收藏夹，同一任务可归入多个收藏夹。支持拖拽排序、重命名、设置默认收藏夹，以及按收藏夹为单位批量打包下载 ZIP。
- **快捷批量操作**：桌面端支持鼠标拖拽框选、Ctrl/⌘ 连选，移动端支持顺滑侧滑多选。
- **纯本地存储**：所有记录与图片均存放在浏览器 IndexedDB 中（采用 SHA-256 去重压缩），支持一键打包导出 ZIP 备份。

#### 🔌 多配置与供应商增强
- **多配置管理**：支持创建并保存多个 API 配置，按需快速切换；支持拖拽排序。
- **多供应商接入**：内置 OpenAI 兼容接口（含 `Images API` 和 `Responses API`）、sub2api（异步）、fal.ai（支持队列），并支持通过 JSON 导入自定义 HTTP 供应商配置。
- **Agent 模式独立 API 配置**：支持为 Agent 模式使用原生或混合的独立 API 配置，解决部分供应商/模型不支持 `image_generation` 工具的问题。
- **Codex CLI 兼容模式**：对上游为 Codex CLI 的 API，开启后应用 Codex CLI 实际支持的参数，并将多图生成拆分为并发单图。
- **提示词防改写**：Responses API 会始终在请求文本前加入强制指令防止提示词被改写。
- **智能诊断提示**：当检测到接口异常改写行为或缺少常规参数时，自动提示开启相应的兼容模式。

</details>

---

## 🚀 部署

两种部署形态，**同一份构建产物**，运行期决定：

| 形态 | 后端兜底配置 | 自动备份 | 说明 |
|---|:---:|:---:|---|
| **Node 服务**（推荐） | ✅ | ✅ | 完整能力，一个容器搞定 |
| 纯静态托管 | ❌ | ❌ | 行为与原版一致，用户自己填配置 |

<a id="docker-deployment"></a>
### 方式一：Docker 部署（推荐）

**前后端在同一个容器内**——一个 Node 进程同时托管前端静态文件、代理 API 请求、提供备份接口。不需要拆成两个容器。

#### 快速开始

```bash
docker run -d --name image-workbench \
  -p 8080:3000 \
  -v /mnt/user/appdata/image-workbench:/data \
  -e ENABLE_API_PROXY=true \
  -e API_PROXY_URL=https://your-upstream.example.com/v1 \
  -e DEFAULT_API_KEY=sk-xxxx \
  ghcr.io/skywolf123/image-workbench:latest
```

访问 `http://<你的服务器地址>:8080`，首次打开会引导生成成员码。

> [!NOTE]
> 后端兜底只在请求走同源代理时才起作用，所以要让服务端补 Key 的话，`ENABLE_API_PROXY=true` 不能省。

> [!IMPORTANT]
> `-v /mnt/user/appdata/image-workbench:/data` 是**必须**的：备份数据落在 `/data`，不挂载的话容器重建后备份就没了。

#### 环境变量

**后端兜底配置**

| 变量 | 说明 |
|------|------|
| `DEFAULT_API_KEY` | 后端持有的 API Key。前端没填时由代理补上，且不会进入前端产物。 |
| `DEFAULT_API_KEY_FILE` | 从容器内文件读取上述 Key，避免 `docker inspect` 泄漏。文件不存在或为空时启动失败。 |
| `API_PROXY_URL` | 代理转发的上游地址（不自动补 `/v1`）。沿用上游变量名，语义就是「真实地址只存在于这里」。 |
| `API_URL` | 上游更早的变量名，作为 `API_PROXY_URL` 的兜底保留。**新部署请直接用 `API_PROXY_URL`**——设了它会被视为使用了弃用变量，用户首次打开会收到一条迁移提示。 |

**代理**

| 变量 | 说明 |
|------|------|
| `ENABLE_API_PROXY` | 开启同源代理，请求发往 `/api-proxy/` 再转发到 `API_PROXY_URL`。后端兜底依赖它。 |
| `LOCK_API_PROXY` | 强制锁定代理为开启，用户无法关闭。 |

**前端配置的开关**

| 变量 | 说明 |
|------|------|
| `HIDE_API_SETTINGS` | 隐藏设置页的「API 配置」标签。 |
| `LOCK_PRESET_KEY` | 锁定预置配置的 API Key 字段并清空本地已存的 Key。 |
| `DEFAULT_API_URL` | 预置配置，支持 [预置配置说明](#preset-config) 中的三种填写方式。指向 `.json` 文件或容器内路径时启动时自动读取并内嵌。 |
| `LOCK_PRESET_CONFIG_PARAMS` / `PREVENT_PRESET_CONFIG_DELETION` / `SHOW_PRESET_CONFIG_ONLY` | 见 [环境变量一览](#preset-config)。 |

**其它**

| 变量 | 说明 |
|------|------|
| `DATA_DIR` | 备份数据目录，默认 `/data`。 |
| `HOST` / `PORT` | 监听地址和端口，默认 `0.0.0.0:3000`。 |

> [!WARNING]
> 开启代理后，任何能访问该服务的人都能让服务器代为请求上游 API。建议仅在局域网或有访问控制（如 IP 白名单）的环境中使用。

<details>
<summary><b>使用密钥文件而非环境变量</b></summary>

环境变量会出现在 `docker inspect` 与 shell history 中，用挂载文件更稳：

```bash
docker run -d --name image-workbench \
  -p 8080:3000 \
  -v /mnt/user/appdata/image-workbench:/data \
  -v /mnt/user/appdata/image-workbench/key.txt:/run/secrets/api_key:ro \
  -e ENABLE_API_PROXY=true \
  -e API_PROXY_URL=https://your-upstream.example.com/v1 \
  -e DEFAULT_API_KEY_FILE=/run/secrets/api_key \
  ghcr.io/skywolf123/image-workbench:latest
```

</details>

<details>
<summary><b>Docker Compose</b></summary>

```yaml
services:
  image-workbench:
    image: ghcr.io/skywolf123/image-workbench:latest
    ports:
      - "8080:3000"
    volumes:
      - /mnt/user/appdata/image-workbench:/data
    environment:
      - ENABLE_API_PROXY=true
      - API_PROXY_URL=https://your-upstream.example.com/v1
      - DEFAULT_API_KEY=sk-xxxx
    restart: unless-stopped
```

</details>

<details>
<summary><b>不需要后端兜底，只要备份功能</b></summary>

不配置 `DEFAULT_API_KEY` 时应用保持原版行为（用户在设置页自己填 Key），但备份功能依然可用：

```bash
docker run -d --name image-workbench \
  -p 8080:3000 \
  -v /mnt/user/appdata/image-workbench:/data \
  ghcr.io/skywolf123/image-workbench:latest
```

用户打开设置页的「备份」标签即可填写成员码开始备份。

</details>

### 方式二：容器管理面板（Unraid / 群晖 / Portainer 等）

在面板里新建容器，按下表填写即可。以下以 Unraid 为例，其他面板的字段名可能不同（如群晖叫「文件夹」、Portainer 直接在 Stacks 里写 compose）：

| 字段 | 值 |
|---|---|
| Repository / Image | `ghcr.io/skywolf123/image-workbench:latest` |
| Network Type | `Bridge` |
| Port | 容器 `3000` → 宿主机任意端口（如 `8080`） |
| Path / Volume | 容器 `/data` → 宿主机持久化目录（Unraid 惯例是 `/mnt/user/appdata/image-workbench`） |
| Variable | `ENABLE_API_PROXY` = `true` |
| Variable | `API_PROXY_URL` = 你的上游地址 |
| Variable | `DEFAULT_API_KEY` = 你的 Key |

> [!IMPORTANT]
> `/data` 的挂载是**必须**的，且要指向宿主机上的持久化目录。不挂载的话容器重建后备份就没了。

> [!NOTE]
> ghcr.io 的镜像包默认是 **private**。若拉取时提示无权限，在 GitHub 的 Package 设置里改为 public，或在面板中配置 ghcr.io 的登录凭据。

### 方式三：纯静态部署

不部署 Node 服务时，本项目行为与 `88lin/gpt-image-studio` 完全一致：用户自己在设置页填写 API Key，数据只存在浏览器本地。备份相关的界面会自动隐藏，后端兜底也不参与（没有服务端可以承接代理）。

支持 Vercel、GitHub Pages、Cloudflare Workers，工作流文件均已内置。

纯静态部署下，两个前端开关仍可在**构建前**通过 `VITE_` 变量注入：`VITE_HIDE_API_SETTINGS`、`VITE_LOCK_PRESET_KEY`。但它们只改变界面形态，没有后端提供 Key 时锁住 Key 会导致无人可用的配置——纯静态部署建议不要开启。

**Vercel**：在项目 **Settings → Environment Variables** 中设置 `VITE_DEFAULT_API_URL`，导入仓库即可。

**GitHub Pages**：在仓库 **Settings → Pages** 中将 Source 设为 **GitHub Actions**，然后在 **Actions** 里手动触发 **Deploy to GitHub Pages**。

**Cloudflare Workers**：修改 `wrangler.jsonc` 中的 `name` 后在本地执行构建与部署。Cloudflare 不会在部署后改写静态文件，因此必须**在构建前**设置 `VITE_DEFAULT_API_URL`。

> [!IMPORTANT]
> **纯静态部署下没有备份能力**。若你需要防止浏览器清理缓存导致数据丢失，请使用 Docker 部署。

### 方式四：本地开发

```bash
pnpm install

pnpm run dev      # 仅前端（Vite），行为等同于纯静态部署
pnpm run build    # 构建前端产物到 dist/
pnpm start        # 启动 Node 服务，托管 dist/ 并提供代理与备份
pnpm test         # 运行测试
```

> [!NOTE]
> 本地开发时 `pnpm run dev` 没有后端，所以不会出现备份标签、也没有后端兜底——这是正常行为，方便你调试原版的前端交互。
>
> 下面的 Vite 跨域代理只做转发，**不注入 Key**，也无法提供后端兜底。要验证后端兜底请用 `pnpm start`。

<details>
<summary><b>本地开发跨域代理（可选）</b></summary>

如果在本地开发时遇到浏览器的 CORS 限制，可复制 `dev-proxy.config.example.json` 为 `dev-proxy.config.json` 并填写目标地址，Vite 开发服务器会提供同源 `/api-proxy/` 转发。

</details>

---

<a id="preset-config"></a>
### 预置配置说明

Node 服务部署与纯静态部署都支持通过环境变量提供"预置配置"——部署端预先加入用户配置列表的 API 配置。用户打开页面时会自动看到这些配置。

环境变量的值支持三种填写方式：

| 填写方式 | 说明 | 示例 |
|------|------|------|
| **直接填写 API 地址** | 自动创建一个 OpenAI 兼容的默认预置配置（ID 为 `default-openai`）并注入 API URL，其余参数使用应用默认值。末尾带 `/` 时直接拼接接口，不补 `/v1` 前缀。 | `https://api.openai.com/v1` |
| **API 地址 + 查询参数** | 在地址后追加参数，可同时预填 Key、模型等字段。 | `https://api.openai.com/v1?model=gpt-image-2.5-sunburst&apiMode=images` |
| **JSON 配置文件 / 导入链接** | 通过仓库内或本地的 JSON 文件路径、远程 URL 或含 `?settings=` 参数的导入链接提供完整预置配置，支持预置多个配置。 | 详见 [预置配置 JSON 格式](#preset-config-json) |

<a id="preset-config-env"></a>
**环境变量一览**

| 构建时变量（纯静态） | Docker 运行变量 | 功能说明 |
|------|------|------|
| `VITE_DEFAULT_API_URL` | `DEFAULT_API_URL` | 设定预置配置值 |
| `VITE_LOCK_PRESET_CONFIG_PARAMS=true` | `LOCK_PRESET_CONFIG_PARAMS=true` | 锁定预置配置中除 API Key 外的参数，并禁止编辑预置供应商定义 |
| `VITE_PREVENT_PRESET_CONFIG_DELETION=true` | `PREVENT_PRESET_CONFIG_DELETION=true` | 禁止删除预置配置和预置供应商，不锁定参数 |
| `VITE_SHOW_PRESET_CONFIG_ONLY=true` | `SHOW_PRESET_CONFIG_ONLY=true` | 只允许使用当前预置配置，禁止创建、复制、删除、拖动、切换供应商 |
| `VITE_LOCK_PRESET_KEY=true` | `LOCK_PRESET_KEY=true` | 锁定预置配置的 API Key 字段，并清空本地已存的 Key |
| `VITE_HIDE_API_SETTINGS=true` | `HIDE_API_SETTINGS=true` | 隐藏设置页的「API 配置」标签 |

> [!NOTE]
> `LOCK_PRESET_KEY` 与 `LOCK_PRESET_CONFIG_PARAMS` 是一对互补的开关：后者锁定预置配置中**除 API Key 外**的全部参数，前者**只锁 API Key**。两者都只作用于预置配置，用户自己新建的配置不受影响。
>
> 兼容提示：旧变量 `VITE_SHOW_DEFAULT_CONFIG_ONLY`／`SHOW_DEFAULT_CONFIG_ONLY` 仍可使用，等同于对应的 `SHOW_PRESET_CONFIG_ONLY`。

> [!NOTE]
> **未开启上述限制时的默认行为**：
> - **参数更新**：API 地址、模型、超时等参数会与上一次部署快照比较；部署值发生变化时覆盖一次本地值，之后保留用户的本地修改，直到部署值再次变更。
> - **API Key**：始终由用户在本地管理，重新部署不覆盖。
> - **排序与删除**：预置配置可拖动；预置配置和预置供应商均允许删除，删除状态保存在浏览器中，重新部署不会恢复。
> - **下线预置清理**：部署端移除某个预置后，若用户从未修改过该配置且没有历史生成任务引用，会自动从本地删除；若已被修改或仍被历史任务引用，则保留并转为普通配置。

---

## 🛠️ URL 传参快速填充

支持通过 URL 查询参数快速填入 API 配置，便于与 New API 等平台集成。

| 参数 | 说明 | 示例 |
|------|------|------|
| `apiUrl` | API Base URL | `?apiUrl=https://api.example.com/v1` |
| `apiKey` | API Key | `?apiKey=sk-xxxx` |
| `model` | 模型 ID | `?model=gpt-image-2.5-sunburst` |
| `imageGenerationModel` | Responses API 的图像生成工具模型，留空使用 API 默认值 | `?imageGenerationModel=gpt-image-2.5-sunburst` |
| `apiMode` | `images` 或 `responses`，默认 `images` | `?apiMode=responses` |
| `profileName` | 配置名称，默认"URL 参数配置" | `?profileName=我的配置` |
| `reasoningEffort` | Responses API 推理强度 | `?reasoningEffort=high` |
| `codexCli` | Codex CLI 兼容模式 | `?codexCli=true` |
| `streamImages` | 流式传输 | `?streamImages=true` |
| `streamPartialImages` | 中间步骤图像数（需配合 streamImages） | `?streamPartialImages=2` |
| `profileId` | 目标配置 ID；匹配到同 ID 配置时直接更新 | `?profileId=my-service` |
| `transparentBackgroundMethod` | 透明背景实现方式：`api`（原生）或 `local`（本地后处理） | `?transparentBackgroundMethod=local` |

集成示例（New API 聊天系统）：

```text
http://<你的部署地址>/?apiUrl={address}&apiKey={key}&model={model}
```

> [!NOTE]
> 开启 `LOCK_PRESET_KEY` 时，预置配置的 `apiKey` 会被清空（Key 由后端提供），此参数对预置配置不生效。

**自定义格式供应商**

如需导入自定义格式的 API 配置，请使用 `settings` 参数并传入 URL 编码后的完整 JSON：

- `?settings={URL编码后的JSON}`（只读取 `customProviders` 和 `profiles` 列表）

> [!TIP]
> 推荐先在项目内完成配置生成与导入：
>
> **设置 → API 配置 → 供应商类型 → 创建自定义供应商 → AI 一键生成与导入**
>
> 完成后可在 **API 配置 → 当前配置** 使用右侧快捷按钮：
>
> - **链接按钮**：复制可导入配置的 URL。复制时可选择不包含 API Key，并使用 `{address}`、`{key}`、`{model}` 等变量，便于在 New API 等平台中集成分享。
> - **复制按钮**：将当前配置复制一份到配置列表底部。

JSON 结构示例：

```json
{
  "customProviders": [
    {
      "id": "custom-example-task",
      "name": "示例异步任务供应商",
      "submit": {
        "path": "images/generations",
        "method": "POST",
        "contentType": "json",
        "body": {
          "model": "$profile.model",
          "prompt": "$prompt",
          "size": "$params.size",
          "quality": "$params.quality",
          "output_format": "$params.output_format",
          "output_compression": "$params.output_compression",
          "n": "$params.n",
          "image_urls": "$inputImages.dataUrls"
        },
        "taskIdPath": "data.0.task_id"
      },
      "poll": {
        "path": "tasks/{task_id}",
        "method": "GET",
        "intervalSeconds": 5,
        "statusPath": "data.status",
        "successValues": ["completed"],
        "failureValues": ["failed", "cancelled"],
        "errorPath": "data.error.message",
        "result": {
          "imageUrlPaths": ["data.result.images.*.url.*"],
          "b64JsonPaths": []
        }
      }
    }
  ],
  "profiles": [
    {
      "id": "example-profile",
      "name": "示例异步任务供应商",
      "provider": "custom-example-task",
      "baseUrl": "https://api.example.com/v1",
      "model": "gpt-image-2.5-sunburst",
      "apiMode": "images"
    }
  ]
}
```

示例中的 `example-profile` 是唯一配置，因此自动成为默认预置配置。若添加更多配置，需要为其中一项设置 `isDefault: true`。

---

<a id="preset-config-json"></a>
## 📋 预置配置 JSON 格式

使用 JSON 文件或分享链接提供预置配置时，JSON 对象包含两个顶层字段：

- **`customProviders`**（数组）：自定义供应商定义。如果只使用内置供应商（OpenAI 兼容、sub2api（异步）或 fal.ai），此数组留空 `[]` 即可。
- **`profiles`**（数组）：预置的 API 配置列表。每项对应用户配置页中的一个配置条目。

### 配置列表字段说明（`profiles`）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 定向更新时填写 | 用于标识配置条目：若后续链接携带相同 ID（查询参数 `profileId`、`settings` 链接或预置配置 JSON 中的 `id`），将直接更新该条目而非新建。应用内普通分享链接会省略此字段。 |
| `name` | 是 | 配置名称，显示在配置列表中。 |
| `provider` | 是 | 供应商类型：`openai`、`sb2api-async`、`fal`，或 `customProviders` 中定义的自定义供应商 ID。 |
| `baseUrl` | 是 | API 基地址。末尾带 `/` 时直接拼接接口，不补 `/v1` 前缀。 |
| `apiKey` | 否 | 一般建议省略，让用户导入后自行填写。部署端想直接提供 Key 时可填写，但开启 `LOCK_PRESET_KEY` 后会被清空。 |
| `model` | 是 | 模型 ID。 |
| `apiMode` | 否 | `images` 或 `responses`，默认 `images`。 |
| `isDefault` | 否 | 设为 `true` 时作为默认选中的配置。仅有一个配置时自动成为默认。 |
| `description` | 否 | Markdown 格式的说明，显示在配置页顶部。 |

其余字段（`timeout`、`codexCli`、`apiProxy`、`streamImages`、`streamPartialImages`、`transparentBackgroundMethod` 等）与用户在界面中创建的配置完全一致。

### 示例：仅 OpenAI 兼容

```json
{
  "customProviders": [],
  "profiles": [
    {
      "id": "example-openai",
      "name": "示例配置",
      "provider": "openai",
      "baseUrl": "https://api.example.com/v1",
      "model": "gpt-image-2.5-sunburst",
      "apiMode": "images",
      "isDefault": true
    }
  ]
}
```

### 示例：OpenAI 兼容 + sub2api + fal.ai 多配置

```json
{
  "customProviders": [],
  "profiles": [
    {
      "id": "main-openai",
      "name": "主力配置",
      "provider": "openai",
      "baseUrl": "https://api.example.com/v1",
      "model": "gpt-image-2.5-sunburst",
      "apiMode": "images",
      "isDefault": true,
      "description": "**日常使用**，响应较快。"
    },
    {
      "id": "async-backup",
      "name": "备用（异步）",
      "provider": "sb2api-async",
      "baseUrl": "https://async.example.com/v1",
      "model": "gpt-image-2.5-sunburst",
      "apiMode": "images"
    },
    {
      "id": "fal-fallback",
      "name": "fal.ai",
      "provider": "fal",
      "baseUrl": "https://fal.run",
      "model": "openai/gpt-image-2",
      "apiMode": "images"
    }
  ]
}
```

### 如何将预置配置提供给环境变量

预置配置 JSON 可以通过以下三种方式填入部署环境变量：

**方式一：远程 URL**

```dotenv
VITE_DEFAULT_API_URL=https://example.com/image-workbench-config.json
```

**方式二：本地文件路径**

```dotenv
VITE_DEFAULT_API_URL=./image-workbench-config.json
```

Docker 部署时需先挂载文件再指向容器内路径：

```bash
docker run -d --name image-workbench \
  -p 8080:3000 \
  -v /mnt/user/appdata/image-workbench:/data \
  -v /mnt/user/appdata/image-workbench/image-workbench-config.json:/config/image-workbench-config.json:ro \
  -e DEFAULT_API_URL=/config/image-workbench-config.json \
  ghcr.io/skywolf123/image-workbench:latest
```

**方式三：导入链接**

先在**纯静态部署**或原版的在线体验中配置好某个条目，点击"链接"按钮复制含 `?settings=` 参数的 URL（请勿勾选任何"New API 变量配置"选项），直接填入环境变量。

> [!NOTE]
> 页面中的"复制导入配置 URL"按钮导出的是**当前选中的单个配置**及其关联的自定义供应商。如需一次性预置包含多个供应商的列表，请使用前两种方式。

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

原始项目：[CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) — Copyright (c) CookSleep
二次开发：[88lin/gpt-image-studio](https://github.com/88lin/gpt-image-studio) — Copyright (c) 2026 88lin
本 fork：[skywolf123/image-workbench](https://github.com/skywolf123/image-workbench)

感谢以上作者与所有提示词模板贡献者。
