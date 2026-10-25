/**
 * ComfyForge 能力探测层。
 *
 * 设计原则（吸收自 dsh-comfyui-image 的 comfy/nodes.ts）：
 *   **所有网络访问集中在这一层，产出「事实」** —— 于是建图层（workflows.js）可以是纯函数，
 *   不需要真装 ComfyUI 就能单测。
 *
 * 探测的事：
 *   1. 服务器与显存（system_stats）
 *   2. 底模（三态：指定且存在 / 没指定自动挑 / 指定但不存在报错）
 *   3. 采样器与调度器（双态：显式传错报错 / 默认值过期静默回退）
 *   4. 本机自定义节点能力矩阵（去背 / 视频 / 风格参考 / 量化 / 姿态）
 *   5. 模型仓体检（本机头号问题：一个模型都没有）
 */
import {
  ComfyForgeError,
  checkpointNotFound,
  noCheckpoint,
  nodeMissing,
  samplerNotFound
} from './errors.js';

/** 合并节点声明的必填 + 可选输入。 */
export function declaredInputs(info) {
  return { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) };
}

/** 只取必填输入。 */
export function requiredInputs(info) {
  return { ...(info?.input?.required ?? {}) };
}

/** 枚举输入的可选值；不是枚举就 undefined。 */
export function enumChoices(spec) {
  if (!Array.isArray(spec)) return undefined;
  const first = spec[0];
  if (Array.isArray(first) && first.length > 0 && first.every((v) => typeof v === 'string')) {
    return first;
  }
  return undefined;
}

/** 输入项声明的默认值。 */
export function specDefault(spec) {
  if (!Array.isArray(spec)) return undefined;
  const meta = spec[1];
  if (meta && typeof meta === 'object' && 'default' in meta) return meta.default;
  return undefined;
}

/** 在已声明的键名里挑第一个命中候选名单的。 */
export function pickDeclaredKey(declared, candidates) {
  for (const candidate of candidates) {
    if (candidate in declared) return candidate;
  }
  return undefined;
}

/** 只填「节点确实声明过」的键，避免把不存在的输入塞进去导致 /prompt 拒收。 */
export function fillInputs(info, wanted) {
  const declared = declaredInputs(info);
  const out = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (value !== undefined && key in declared) out[key] = value;
  }
  return out;
}

/**
 * 在 fillInputs 基础上，把「我们没提供、但节点要求必填的**枚举类**输入」用节点自己的默认值补上。
 *
 * 这是对付第三方节点参数名各异的关键一招：某个去背节点多出一个必填 `model`，
 * 我们不需要知道它叫什么 —— 只要它是个枚举，就填节点自己的默认值。
 * **只补枚举，绝不误填 IMAGE 这类连线输入。**
 */
export function autoFillRequired(info, wanted) {
  const out = fillInputs(info, wanted);
  const required = requiredInputs(info);
  for (const [key, spec] of Object.entries(required)) {
    if (key in out) continue;
    const choices = enumChoices(spec);
    const fallback = specDefault(spec) ?? choices?.[0];
    if (fallback !== undefined) out[key] = fallback;
  }
  return out;
}

/** 数字类型输入声明（INT / FLOAT），含 min/max/step。 */
export function numberSpecOf(info, inputKey) {
  const spec = declaredInputs(info)[inputKey];
  if (!Array.isArray(spec)) return undefined;
  const typeName = spec[0];
  if (typeof typeName !== 'string') return undefined;
  const names = typeName.split(',').map((n) => (n.split(':')[0] ?? '').trim().toUpperCase());
  const hasFloat = names.includes('FLOAT');
  const hasInt = names.includes('INT');
  if (!hasFloat && !hasInt) return undefined;
  const meta = spec[1] && typeof spec[1] === 'object' ? spec[1] : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return { kind: hasFloat ? 'float' : 'int', min: num(meta.min), max: num(meta.max), step: num(meta.step) };
}

/* ─────────────────────────── 底模 ─────────────────────────── */

/**
 * 挑底模（三态）：
 *   ① 指定了且存在 → 用它
 *   ② 没指定 → 优先带 "xl" 的（更通用），否则第一个
 *   ③ 指定了但不存在 → **报错并列出可选项**（比默默换一个更可预测）
 *
 * 空模型仓是本机的头号问题 → 走 noCheckpoint() 给出可执行的补齐方案。
 */
export async function chooseCheckpoint(client, preferred, comfyuiDirs) {
  const info = await client.nodeInfo('CheckpointLoaderSimple');
  if (!info) {
    throw nodeMissingHint();
  }
  const available = enumChoices(requiredInputs(info).ckpt_name) ?? [];

  if (available.length === 0) {
    throw noCheckpoint(comfyuiDirs);
  }
  if (preferred) {
    if (available.includes(preferred)) return { checkpoint: preferred, available };
    throw checkpointNotFound(preferred, available);
  }
  const chosen = available.find((name) => /xl/i.test(name)) ?? available[0];
  return { checkpoint: chosen, available };
}

