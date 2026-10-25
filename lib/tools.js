/**
 * ComfyForge 的工具定义与注册。
 *
 * 命名铁律：一律 `comfy_` 前缀 —— 绝不注册 `generate_image`（本机 dsh-agnes-multimodal
 * 已占用，见 SPEC §4.1）。
 *
 * 参数 schema 只用宿主白名单（2026-10-20 从 app.asar 取证）：
 *   约束键：type / oneOf / properties / required / additionalProperties / items / enum / const
 *   注解键：description / title / default / examples
 *   **minimum / maximum / format / pattern / allOf / $ref 一律被 reject** → 范围只写 description。
 *
 * V0 只注册三个**只读、不消耗 GPU** 的工具，用来验证装配与体检：
 *   comfy_status / comfy_object_info / comfy_doctor
 */
import { capabilityMatrix, listCustomNodes, probeModelRepo } from './probe.js';

/** 工具执行超时（毫秒）—— 体检类工具不该长跑。 */
const READ_TIMEOUT_MS = 120_000;

/** 统一的「把错误变成 message + 下一步」的收尾。 */
function failureText(error) {
  if (error && typeof error === 'object' && 'hint' in error) {
    return error.hint ? `${error.message}\n下一步：${error.hint}` : String(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

/** 一行摘要：把 JSON 结果压成给模型看的多行文本。 */
function lines(...parts) {
  return parts.flat().filter((line) => line !== undefined && line !== null && line !== '').join('\n');
}

/* ───────────────────────── comfy_status ───────────────────────── */

function statusDefinition(runtime) {
  return {
    name: 'comfy_status',
    description: lines(
      '检查 ComfyUI 服务器是否可达，并返回版本、设备与显存概况。',
      '这是**只读探活**，不提交任何任务、不消耗 GPU —— 用户问「ComfyUI 开着吗」「显存还剩多少」，',
      '或你要判断某工作流能不能跑之前，先调它。',
      '返回里包含 baseUrl（当前生效的地址）、comfyuiDirs（本机安装目录）、',
      '以及 vram 预算判定（本机 6G 机器，跑大工作流前要看这一项）。'
    ).join(' '),
    parameters: {
      type: 'object',
      properties: {
        /// 无参数 —— 但保留一个可选的 probe_vram，方便用户只想要显存数字时少读点内容。
        probe_vram: {
          type: 'boolean',
          description: '为 true 时额外返回显存预检详情（默认 true，本来就很便宜）。'
        }
      },
      required: [],
      additionalProperties: false
    },
    output: { schema: { type: 'object' } },
    timeoutMs: READ_TIMEOUT_MS,
    async execute(args) {
      const config = runtime.getConfig();
      try {
        const client = runtime.createClient(await runtime.getApiKey());
        const probe = await runtime.probeServer(client).catch(() => undefined);
        if (probe === undefined) {
          return { ok: false, baseUrl: config.baseUrl, error: 'ComfyUI 没响应' };
        }
        const queue = await client.getQueue().catch(() => undefined);
        const vram = runtime.checkVram(probe, undefined, config.vramBudgetMiB);
        return {
          ok: true,
          baseUrl: config.baseUrl,
          comfyuiDirs: config.comfyuiDirs,
          comfyuiVersion: probe.version,
          pythonVersion: probe.pythonVersion,
          device: probe.deviceName,
          vramTotalMiB: probe.vramTotalMiB,
          vramFreeMiB: probe.vramFreeMiB,
          vramBudgetMiB: config.vramBudgetMiB,
          vramDetail: vram.detail,
          queueRunning: queue ? queue.queue_running.length : undefined,
          queuePending: queue ? queue.queue_pending.length : undefined
        };
      } catch (error) {
        return { ok: false, baseUrl: config.baseUrl, error: failureText(error) };
      }
    }
  };
}

/* ─────────────────────── comfy_object_info ─────────────────────── */

function objectInfoDefinition(runtime) {
  return {
    name: 'comfy_object_info',
    description: lines(
      '查询 ComfyUI 的节点定义：节点类名、输入项、以及加载器里**实际可用**的模型文件名。',
      '这是手写工作流前查环境的工具（`filter: "Loader"` 可一次看到所有加载器），',
      '也用来回答「本机有哪些底模 / 采样器」。',
      '**它不是生成入口** —— 要生成走工作流工具；本工具只读，不消耗 GPU。',
      '返回内容可能很大（完整 /object_info 可达数 MB），所以务必带 filter，或指名具体节点类名。'
    ).join(' '),
    parameters: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '具体节点类名（如 "KSampler"、"CheckpointLoaderSimple"）。给了就只返回它，最省 token。'
        },
        filter: {
          type: 'string',
          description: '子串过滤节点类名（大小写不敏感），如 "Loader" / "Video" / "GGUF"。node 与 filter 二选一。'
        },
        list_models: {
          type: 'boolean',
          description: '为 true 时额外汇总各加载器里的可选模型文件名（底模/采样器/Vae 等），而不是整个 object_info。'
        }
      },
      required: [],
      additionalProperties: false
    },
    output: { schema: { type: 'object' } },
    timeoutMs: READ_TIMEOUT_MS,
    async execute(args) {
      try {
        const client = runtime.createClient(await runtime.getApiKey());
        const config = runtime.getConfig();

        if (args.list_models === true) {
          return await summarizeModels(client, config);
        }

        const all = await client.objectInfo();
        if (args.node !== undefined && args.node !== '') {
          const info = all?.[args.node];
          if (info === undefined) {
            return {
              ok: false,
              error: `本机没有节点 \`${args.node}\``,
              hint: '类名要完全一致。可先用 filter 搜（如 filter: "Sampler"）。'
            };
          }
          return { ok: true, node: args.node, info: compactNodeInfo(info) };
        }

        const names = Object.keys(all ?? {});
        if (args.filter !== undefined && args.filter !== '') {
          const needle = args.filter.toLowerCase();
          const matched = names.filter((name) => name.toLowerCase().includes(needle));
          return {
            ok: true,
            filter: args.filter,
            count: matched.length,
            nodes: matched.slice(0, 200),
            truncated: matched.length > 200
          };
        }

        // 一个都没给：只回类名清单（不回那么多细节，省 token）。
        return {
          ok: true,
          count: names.length,
          nodes: names.slice(0, 300),
          truncated: names.length > 300,
          hint: '带 node 或 filter 可以看具体定义；list_models: true 可以看可用模型清单。'
        };
      } catch (error) {
        return { ok: false, error: failureText(error) };
      }
    }
  };
}

