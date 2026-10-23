/**
 * gen-models.mjs — 从 SCNet 客户端自己的 models.json 生成插件用的静态模型表。
 *
 * 为什么必须静态：`GET /api/llm/v1/models` 只返回 `{id, object, ownedBy}` 三个字段，
 * contextWindow / maxTokens / 模态信息全缺，所以模型目录不能靠运行时发现，必须自带。
 * 来源就是客户端自己的 models.json —— 厂商自己维护的那份，比任何猜测都权威。
 *
 * 只保留 chat 模型：models.json 列了 30 个，/models 端点列了 31 个，多出来的
 * `Qwen3-Embedding-8B` 是嵌入模型，不能聊天，客户端自己也没列。
 *
 * 路径都可覆盖，默认值不绑定任何一台具体的机器：
 *   SCNET_MODELS_JSON  — 源文件，默认 %USERPROFILE%\.sclaw\agent\models.json
 *   SCNET_MODELS_OUT   — 输出文件，默认本包根目录的 models.js
 * 输出被强制限制在本包目录内：这个脚本随包发布，不该在用户机器的别处建目录写文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.SCNET_MODELS_JSON ?? path.join(homedir(), '.sclaw', 'agent', 'models.json'));
const OUT = path.resolve(process.env.SCNET_MODELS_OUT ?? path.join(PKG_DIR, 'models.js'));
if (!OUT.startsWith(PKG_DIR + path.sep)) {
  throw new Error(`refusing to write outside the package: ${OUT}`);
}

/** 厂商表里 maxTokens 超过 contextWindow 的条目，夹到窗口后记在这里，写进表头。 */
const clamped = [];

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const provider = raw.providers.scnet;
if (provider === undefined) throw new Error('models.json has no providers.scnet');
if (provider.baseUrl !== 'https://api.scnet.cn/api/llm/v1') throw new Error(`unexpected baseUrl ${provider.baseUrl}`);
if (provider.api !== 'openai-completions') throw new Error(`unexpected api ${provider.api}`);

const models = provider.models;
if (models.length !== 30) throw new Error(`expected 30 models, got ${models.length}`);

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function entryOf(m) {
  if (typeof m.id !== 'string' || m.id.length === 0) throw new Error(`bad id ${JSON.stringify(m)}`);
  if (m.thinkingMode !== 'levels') throw new Error(`${m.id}: unexpected thinkingMode ${m.thinkingMode}`);
  if (!Array.isArray(m.input) || m.input.length === 0) throw new Error(`${m.id}: bad input`);
  for (const modality of m.input) {
    if (modality !== 'text' && modality !== 'image') throw new Error(`${m.id}: unknown modality ${modality}`);
  }
  if (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0) throw new Error(`${m.id}: bad contextWindow`);
  if (!Number.isInteger(m.maxTokens) || m.maxTokens <= 0) throw new Error(`${m.id}: bad maxTokens`);
  if (typeof m.reasoning !== 'boolean') throw new Error(`${m.id}: bad reasoning`);

  // 厂商表里有两个模型的 maxTokens 大于整个 contextWindow（输出预算超过全部上下文，
  // 自相矛盾）。宿主会把 maxTokens 当 defaultMaxTokens 用，照抄上去等于给上游一个
  // 不可能满足的预算。夹到窗口本身，并把夹过的条目记下来写进表头。
  let maxTokens = m.maxTokens;
  if (maxTokens > m.contextWindow) {
    clamped.push(`${m.id} (${m.maxTokens} -> ${m.contextWindow})`);
    maxTokens = m.contextWindow;
  }

  const out = {
    id: m.id,
    name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id,
    input: [...m.input],
    contextWindow: m.contextWindow,
    maxTokens: maxTokens,
    reasoning: m.reasoning,
  };

  if (m.reasoning) {
    const map = m.thinkingLevelMap;
    if (map === undefined || typeof map !== 'object') throw new Error(`${m.id}: reasoning model without thinkingLevelMap`);
    const normalized = {};
    for (const level of LEVELS) {
      const value = map[level];
      if (value === undefined) throw new Error(`${m.id}: thinkingLevelMap missing ${level}`);
      if (value !== null && typeof value !== 'string') throw new Error(`${m.id}: thinkingLevelMap.${level} is neither null nor string`);
      normalized[level] = value;
    }
    const defaultLevel = m.defaultThinkingLevel;
    if (typeof defaultLevel !== 'string' || !LEVELS.includes(defaultLevel)) {
      throw new Error(`${m.id}: bad defaultThinkingLevel ${defaultLevel}`);
    }
    if (normalized[defaultLevel] === null) throw new Error(`${m.id}: defaultThinkingLevel ${defaultLevel} is mapped to null`);
    out.thinkingLevelMap = normalized;
    out.defaultThinkingLevel = defaultLevel;
  } else if (m.thinkingLevelMap !== undefined || m.defaultThinkingLevel !== undefined) {
    throw new Error(`${m.id}: non-reasoning model carries thinking metadata`);
  }
  return out;
}