function nodeMissingHint() {
  return nodeMissing(
    'CheckpointLoaderSimple',
    '这个节点是 ComfyUI 核心自带的。请确认 baseUrl 指向的是真的 ComfyUI，且版本不过旧。'
  );
}

/* ─────────────────────── 采样器 / 调度器 ─────────────────────── */

/**
 * 校验采样器与调度器（**双态**）：
 *   用户**显式**给的错了 → 报错并列出可用值；
 *   只是**配置默认值**在本机不存在 → 静默回退 + 写进 notes。
 * 这个区分是可用性的分水岭（用户意图 vs 插件默认值）。
 */
export async function chooseSampler(client, request, config) {
  const info = await client.nodeInfo('KSampler');
  const notes = [];
  if (!info) {
    throw nodeMissing('KSampler', 'KSampler 是 ComfyUI 核心节点，缺它说明地址可能不是 ComfyUI 服务。');
  }
  const required = requiredInputs(info);
  const samplerOptions = enumChoices(required.sampler_name) ?? [];
  const schedulerOptions = enumChoices(required.scheduler) ?? [];

  const userPickedSampler = request.samplerName !== config.samplerName;
  const userPickedScheduler = request.scheduler !== config.scheduler;

  let samplerName = request.samplerName;
  if (samplerOptions.length > 0 && !samplerOptions.includes(samplerName)) {
    if (userPickedSampler) {
      throw samplerNotFound('采样器', samplerName, samplerOptions);
    }
    const fallback = samplerOptions.includes(config.samplerName) ? config.samplerName : samplerOptions[0];
    notes.push(`采样器 ${samplerName} 在本机不存在，已改用 ${fallback}。`);
    samplerName = fallback;
  }

  let scheduler = request.scheduler;
  if (schedulerOptions.length > 0 && !schedulerOptions.includes(scheduler)) {
    if (userPickedScheduler) {
      throw samplerNotFound('调度器', scheduler, schedulerOptions);
    }
    const fallback = schedulerOptions.includes(config.scheduler) ? config.scheduler : schedulerOptions[0];
    notes.push(`调度器 ${scheduler} 在本机不存在，已改用 ${fallback}。`);
    scheduler = fallback;
  }

  return { samplerName, scheduler, notes };
}

/* ─────────────────────── 服务器与显存 ─────────────────────── */

/** 服务器信息：版本、设备、显存。 */
export async function probeServer(client) {
  const stats = await client.systemStats();
  const system = stats?.system ?? {};
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const primary = devices.find((d) => d?.type === 'cuda') ?? devices[0];
  const totalMiB = primary?.vram_total ? Math.round(primary.vram_total / (1024 * 1024)) : undefined;
  const freeMiB = primary?.vram_free ? Math.round(primary.vram_free / (1024 * 1024)) : undefined;
  return {
    version: system.comfyui_version ?? 'unknown',
    pythonVersion: system.python_version ?? system.python ?? undefined,
    deviceName: primary?.name ?? undefined,
    deviceType: primary?.type ?? undefined,
    vramTotalMiB: totalMiB,
    vramFreeMiB: freeMiB
  };
}

/**
 * 显存预检：估算需求 vs 可用，不足时给建议。
 * **6G 机器上，提前警告比跑到一半 OOM 友好得多。**
 */
export function checkVram(probe, needMiB, budgetMiB) {
  const available = probe.vramFreeMiB ?? probe.vramTotalMiB;
  if (available === undefined) return { ok: true, detail: '未能读到显存信息，跳过预检。' };
  const cap = Math.min(available, budgetMiB ?? available);
  if (needMiB === undefined) return { ok: true, detail: `当前可用显存约 ${available} MiB。` };
  if (needMiB > cap) {
    return {
      ok: false,
      needMiB,
      availableMiB: cap,
      detail: `预计需要约 ${needMiB} MiB，当前可用约 ${cap} MiB。`
    };
  }
  return { ok: true, detail: `预计需要约 ${needMiB} MiB，当前可用约 ${cap} MiB，余量充足。` };
}

/* ─────────────── 本机自定义节点能力矩阵（本项目专属） ─────────────── */

