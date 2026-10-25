# ComfyForge 插件 · 开发规格书

> **用途**：把这整份文档交给一个新对话（创造模式），即可从零构建本插件。
> **来源**：2026-10-20 妈妈（LCS）对三款现役 DSH ComfyUI 插件的源码级逆向（共 2.3 万行），结论见 `reference/吸收笔记-0{1,2,3}-*.md`。
> **参考源码**：`reference/dsh-comfyui-0.5.5/`、`reference/dsh-comfyui-image-0.1.1/`、`reference/dsh-comfyui-canvas-0.1.13/`。

---

## 0. 一句话定位

**ComfyForge = 把「工作流平台能力」（dsh-comfyui）× 「可靠性工程」（dsh-comfyui-image）× 「原生画布嵌入」（dsh-comfyui-canvas 的范式）合成一个插件，针对本机（RTX 3060 6G + 空模型仓 + 秋叶 ComfyUI）做定制。**

**它要解决的核心问题**（三家的共同短板）：
1. **本机一个模型都没有** → 三家都会在此卡住或瞎猜；ComfyForge 要「**探测到空 → 给可执行的补齐方案**」，而不是一句「没有可用底模」。
2. **6G 显存** → 默认工作流必须轻量，重工作流要先估算显存再放行。
3. **工具重名** → 现役 Agnes 插件已占用 `generate_image`；ComfyForge 自己的工具一律 `comfy_*` 前缀，**绝不抢名**。
4. **可靠性** → 三家只有一家有 doctor、只有一家有测试；ComfyForge 两样都要，且要能在**没有真 ComfyUI** 时自测。
5. **安全** → 不写用户 ComfyUI 安装目录（或写了必须备份+指纹+可卸载）、桥接必须鉴权、路径校验必须 `realpath`。

---

## 1. 运行环境（硬事实，实施时按此写死默认值）

| 项 | 值 | 出处 |
|---|---|---|
| DSH 宿主 | **0.2.1-rc.2** | `D:\DSH\resources\app.asar` 的 `dsh/desktop-runtime.json` |
| 宿主内置包 | `dsh-settings 0.2.1-rc.2`、`dsh-tools 0.2.1-rc.2`、`cordis 4.0.5`、`schemastery 3.18.5` | 同上（asar 内 package.json 实测） |
| `engines.dsh` 必须声明 | `>=0.2.0-rc.1 <0.3.0-0` | **0.2.1 起兼容检查只读这个字段** |
| `peerDependencies` | `@deepseek-ai/dsh-settings` 要含 `^0.2.0-alpha.1 \|\| ^0.2.1-alpha.1` | **semver 预发布范围永不跨 x.y.z 线**，漏了就装不上（dsh-comfyui issue #12） |
| ComfyUI 安装根 | `D:\QWQ\ComfyUI-aki-v3.2`（秋叶 v3.2） | 本机实测 |
| ComfyUI 本体 | `.../ComfyUI`，版本 **0.30.2** | `ComfyUI/comfyui_version.py` |
| ComfyUI Python | `D:\QWQ\ComfyUI-aki-v3.2\python\python.exe`（**3.13.11**） | 本机实测 |
| torch | **2.13.0+cu130**，`cuda.is_available() == True` | 本机实测 |
| GPU | **RTX 3060 Laptop，6144 MiB**（当前占用 691MiB / 6%） | `nvidia-smi` |
| 默认端口 | 8188（当前**未监听** —— ComfyUI 没在跑） | `netstat` 实测 |
| 已装自定义节点 | `ComfyUI-GGUF`、`ComfyUI-Impact-Pack`、`ComfyUI-LTXVideo`、`ComfyUI-Manager`、**`ComfyUI-RMBG`**、`ComfyUI-VideoHelperSuite`、`ComfyUI-WanVideoWrapper`、`ComfyUI_Custom_Nodes_AlekPet`、`ComfyUI_IPAdapter_plus`、`ComfyUI_UltimateSDUpscale`、`comfyui_controlnet_aux` | `custom_nodes/` 实测 |
| **模型仓状态** | **`models/checkpoints`、`loras`、`vae`、`unet`、`clip` 等目录全部只有 `put_xxx_here` 占位符 —— 零模型** | 本机实测（**这是设计的头号约束**） |
| 用户已存工作流 | `user/default/workflows/` 为空 | 本机实测 |
| 输入/输出目录 | `input/` 3 个文件、`output/` 2 个文件 | 本机实测 |

---

## 2. 项目脚手架（可直接照抄的参数）

```
项目根：D:\用户\代码\dsh-comfyforge\
├── package.json          name: dsh-comfyforge（或 @local/dsh-comfyforge）
├── cordis.patch.yml      bundle patch：insert 一条 entry
├── lib/                  宿主侧（ESM，无需构建，或 TS→tsc）
│   ├── index.js          插件入口：apply(ctx, config)
│   ├── config.js         schemastery Config schema（volatile 标记）
│   ├── client.js         ComfyUI HTTP 客户端
│   ├── probe.js          能力探测层（不发光的纯查）
│   ├── graph.js          图链接归一化 + 虚拟节点改线
│   ├── convert.js        图 → API 转换
│   ├── analyze.js        连通分量分析
│   ├── workflows.js      内置工作流构建（纯函数）
│   ├── store.js          持久化（JSON 文件）
│   ├── skillpack.js      技能包读写
│   ├── errors.js         错误体系（hint）
│   ├── tools.js          工具注册
│   ├── routes.js         HTTP 路由
│   ├── proxy.js          媒体代理
│   └── doctor.js         自检
├── client/
│   └── client.js         浏览器半：window.__ModuleLoader__.load
├── scripts/
│   ├── doctor.mjs        自检（可脱离 DSH 运行）
│   └── run-tests.mjs     测试（自带 mock ComfyUI）
└── test/
    └── mock-comfy.mjs    mock 后端
```

