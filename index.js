/**
 * dsh-connect-scnet —— 把「超算互联网」(SCNet) 客户端里已经登录的模型接入 DSH。
 *
 * 设计要点（每条都是对着 DSH 0.2.x 的真实契约反推出来的，改动前请先读 README）：
 *
 * 1. 只注册 `ctx.llm` 的三件套（registerAdapter / registerModelDiscovery /
 *    registerConfigurableProviders）。本包是 host-only bundle，没有 `dsh.client`，
 *    因为 Models 设置页对第三方 settings namespace 只渲染「高级提示」并且提交按钮恒禁用
 *    （见 asar 内 settings-models 的 `layoutOf`：只有 llm-deepseek / llm-pi-ai 有表单）。
 *
 * 2. 模型目录是**静态自带**的（`models.js`，30 条，由 scripts/gen-models.mjs 从客户端
 *    自己的 `~/.sclaw/agent/models.json` 生成）。SCNet 的 `GET /models` 只回
 *    `{id, object, ownedBy}`，没有 contextWindow / maxTokens，不能拿来做目录。
 *
 * 3. API key **直接复用 SCNet 客户端已经存好的凭据**，用户不需要二次配置：
 *    客户端把 key 落在 `~/.sclaw/agent/scnet-credentials/<hash>.json`，
 *    形如 `{"scnet":{"type":"api_key","key":"sk-…"}}`。查找顺序是
 *    ① DSH 凭据服务里的 `SCNET_API_KEY`（它自己也会回退到启动环境变量）
 *    ② Config.credentialFile 指定的文件/目录
 *    ③ 默认的 SCNet 客户端凭据目录（按 mtime 取最新的一份）
 *    都找不到就抛 `LlmError(…, "MISSING_CREDENTIAL")`——PiAiAdapter 把这一条翻译成
 *    「该 provider 没有可用模型」，也就是「未配置」。
 *
 * 4. `compat` 八个字段（依据见 README「协议实测」一节）：
 *    - `maxTokensField: "max_completion_tokens"`：SCNet 接受 `max_tokens` 但**不截断**，
 *      只有 `max_completion_tokens` 真的生效。
 *    - `thinkingFormat: "qwen"`：SCNet 默认就思考，而 pi-ai 的 `qwen` 分支在没有 effort 时
 *      会发 `enable_thinking:false`（实测能关思考）；默认的 `openai` 分支什么都不发，
 *      等于关不掉；`reasoning_effort:"off"` 也关不掉（实测）。
 *    - `supportsStore` / `supportsDeveloperRole` 关掉：少发两个上游未必需要的字段。
 *    - `requiresReasoningContentOnAssistantMessages: false`：不回填空的 reasoning_content。
 *    - `supportsUsageInStreaming` / `supportsFinishReason` 为真：这两条只是把 pi-ai 的
 *      默认值写成字面量，抓包确认上游确实回 usage 与 finish_reason。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";

import { SCNet_BASE_URL, SCNet_MODELS, SCNet_PROVIDER_NAME } from "./models.js";

const PROVIDER_ID = "scnet";
const FALLBACK_SETTINGS_NS = "llm-scnet";

/** DSH 凭据服务里读写的引用名。settings-models 页面没有 apiKeyEnv 时会推导出同一个名字。 */
const CREDENTIAL_REF = "SCNET_API_KEY";

/** 与 llm-pi-ai / dsh-workbuddy-connect 保持一致的默认值。 */
const STREAM_IDLE_TIMEOUT_MS = 3e5;

const REQUEST_IMAGE_BUDGETS = Object.freeze({
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
});

const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * 逐字段覆盖 pi-ai 的 `detectCompat()`。scnet 不在它的识别名单里，默认会落到
 * `thinkingFormat: "openai"`，那一条对 SCNet 是有害的默认值，必须显式改掉。
 */
const COMPAT = Object.freeze({
  maxTokensField: "max_completion_tokens",
  thinkingFormat: "qwen",
  supportsReasoningEffort: true,
  supportsStore: false,
  supportsDeveloperRole: false,
  requiresReasoningContentOnAssistantMessages: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
});

/** dsh-llm 的 `LEGAL_API_KEY`：只允许可打印 ASCII，且不能含空白。 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;

/**
 * pi-ai 的 auth 对象。key 由 `resolveApiKey` 直接交给 adapter，所以这里的
 * credentials 生命周期只是占位——绝不能让它变成第二条写 key 的路。
 */