/**
 * 本机 ComfyUI 装了什么节点，决定哪些能力真的可用。
 *
 * ⚠️ 这些类名**是从真实 /object_info 取证来的**（2026-10-20 实测 1459 个节点），
 * **不要凭记忆改**：第一版凭记忆写的 `LTXVLoader` / `ManagerNode` / `RMBGModelLoader` /
 * `IPAdapterApply` **全都不存在** —— 而且错得很"合理"，只有接真数据才能发现。
 * 改这里之前先跑一次 `node scripts/doctor.mjs`，或直接查 /object_info。
 */
const CAPABILITY_PROBES = [
  { key: 'gguf', label: 'GGUF 量化模型加载', nodes: ['UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced', 'DualCLIPLoaderGGUF', 'CLIPLoaderGGUF'], why: '6G 显存首选：量化档比 fp16 省一半以上显存。' },
  { key: 'rmbg', label: '背景移除', nodes: ['RMBG', 'BiRefNetRMBG'], why: '做 remove_background 用。' },
  { key: 'wanvideo', label: 'Wan 视频生成', nodes: ['WanVideoModelLoader', 'WanVideoSampler', 'WanVideoTextEncode'], why: '文生视频/图生视频。6G 上非常勉强，需低分辨率 + 少帧。' },
  { key: 'ipadapter', label: 'IPAdapter 风格/角色参考', nodes: ['IPAdapter', 'IPAdapterAdvanced', 'IPAdapterUnifiedLoader', 'IPAdapterModelLoader'], why: '做风格参考与角色一致性。' },
  { key: 'controlnet_aux', label: 'ControlNet 预处理器', nodes: ['CannyEdgePreprocessor', 'OpenposePreprocessor', 'DepthAnythingPreprocessor'], why: '姿态/边缘/深度控制。' },
  { key: 'ltxvideo', label: 'LTX 视频', nodes: ['LTXVBaseSampler', 'EmptyLTXVLatentVideo', 'LTXVConditioning', 'LTXVScheduler'], why: '另一种视频方案，比 Wan 轻。' },
  { key: 'video_helper', label: '视频合成工具', nodes: ['VHS_VideoCombine', 'VHS_LoadVideo'], why: '把帧合成为 mp4/webm。' },
  { key: 'upscale', label: '放大', nodes: ['UltimateSDUpscale'], why: '低分辨率出图后放大。' }
];

/**
 * 目录级能力（不是节点，靠 custom_nodes 目录名判断）。
 * ComfyUI-Manager 这类插件只注册菜单/API，**不注册节点** —— 用节点探测会误报「不可用」。
 */
const DIRECTORY_PROBES = [
  { key: 'manager', label: 'ComfyUI-Manager', dirs: ['ComfyUI-Manager', 'ComfyUI-Manager-main'], why: '装/更新自定义节点。' },
  { key: 'impact', label: 'Impact-Pack', dirs: ['ComfyUI-Impact-Pack'], why: '诊断/修脸/细节增强等。' },
  { key: 'alekpet', label: 'AlekPet 节点包', dirs: ['ComfyUI_Custom_Nodes_AlekPet'], why: '一批实用小节点。' }
];

/**
 * 扫描本机能力矩阵。
 * @param objectInfo - 完整 /object_info 结果（一次拉取，避免 N 次请求）
 * @param customNodeDirs - custom_nodes 下的目录名清单（可选；给了就能探到 Manager 这类「只注册菜单不注册节点」的插件）
 */
export function capabilityMatrix(objectInfo, customNodeDirs) {
  const all = objectInfo && typeof objectInfo === 'object' ? objectInfo : {};
  const dirs = Array.isArray(customNodeDirs) ? customNodeDirs : [];

  const byNode = CAPABILITY_PROBES.map((probe) => {
    const available = probe.nodes.filter((name) => name in all);
    return {
      key: probe.key,
      label: probe.label,
      available: available.length > 0,
      nodes: available,
      missing: probe.nodes.filter((name) => !(name in all)),
      why: probe.why
    };
  });

  const byDir = DIRECTORY_PROBES.map((probe) => {
    // 目录清单没给时不判定（返回 unknown，而不是误报「不可用」）。
    if (dirs.length === 0) {
      return {
        key: probe.key, label: probe.label, available: undefined,
        nodes: [], missing: [], why: probe.why, note: '未读取 custom_nodes 目录，无法判定'
      };
    }
    const present = probe.dirs.filter((d) => dirs.includes(d));
    return {
      key: probe.key,
      label: probe.label,
      available: present.length > 0,
      nodes: present,
      missing: probe.dirs.filter((d) => !dirs.includes(d)),
      why: probe.why
    };
  });

  return [...byNode, ...byDir];
}