### package.json 关键字段（照抄）

```jsonc
{
  "name": "dsh-comfyforge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./client/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=22.19", "dsh": ">=0.2.0-rc.1 <0.3.0-0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-settings": "^0.2.0-alpha.1 || ^0.2.1-alpha.1"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.4"   // 可选：不导出 Config 也能工作
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale"]
    }
  }
}
```

**`cordis.patch.yml`**（4 行，照抄）：
```yaml
- insert:
    - id: comfyforge
      name: 'dsh-comfyforge'
```

安装（**装完必须重启 DSH**）：
```
dsh plugin --profile desktop add link:D:/用户/代码/dsh-comfyforge
```
或用 `github:` / npm 形式。

---

## 3. 插件入口契约（最关键的接口，必须精确）

### 3.1 必需 / 可选服务分离（**照抄 dsh-comfyui `lib/index.js:27`**）

```js
export const name = 'dsh-comfyforge';
export const inject = ['tools'];              // ← 只这一个必需
export const Config = /* schemastery schema */;  // 可选

export async function apply(ctx, entryConfig) { /* ... */ }
```

**规则**：
- `inject` 只放 `tools`。缺了它 `ctx.tools` 会报 `cannot get property "tools" without inject`。
- `webServer` / `settings` / `credentials` / `skills` **一律不进 inject**，改为：
  - 需要在装配后就要的（路由）→ `ctx.inject(['webServer'], (webCtx) => { ... })`（**sub-fiber，不能在 apply 里一次性 `ctx.get`** —— loader 条目并发激活，webServer 可能晚到）
  - 只需读一次的（配置写状态）→ `ctx.get('settings')?.writable === true`
  - 只在运行时用的（取 API key）→ `ctx.get('credentials')`
- **headless 宿主**（无 webServer）必须能正常运行：只有工具，没有路由/UI，**不报错**。

### 3.2 全部资源用 `ctx.effect()` 登记

```js
ctx.effect(() => {
  const disposers = registerComfyForgeTools(ctx, runtime);
  return () => disposers.forEach(d => d());
}, 'comfyforge: tools');
```
工具、路由、技能、socket、样式，**每个都要返回 disposer**。漏一个就在热重载时泄漏。

### 3.3 设置页（**双版本适配**）

```js
ctx.inject(['settings'], (settingsCtx) => {
  const settings = settingsCtx.settings;
  if (typeof settings.installSection === 'function') {          // dsh 0.1.2–0.1.5
    settings.installSection(ctx, NS, Config, resolved, { setSource, onChange });
    return;
  }
  if (typeof settings.configure === 'function') {               // dsh 0.1.7+
    const configure = settings.configure.bind(settings);
    settingsCtx.effect(() => configure({ auto: false }, ctx.fiber), 'comfyforge: settings policy');
  }
});

// dsh 0.1.7+：保存后走这个事件拿新值
ctx.on('loader/volatile-update', () => refreshConfig(resolveConfig(entryConfig)));
```
**注意 dsh-comfyui 的 issue #20**：0.2.x 上设置页可能报 `Plugin entry "comfyui" is no longer configurable`。ComfyForge 的对策：**设置页尽力而为，配置文件兜底**（见 §6.2），绝不把「能改地址」这件事只押在设置页上。

### 3.4 Config schema（**必须标 volatile，否则设置页保存失败**）

```js
export const Config = z.object({
  baseUrl:         z.string().default('http://127.0.0.1:8188').volatile(),
  apiKeyEnv:       z.string().default('COMFYUI_API_KEY').volatile(),
  connectTimeoutMs:z.number().min(1_000).max(60_000).default(10_000).volatile(),
  timeoutMs:       z.number().min(5_000).max(3_600_000).default(900_000).volatile(),
  pollIntervalMs:  z.number().min(200).max(10_000).default(1_000).volatile(),
  maxMediaItems:   z.number().min(1).max(50).default(12).volatile(),
  maxMediaBytes:   z.number().min(64*1024).max(512*1024*1024).default(64*1024*1024).volatile(),
  mediaHost:       z.string().default('').volatile(),
  comfyuiDirs:     z.array(z.string()).default([]).volatile(),   // ← 默认填 ['D:\\QWQ\\ComfyUI-aki-v3.2']
  skillsDir:       z.string().default('').volatile(),
  outputDir:       z.string().default(''),                       // 非 volatile：改了重启
  dataDir:         z.string().default(''),
  maxAssets:       z.number().min(1).max(10_000).default(200),
  vramBudgetMiB:   z.number().min(1024).default(5500).volatile() // ← ComfyForge 新增：6G 机器的显存预算
});
```
**volatile 读取的双形态兼容**（**照抄 dsh-comfyui `lib/config.js:54-61`**）：
```js
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
function current(value) {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) return value.get();
  return value;
}
```
> **这是妈妈亲自踩过的坑**：带 `.volatile()` 的字段在运行期是 accessor，不带的是普通值。照抄别人用 `.get()` 会在运行时炸 `config.X.get is not a function`。

---

## 4. 工具清单（对外契约）

### 4.1 命名铁律

- **一律 `comfy_` 前缀**（`comfy_workflow` / `comfy_skill` / `comfy_object_info` / `comfy_run` / `comfy_status` / `comfy_doctor`）。
- **绝不注册 `generate_image`** —— 本机 `dsh-agnes-multimodal` 已占用（`lib/index.js:463`）。若真要提供图片生成入口，用 `comfy_image`。
- 若将来要接管 `generate_image`，必须是**用户显式要求**且先卸载 Agnes，并在 doctor 里报警。

### 4.2 主入口 `comfy_workflow`（action 复用式）