const INERT_AUTH = Object.freeze({
  credentials: Object.freeze({
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("dsh-connect-scnet: the scnet route has no pi-ai credential lifecycle");
    },
    async delete() {},
  }),
  authContext: Object.freeze({
    async env() {},
    async fileExists() {
      return false;
    },
  }),
});

export const name = "dsh-connect-scnet";

export const inject = ["llm"];

export const Config = z.object({
  credentialFile: z
    .string()
    .default("")
    .description(
      "Path to the SCNet client credential JSON, or to the directory that holds it. " +
        "Leave empty to auto-discover under ~/.sclaw/agent/scnet-credentials.",
    ),
  baseURL: z
    .string()
    .default("")
    .description(`OpenAI-compatible base URL of the SCNet LLM gateway. Empty means ${SCNet_BASE_URL}.`),
});

function settingsNamespaceOf(ctx) {
  // `ctx.fiber.entry` 由 Loader 注入，不在 Cordis 的公开类型里，裸 ctx.plugin() 下可能缺失。
  const id = ctx?.fiber?.entry?.options?.id;
  return typeof id === "string" && id !== "" ? id : FALLBACK_SETTINGS_NS;
}

function normalizeBaseURL(value) {
  if (typeof value !== "string") return SCNet_BASE_URL;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length === 0 ? SCNet_BASE_URL : trimmed;
}

/** 把一条 models.js 条目翻译成 pi-ai 的 Model。 */
function toPiModel(entry, baseURL) {
  const reasoning = entry.reasoning
    ? {
        reasoning: true,
        ...(entry.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...entry.thinkingLevelMap } }),
      }
    : { reasoning: false };
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: baseURL,
    input: [...entry.input],
    cost: NO_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    ...reasoning,
    compat: COMPAT,
  };
}

function keyOfRecord(parsed) {
  const candidates = [parsed?.scnet?.key, parsed?.key];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

async function keyFromFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  return keyOfRecord(parsed);
}

/** 读一个目录下所有 `*.json`，按 mtime 从新到旧，取第一份带 key 的。 */
async function keyFromDirectory(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const entry of names) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    const path = join(directory, entry);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      candidates.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }
  // mtime 相同是可能的（批量拷贝/解包会把多个文件写成同一时间），
  // 那时只按 mtime 排序结果不稳定，可能挑中旧 key。用文件名做次级键定序，
  // 至少让同一台机器上的选择是确定的、可复现的。
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    const key = await keyFromFile(candidate.path);
    if (key !== undefined) return { key, source: candidate.path };
  }
  return undefined;
}

/** 路径既可能是单个 JSON 文件，也可能是装着 JSON 的目录。 */
async function keyFromPath(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) {
    const hit = await keyFromDirectory(path);
    return hit === undefined ? undefined : hit;
  }
  if (!info.isFile()) return undefined;
  const key = await keyFromFile(path);
  return key === undefined ? undefined : { key, source: path };
}

function defaultCredentialDirectory() {
  return join(homedir(), ".sclaw", "agent", "scnet-credentials");
}

/**
 * 把原始字符串收敛成可以塞进 HTTP 头的 key。空 → undefined（视为这一路没有配置），
 * 含非法字符 → 直接抛 INVALID_CREDENTIAL，因为静默跳过会让「配了但配错了」看起来像没配。
 */
function checkedKey(raw, source) {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (!LEGAL_API_KEY.test(value)) {
    throw new LlmError(
      `dsh-connect-scnet: the API key read from ${source} contains characters no HTTP header can carry; ` +
        `store the raw key instead`,
      "INVALID_CREDENTIAL",
    );
  }
  return value;
}

function missingCredentialError(tried) {
  return new LlmError(
    `dsh-connect-scnet: no SCNet API key is configured, so provider "${PROVIDER_ID}" advertises no models. ` +
      `Looked in ${tried.join(", ")}. ` +
      `Start the SCNet client once so it writes its credential file, or set ${CREDENTIAL_REF} through the ` +
      `credentials service, or point this plugin's "credentialFile" option at the client's credential JSON.`,
    "MISSING_CREDENTIAL",
  );
}