/** 读一个 ComfyUI 安装根下的 custom_nodes 目录名清单。 */
export async function listCustomNodes(comfyuiDirs, fsModule = null) {
  const fs = fsModule ?? (await import('node:fs'));
  const dirs = Array.isArray(comfyuiDirs) ? comfyuiDirs : [];
  const found = new Set();
  for (const dir of dirs) {
    for (const candidate of [dir, `${dir}\\ComfyUI`]) {
      const target = `${candidate}\\custom_nodes`;
      try {
        if (!fs.existsSync(target)) continue;
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
          if (entry.isDirectory()) found.add(entry.name);
        }
      } catch {
        // 目录不可读就跳过
      }
    }
  }
  return [...found];
}

/* ─────────────── 模型仓体检（本机头号问题） ─────────────── */

/** 要体检的模型目录（相对 ComfyUI 根）。 */
const MODEL_DIRS = [
  ['checkpoints', '底模'],
  ['loras', 'LoRA'],
  ['vae', 'VAE'],
  ['unet', 'UNet'],
  ['diffusion_models', '扩散模型'],
  ['clip', 'CLIP / 文本编码器'],
  ['text_encoders', '文本编码器'],
  ['controlnet', 'ControlNet'],
  ['embeddings', 'Embedding'],
  ['upscale_models', '放大模型'],
  ['background_removal', '去背模型'],
  ['LLM', 'LLM'],
  ['audio_encoders', '音频编码器']
];

/**
 * 从 ComfyUI 侧的 /object_info 与文件系统两条路核对模型仓。
 *
 * 只用 /object_info 判定底模是否为空是不够的（它只报「可选项」），
 * 所以这里同时读文件系统 —— 两者互相印证，报告更可信。
 */
export async function probeModelRepo(comfyuiDirs, objectInfo, fsModule = null) {
  const fs = fsModule ?? (await import('node:fs'));
  const dirs = Array.isArray(comfyuiDirs) ? comfyuiDirs : [];
  const roots = [];
  for (const dir of dirs) {
    // 用户配的可能是安装根（含 ComfyUI/ 子目录），也可能是 ComfyUI 本体。
    for (const candidate of [dir, `${dir}\\ComfyUI`]) {
      try {
        if (fs.existsSync(`${candidate}\\models`)) roots.push(candidate);
      } catch {
        // 目录不可读就跳过
      }
    }
  }

  const counts = {};
  for (const [key, label] of MODEL_DIRS) {
    counts[key] = { label, files: 0, samples: [] };
  }
  for (const root of roots) {
    for (const [key] of MODEL_DIRS) {
      const target = `${root}\\models\\${key}`;
      try {
        if (!fs.existsSync(target)) continue;
        const entries = fs.readdirSync(target, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const name = entry.name;
          // 秋叶版放的是 put_xxx_here 占位符，不算模型。
          if (/^put_.*_here$/i.test(name)) continue;
          if (/\.(safetensors|ckpt|pt|pth|gguf|bin|sft|onnx)$/i.test(name)) {
            counts[key].files += 1;
            if (counts[key].samples.length < 5) counts[key].samples.push(name);
          }
        }
      } catch {
        // 权限/路径问题跳过
      }
    }
  }

  const fromInfo = enumChoices(objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name) ?? [];
  const report = {
    roots,
    counts,
    checkpointCount: counts.checkpoints.files,
    checkpointFromObjectInfo: fromInfo.length,
    empty: counts.checkpoints.files === 0 && fromInfo.length === 0
  };
  return report;
}

/** 一套可执行的补齐方案（空模型仓时给，不是一句抱怨）。 */
export function suggestModels(probe, config) {
  const lines = [];
  const budget = config?.vramBudgetMiB ?? 5500;
  lines.push(`按本机 ${Math.round(budget / 1024)}G 显存预算，推荐顺序：`);
  lines.push('  ① SD1.5 系（约 2 GB，最稳）—— 例如 anything-v5 / dreamshaper_8，512×512 出图轻松。');
  lines.push('  ② SDXL 系 GGUF 量化档（约 3.5 GB）—— 本机已装 ComfyUI-GGUF 节点，优先走这条，1024×1024 可行。');
  lines.push('  ③ SDXL 系 fp16（约 6.5 GB）—— 会非常紧张，不推荐单独跑，除非配 --lowvram。');
  lines.push('下载源建议：ModelScope（modelscope.cn，国内直连实测 6~8 MB/s，比 HuggingFace 快十倍）。');
  if (Array.isArray(probe?.roots) && probe.roots.length > 0) {
    lines.push(`放到：${probe.roots.map((r) => `${r}\\models\\checkpoints`).join(' 或 ')}`);
  } else {
    lines.push('放到：<你的 ComfyUI 目录>\\models\\checkpoints（先在设置页确认 comfyuiDirs）。');
  }
  lines.push('放好后在 ComfyUI 界面刷新，再跑一次 comfy_doctor 复查。');
  return lines.join('\n');
}