| action | 作用 | 输出成本 |
|---|---|---|
| `list` | 列出可运行工作流 + 参数清单 + env + 加载区 + ComfyUI 端图工作流 | 中（**唯一的入口**） |
| `run` | 按 id 运行 + 参数覆盖（**拒绝未知参数名**） | 高（含结果） |
| `get` | 取单个工作流完整 JSON —— **明确标注「仅诊断，非运行路径」** | 很高 |
| `refresh` | 重算参数快照（options/min/max/step） | 低 |
| `skill` | 取某工作流的技能包正文（三级披露第二级） | 中 |
| `status` | **ComfyForge 新增**：只读探活 + 队列概况（不生成，不消耗 GPU） | 低 |

**参数 schema 硬约束**（**照抄 dsh-comfyui-image `tool.ts:8-11` 的教训**）：
- `parameters` 必须是**原始 JSON Schema**，不是 `required: true` 那种 DSL 写法。
- DSH 的 schema 子集是**强制**的：`minimum`/`maximum`/`format` 会被 `assertSupportedJsonSchema` **直接拒绝** → 范围只写进 `description`，运行时兜底校验。
- 输出用**无损 JSON**：可选字段用条件赋值，**不要塞 `undefined`**（`JSON.stringify` 会丢键）。

#### ⚠️ Schema 精确白名单（**妈妈从宿主 asar 里取证，2026-10-20**）

出处：`D:\DSH\resources\app.asar` → `@deepseek-ai/dsh-tools/lib/index.js` 的 `assertSupportedJsonSchema` / `checkSchemaNode`。

**允许的约束键（只有这 8 个）**：
```
type  oneOf  properties  required  additionalProperties  items  enum  const
```
**允许的注解键（只有这 4 个，值必须是无损 JSON）**：
```
description  title  default  examples
```
**一律 reject**：`minimum` `maximum` `exclusiveMinimum` `exclusiveMaximum` `format` `pattern` `minLength` `maxLength` `minItems` `maxItems` `uniqueItems` `multipleOf` `$ref` `$schema` `definitions` `allOf` `anyOf` `not` `if` `then` `else` …
报错原文：`… is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`

**另有 7 条结构约束**：
1. `type` 与 `oneOf` **不能并存**。
2. 声明了 `properties`/`required`/`additionalProperties`/`items`/`enum`/`const` → **必须有 `type` 或 `oneOf`**（报 `… requires type or oneOf`）。
3. `oneOf` 必须是**至少两个** schema 的数组。
4. **`oneOf` 旁边不许有** `properties`/`required`/`additionalProperties`/`items`/`enum`/`const`。
5. `type` 必须是允许的类型名之一。
6. `description` / `title` 必须是**字符串**。
7. **循环引用报 `… is circular`**。

**照做三条**：
- **范围只写 `description`**，运行时兜底校验。
- **必填随模式变化** → `required: []` + `additionalProperties: false`，必填性交运行时按模式判（别假装 schema 能表达）。
- **结构化输出 schema 必须是 object 根**（`assertObjectJsonSchema` 要求 `schema.type === "object"`）。

**「拒绝未知参数」**（**照抄 dsh-comfyui `tools.js:751-757`**）：
```js
const known = new Set((saved.parameters ?? []).map(p => p.name));
const unknown = Object.keys(values).filter(n => !known.has(n));
if (unknown.length > 0) {
  throw new Error(`comfy_workflow: "${saved.name}" has no parameter ${unknown.map(n=>`"${n}"`).join(', ')} — nothing was submitted. Valid parameter names: ${[...known].join(', ') || '(none)'}`);
}
```
> **为什么**：静默忽略拼错的键 → 模型以为「ComfyUI 无视我的提示词」。这是最坑的静默失败。

### 4.3 `comfy_skill`（技能包读写，**Agent 自己变聪明的机制**）

动作（每个都带 `workflow_id`）：`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`。

- `enable` = **唯一的创建路径**（建目录 + 写骨架 SKILL.md，自动列出该工作流全部可调参数名占位）。
- `write` 是**整体覆盖** → 给已有文件加内容必须用 `append`。
- `SKILL.md` 不能改名/删除；整包销毁是用户在面板上的决定。
- **「运行前必读」门禁**（**照抄 dsh-comfyui `tools.js:5-30, 743-745`**）：
```js
const skillPackReads = new WeakMap();   // Agent → Set<workflowId>
function markSkillPackRead(agent, id) { /* ... */ }
function hasReadSkillPack(agent, id) {
  if (typeof agent !== 'object' || agent === null) return true;  // 内部调用不拦
  return skillPackReads.get(agent)?.has(id) === true;
}
```
**用 WeakMap 键是会话对象** → 条目生命周期与会话完全一致，无需清理，不跨会话（**键为 WeakMap 不会内存泄漏** —— 这是精髓）。

### 4.4 三级披露（**最省 token 的设计，必须实现**）

```
① comfy_workflow action:list  → 挂技能包的工作流只多出一行「技能包: <摘要>」（含文件数、是否必读）
② comfy_workflow action:skill → 返回 SKILL.md 正文 + <skill_resources> 绝对目录  ← 同时解除「必读」门禁
③ 正文点名 references/xxx.md → 模型自己用文件工具读那一篇（assets/ 里的图同理，按需取）
```
**关键洞察**（**照抄 dsh-comfyui `skillpack.js:1-24`**）：技能包**不注册进 `ctx.skills`** —— 那个注册表会把技能发布到**常驻 catalog**，正是要避免的成本。所以技能包自己做文件系统 + 工具读取。

**`action: skill` 的返回框架**（**照抄 dsh-comfyui `tools.js:495-511`**）：
```
<skill_content name="...">
<skill_resources>
Base directory for this skill: <绝对路径>
Files in this pack: a.md, b.md — resolve them against the base directory and read one only when the instructions below point at it.
</skill_resources>

<skill_instructions>
<body>
</skill_instructions>
</skill_content>
```