/** 把一个节点定义压成可读的形状（只留输入项与输出）。 */
function compactNodeInfo(info) {
  const inputs = {};
  for (const [key, spec] of Object.entries(info?.input?.required ?? {})) {
    inputs[key] = compactSpec(spec, '必填');
  }
  for (const [key, spec] of Object.entries(info?.input?.optional ?? {})) {
    inputs[key] = compactSpec(spec, '可选');
  }
  return { category: info?.category, output: info?.output, output_name: info?.output_name, inputs };
}

/** 输入项声明 → 可读摘要（枚举列出可选值）。 */
function compactSpec(spec, required) {
  if (!Array.isArray(spec)) return { required, type: 'unknown' };
  const typeName = spec[0];
  const out = { required };
  if (Array.isArray(typeName)) {
    // 枚举：第一项就是可选值数组
    out.type = 'enum';
    out.options = typeName.slice(0, 40);
    if (typeName.length > 40) out.optionsTruncated = true;
  } else {
    out.type = String(typeName);
    const meta = spec[1];
    if (meta && typeof meta === 'object') {
      if (meta.default !== undefined) out.default = meta.default;
      if (meta.min !== undefined) out.min = meta.min;
      if (meta.max !== undefined) out.max = meta.max;
    }
  }
  return out;
}

/** 汇总各加载器的可选模型清单。 */
async function summarizeModels(client, config) {
  const all = await client.objectInfo();
  const loaders = {
    checkpoints: 'CheckpointLoaderSimple',
    loras: 'LoraLoader',
    vae: 'VAELoader',
    samplers: 'KSampler',
    controlnet: 'ControlNetLoader',
    upscale: 'UpscaleModelLoader'
  };
  const out = {};
  for (const [key, classType] of Object.entries(loaders)) {
    const info = all?.[classType];
    const required = info?.input?.required ?? {};
    // 每类加载器里第一个枚举输入就是它的文件/选项清单。
    const keyName = Object.keys(required).find((k) => Array.isArray(required[k]?.[0]));
    const options = keyName ? (required[keyName][0] ?? []) : [];
    out[key] = {
      node: classType,
      input: keyName,
      count: options.length,
      sample: options.slice(0, 20)
    };
  }
  const repo = await probeModelRepo(config.comfyuiDirs, all).catch(() => undefined);
  return { ok: true, loaders: out, modelRepo: repo ? summarizeRepo(repo) : undefined };
}

/** 把模型仓体检结果压成摘要。 */
function summarizeRepo(repo) {
  const entries = Object.entries(repo.counts ?? {})
    .filter(([, v]) => v.files > 0)
    .map(([k, v]) => `${v.label}=${v.files}`);
  return {
    roots: repo.roots,
    checkpointCount: repo.checkpointCount,
    checkpointFromObjectInfo: repo.checkpointFromObjectInfo,
    empty: repo.empty,
    nonEmptyDirs: entries.length > 0 ? entries.join('、') : '（全部为空）'
  };
}

