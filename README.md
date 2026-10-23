# dsh-connect-scnet

把 **超算互联网（SCNet）「计算服务」客户端**里已经登录的模型接入 DeepSeek Harness。

装好之后，DSH 的模型选择器里会多出 `scnet` 这个 provider 和它的 30 个模型
（`SCNet-Max`、`DeepSeek-V4-Pro-0813`、`Qwen3.8-Max`、`Kimi-K3`、`GLM-5.3` …）。
**不需要二次登录、不需要手填 API key** —— 插件直接读 SCNet 客户端自己保存的那份凭据。

这是一个 **host-only bundle**：只有 `index.js` 一个 host 半边，没有 `lib/client.js`。
原因见下面「为什么没有设置卡片」。

*Bring the models already signed in to the **SCNet (超算互联网) Computing Service** desktop client
into DeepSeek Harness — it reuses the client's own API key, so there is nothing to configure.*

## 安装 / Install

需要 DSH 0.2.0-rc.0 及以上（`@deepseek-ai/dsh-llm` 的 peer 范围）。先登录一次 SCNet 客户端。

```sh
dsh plugin --profile <你的 profile> add dsh-connect-scnet
```

直接从仓库装也可以，pnpm 认 `github:` 形式：

```sh
dsh plugin --profile <你的 profile> add github:hualuo520-h/dsh-connect-scnet
```

装完重启 DSH，在模型选择器里选 `scnet`。想改配置见下面「配置项」。

---

## 它怎么拿到 API key

按顺序找，命中第一个就用：

1. **DSH 凭据服务里的 `SCNET_API_KEY`**
   （`ctx.credentials.resolve("SCNET_API_KEY")`；该服务自己会把「已存值」排在「启动环境变量」之前，
   所以 `setx SCNET_API_KEY sk-…` 之后重启 DSH 也算。）
2. **本插件的 `credentialFile` 配置**：可以是那个 JSON 文件本身，也可以是装着它的目录。
3. **SCNet 客户端默认凭据目录**：`%USERPROFILE%\.sclaw\agent\scnet-credentials\`。
   客户端把 key 落在 `{"scnet":{"type":"api_key","key":"sk-…"}}` 这种文件里；
   目录里有多个时按 mtime 取最新的一份（mtime 相同则按文件名定序，保证结果可复现）。

三处都没有 → 插件抛 `MISSING_CREDENTIAL`，DSH 会把 `scnet` 显示成「未配置」而不是报错崩溃。
**所以：先启动一次 SCNet 客户端并登录，再装这个插件，最省事。**

key 首尾的空白（粘贴时最常见的尾随换行）会被静默去掉；去掉之后如果还剩不能进 HTTP 头的
字符（中间有空白、非 ASCII），插件报 `INVALID_CREDENTIAL` 而不是静默当成「没配」——配错了要能看出来。

---

## 为什么没有设置卡片

DSH 的 Models 设置页（`dsh-client-ui-settings-models`）只给两个 settings namespace 画表单：

```js
// settings-models 的 layoutOf()
if (ns === "llm-deepseek") return "deepseek";
if (ns === "llm-pi-ai")  return "pi-ai";
return "unknown";          // ← 第三方插件全部落这里
```

`layout === "unknown"` 时页面只渲染一句「高级提示」，而且提交按钮恒为禁用
（`submitDisabled: disabled || layout === "unknown" || …`）。也就是说**第三方插件没法借这个页面收 key**。
`dsh-connect-trae` / `dsh-connect-qoder` 因此各自带了一个 `lib/client.js` 自绘卡片。

本插件选择不带 client 半边，代价是设置页里看不到它的输入框，收益是：
少一个需要跟着 host 版本走的 React 半身，而 key 本来就应该由客户端自己提供。

---

## 模型目录为什么是静态的

`GET https://api.scnet.cn/api/llm/v1/models` 确实能返回 31 个 id，但每条只有

```json
{ "id": "SCNet-Max", "object": "model", "ownedBy": "system" }
```

**没有 `contextWindow`，没有 `maxTokens`，也没有模态信息**。拿它当目录等于丢掉全部窗口信息。

所以目录来自 `models.js`（30 条），由 `scripts/gen-models.mjs` 从 SCNet 客户端自己的
`~/.sclaw/agent/models.json` 生成。要更新模型表：

```powershell
node scripts/gen-models.mjs
```