**技能包目录形状**（一层深，对齐宿主 skill 规范）：
`references/` `scripts/` `assets/` `templates/` `agents/`（可自定义，但要过名字正则）

**上限**：单文本文件 256 KB（**它整份进上下文**）；`assets/` 二进制 4 MB；整包 2000 文件 / 20 MB。

### 4.5 工具描述里要写「行为纪律」

**照抄 dsh-comfyui `tools.js:465` 的手法** —— 在 description 里直接写模型的正确行为：
- async 提交后**结束本轮**，不要 `job_output wait:true`、不要 sleep/poll；完成通知会唤醒。
- **结果就是最终结果**：地址已带好，不要再查状态、不要再查资产、不要拼 URL。
- 把结果给的 Markdown 行**原样贴进回复**（那是用户唯一看得到结果的地方）。
- **`get` 不是运行路径**（会输出完整 JSON、吃大量 token）。
- 视频/音频**一律 async**（几分钟，sync 会超时）。

---

## 5. 异步与进度（视频/音频必需）

### 5.1 job 契约双版本适配（**照抄 dsh-comfyui `tools.js:31-55`**）
```js
function sessionJobs(jobs) { return typeof jobs.readAt === 'function'; }        // 0.1.7+ 探测能力，不查版本号
function jobOwner(jobs, agent) { /* {owner: agent} vs {owner: agent.id} */ }
function jobCompleted(jobs, text) { return sessionJobs(jobs) ? {status:'completed', result:text} : {status:'completed', output:text}; }
function jobFailed(jobs, msg)     { return sessionJobs(jobs) ? {status:'failed', detail:`comfyforge: ${msg}`} : {status:'failed', detail:'comfyforge', output: msg}; }
```

### 5.2 只取消自己那条（**照抄 `comfyui.js:280-297`**）
```js
async cancelPrompt(promptId) {
  const q = await this.getQueue();
  if (q.queue_pending.some(i => i.prompt_id === promptId)) return this.deleteQueueItems([promptId]);
  if (q.queue_running.some(i => i.prompt_id === promptId)) return this.interruptPrompt(promptId);
}
```
> **为什么**：裸 `interrupt()` 会打断**别人正在跑的任务**（另一个会话的、或用户自己在 ComfyUI 点的）。它踩过这个 bug 并修了。

### 5.3 WebSocket 进度（best-effort，**照抄 `progress.js`**）
- 一个共享 socket 连 `ws://<baseUrl>/ws?clientId=<uuid>`，读 `progress` 事件（`{value,max,node,prompt_id}`）。
- 断了 3 秒重连（`scheduleRetry`）；`dispose()` 清定时器。
- **拉不到就退化成「无进度条」，绝不因此让生成失败**（远端鉴权代理连不上是常态）。
- **进度行只在值变化时发**（`if (line === lastLine) return;`）。
- 超时抛错前**先 `cancelPrompt`**，不留孤儿任务。

---

## 6. ComfyUI HTTP 客户端（工程细节，全是坑）

### 6.1 必备方法
`systemStats` / `objectInfo` / `queuePrompt` / `getHistory` / `getQueue` / `cancelPrompt` / `interruptPrompt` / `clearHistory` / `deleteHistory` / `freeMemory` / `listUserData` / `getUserDataFile` / `uploadMedia` / `fetchViewStreamed`

### 6.2 必须处理的 12 个坑

| # | 坑 | 解法（照抄位置） |
|---|---|---|
| 1 | 路由前缀：**只转发 `/api/*` 的反向代理**会让裸路由 404 | 首次请求探测，进程级 `Map<baseUrl, ''\|'/api'>` 缓存（`comfyui.js:65-113`） |
| 2 | `/upload/image` 只收 multipart，原始字节 POST → 400 | `FormData` + 字段名 `image` + `overwrite=true`（`comfyui.js:175-184`） |
| 3 | 视频上传连接超时太紧 | `Math.max(connectTimeoutMs, 120_000)` |
| 4 | 音视频拖动进度条要 206/Content-Range/416 | HEAD 转 HEAD；`maxMediaBytes` **只对 200 全量响应生效**（分段天然有界）（`proxy.js:13-33`） |
| 5 | **ComfyUI 的 `/history` 是内存态**，重启/清空后 prompt+node+index 式 URL 全 404 | 媒体 URL **按 filename/subfolder/type 直连**（`comfyui.js:503-516`） |
| 6 | 聊天 markdown 要求绝对 URL，局域网访问时 loopback 不显示 | 三级回退：显式 `mediaHost` → 浏览器实际 origin → 本机 LAN IP → loopback（`index.js:130-150` + `host-hint.js`） |
| 7 | 零配置学出用户访问地址 | 往 index.html **注入一行 `/comfyforge/ping` 自报**（`webServer.tapIndex`，`index.js:388-392`） |
| 8 | 有些节点把音频/视频塞进 `images`/`videos` 数组 | **按扩展名二次分类** `kind`，卡片才渲染播放器（`comfyui.js:522-555`） |
| 9 | 旧聊天记录的 URL 是老式 `prompt/node/index` | 回退查自己的资产索引补文件名（`proxy.js:98-113`） |
| 10 | 非标准自定义节点路由（如 TTS 音色库） | `getOk(path, timeout)`：404/网络错误一律吞掉返 false（`comfyui.js:146-154`） |
| 11 | `/v2/userdata` 在老版本不存在 | 探测 404 → 落回 `/userdata?dir=...&recurse=true` 并归一化（`comfyui.js:339-368`） |
| 12 | 同源保护 | `sameOrigin(request)`：比对 `Origin` 与 `Host`；POST 写操作必须过（`http.js:29-37`） |

### 6.3 本机专属：**空模型仓的专门诊断**