/* ───────────────────────── comfy_doctor ───────────────────────── */

function doctorDefinition(runtime) {
  return {
    name: 'comfy_doctor',
    description: lines(
      'ComfyForge 的体检报告：本机能不能出图、缺什么、下一步做什么。',
      '它会检查：① 生效配置与 ComfyUI 目录 ② 服务器可达性（版本/设备/显存）',
      '③ 核心节点是否齐全 ④ **模型仓体检**（本机头号问题：一个模型都没有）',
      '⑤ 自定义节点能力矩阵（去背/视频/风格参考/量化/姿态）⑥ 工具名冲突。',
      '**只读，不消耗 GPU。** 任何「跑不出图」的排查都应该从它开始。'
    ).join(' '),
    parameters: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['config', 'server', 'nodes', 'models', 'capabilities', 'conflicts'] },
          description: '只要体检这几节（默认全部）。排查特定问题时可以只取一节，省 token。'
        }
      },
      required: [],
      additionalProperties: false
    },
    output: { schema: { type: 'object' } },
    timeoutMs: READ_TIMEOUT_MS,
    async execute(args) {
      const config = runtime.getConfig();
      const want = Array.isArray(args.sections) && args.sections.length > 0 ? new Set(args.sections) : undefined;
      const section = (name) => want === undefined || want.has(name);

      const report = { ok: true };

      if (section('config')) {
        report.config = {
          baseUrl: config.baseUrl,
          comfyuiDirs: config.comfyuiDirs,
          vramBudgetMiB: config.vramBudgetMiB,
          dataDir: config.dataDir,
          configFile: runtime.configFile
        };
      }

      let objectInfo;
      let client;
      try {
        client = runtime.createClient(await runtime.getApiKey());
        objectInfo = await client.objectInfo();
      } catch (error) {
        report.ok = false;
        report.server = { reachable: false, error: failureText(error) };
        report.summary = '连不上 ComfyUI —— 先启动它（绘世启动器），再跑一次体检。';
        return report;
      }

      if (section('server')) {
        const probe = await runtime.probeServer(client).catch(() => undefined);
        report.server = probe
          ? {
              reachable: true,
              comfyuiVersion: probe.version,
              pythonVersion: probe.pythonVersion,
              device: probe.deviceName,
              vramTotalMiB: probe.vramTotalMiB,
              vramFreeMiB: probe.vramFreeMiB
            }
          : { reachable: true, note: '拿不到 system_stats 详情' };
      }

      if (section('nodes')) {
        const core = runtime.CORE_NODES;
        const missing = core.filter((name) => !(name in (objectInfo ?? {})));
        report.nodes = { total: Object.keys(objectInfo ?? {}).length, coreMissing: missing, coreOk: missing.length === 0 };
      }

      if (section('models')) {
        const repo = await runtime.probeModelRepo(config.comfyuiDirs, objectInfo).catch(() => undefined);
        if (repo) {
          report.models = { ...summarizeRepo(repo), counts: compactCounts(repo.counts) };
          if (repo.empty) {
            report.ok = false;
            report.models.suggestion = runtime.suggestModels(repo, config);
          }
        }
      }

      if (section('capabilities')) {
        const customNodeDirs = await listCustomNodes(config.comfyuiDirs).catch(() => []);
        report.capabilities = capabilityMatrix(objectInfo, customNodeDirs).map((c) => ({
          key: c.key,
          label: c.label,
          available: c.available,
          nodes: c.nodes,
          why: c.why
        }));
      }

      if (section('conflicts')) {
        report.conflicts = runtime.detectToolConflicts();
      }

      report.summary = buildSummary(report);
      return report;
    }
  };
}

function compactCounts(counts) {
  const out = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    out[key] = { label: value.label, files: value.files, samples: value.samples };
  }
  return out;
}

function buildSummary(report) {
  const parts = [];
  if (report.models?.empty) parts.push('模型仓是空的 —— 必须先放一个底模才能出图。');
  if (report.nodes && report.nodes.coreOk === false) parts.push(`缺 ${report.nodes.coreMissing.length} 个核心节点。`);
  if (report.conflicts && report.conflicts.length > 0) parts.push(`有 ${report.conflicts.length} 处工具名冲突。`);
  if (parts.length === 0) parts.push('体检通过：可以出图。');
  return parts.join(' ');
}

/* ───────────────────────── 注册 ───────────────────────── */

/** 由 index.js 调用：注册全部 V0 工具，返回 disposer 数组。 */
export function registerComfyForgeTools(ctx, runtime) {
  const tools = ctx.tools;
  const disposers = [];
  disposers.push(tools.register(statusDefinition(runtime)));
  disposers.push(tools.register(objectInfoDefinition(runtime)));
  disposers.push(tools.register(doctorDefinition(runtime)));
  return disposers;
}
