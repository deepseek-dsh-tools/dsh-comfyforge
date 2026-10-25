/**
 * ComfyForge 配置。
 *
 * 两条硬约束（都是踩过坑总结的，见 SPEC §3.4）：
 *   1. 运行期可改的字段必须标 `.volatile()` —— dsh 0.1.7+ 的设置页只认 volatile 字段，
 *      没标的会报 `Plugin entry has no volatile fields`，配置存不下来。
 *   2. 读 volatile 字段必须**双形态兼容** —— 新宿主给 accessor（要 .get()），
 *      老宿主给普通值。不认识就会在运行时炸 `config.x.get is not a function`。
 *
 * 另外提供一个「配置文件便利层」：手改 JSON 即可改地址，不用动 YAML、不用重启 DSH。
 * 优先级（高者赢）：插件配置 → 配置文件 → 环境变量 → 内置默认值。
 *
 * ⚠️ schemastery 是**可选依赖**（动态探测）：
 *   拿得到 → 导出 `Config` schema，设置页能自动投影表单、volatile 机制生效；
 *   拿不到（例如 link: 安装而解析链够不到 profile 的 node_modules）
 *         → 不导出 schema，退化为手写校验，**工具功能完全不受影响**。
 *   dsh 明确支持「插件不导出 Config schema」→ 原始配置对象原样交给 apply。
 *
 * 吸收自 dsh-comfyui 的 config.js（volatile 机制）+ dsh-comfyui-image 的 config.ts（四层优先级 + 零依赖可选）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';

/** 探测 schemastery；拿不到就 null。 */
async function loadSchemaLib() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    const z = mod?.default ?? mod;
    return typeof z?.object === 'function' ? z : null;
  } catch {
    return null;
  }
}

const z = await loadSchemaLib();

/** 插件 id，同时用作配置目录名与设置页 namespace。 */
export const PLUGIN_ID = 'dsh-comfyforge';

/** 设置页 / config namespace（与 cordis.patch.yml 里的 entry id 一致）。 */
export const NS = 'comfyforge';

/** ComfyUI 默认地址。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

/** 本机 ComfyUI 安装根（秋叶 v3.2，2026-10-20 实测）。 */
export const DEFAULT_COMFYUI_DIRS = ['D:\\QWQ\\ComfyUI-aki-v3.2'];

/** 配置文件位置；测试可用 `DSH_COMFYFORGE_CONFIG` 指到临时目录。 */
export const CONFIG_FILE =
  process.env.DSH_COMFYFORGE_CONFIG || path.join(os.homedir(), `.${PLUGIN_ID}`, 'config.json');

/** 内置默认值（配置文件 / 环境变量缺失时用）。 */
export const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  apiKeyEnv: 'COMFYUI_API_KEY',
  connectTimeoutMs: 10_000,
  timeoutMs: 900_000,
  pollIntervalMs: 1_000,
  maxMediaItems: 12,
  maxMediaBytes: 64 * 1024 * 1024,
  mediaHost: '',
  skillsDir: '',
  outputDir: '',
  dataDir: '',
  maxAssets: 200,
  /** 6G 机器的显存预算（MiB）—— 跑前估算用。 */
  vramBudgetMiB: 5500
};

/**
 * Loader 条目配置的 schema（**只有在探测到 schemastery 时才构建**）。
 *
 * volatile 字段（运行期可改，设置页保存直接生效）：
 *   baseUrl / apiKeyEnv / 三个超时 / maxMediaItems / maxMediaBytes / mediaHost / comfyuiDirs / skillsDir / vramBudgetMiB
 * 非 volatile（改了要重启插件，因为 store 在启动时用它们建）：
 *   dataDir / maxAssets / outputDir
 */
function buildConfigSchema(z) {
  return z.object({
    /** ComfyUI HTTP 服务器地址。 */
    baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
    /** 可选 API Key 的环境变量名 / 凭据名。 */
    apiKeyEnv: z.string().default('COMFYUI_API_KEY').volatile(),
    /** 单次请求的连接/读取超时。 */
    connectTimeoutMs: z.number().min(1_000).max(60_000).default(10_000).volatile(),
    /** 一次同步生成的等待预算（异步任务另有 job 超时）。 */
    timeoutMs: z.number().min(5_000).max(3_600_000).default(900_000).volatile(),
    /** 等完成时的轮询间隔。 */
    pollIntervalMs: z.number().min(200).max(10_000).default(1_000).volatile(),
    /** 单次结果最多取回多少媒体条目。 */
    maxMediaItems: z.number().min(1).max(50).default(12).volatile(),
    /** 媒体代理单文件字节上限。 */
    maxMediaBytes: z.number().min(64 * 1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024).volatile(),
    /** 生成媒体的外部访问基址；空 = 自动检测。 */
    mediaHost: z.string().default('').volatile(),
    /** 技能包根目录；空 = `<dataDir>/skills`。必须绝对路径。 */
    skillsDir: z.string().default('').volatile(),
    /** ComfyUI 输出目录（本机），用于删除产出文件；空 = 从文件路径推断。 */
    outputDir: z.string().default(''),
    /** 插件数据目录；空 = `$DSH_HOME/data/dsh-comfyforge`。 */
    dataDir: z.string().default(''),
    /** 资产索引最多保留多少条。 */
    maxAssets: z.number().min(1).max(10_000).default(200),
    /** 本机 ComfyUI 安装目录（可多个：映射/多实例/便携版）。Agent 据此定位 models、工作流、节点。 */
    comfyuiDirs: z.array(z.string()).default(DEFAULT_COMFYUI_DIRS).volatile(),
    /** 显存预算（MiB）—— 跑前估算，不足时提前警告而不是跑到一半 OOM。 */
    vramBudgetMiB: z.number().min(1024).max(100_000).default(5500).volatile()
  });
}