```js
// probe.js —— 底模三态（照抄 dsh-comfyui-image nodes.ts:120-158）
export async function chooseCheckpoint(client, preferred) {
  const info = await client.nodeInfo('CheckpointLoaderSimple');
  if (!info) throw new ImagePluginError('ComfyUI 里没有 CheckpointLoaderSimple 节点。',
    '这个节点是 ComfyUI 核心自带的。请确认 baseUrl 指向的是真的 ComfyUI，且版本不过旧。');
  const available = enumChoices(requiredInputs(info).ckpt_name) ?? [];
  if (available.length === 0) {
    // ★ 本机正中这条
    throw new ImagePluginError('ComfyUI 报告没有任何可用的底模（models/checkpoints 是空的）。', /* 见下方 ComfyForge 增强版 */);
  }
  if (preferred) { if (available.includes(preferred)) return {checkpoint: preferred, available};
    throw new ImagePluginError(`指定的底模不存在：${preferred}`, `本机可用的底模有：${available.slice(0,12).join('、')}…`); }
  return { checkpoint: available.find(n => /xl/i.test(n)) ?? available[0], available };
}
```

**ComfyForge 的增强（三家的共同短板，必须做）** —— 探测到空模型仓时，给的不能只是一句抱怨，而是：
1. **列出本机 ComfyUI 的确切目录**（从 `comfyuiDirs` 配置读）。
2. **给出按 6G 显存可用的候选模型清单**（含推荐量化档位、体积、预计显存），例如：
   - SD1.5 系（约 2 GB，6G 充裕）
   - SDXL 系（约 6.5 GB fp16 / **约 3.5 GB fp8 或 GGUF Q8 → 6G 可行**）
   - **本机已装 `ComfyUI-GGUF` 节点 → 优先推荐 GGUF 量化档**（这是本机真实优势）
3. **给出 ModelScope 下载源提示**（妈妈实测：ModelScope 国内直连 6~8 MB/s，比 HuggingFace 快十倍 —— 见 memory）。
4. **给出一条可复制的 `dsh-comfyforge doctor --suggest-model` 命令**。

---

## 7. 图 → API 转换器（最难替代的硬功夫，按需实现）

> **优先级说明**：如果 V1 只做「用户粘贴 API 格式 JSON / 从文件导入」，可以**先不做**这层。但只要想支持「跑我在 ComfyUI 里保存的那张图」，这层就是必需的。**它是三家能力的分水岭。**

### 7.1 步骤链（照抄 dsh-comfyui `graph.js` + `convert.js` + `analyze.js`）

```
① normalizeLinks      老前端位置数组 ↔ v0.4 对象条目，归一成 [id,origin,oSlot,target,tSlot,type]
② resolveVirtualLinks KJNodes SetNode/GetNode 按名字配对；rgthree Mute/Bypass Relay 丢弃
③ analyzeGraph        虚拟节点已改线 → 找连通分量（groups 只是矩形，无执行语义）
④ convertGraphToApi   分量 → API JSON
⑤ POST /prompt 校验   nodeErrors 必须为空才算提取成功
```

### 7.2 六个必须处理的转换坑

| # | 坑 | 解法 |
|---|---|---|
| 1 | **node id 引用必须是字符串** | `[String(nodeId), slot]` —— 服务端按键做字典查找，数字会 KeyError |
| 2 | **widget 顺序取图节点自身 `inputs` 数组序**，不是 object_info 序 | 要含动态子 widget；**被链接的 widget 仍占 widgets_values 一个位置** |
| 3 | **`control_after_generate` 占位** | 名为 `seed`/`noise_seed` 的 INT 前面端渲染生成后控制下拉，**占一个 widgets_values 槽但无 API 输入** → 补占位名，否则后续 widget 全部错位 |
| 4 | **bypass（mode 4）是直通** | 输出跟随**第一个有连线的输入**；分析与转换必须用**同一规则**，否则 `A → [绕过] → B` 被切成两半，「主流程」提取会漏节点 |
| 5 | **DynamicCombo V3 保持扁平** | 子控件平铺成 `主名.子名`（`codec: "auto"`），**包成 `{key, inputs}` 反而匹配不上** |
| 6 | **子图（subgraph）实例不支持** | 明确报错，让用户先在 ComfyUI 里转回普通节点 |

### 7.3 设计原则（**照抄它的注释，这是精髓**）
- **转换后先过 `POST /prompt` 校验**才算成功 → 不产出「能转但跑不起来」的工作流。
- **上游断线大声报错**：未注册 UI-only 节点，是 `Primitive*` 就内联其第一个值；有输出被使用且非 Primitive → **硬报错**。
- **多分量把选择权交给用户**，不猜：面板弹「整体 / 按分量 / 主流程」并先展示分析报告（各分量节点数、所在组）。
- **旧格式自愈**：`flattenDynamicCombos` 在提交前摊平老格式，**不改用户手动重存**。

---

## 8. 持久化（JSON 文件即数据库，零依赖）

`dataDir` 默认 `$DSH_HOME/data/dsh-comfyforge`（本机 = `D:\DSH\.dsh\data\dsh-comfyforge`）。

| 文件 | 内容 | 要点 |
|---|---|---|
| `workflows.json` | 工作流库（id/name/description/workflow/parameters/tags/skillDir/requireSkill/source/updatedAt） | **保存时不碰 `skillDir`/`requireSkill`**（别的功能拥有的字段，编辑器不该越权删） |
| `assets.json` | 资产索引（promptId → media） | ComfyUI history 易失，**这是插件自己的记忆**；`unshift` + 长度截断 |
| `tracked.json` | 队列追踪状态 | 重启后已完成 run 仍可见 |
| `media-sizes.json` | 上传文件的像素尺寸 | 图生图默认按源图分辨率 |
| `media-hashes.json` | 内容哈希 → 文件名 | 重复上传复用，不产生 `image(1).png` |
| `slots.json` | 加载区槽位 | **有序列表**，空位用 `null`；旧版单对象格式读进来自动升级成单槽列表 |
| `runs.json` | **运行账本**（ComfyForge 强化） | `Map<promptId,{overrides,timestamp,status}>`，上限 500，**upsert**（重复下载不产生重复条目）；用 history 最终 status 覆盖暂存 `'queued'` |

