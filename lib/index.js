/**
 * ComfyForge 插件入口。
 *
 * 契约要点（SPEC §3）：
 *   1. `inject` **只放 ['tools']** —— 缺它 `ctx.tools` 会报 `cannot get property "tools" without inject`。
 *      `webServer` / `settings` / `credentials` / `skills` **一律不进 inject**：它们是可选的，
 *      插件在缺它们时应当优雅降级（headless 宿主只掉 UI、保工具，不报错）。
 *   2. `webServer` 要在 **sub-fiber** 里取 —— loader 条目并发激活，webServer 可能晚于本插件到，
 *      在 apply 里一次性 `ctx.get` 会静默跳过挂载。
 *   3. 所有资源（工具/路由/技能/socket）都走 `ctx.effect()` 并返回 disposer。
 *   4. volatile 字段走 `resolveConfig`（内部做双形态读取），并在 `loader/volatile-update` 时重解析。
 *
 * 吸收自 dsh-comfyui 的 lib/index.js。
 */
import { Config, NS, resolveConfig, CONFIG_FILE } from './config.js';
import { ComfyUIClient, CLIENT_ID } from './client.js';
import { capabilityMatrix, checkVram, probeModelRepo, probeServer, suggestModels } from './probe.js';
import { registerComfyForgeTools } from './tools.js';

export const name = 'dsh-comfyforge';
export { Config };

/**
 * 必需服务：只有 `tools`（模型面向的工具注册表）。
 * 不把它写进 inject，读 `ctx.tools` 会被 cordis 直接拒绝。
 */
export const inject = ['tools'];

/** 内置工作流用到的**核心**节点（核心 ComfyUI 自带；缺了说明地址不对或版本太旧）。 */
export const CORE_NODES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'KSampler',
  'EmptyLatentImage',
  'VAEDecode',
  'VAEEncode',
  'VAEEncodeForInpaint',
  'LoadImage',
  'LoadImageMask',
  'SaveImage',
  'PreviewImage'
];

/** 已知会占用工具名的其它插件（跨插件重名会互相顶掉，必须探测）。 */
const KNOWN_TOOL_OWNERS = [
  { tool: 'generate_image', owner: 'dsh-agnes-multimodal', note: '本机已装；ComfyForge 不抢这个名字。' },
  { tool: 'generate_video', owner: 'dsh-agnes-multimodal', note: '本机已装。' }
];

/** 解析 API Key：优先凭据存储，其次进程环境变量。 */
async function resolveApiKey(ctx, envName) {
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(envName);
      if (resolved !== undefined) return resolved.value;
    } catch {
      // 落回进程环境变量
    }
  }
  return process.env[envName];
}

/**
 * 插件主体。loader 校验 entry config 是否符合 `Config`（补默认值）后交给 apply。
 */
export async function apply(ctx, entryConfig) {
  // volatile 字段在 dsh 0.1.7+ 是 accessor、老宿主是普通值；resolved 是每个消费者读的那一份，
  // 设置页保存时由 loader/volatile-update 原地刷新。
  const resolved = resolveConfig(entryConfig);

  /** 运行时门面：工具与路由都通过它取配置/建 client，不直接碰 ctx。 */
  const runtime = {
    configFile: CONFIG_FILE,
    CORE_NODES,
    getConfig: () => resolved,
    getApiKey: () => resolveApiKey(ctx, resolved.apiKeyEnv),
    createClient: (apiKey) =>
      new ComfyUIClient(resolved.baseUrl, apiKey, resolved.connectTimeoutMs, resolved.maxMediaBytes),
    probeServer,
    probeModelRepo,
    capabilityMatrix,
    checkVram,
    suggestModels,
    clientId: CLIENT_ID,
    /**
     * 探测工具名冲突：看已注册的工具里有没有 ComfyForge 想用的名字被占。
     * 不直接读别的插件的注册表（那是私有结构），只对照已知清单 + 自己的命名前缀。
     */
    detectToolConflicts: () => {
      const conflicts = [];
      try {
        const registered = ctx.tools?.list?.() ?? ctx.tools?.registered?.() ?? undefined;
        if (Array.isArray(registered)) {
          const names = new Set(registered.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean));
          for (const entry of KNOWN_TOOL_OWNERS) {
            if (names.has(entry.tool) && !entry.tool.startsWith('comfy_')) {
              conflicts.push({ tool: entry.tool, owner: entry.owner, note: entry.note });
            }
          }
        }
      } catch {
        // 拿不到清单不算失败：这只是体检的一节。
      }
      // 静态判据：ComfyForge 自己的工具一律 comfy_ 前缀（绝不含 generate_image）。
      return conflicts;
    }
  };

  /**
   * 就地接住新配置；baseUrl 变了要重新建 client（client 是每次调用新建的，所以只需换 resolved）。
   * dsh 0.1.7+：设置页保存会把 volatile 值写进**同一批 accessor 对象**，然后通知本 fiber。
   */
  const refreshConfig = (next) => {
    Object.assign(resolved, next);
  };

  ctx.on('loader/volatile-update', () => {
    refreshConfig(resolveConfig(entryConfig));
  });

  // ── 工具（V0 全部是只读体检类） ──
  ctx.effect(() => {
    const disposers = registerComfyForgeTools(ctx, runtime);
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose();
      }
    };
  }, 'comfyforge: tools');

  // ── 设置页（双版本适配）──
  // 宿主没设置服务时这一整块不注册，entry config 保持装配时的样子，不报错。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (typeof settings.installSection === 'function') {
      // dsh 0.1.2–0.1.5：分区注册表自己留一份值的副本。
      settings.installSection(ctx, NS, Config, resolved, {
        setSource: (current) => {
          refreshConfig(resolveConfig(current));
        },
        onChange: () => {
          refreshConfig(resolveConfig(entryConfig));
        }
      });
      return;
    }
    if (typeof settings.configure === 'function') {
      // dsh 0.1.7+：表单从 volatile 字段投影出来，保存走上面的 volatile-update 事件。
      // 本插件自带设置页（client 半），所以关掉自动生成的表单。
      const configure = settings.configure.bind(settings);
      settingsCtx.effect(() => configure({ auto: false }, ctx.fiber), 'comfyforge: settings page policy');
    }
  });
}