/**
 * 导出的 schema；探测不到 schemastery 时为 `undefined`。
 * dsh 支持插件不导出 Config schema（原始配置原样交给 apply），此时靠手写校验兜底。
 */
export const Config = z ? buildConfigSchema(z) : undefined;

/** 探测结果，供 doctor / 启动自检报告使用。 */
export const HAS_SCHEMA_LIB = z !== null;

/** volatile accessor 的协议 symbol（跨 cosmokit 副本共享）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 读一个可能是 volatile accessor（新宿主）或普通值（老宿主）的字段。
 * ⚠️ 不认识这个就会在运行时炸 `config.x.get is not a function`。
 */
export function current(value) {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) {
    return value.get();
  }
  return value;
}

/** 读配置文件；坏了就当没有，绝不因为这个把插件搞挂。 */
export function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    // 剥掉可能的 UTF-8 BOM，否则 JSON.parse 会炸。
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 把一份补丁合并进配置文件（留给面板 / CLI 用）。 */
export function writeConfigFile(patch) {
  const next = { ...readConfigFile(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** 环境变量名 → 配置键。 */
const ENV_KEYS = {
  COMFYUI_URL: 'baseUrl',
  COMFYUI_BASE_URL: 'baseUrl',
  COMFYUI_STEPS: 'steps',
  COMFYUI_TIMEOUT_MS: 'timeoutMs',
  COMFYFORGE_VRAM_BUDGET: 'vramBudgetMiB'
};

/** 从环境变量里抽配置（适合容器 / 临时覆盖）。 */
export function configFromEnv(env = process.env) {
  const out = {};
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey];
    if (value !== undefined && value !== '') out[configKey] = value;
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

function pickNumber(min, max, ...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
  }
  return undefined;
}

/** 插件数据目录的默认位置。 */
export function defaultDataDir() {
  const base = process.env.DSH_HOME ?? join(os.homedir(), '.dsh');
  return join(base, 'data', PLUGIN_ID);
}

/**
 * 把 Loader 的条目配置解析成插件读的普通对象。
 *
 * 调用两次的场合：`loader/volatile-update` 事件之后要重新解析一次 ——
 * accessor 是**同一批对象**，只是里面的值被换成新的了。
 */
export function resolveConfig(raw, env = process.env) {
  const bare = isPlainObject(raw) ? raw : {};
  const fromFile = readConfigFile();
  const fromEnv = configFromEnv(env);

  // 每一层按 volatile 双形态取值后再拼，高者赢。
  const s = (...keys) => [
    ...keys.map((k) => current(bare[k])),
    ...keys.map((k) => fromFile[k]),
    ...keys.map((k) => fromEnv[k])
  ];
  const n = (...keys) => s(...keys);

  const dirs = s('comfyuiDirs').find((v) => Array.isArray(v) && v.length > 0);
  const configuredDataDir = pickString(...s('dataDir'));

  return {
    baseUrl: (pickString(...s('baseUrl')) ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKeyEnv: pickString(...s('apiKeyEnv')) ?? DEFAULTS.apiKeyEnv,
    connectTimeoutMs: Math.round(pickNumber(1_000, 60_000, ...n('connectTimeoutMs')) ?? DEFAULTS.connectTimeoutMs),
    timeoutMs: Math.round(pickNumber(5_000, 3_600_000, ...n('timeoutMs')) ?? DEFAULTS.timeoutMs),
    pollIntervalMs: Math.round(pickNumber(200, 10_000, ...n('pollIntervalMs')) ?? DEFAULTS.pollIntervalMs),
    maxMediaItems: Math.round(pickNumber(1, 50, ...n('maxMediaItems')) ?? DEFAULTS.maxMediaItems),
    maxMediaBytes: Math.round(pickNumber(64 * 1024, 512 * 1024 * 1024, ...n('maxMediaBytes')) ?? DEFAULTS.maxMediaBytes),
    mediaHost: (pickString(...s('mediaHost')) ?? DEFAULTS.mediaHost).replace(/\/+$/, ''),
    skillsDir: pickString(...s('skillsDir')) ?? DEFAULTS.skillsDir,
    outputDir: pickString(...s('outputDir')) ?? DEFAULTS.outputDir,
    dataDir: configuredDataDir !== undefined ? configuredDataDir : defaultDataDir(),
    maxAssets: Math.round(pickNumber(1, 10_000, ...n('maxAssets')) ?? DEFAULTS.maxAssets),
    comfyuiDirs: Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d.trim() !== '') : [...DEFAULT_COMFYUI_DIRS],
    vramBudgetMiB: Math.round(pickNumber(1024, 100_000, ...n('vramBudgetMiB')) ?? DEFAULTS.vramBudgetMiB)
  };
}

/**
 * SD1.5 系底模最舒服是 512，SDXL 系是 1024。
 * 规则直白写在这里，不做更深的猜测（吸收自 dsh-comfyui-image config.ts:190）。
 */
export function suggestSizeForCheckpoint(checkpoint, config) {
  const name = String(checkpoint).toLowerCase();
  const looksLikeLegacy = /(^|[^a-z0-9])(sd[_ ]?1[._-]?5|sd15|v1-5|sd_v1)/.test(name) && !name.includes('xl');
  if (looksLikeLegacy) return { width: 512, height: 512 };
  return { width: 1024, height: 1024 };
}