**铁律**：
- `readJsonFile` 解析失败**返回 fallback**，插件永不因数据损坏起不来。
- 新建用 `randomUUID()`，更新按 id。
- 写文件都带尾换行。

---

## 9. 安全（不可省，照抄 + 修正）

### 9.1 路径处理（**照抄 dsh-comfyui `skillpack.js:18-23, 70-74`**）
```js
const FILE_NAME = /^[A-Za-z0-9_一-龥][A-Za-z0-9._一-龥-]{0,127}$/;   // 允许中文；上限 128（不是 64）
const DIR_NAME  = /^[A-Za-z0-9_一-龥][A-Za-z0-9_一-龥-]{0,39}$/;
const SLUG      = /^[a-z0-9][a-z0-9-]{0,79}$/;
// 每个读写删之前：resolve() 之后用 relative() 复查是否逃逸
```
> **为什么上限是 128 而不是 64**：批量导入的模板名很长（`c-pop-guofeng-traditional-chinese-style-cinematic-ballad`），卡死会让文件**静默不可见**。

### 9.2 zip 导入（**照抄 dsh-comfyui `transfer.js:12-18, 32-37`**）
- **路径绝不取自 zip 条目名** —— 包根目录从导入后新工作流的 slug 重新派生。
- 每个包内相对路径重过 `parseSkillPath` + 容器/上限检查。
- **导入永远创建新工作流** → 恶意包最坏只是产生垃圾。
- **解压炸弹防护**：单条目 64 MB / 总 256 MB / 包内工作流数 500。

### 9.3 **修正 canvas 那三处安全债**（ComfyForge 必须做到）

| canvas 的问题 | 证据 | ComfyForge 的做法 |
|---|---|---|
| 直接覆盖用户 ComfyUI 安装目录，判据只有 `__version__` 字符串，无备份无 diff | `index.js:1316-1326` | **不注入 ComfyUI 目录**；若必须注入（桥接）：先备份 → 记内容 SHA-256 → 可一键卸载 → doctor 报状态 |
| 前缀校验用 `path.resolve` 而非 `realpath`，junction 可越界 | `index.js:1687-1690` | **一律 `realpath` 后再做前缀校验** |
| 桥接 `/report`、`/result` 刻意不过 token 门 | `__init__.py:65-74, 145-152` | **桥接路由强制 token + 只认 loopback** |
| `sandboxPolicy: {mode:'danger-full-access'}` 多处 | `index.js:431,550,627` | **绝不引入** |
| 全局单槽 `_latest` 模块级单例，多前端互相覆盖 | `__init__.py:35` | **按会话隔离**；结果表按**时间**淘汰（canvas 按插入序，可被刷满挤掉真结果） |
| `comfyui_reload` 用 `netstat + taskkill /F` 按端口杀 | `index.js` | **杀进程前核对进程名/路径**，不做盲杀 |
| `load_workflow` 覆盖未保存现场只靠 skill 约定 | skill | **破坏性操作全部加硬守卫**（不只 `clear`） |

### 9.4 其他
- **API Key 不下发浏览器**（只在服务端用；浏览器走同源代理）。
- `maxMediaBytes` 上限防一次拉爆内存（默认 64 MB）。
- 配置写入包 `safeUpdate`：`Promise.resolve(settings.update(...)).catch(() => {})` —— **unhandled rejection 会被当成 fatal boot**（照抄 canvas `index.js:334-336`）。

---

## 10. 浏览器半（client/）

### 10.1 自注册模式（**照抄 dsh-comfyui `client/client.js:1-7`**）
```js
window.__ModuleLoader__.load({
  id: "dsh-comfyforge",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const react = require("react");
    // ... 组件定义 ...
    exports.apply = apply; exports.inject = ["slots"]; exports.name = "dsh-comfyforge";
    return module.exports;
  }
});
```

### 10.2 挂载点（**照抄 dsh-comfyui `client.js:5197-5242` 的四个槽**）
```js
ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name:"tool.call.toolview", key:"comfy_workflow" }, Card));
ctx.slots.inject("settings.section",   () => ctx.slots.register({ name:"settings.section", id:"comfyforge", order:30, label:()=>t("settingsTitle") }, Settings));
ctx.slots.inject("shell.overlay",      () => ctx.slots.register({ name:"shell.overlay", id:"comfyforge.panel", order:20, label:()=>t("panelTitle") }, Panel));
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name:"conversation.session.header.actions", id:"comfyforge", order:100, label:()=>t("panelTitle") }, Trigger));
```
**用 `slots.inject` 而不是直接 register** —— 贡献项会等真实的槽声明，并随本插件 fiber 一起回收。

**已知槽名对照**（两家实测，按用途挑）：

| 槽名 | 谁在用 | 用途 |
|---|---|---|
| `tool.call.toolview` | dsh-comfyui | 工具调用的卡片 UI（**键是工具名**） |
| `settings.section` | 两家都用 | 设置页分区 |
| `shell.overlay` | dsh-comfyui | 全屏浮层面板（**停靠面板走这个**） |
| `conversation.session.header.actions` | dsh-comfyui | 会话头部按钮 |
| `conversation.view` | canvas | 会话区整块视图（**做分屏嵌入走这个**） |
| `conversation.composer.dock` | canvas | 输入框附近的停靠区 |
| `conversation.session.header.utilities` | canvas | 会话头部工具区（与 `actions` 不同） |

> **注意**：`client` 半的 `inject` 要按用到的槽声明 —— dsh-comfyui 是 `["slots"]`，canvas 是 `["slots", "configForms"]`（后者用于 `ctx.configForms.get(NAMESPACE)` 读配置表单）。