/**
 * PiAiAdapter 只接受 provider 级默认思考档，而 SCNet 的 7 个 reasoning 模型各有
 * 自己的默认档。这里只重写 `modelInfo`，把默认档换成该模型自己在 models.js 里
 * 声明的那一档 —— 其余行为（listModels / prepareCall / stream）全部继承。
 *
 * 不改的话：`profile.reasoning` 为空 → `describableReasoningLevel(model, undefined)`
 * 直接返回 undefined → modelInfo() 不带 defaultEffort → 宿主不补 effort →
 * pi-ai 的 qwen 分支发 `enable_thinking:false`，等于把模型静默降级成不思考。
 */
class SCNetPiAiAdapter extends PiAiAdapter {
  modelInfo(snapshot, provider, model) {
    const info = super.modelInfo(snapshot, provider, model);
    if (info.reasoning === undefined) return info;
    const entry = SCNet_MODELS.find((row) => row.id === model);
    const wanted = entry?.defaultThinkingLevel;
    if (typeof wanted !== "string") return info;
    // 只在该档确实出现在 efforts 里时替换，避免造出 normalizeModelInfo 会拒绝的默认档。
    if (!info.reasoning.efforts.some((row) => row.id === wanted)) return info;
    return { ...info, reasoning: { ...info.reasoning, defaultEffort: wanted } };
  }
}

