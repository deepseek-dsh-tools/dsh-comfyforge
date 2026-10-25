#!/usr/bin/env node
/**
 * ComfyForge 自检（doctor）——「本机到底能不能出图」的体检报告。
 *
 * 用法（**不需要 DSH，独立跑**）：
 *   node scripts/doctor.mjs                       # 按当前配置体检
 *   node scripts/doctor.mjs --base-url http://192.168.1.9:8188
 *   node scripts/doctor.mjs --json                # 机器可读（给 CI / 脚本用）
 *   node scripts/doctor.mjs --suggest-model       # 模型仓为空时给补齐方案
 *   node scripts/doctor.mjs --config-file <路径>  # 用别的配置文件
 *
 * 退出码：
 *   0 = 全绿（能出图）
 *   1 = 连不上 ComfyUI
 *   2 = 连上了但有阻塞项（模型仓为空 / 缺核心节点）
 *   3 = 配置或工具名有冲突
 * 刻意不抛异常堆栈 —— 这是给人看的体检报告，不是测试。
 *
 * 吸收自 dsh-comfyui-image 的 scripts/doctor.mjs，并按本机情况增强（模型仓 + 显存 + 能力矩阵）。
 */
import process from 'node:process';
import { CONFIG_FILE, resolveConfig, DEFAULT_COMFYUI_DIRS } from '../lib/config.js';
import { ComfyUIClient } from '../lib/client.js';
import {
  capabilityMatrix,
  checkVram,
  listCustomNodes,
  probeModelRepo,
  probeServer,
  suggestModels
} from '../lib/probe.js';
import { CORE_NODES } from '../lib/index.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const wantSuggest = argv.includes('--suggest-model');
const baseUrlFlagIndex = argv.indexOf('--base-url');
if (baseUrlFlagIndex >= 0 && argv[baseUrlFlagIndex + 1]) {
  process.env.COMFYUI_URL = argv[baseUrlFlagIndex + 1];
}
const configFileFlagIndex = argv.indexOf('--config-file');
if (configFileFlagIndex >= 0 && argv[configFileFlagIndex + 1]) {
  process.env.DSH_COMFYFORGE_CONFIG = argv[configFileFlagIndex + 1];
}

const config = resolveConfig(undefined);

const lines = [];
const say = (text = '') => {
  lines.push(text);
  if (!asJson) process.stdout.write(`${text}\n`);
};
const ok = (text) => say(`  \u2713 ${text}`);
const bad = (text) => say(`  \u2717 ${text}`);
const warn = (text) => say(`  ! ${text}`);
const head = (text) => say(`\n${text}`);

const report = {
  plugin: 'dsh-comfyforge',
  generatedAt: new Date().toISOString(),
  configFile: CONFIG_FILE,
  reachable: false,
  comfyui: null,
  coreNodes: { ok: false, missing: [] },
  models: null,
  capabilities: [],
  vram: null,
  exitCode: 0
};

/* ───────────────────── 1. 生效配置 ───────────────────── */
head('一、生效配置');
say(`  配置文件：${CONFIG_FILE}${CONFIG_FILE !== process.env.DSH_COMFYFORGE_CONFIG ? '' : '（由 --config-file 指定）'}`);
ok(`baseUrl        = ${config.baseUrl}`);
ok(`comfyuiDirs    = ${config.comfyuiDirs.join('、') || '（空 —— 未配置）'}`);
ok(`vramBudgetMiB  = ${config.vramBudgetMiB}`);
ok(`dataDir        = ${config.dataDir}`);
ok(`timeoutMs      = ${config.timeoutMs}`);

/* ───────────────────── 2. 连服务器 ───────────────────── */
head('二、ComfyUI 服务器');
const client = new ComfyUIClient(config.baseUrl, undefined, config.connectTimeoutMs, config.maxMediaBytes);
let objectInfo;
try {
  objectInfo = await client.objectInfo();
  const probe = await probeServer(client);
  report.reachable = true;
  report.comfyui = probe;
  ok(`可达：${config.baseUrl}`);
  ok(`ComfyUI ${probe.version}${probe.pythonVersion ? ` · Python ${probe.pythonVersion}` : ''}`);
  if (probe.deviceName) {
    ok(`设备：${probe.deviceName}${probe.vramTotalMiB ? ` · 显存 ${probe.vramTotalMiB} MiB（空闲 ${probe.vramFreeMiB ?? '?'} MiB）` : ''}`);
  }
  const queue = await client.getQueue().catch(() => undefined);
  if (queue) {
    say(`  队列：运行中 ${queue.queue_running.length} · 等待中 ${queue.queue_pending.length}`);
  }
} catch (error) {
  bad(`连不上：${config.baseUrl}`);
  say(`    → ${error?.message ?? String(error)}`);
  if (error?.hint) say(`    → ${error.hint}`);
  report.exitCode = 1;
  if (!asJson) {
    say('\n结论：ComfyUI 没在跑。启动它（D:\\QWQ\\ComfyUI-aki-v3.2\\绘世启动器.exe）再跑一次体检。');
  }
  emit();
  process.exit(report.exitCode);
}