const entries = models.map(entryOf);

const ids = new Set();
for (const e of entries) {
  if (ids.has(e.id)) throw new Error(`duplicate id ${e.id}`);
  ids.add(e.id);
  // 夹完之后这条必须成立；它是整张表的自洽条件，不是可选项。
  if (e.maxTokens > e.contextWindow) throw new Error(`${e.id}: maxTokens ${e.maxTokens} > contextWindow ${e.contextWindow}`);
}

const reasoningCount = entries.filter((e) => e.reasoning).length;
const imageCount = entries.filter((e) => e.input.includes('image')).length;

const lines = [];
lines.push('/**');
lines.push(' * SCNet 模型目录，由 scripts/gen-models.mjs 从 SCNet 客户端自己的');
lines.push(' * `~/.sclaw/agent/models.json` 生成 —— 不要手改，改生成脚本。');
lines.push(' *');
lines.push(' * 为什么是静态表：`GET /api/llm/v1/models` 只返回 id/object/ownedBy，');
lines.push(' * 没有 contextWindow 也没有 maxTokens，运行时发现凑不出可用目录。');
lines.push(' *');
lines.push(' * 来源即厂商客户端自身配置，是这台机器上能拿到的最权威的一份。');
lines.push(` * 共 ${entries.length} 个 chat 模型，其中 ${reasoningCount} 个声明支持思考、${imageCount} 个接受图片输入。`);
lines.push(' * 未列入的是 `Qwen3-Embedding-8B`（嵌入模型，不可聊天，客户端自己也没列）。');
if (clamped.length > 0) {
  lines.push(' *');
  lines.push(' * 厂商表里 maxTokens 大于 contextWindow 的条目，已夹到窗口本身（原值 -> 现值）：');
  for (const note of clamped) lines.push(` *   - ${note}`);
}
lines.push(' */');
lines.push('');
lines.push('/** 该目录对应的上游地址。 */');
lines.push('export const SCNet_BASE_URL = ' + JSON.stringify(provider.baseUrl) + ';');
lines.push('');
lines.push('/** 供应商显示名，与 SCNet 客户端自己用的一致。 */');
lines.push('export const SCNet_PROVIDER_NAME = ' + JSON.stringify(provider.name) + ';');
lines.push('');
lines.push('/**');
lines.push(' * 每个模型的思考等级映射。`null` 表示该模型不支持这一档 —— pi-ai 的');
lines.push(' * `getSupportedThinkingLevels()` 会把映射为 null 的等级从可选列表里剔除，');
lines.push(' * 所以这里照抄客户端的表，不做任何裁剪。');
lines.push(' */');
lines.push('export const SCNet_MODELS = [');
for (const e of entries) {
  lines.push('  {');
  lines.push(`    id: ${JSON.stringify(e.id)},`);
  lines.push(`    name: ${JSON.stringify(e.name)},`);
  lines.push(`    input: ${JSON.stringify(e.input)},`);
  lines.push(`    contextWindow: ${e.contextWindow},`);
  lines.push(`    maxTokens: ${e.maxTokens},`);
  if (!e.reasoning) {
    lines.push('    reasoning: false,');
  } else {
    lines.push('    reasoning: true,');
    lines.push(`    defaultThinkingLevel: ${JSON.stringify(e.defaultThinkingLevel)},`);
    lines.push('    thinkingLevelMap: {');
    for (const level of LEVELS) {
      lines.push(`      ${level}: ${JSON.stringify(e.thinkingLevelMap[level])},`);
    }
    lines.push('    },');
  }
  lines.push('  },');
}
lines.push('];');
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`wrote ${OUT} (${entries.length} models, ${reasoningCount} reasoning, ${imageCount} image-capable)`);