### 10.3 面板（三页签，V1 够用）
- **工作流**：库列表（新建/编辑/运行/删除/导入 `.json`）+ 标签筛选 + 加载区（槽位、内容哈希去重、尺寸显示）
- **资产**：生成结果卡片（预览/下载/悬停删除，删除时**同时清 ComfyUI output 目录的文件**）
- **队列**：实时队列 + 历史，支持删除/中断/重跑/清空/释放内存
- **设置**：服务器地址、API Key 环境变量名、ComfyUI 目录（可多条）、媒体地址、技能包目录、显存预算、**测试连接**

### 10.4 可选：iframe 嵌入（V2，抄范式不抄实现）

若要做「把 ComfyUI 原生画布嵌成标签」：
- **跨域靠「对端注入 SDK」，不读 `contentWindow`**（canvas `client.js:190-197` + `bridge.js:12-13`）—— 宿主永不依赖同源。
- **iframe 常驻 body，绝不 `removeChild`**（会销毁浏览上下文 = 重新加载 ComfyUI 几十秒）；只改 `display/left/top/width/height`。
- **零核心改动的布局**：只打 `html[data-split-on]` 标记 + CSS 变量；**不碰 hash 类名、不 fork 核心**。
- **DOM 看门狗**：任何状态变化都重算标记，兜住 effect 清理漏跑；用 `display:none` 而不是 `visibility`（后者会被 iframe 自身 visible 穿透）。

---

## 11. 可靠性工程（**这是 ComfyForge 甩开三家的地方**）

### 11.1 分层解耦（**照抄 dsh-comfyui-image 的哲学**）
```
契约层 tool.js    —— 工具名/描述/schema/render    【对外稳定】
执行层 runner.js  —— 归一化→探测→上传→建图→提交→轮询→取图→落盘   【改这里】
纯函数层 workflows.js —— 构建 API 工作流           【不碰网络/文件 → 可离线单测】
探测层 probe.js   —— 所有网络访问集中于此           【产出「事实」】
```
**核心洞察**：把网络访问全收敛到探测层 → 构建层是纯函数 → **不用真装 ComfyUI 就能跑全部测试**。

### 11.2 错误体系（**照抄 dsh-comfyui-image `errors.ts`**）
```js
export class ComfyForgeError extends Error {
  readonly hint?: string;
  constructor(message, hint) { super(message); this.name='ComfyForgeError'; if (hint) this.hint = hint; }
}
export function formatError(e) {
  if (e instanceof ComfyForgeError) return e.hint ? `${e.message}\n下一步：${e.hint}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