export function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx);

  const readConfig = () => (config !== null && typeof config === "object" ? config : {});

  async function resolveApiKey() {
    // `tried` 必须是本函数的局部变量。resolveApiKey 是 async 且会被并发调用
    // （PiAiAdapter 的 listModels 与 streamWithSnapshot 各 await 一次），
    // 共享一个数组会让两条调用互相清空/追加，MISSING_CREDENTIAL 的提示里
    // 就会出现重复或错位的条目 —— 那是一条本该帮人定位问题的信息。
    const tried = [];

    // ① DSH 凭据服务（它自己会把「已存值」排在「启动环境变量」前面）
    const credentials = ctx.get?.("credentials");
    if (credentials !== undefined && typeof credentials.resolve === "function") {
      tried.push(`the "${CREDENTIAL_REF}" credential`);
      let hit;
      try {
        hit = await credentials.resolve(CREDENTIAL_REF);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-connect-scnet: could not read ${CREDENTIAL_REF} from the credentials service`, error);
        hit = undefined;
      }
      const value = hit?.value;
      if (typeof value === "string") {
        const key = checkedKey(value, `credential ${CREDENTIAL_REF}`);
        if (key !== undefined) return key;
      }
    } else {
      tried.push(`the credentials service (absent in this profile)`);
    }

    // ② Config.credentialFile（文件或目录）
    const configured = readConfig().credentialFile;
    const configuredPath = typeof configured === "string" ? configured.trim() : "";
    if (configuredPath.length > 0) {
      tried.push(`credentialFile "${configuredPath}"`);
      const hit = await keyFromPath(configuredPath);
      if (hit !== undefined) {
        const key = checkedKey(hit.key, hit.source);
        if (key !== undefined) return key;
      }
    }

    // ③ SCNet 客户端自己的凭据目录
    const directory = defaultCredentialDirectory();
    tried.push(`"${directory}"`);
    const hit = await keyFromDirectory(directory);
    if (hit !== undefined) {
      const key = checkedKey(hit.key, hit.source);
      if (key !== undefined) return key;
    }

    throw missingCredentialError(tried);
  }

  const buildModels = () => {
    const baseURL = normalizeBaseURL(readConfig().baseURL);
    return SCNet_MODELS.map((entry) => toPiModel(entry, baseURL));
  };

  // 每个模型的输出上限就是它自己声明的 maxTokens；写进 configuredMaxTokens 后
  // PiAiAdapter.modelInfo() 才会带上 defaultMaxTokens，宿主才会在用户没指定时用它。
  const configuredMaxTokens = new Map(SCNet_MODELS.map((entry) => [entry.id, entry.maxTokens]));

  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: SCNet_PROVIDER_NAME,
      auth: {
        apiKey: {
          name: "SCNet API key",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: "SCNet" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    // PiAiAdapter 通过 createModels().getModels(provider) 取模型；这里让它每次都重新算，
    // 这样 baseURL 改了以后不用重建 provider。
    getModels: () => buildModels(),
  };

  // profile 上**不能**放 reasoning 字段：PiAiAdapter.modelInfo() 里
  // `describableReasoningLevel(model, profile.reasoning)` 取的是 profile 级默认档，
  // 而 profile 是按 provider 一个，SCNet 却有 7 个 reasoning 模型、各自默认档不同
  // （Kimi-K3 / GLM-5.2 / GLM-5.3 / GLM-5.3-Flash = max，DeepSeek-V4-Pro-0813 /
  // DeepSeek-V4-Flash-0731 = high，SCNet-Max = medium）。塞一个全局值进去，
  // 不支持该档的模型会被过滤成 undefined，于是 modelInfo() 丢掉 defaultEffort；
  // 而 defaultEffort 缺失时宿主不会补 effort，pi-ai 的 qwen 分支就发
  // `enable_thinking:false` —— 等于把这些模型静默变成"不思考"。
  // 默认档必须逐模型给，见下面的 SCNetPiAiAdapter。
  const profile = {
    provider: PROVIDER_ID,
    displayName: SCNet_PROVIDER_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-connect-scnet retryPolicy"),
    configuredMaxTokens,
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  // PiAiAdapter 按 Map 的**身份**做 memo，所以刷新必须换一个新的 Map。
  let profiles = new Map([[PROVIDER_ID, profile]]);

  const adapter = new SCNetPiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveApiKey(),
    resolveAttachments: () => ctx.get?.("attachments"),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get?.("fs")?.processPathFromHostPath?.(hostPath),
        ref,
      ),
  });

  const invalidate = () => {
    profiles = new Map([[PROVIDER_ID, profile]]);
    try {
      ctx.emit("llm/adapters-updated");
    } catch (error) {
      ctx.logger?.warn?.("dsh-connect-scnet: could not announce llm/adapters-updated", error);
    }
  };

  // 模型发现：SCNet 的 /models 没有窗口信息，所以直接回静态目录（与 pi-ai 自带目录命中时同构）。
  const discover = async () =>
    SCNet_MODELS.map((entry) => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      inputModalities: [...entry.input],
    }));

  let releaseAdapter;
  let releaseDiscovery;
  let releaseDirectory;
  const dispose = () => {
    // 逆序释放；每一步都独立兜住，避免前一个抛错把后面的清理吞掉。
    for (const release of [releaseDirectory, releaseDiscovery, releaseAdapter]) {
      if (release === undefined) continue;
      try {
        release();
      } catch (error) {
        ctx.logger?.warn?.("dsh-connect-scnet: failed to release an llm registration", error);
      }
    }
    releaseAdapter = undefined;
    releaseDiscovery = undefined;
    releaseDirectory = undefined;
  };

  try {
    releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    releaseDiscovery = ctx.llm.registerModelDiscovery(settingsNs, discover);
    releaseDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER_ID,
        displayName: SCNet_PROVIDER_NAME,
        settingsNs,
        settingsPath: [],
        declared: false,
      },
    ]);
  } catch (error) {
    dispose();
    throw error;
  }

  try {
    ctx.effect(() => () => dispose());
  } catch (error) {
    // 没有 effect 通道时（裸 ctx.plugin）至少保证注册不会泄漏。
    dispose();
    throw error;
  }

  // key 被换掉以后要让宿主重新拉一次目录（否则界面还停在「未配置」）。
  // ctx.on 返回 disposer，必须交给 ctx.effect 才能随插件卸载一起释放。
  if (typeof ctx.on === "function" && typeof ctx.effect === "function") {
    try {
      ctx.effect(() =>
        ctx.on("credentials/reference-updated", (ref) => {
          if (ref === CREDENTIAL_REF) invalidate();
        }),
      );
    } catch (error) {
      ctx.logger?.warn?.("dsh-connect-scnet: could not subscribe to credentials/reference-updated", error);
    }
  }

  // 启动时先探一次 key，好让「没找到 key」这件事出现在日志里而不是静默空目录。
  // 这里对返回值做一次形状检查：resolveApiKey 的契约是「返回非空字符串或抛错」，
  // 但真出问题时宁可记一条日志，也不要在插件加载阶段抛 TypeError。
  void resolveApiKey().then(
    (key) => {
      if (typeof key !== "string" || key.length === 0) {
        ctx.logger?.warn?.(
          "dsh-connect-scnet: the credential lookup returned no usable key; the provider will advertise no models",
        );
        return;
      }
      ctx.logger?.debug?.(`dsh-connect-scnet: using an SCNet API key of length ${key.length}`);
    },
    (error) => {
      if (error instanceof LlmError && error.code === "MISSING_CREDENTIAL") {
        ctx.logger?.warn?.(error.message);
        return;
      }
      ctx.logger?.warn?.("dsh-connect-scnet: could not resolve the SCNet API key", error);
    },
  );
}