源与输出都可以覆盖，默认值不绑定任何一台具体的机器：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SCNET_MODELS_JSON` | `%USERPROFILE%\.sclaw\agent\models.json` | 源文件 |
| `SCNET_MODELS_OUT` | 本包根目录的 `models.js` | 输出文件；**被强制限制在包目录内**，指向别处会直接报错退出 |

脚本会校验来源（provider 必须是 `scnet`、api 必须是 `openai-completions`、条数必须是 30、
每条 reasoning 模型必须有完整的 7 档 `thinkingLevelMap`、`maxTokens` 不得超过 `contextWindow`），
任何一条不符就 exit 1，不写文件。

厂商表里有两个模型 `maxTokens` 大于 `contextWindow`（`Qwen3.5-122B-A10B` 102400/131072、
`Qwen3-235B-A22B` 32768/131072，输出预算比整个上下文还大，自相矛盾）。生成器把它们**夹到窗口本身**，
并把夹过的条目记在 `models.js` 表头 —— 照抄原值等于给上游一个不可能满足的预算。

（那 31 个里多出来的是 `Qwen3-Embedding-8B`，嵌入模型，不能聊天，已排除。）

---

## 协议实测：为什么是这八个 compat 字段

pi-ai 的 `detectCompat()` 不认识 `api.scnet.cn`，会给一套默认值，其中**有一条对 SCNet 是有害的**。
前六条是对着真实端点跑探针定下来的；后两条只是把 pi-ai 的默认值显式写出来（写成字面量而不是
依赖默认，是为了让「我们依赖它」这件事在代码里看得见），依据是抓包确认上游确实这样回。

| 字段 | 取值 | 依据 |
|---|---|---|
| `maxTokensField` | `"max_completion_tokens"` | 发 `max_tokens: 32` 会被 **200 接受但不截断**（实测 `completion_tokens=162`）；只有 `max_completion_tokens: 32` 真的截到 32。 |
| `thinkingFormat` | `"qwen"` | SCNet **默认就思考**。pi-ai 的 `qwen` 分支在无 effort 时发 `enable_thinking:false`，实测能关思考；默认的 `openai` 分支什么都不发，等于关不掉。 |
| `supportsReasoningEffort` | `true` | qwen 分支只有它为真才带 `reasoning_effort`。 |
| `supportsStore` | `false` | 不发 `store`。 |
| `supportsDeveloperRole` | `false` | 不发 `role:"developer"`（SCNet 其实接受，保守关掉）。 |
| `requiresReasoningContentOnAssistantMessages` | `false` | 不在助手历史里补空 `reasoning_content`。 |
| `supportsUsageInStreaming` | `true` | 让 pi-ai 发 `stream_options:{include_usage:true}`。抓包确认上游接受，且流末尾确实带回 `usage`（`inputTokens/outputTokens` 都非零）。 |
| `supportsFinishReason` | `true` | 声明上游会给 `finish_reason`。抓包确认每条流都有（`stop` / `length` / `tool_calls` 都见过）；若关掉，pi-ai 会改用自己的推断。 |

关于「怎么关思考」这件事，实测结论是：

- **能关**：`enable_thinking:false`、`thinking:{type:"disabled"}`、`reasoning:{effort:"none"}`
- **不能关**：不传字段（默认就思考）、`chat_template_kwargs:{thinking:false}`、**`reasoning_effort:"off"`**
- **报错**：`thinking_budget:0` → HTTP 400 `code:"10013"`

`reasoning_effort:"off"` 关不掉思考，是选 `thinkingFormat:"qwen"` 而不是 `"openai"` 的根本原因。

> **证据不在包里**：定这些取值用的探针脚本是我在开发机上临时写的，没有随包发布，
> 所以上表无法在本包内复现。它们的结论可以用一次请求自己核对：抓 `POST /chat/completions`
> 的请求体看有没有 `enable_thinking` / `reasoning_effort`，再看响应有没有 `finish_reason`
> 与流末尾的 `usage`。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `credentialFile` | `""` | SCNet 凭据 JSON 的路径，或装着它的目录。留空则自动找 `~/.sclaw/agent/scnet-credentials`。 |
| `baseURL` | `""` | 网关地址，留空用 `https://api.scnet.cn/api/llm/v1`。想走自建反代时改这里。 |

两个字段都不是 `volatile`，所以在 UI 里改不了 —— 要改就写进 profile 的 `cordis.patch.yml`。
**注意只能写 id 定向覆盖，不要再 `insert` 一次**（bundle 自己的 patch 已经插过 `llm-scnet`，
同一个 id 出现两次会让插件树加载直接失败：`duplicate loader entry id: llm-scnet`）：

```yaml
- id: llm-scnet
  config:
    baseURL: https://my-gateway.example/v1
```

---

## 已知限制

- **余额**。实测账号里只有 `SCNet-Max` 能真正调通，其余 29 个模型返回
  `402 Insufficient Balance`。这是账号侧的事，插件照实把它们列出来 —— 列出来不等于能用。
  任何「某模型行为如何」的结论，目前只对 `SCNet-Max` 成立。
- **思考等级**照抄客户端 `models.json` 的 `thinkingLevelMap`（7 个模型有），
  映射为 `null` 的档位 pi-ai 会剔除，所以那些模型不会显示 `minimal` / `xhigh` 之类的空档。
- **图片**：`input` 含 `image` 的 11 个模型走 DSH 的 durable attachment 服务；
  如果 profile 里没有 `attachments` 服务，带图请求会报 `UNSUPPORTED_CONTENT`。

---

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | host 半边：`apply()` 里注册 adapter / discovery / directory 三件套 |
| `models.js` | 静态模型目录（30 条，生成物，别手改） |
| `scripts/gen-models.mjs` | 从 SCNet 客户端 `models.json` 重新生成 `models.js` |
| `cordis.patch.yml` | bundle patch：往 profile 里插一条 `llm-scnet` |
| `locale/{zh,en}.json` | 插件标题与描述 |
| `icon.svg` | 插件图标 |