/* ───────────────────── 3. 核心节点 ───────────────────── */
head('三、核心节点');
const missingCore = CORE_NODES.filter((nodeName) => !(nodeName in (objectInfo ?? {})));
report.coreNodes = { ok: missingCore.length === 0, missing: missingCore };
say(`  总节点数：${Object.keys(objectInfo ?? {}).length}`);
if (missingCore.length === 0) {
  ok(`核心节点齐全（${CORE_NODES.length} 个）`);
} else {
  bad(`缺 ${missingCore.length} 个核心节点：${missingCore.join('、')}`);
  say('    → 核心节点是 ComfyUI 自带的，缺它们说明地址不对或版本太旧。');
  report.exitCode = 2;
}

/* ───────────────────── 4. 模型仓（本机头号问题） ───────────────────── */
head('四、模型仓体检');
const repo = await probeModelRepo(config.comfyuiDirs, objectInfo).catch((error) => {
  warn(`模型仓体检失败：${error?.message ?? String(error)}`);
  return null;
});
if (repo) {
  report.models = repo;
  say(`  扫描到的 ComfyUI 根：${repo.roots.length > 0 ? repo.roots.join('、') : '（没找到含 models/ 的目录）'}`);
  const nonEmpty = Object.entries(repo.counts).filter(([, v]) => v.files > 0);
  if (nonEmpty.length === 0) {
    bad('模型仓是空的 —— 一个模型都没有。');
  } else {
    for (const [key, value] of nonEmpty) {
      ok(`${value.label}（models/${key}）：${value.files} 个${value.samples.length ? ` — ${value.samples.slice(0, 3).join('、')}` : ''}`);
    }
  }
  say(`  /object_info 报告的底模数：${repo.checkpointFromObjectInfo}`);
  if (repo.empty) {
    report.exitCode = report.exitCode === 0 ? 2 : report.exitCode;
    warn('没有底模 → 任何出图工作流都跑不了。');
    if (wantSuggest || !asJson) {
      say('\n  补齐方案：');
      for (const line of suggestModels(repo, config).split('\n')) say(`  ${line}`);
    }
  }
}

/* ───────────────────── 5. 能力矩阵 ───────────────────── */
head('五、自定义节点能力矩阵');
const customNodeDirs = await listCustomNodes(config.comfyuiDirs).catch(() => []);
const caps = capabilityMatrix(objectInfo, customNodeDirs);
report.capabilities = caps;
report.customNodes = customNodeDirs;
say(`  custom_nodes 下 ${customNodeDirs.length} 个目录`);
for (const cap of caps) {
  if (cap.available === true) ok(`${cap.label}（${cap.nodes.join('、')}）`);
  else if (cap.available === false) warn(`${cap.label} —— 不可用（缺 ${cap.missing.join('、')}）`);
  else warn(`${cap.label} —— ${cap.note}`);
}
const rmBgCap = caps.find((c) => c.key === 'rmbg');
if (rmBgCap && rmBgCap.available) {
  say(`  → 去背景可用；本机装的是 ComfyUI-RMBG（节点 ${rmBgCap.nodes.join('、')}）。`);
}
const wanCap = caps.find((c) => c.key === 'wanvideo');
if (wanCap && wanCap.available) {
  warn('Wan 视频在本机 6G 显存上非常勉强 —— 只建议低分辨率 + 少帧，且先用 checkVram 估算。');
}

/* ───────────────────── 6. 显存预检 ───────────────────── */
head('六、显存预检');
if (report.comfyui) {
  const vram = checkVram(report.comfyui, undefined, config.vramBudgetMiB);
  report.vram = vram;
  say(`  ${vram.detail}`);
  if (!vram.ok) warn('显存偏紧 —— 跑大工作流前请调小分辨率或换量化模型。');
}

/* ───────────────────── 结论 ───────────────────── */
head('结论');
const blockers = [];
if (report.exitCode === 1) blockers.push('连不上 ComfyUI');
if (missingCore.length > 0) blockers.push(`缺 ${missingCore.length} 个核心节点`);
if (repo?.empty) blockers.push('模型仓为空（没有底模）');
if (blockers.length === 0) {
  say('  可以出图。');
  report.exitCode = 0;
} else {
  say(`  阻塞项：${blockers.join('；')}`);
}
if (report.exitCode === 0 && (rmBgCap?.available ?? false) === false) {
  say('  （提示：去背景不可用，但其它模式正常。）');
}

emit();
process.exit(report.exitCode);

/** 输出：JSON 或已打印过的文本。 */
function emit() {
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