// 错误即 API，构造即文档：
comfyUnreachable(baseUrl, cause) / fileMissing(kind, path) / argConflict(msg, hint)
nodeMissing(classType, hint)     / executionFailed(detail, promptId) / timedOut(waitedMs, promptId, baseUrl) / vramInsufficient(needMiB, haveMiB, 建议)
```
> **DSH 会把 message 直接给模型看** → message 是「发生了什么」、hint 是「下一步怎么办」。**绝不甩一句 `fetch failed`。**

### 11.3 doctor 自检（**照抄并增强 dsh-comfyui-image `scripts/doctor.mjs`**）

必须能**脱离 DSH 独立运行**：`node scripts/doctor.mjs [--base-url URL] [--json]`

检查项（**ComfyForge 增强版**）：
1. 打印**生效配置**（四层来源合并结果）+ 配置文件位置
2. 探活 `/system_stats` → 版本、设备、**显存总量**
3. 列出底模 / 采样器 / 调度器的**真实可选值**（来自 `/object_info`，不是猜的）
4. **核心节点清单**逐项查（缺 → 「地址不对或版本太旧」）
5. **★ 模型仓体检**（本机头号问题）：checkpoints / loras / vae / unet / clip 各自有几个文件；为 0 时给 §6.3 的候选方案
6. **★ 显存预算**：按 `vramBudgetMiB` 判定哪些工作流能跑、哪些要 warn
7. **★ 自定义节点能力矩阵**：RMBG（去背）/ WanVideoWrapper（视频）/ IPAdapter（风格参考）/ GGUF（量化模型）/ ControlNet-aux（姿态）各是否可用
8. **★ 工具名冲突检测**：扫描已装插件，若 `generate_image` 等名字被占用则报警
9. **★ 桥接状态**（若有）：已装/未装/版本是否最新/内容指纹是否被改
10. 逐模式判定 `text2img` / `img2img` / `inpaint` / `remove_background` / `video` 能不能跑，给出缺什么

**退出码**：`0`=全绿 / `1`=连不上 ComfyUI / `2`=连上了但有模式跑不了 / `3`=配置或工具名有冲突。

### 11.4 测试（mock ComfyUI）
- `scripts/run-tests.mjs` 自带 mock 后端 → **不需要真装 ComfyUI**。
- 覆盖：参数归一化与冲突规则 / 四种模式的建图连线断言 / 底模三态 / 采样器双态 / 图→API 转换（含六个坑）/ 技能包路径校验与穿越尝试 / zip 导入防护 / 错误 hint 文案。
- 目标：**≥ 80 项**。

---

## 12. 显存适配（本机专属，三家都没做）

| 场景 | 6G 可行性 | 做法 |
|---|---|---|
| SD1.5 出图 512×512，20 步 | ✅ 充裕 | 默认档 |
| SDXL 出图 1024×1024 | ⚠️ 勉强 | fp16 会溢 → **优先 GGUF 量化**（本机已装 `ComfyUI-GGUF`）；或 fp8 |
| SDXL + ControlNet | ⚠️ | 降分辨率 / 减 steps |
| LTXVideo 短视频 | ⚠️ | 低分辨率 + 少帧 |
| **Wan 2.1 视频** | ❌ **非常勉强** | 先估算再警告，默认不推荐；必须跑则低分辨率+少帧+GGUF |

**实现**：`probe.js` 里读 `/system_stats` 的显存总量与当前占用 → 按工作流声明的需求估算 → 不足时抛 `vramInsufficient` 并给「调小分辨率 / 换量化模型 / 降 steps」的具体建议。**6G 机器上，提前警告比跑到一半 OOM 友好得多。**

---

## 13. 验收标准（新对话交付时逐条自查）

- [ ] `engines.dsh` = `>=0.2.0-rc.1 <0.3.0-0`；peer 含 `0.2.0-alpha.1 || 0.2.1-alpha.1`
- [ ] `inject = ['tools']` 单一必需；`webServer`/`settings`/`credentials`/`skills` 全部惰性挂载
- [ ] headless 宿主（无 webServer）**能正常启动并只用工具**，不报错
- [ ] 所有资源走 `ctx.effect()`，每个返回 disposer
- [ ] volatile 双形态读取（`Symbol.for('cosmokit.volatile.write')` 探测）
- [ ] 工具名全部 `comfy_*`，**未占用 `generate_image`**
- [ ] 参数 schema 只用 DSH 子集（无 `minimum`/`maximum`/`format`）
- [ ] 未知参数名**拒绝并列出合法名**
- [ ] 输出无损 JSON（不塞 `undefined`）
- [ ] job 契约双版本适配（`result`/`output`、`detail`/`output`、owner 形态）
- [ ] `cancelPrompt` 只取消自己那条（先查队列）
- [ ] 媒体 URL 按文件寻址 + 三级 origin 回退 + `/comfyforge/ping` 自报
- [ ] `/upload/image` 用 multipart
- [ ] 技能包三级披露；**不注册进 `ctx.skills`**
- [ ] 「运行前必读」门禁用 `WeakMap` 按会话
- [ ] 技能包路径正则（含中文、上限 128）+ `relative()` 复查逃逸
- [ ] zip 导入不信任条目名 + 解压炸弹防护 + 永远新建
- [ ] **不写用户 ComfyUI 安装目录**（或：备份+指纹+可卸载）
- [ ] **不用 `danger-full-access`**
- [ ] **不用 `path.resolve` 做安全前缀校验，用 `realpath`**
- [ ] doctor 能独立运行且四档退出码正确
- [ ] 测试 ≥ 80 项，自带 mock，不需要真 ComfyUI
- [ ] 空模型仓时给出可执行的补齐方案（不是一句报错）
- [ ] 显存不足时提前警告
- [ ] 文档齐（README 中英 + CONFIG + PARAMS + FAQ）

### 安装与验证流程（**必须走这套，不许跳步**）

```
1. 装前快照：undo_snapshot reason="before installing dsh-comfyforge"
2. 静态预检：node --check 每个 .js；import 入口模块
3. 挂载：dsh plugin --profile desktop add link:D:/用户/代码/dsh-comfyforge
4. **重启 DSH**（profile 插件改动必须重启，touch cordis.patch.yml 只重载入口）
5. 冒烟：headless 跑一轮，确认工具出现在 catalog 且不报错
6. doctor：确认退出码与预期一致
7. 起 ComfyUI（绘世启动器）→ 设置页或配置改 baseUrl → 测试连接
8. 首次用：**先跑 doctor 看模型仓**（本机为空，需先补模型）
9. 失败即回滚：undo_restore mode="undo"
```
> **依据**：本机有过「豁免绕门禁、绕不过运行时」的前科（DSH 起不来：`1 entry did not activate` / `waiting for service: settingsScope`）。**先静态预检 + headless 冒烟，再重启。**

---

## 14. 分阶段建议（避免一次性写太大）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **V0 骨架** | package.json + cordis.patch.yml + index.js（inject/effect/Config）+ doctor.mjs | 装得上、重启不炸、headless 出工具 |
| **V1 出图** | client.js + probe.js + workflows.js（四模式内置）+ comfy_image 工具 + 落盘 | 能出图（需先补一个模型） |
| **V2 平台** | store.js + 工作流库 + comfy_workflow（action 分流）+ comfy_skill + 技能包三级披露 | 能 list→run、能写技能包 |
| **V3 图→API** | graph.js + convert.js + analyze.js + 提取流程 | 能跑 ComfyUI 里保存的图 |
| **V4 UI** | client/client.js 四槽（设置/面板/卡片/触发） | 面板可用 |
| **V5 嵌入** | iframe 分屏（范式照抄 canvas） | 能嵌原生画布 |

**先做 V0+V1，跑通再往下。** 每一步都过 §13 的验收。

---

## 15. 给新对话的开场提示

> 我现在要开发一个 DSH 插件 `dsh-comfyforge`，接本机 ComfyUI。完整规格书在 `D:\用户\代码\dsh-comfyforge\SPEC.md`，三家现役插件的源码在 `D:\用户\代码\dsh-comfyforge\reference\`（含三份吸收笔记，是我逆向出来的结论）。
>
> 请先：① 读 SPEC.md 全文；② 读三份吸收笔记（尤其 01 主插件的「直接可抄」表）；③ 需要看具体实现时读 reference 下对应源码。
>
> 然后按 SPEC §14 分阶段实施，从 V0 骨架开始。**每改一处 D:\DSH 下的东西都走 safe-change 四段流程**（备份→语法→import→headless 冒烟），别让 DSH 起不来。
>
> 本机硬事实（SPEC §1 有完整表）：DSH 0.2.1-rc.2；ComfyUI 在 `D:\QWQ\ComfyUI-aki-v3.2`（0.30.2，Python 3.13.11，torch 2.13.0+cu130，RTX 3060 6G）；**模型仓是空的**（头号约束）；已装 GGUF/RMBG/WanVideoWrapper/IPAdapter 等节点；是**局域网**环境要支持。
