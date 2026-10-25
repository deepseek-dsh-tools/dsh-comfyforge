# 吸收笔记 03 — dsh-comfyui-image 0.1.1（wbb316）

> 源码根：`D:\用户\工具\Temp\comfy-survey\x-dsh-comfyui-image-0.1.1\package\`
> 规模：src 约 2600 行 TS（lib 是编译产物，同步读）。零第三方运行时依赖（只有 devDeps: typescript + @types/node）。
> 状态：2026-10-04 后停更（近两周零提交，4★）。**但它 0.1.1 的版本号配着相当成熟的工程质量 —— 是三家里「可靠性工程」做得最好的。**

## 一、设计哲学（三层分离，最值得抄的结构）

| 层 | 文件 | 职责 | 关键约束 |
|---|---|---|---|
| **契约层** | `src/tool.ts` | 工具名/描述/参数 schema/输出 schema | **对外稳定，换后端/加模式时尽量不动** |
| **执行层** | `src/runner.ts` | 参数归一化 → 探测 → 上传 → 建图 → 提交 → 轮询 → 取图 → 落盘 → 写元数据 | 「怎么跑」都改这里 |
| **纯函数层** | `src/comfy/workflows.ts` | 构建 API 格式工作流 | **不碰网络、不碰文件系统 → 可离线单测** |
| **探测层** | `src/comfy/nodes.ts` | 所有网络访问集中于此，产出「事实」 | 三件事：底模 / 采样器 / 去背方案 |

> **核心洞察**：把「网络访问」全部收敛到探测层，构建层就是纯函数 —— 于是**不用真装 ComfyUI 就能跑 88 项测试**。这是三家里唯一做到「可测试」的实现。

## A. 单工具契约（吸收要点）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| A1 | **一个 `generate_image` 覆盖四模式** | `tool.ts:21` `TOOL_NAME` | 模式**可推断**：有 image+mask→inpaint；只有 image→img2img；都没有→text2img。**不给模型五个工具去选。** |
| A2 | **模式冲突一律报错，绝不猜** | `docs/PARAMS.md` 第二节表格 | `mode=text2img` 却给了 `input_image` → 报错「想基于这张图改，请显式传 mode="img2img"」。**「Agent 最怕静默降级成另一个模式」** —— 以为在局部重绘，结果整图重画。原则：**能一眼判定的就推断，有歧义的一律报错，报错文本里带上「怎么办」。** |
| A3 | **JSON Schema 只能用 DSH 支持的子集** | `tool.ts:8-11` 注释 | `minimum`/`maximum`/`format` 会被 `assertSupportedJsonSchema` **直接拒绝** → 范围只写进 description，由运行时兜底校验。**这条不读源码不会知道，是必踩坑。** |
| A4 | **工具描述写得啰嗦是刻意的** | `tool.ts:24-48` | 「Agent 只看这一处就能用对」：列模式、推断规则、默认值、用法要点（返回的绝对路径可直接引用、seed 可复现、width/height 只对 text2img 生效）。 |
| A5 | **被忽略 ≠ 报错，但要在 notes 里明说** | `docs/PARAMS.md` 第一节表 | 非 text2img 传了 width/height → 「输出尺寸由输入图决定，width/height 已忽略」。**防「你以为它生效了」。** |
| A6 | **失败时把「为什么 + 怎么办」原样交给模型** | `tool.ts:251-256` | catch 里不直接抛，而是 `renderFailureText(error, mode)` 后抛出。**比抛个 `fetch failed` 有用得多。** |
| A7 | **输出 schema 里 `path` 放最前面** | `docs/PARAMS.md:121` + 输出契约 | `text` 排版刻意：**绝对路径单独占一行、不加任何修饰** → DSH 前端会渲染成可点开的文件链接。 |
| A8 | **cwd 防御式获取** | `tool.ts:188-204` `resolveCwd` | 四候选：`agent.cwd` → `agent.meta.cwd` → `agent.session.cwd` → `agent.session.header.cwd` → `process.cwd()`。**「具体挂在哪一层属于宿主内部结构」** → 防御式取 + 兜底，绝不因为取不到就报错。 |

## B. 参数归一化（`params.ts`）

| # | 机制 | 为什么值得吸收 |
|---|---|---|
| B1 | **超范围是明确报错，不是夹到边界** | `width 超出允许范围 64~8192，收到 99999。` / `steps 必须是数字，收到的是 "abc"。` —— 夹边界会让模型以为生效了。 |
| B2 | **非 8 倍数自动对齐并在 notes 说明** | ComfyUI 要求尺寸对齐；对齐了要说，不能默默改。 |
| B3 | **尺寸按底模自适应** | `config.ts:190-195` `suggestSizeForCheckpoint`：SD1.5 系（名字含 `sd1.5`/`v1-5` 且不含 xl）→ 512；否则 → 1024。**规则直白写在代码里，不做更深猜测。** |

## C. 错误体系（`errors.ts` —— 三家里最好的）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| C1 | **专用错误基类带 `hint`** | `errors.ts:10-19` | `class ImagePluginError extends Error { hint?: string }`。**DSH 会把 message 直接给模型看** → 所以 message 是「发生了什么」、hint 是「下一步怎么办」。 |
| C2 | **统一格式化** | `errors.ts:22-28` `formatError` | `message\n下一步：hint`。 |
| C3 | **每个错误都是构造函数** | `errors.ts:31-74` | `comfyUnreachable(baseUrl, cause)` / `fileMissing(kind, path)` / `argConflict` / `nodeMissing(classType, hint)` / `executionFailed(detail, promptId)` / `timedOut(waitedMs, promptId, baseUrl)`。**错误即 API，构造即文档。** |
| C4 | **报错带具体线索** | `errors.ts:59-65` | 执行失败 → `prompt_id=${promptId}` + 「常见两个原因：节点/模型不存在 或 显存不足」+ 「可以用 model/steps/width/height 调小重试」。 |

## D. 能力探测层（`comfy/nodes.ts` —— 最漂亮的一层）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| D1 | **`fillInputs`：只填节点确实声明过的键** | `nodes.ts:73-83` | 防止把不存在的输入塞进去导致 `/prompt` 拒收。 |
| D2 | **`autoFillRequired`：只补枚举类必填项** | `nodes.ts:92-105` | 应对**第三方节点参数名各异**的关键一招：某个去背节点多出必填 `model`，不需知道它叫什么 —— 只要是枚举，就用它自己的默认值填。**只补枚举，绝不误填 IMAGE 这类连线输入。** |
| D3 | **底模三态选择** | `nodes.ts:120-158` `chooseCheckpoint` | ① 指定且存在 → 用；② 没指定 → 优先带 `xl` 的，否则第一个；③ **指定但不存在 → 报错并列出可选项**（比默默换一个更可预测）。 |
| D4 | **空模型仓的专门报错** | `nodes.ts:135-141` | `available.length === 0` → 「ComfyUI 报告没有任何可用的底模（models/checkpoints 是空的）」+ 「请往…放一个 .safetensors / .ckpt」+「在界面里刷新一下」。**本机正中这条 —— 规格书要复用。** |
| D5 | **采样器「显式传错」vs「默认值不存在」区别对待** | `nodes.ts:187-214` | 用户**显式**给的错 → 报错并列出可用值；只是**配置默认值**在本机不存在 → 退回可用值 + notes 说明。**这个区分极其重要。** |
| D6 | **去背方案按可用性链式挑选** | `nodes.ts:270-414` `chooseRembgPlan` | 四套已核实方案（essentials `RemBGSession+→ImageRemoveBackground+` / BRIA / LayerStyle / WAS），**按 chains 逐个探测，全部存在才算可用**。 |
| D7 | **去背节点的输入键名要「猜」** | `nodes.ts:237-246` | `IMAGE_KEY_CANDIDATES = ['image','images','input_image','img','pixels','image_in']`、`MODEL_KEY_CANDIDATES`。**不同作者叫法不一，靠候选名单兜。** |
| D8 | **安装指引内嵌在错误里** | `nodes.ts:276-307` | 每个方案带完整 `installHint`：git clone 地址 + `pip install "rembg[cpu]"`（**少了 [cpu] 就没有 onnxruntime 后端**）+ 「首次去背会自动下载 u2net 权重约 176MB」。 |
| D9 | **权威索引，不凭记忆** | `nodes.ts:264-268` 注释 | 「仓库与类名的对应关系取自 ComfyUI-Manager 的 extension-node-map.json，**不要凭记忆改**」+ 指出「索引里根本不存在叫 `RemBG` 的节点」是早期版本的错误来源。**这条注释本身就是教训。** |
| D10 | **能力探测暴露给用户** | `nodes.ts:417-432` `checkModeSupport` | 逐模式返回 `{supported, detail}` —— 「为什么不行」有明确回答。 |

## E. 配置四层优先级（`config.ts`）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| E1 | **四层来源，高者赢** | `config.ts:1-16` | ① 插件配置（profile 的 `cordis.patch.yml` 里 entry 的 `config:`）② `~/.<plugin>/config.json`（**不用重启 DSH、不用改 profile**）③ 环境变量 ④ 内置默认值。 |
| E2 | **为什么插件配置最高** | `config.ts:10-11` | 「DSH 的配置树是运维/宿主的权威来源，摆了 config 就该它说了算；配置文件是给『只想改个地址、不想动 YAML』的用户准备的便利层」。 |
| E3 | **不依赖第三方 schema 库** | `config.ts:13-15` | Cordis 在插件没导出 `Config` schema 时会把原始配置**原样**交给 `apply` → 手写校验即可，**避免 link 安装下的依赖解析问题**。 |
| E4 | **配置文件坏了就当没有** | `config.ts:71-82` `readConfigFile` | try/catch + BOM 剥离 → **绝不因为配置文件损坏把插件搞挂**。 |
| E5 | **非法值丢掉退回默认并留痕** | `config.ts:129-167` | `pickString`/`pickNumber(min,max)`/`pickBoolean` 三件套 + 范围校验 + debug 日志留痕。 |
| E6 | **测试可注入配置路径** | `config.ts:30-31` | `DSH_COMFYUI_IMAGE_CONFIG` 环境变量可指向临时目录 → **测试不污染真配置**。 |

## F. 可靠性工程（三家里唯一做到的）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| F1 | **doctor 自检脚本** | `scripts/doctor.mjs` | ① 打印生效配置（四层合并结果）+ 配置文件位置 ② 探活 `/system_stats` 打版本与设备 ③ 列出底模/采样器/调度器的**真实可选值**（来自 `/object_info`，不是猜的）④ **逐模式判定能不能跑**，给出缺什么。**退出码：0=四模式都可用 / 1=连不上 / 2=连上了但有模式跑不了**。刻意不抛堆栈 —— 「这是给人看的体检报告，不是测试」。 |
| F2 | **核心节点清单** | `doctor.mjs:27-39` | 11 个核心节点逐个查，缺了 → 说明「地址不对或版本太旧」。 |
| F3 | **便携文档** | `docs/` 8 份 | INSTALL / CONFIG / PARAMS / USAGE / FAQ / ROADMAP / RELEASING + 中英双语 README。**PARAMS.md 里那张「被忽略 vs 报错」表格是精品。** |
| F4 | **88 项测试 + mock ComfyUI** | `scripts/run-tests.mjs` | **自带 mock 后端，不需要真装 ComfyUI** —— 因为它把网络访问收敛到了探测层。 |
| F5 | **dom 类型注释不 import 宿主类型** | `tool.ts:175-179` | 「不 import 宿主类型，避免 link 安装下的解析问题」→ 自定义最小接口 `ToolExecLike`。 |

## G. 逃生舱（`extra_options.workflow_path`）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| G1 | **自定义工作流占位符接管** | `docs/PARAMS.md` 第五节 + `runner.ts:133+` | `{{prompt}}` / `{{seed}}` / `{{input_image}}` / `{{checkpoint}}` / `{{mode}}` 等 11 个占位符。**用来支持插件还没内置的能力（扩图、超分等）**。 |
| G2 | **整值占位符保类型** | `docs/PARAMS.md:175-177` | 「整个值就是一个占位符」→ 原样替换**类型保持不变**（数字仍是数字）；嵌在句子里 → 字符串拼接。 |
| G3 | **没提供的占位符原样保留** | 同上 | `{{foo}}` 留成 `{{foo}}` —— **便于你发现自己拼错了**。 |
| G4 | **input_image 语义是 ComfyUI 内的文件名** | `docs/PARAMS.md:179-181` | `LoadImage` 的 image 是**输入目录下的文件名枚举**，不是自由字符串 → 插件用 `/upload/image` 返回的文件名回填。**这条注释防止用户写本地绝对路径。** |

## E2. **DSH JSON Schema 精确允许清单**（从宿主 asar 取证，2026-10-20）

> 出处：`D:\DSH\resources\app.asar` 内 `@deepseek-ai/dsh-tools/lib/index.js` 的 `assertSupportedJsonSchema` / `checkSchemaNode`（本机宿主 0.2.1-rc.2 实测提取）。
> **这是写任何插件工具参数的硬约束 —— 违规会被直接 reject，不是警告。**

### 允许的约束键（8 个，`CONSTRAINT_KEYWORDS`）
```
type  oneOf  properties  required  additionalProperties  items  enum  const
```
### 允许的注解键（4 个，`ANNOTATION_KEYWORDS`）
```
description  title  default  examples        ← 注解值必须是「无损 JSON 数据」
```
### **一律 reject** 的键
`minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `format` / `pattern` /
`minLength` / `maxLength` / `minItems` / `maxItems` / `uniqueItems` / `multipleOf` /
`$ref` / `$schema` / `definitions` / `allOf` / `anyOf` / `not` / `if` / `then` / `else` ……
（报错文案就是 `… is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`）

### 另外七条结构约束（同样会被 reject）
1. `type` 与 `oneOf` **不能同时声明**。
2. **声明了 `properties`/`required`/`additionalProperties`/`items`/`enum`/`const` 就必须有 `type` 或 `oneOf`** —— 否则报 `… requires type or oneOf`。
3. `oneOf` 必须是**至少两个** schema 的数组。
4. **`oneOf` 旁边不许出现** `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`。
5. 有 `type` 时，`type` 必须是允许的类型名（`object`/`array`/`string`/`number`/…）。
6. `description` / `title` 必须是**字符串**。
7. **循环引用会报 `… is circular`**（`seen` 集合检测）。

### 结论（写工具时要照做的三条）
- **范围（min/max）只写进 `description`，运行时兜底校验** —— 这正是 dsh-comfyui-image 的做法（`tool.ts:9-11`）。
- **想表达「必填随模式变化」就在 schema 里 `required: []` + `additionalProperties: false`，必填性交给运行时按模式判** —— 别假装 schema 能表达。
- **结构化的输出 schema 必须是 object 根**（`assertObjectJsonSchema`：`schema.type` 必须 `"object"`）。

> 与之呼应的一条：**工具输出必须是无损 JSON** —— `JSON.stringify` 会丢 `undefined` 键，所以可选字段要用条件赋值而不是塞 `undefined`（dsh-comfyui `tools.js:645-666` 就是这么写的）。

## H. 不足与风险

| # | 问题 | 说明 |
|---|---|---|
| H1 | **2026-10-04 后停更** | 对比 dsh-comfyui 十天前刚发版 → 一个基本停更，一个还在跟。选它要接受「作者可能不管了」。 |
| H2 | **V1 预留字段未实现** | `style_reference` / `character_reference` 只写元数据、不参与生成。 |
| H3 | **🔴 与 Agnes 撞名（实测确认）** | 它注册 `generate_image`（`tool.ts:21`），而本机 `dsh-agnes-multimodal` **也注册 `generate_image`**（`lib/index.js:463-464`）。两者都会 `ctx.tools.register({name: 'generate_image', ...})` → **装上去必然互相顶掉，不是共存**。要么二选一，要么改工具名。 |
| H4 | **去背依赖第三方节点** | 核心 ComfyUI 没有去背节点（0.3x 自带的 `RemoveBackground` 输出遮罩、需自备模型）。本机装了 **RMBG**（不在它四个预设里）→ 需要自己加一套 preset。 |
| H5 | **`saveToComfyUI` 默认 true** | 产出落 ComfyUI 的 `output/`；canvas 那家刻意落项目目录。**两种取向，专属插件建议默认落项目目录**（用 `PreviewImage` 走 temp 目录是它给的另一条路）。 |
| H6 | **mock 测试只覆盖 workflows 层** | 纯函数层的测试，不覆盖真实网络路径。 |

## I. 三家横向对比（一图流）

| 维度 | dsh-comfyui | dsh-comfyui-image | dsh-comfyui-canvas |
|---|---|---|---|
| 定位 | **平台型**：工作流库+面板+技能包 | **专用型**：一个 generate_image 四模式 | **嵌入型**：把 ComfyUI 前端搬进 DSH |
| 工具数 | 4（workflow/skill/object_info/run） | 1（generate_image） | 26 |
| 代码量 | 14021 行 | ~2600 行 TS | 4426 行 |
| 依赖 | fflate + schemastery | **零运行时依赖** | 零 |
| UI | 自绘三页签面板 | 无 | iframe 分屏 + 全屏标签 |
| 技能包 | ✅ 三级披露 + Agent 可写 | ❌ | ✅ runtime skill |
| 可测试性 | 一般（无 mock） | **✅ 88 项 + mock 后端** | 一般 |
| 自检 | 无 | **✅ doctor** | `comfyui_config` 体检 |
| 错误质量 | 好 | **✅ 最好（hint 体系）** | 好 |
| 图→API 转换 | **✅ 421 行硬功夫** | ❌ | ✅ export_api |
| 批量扫参 | ❌ | ❌ | **✅ matrix** |
| 设置页可写 | ❌ issue #20 | ✅（配置文件兜底） | ✅ |
| 安全 | 中（技能包路径校验严） | **好（零越权面）** | **差（写用户目录/无鉴权/danger）** |
| 维护 | **✅ 活跃** | ❌ 停更 | ❌ 仓库 404 |
| 推荐 | 首选参考 | 可靠性范本 | 架构范本，**不装** |

## J. 「最强专用插件」应当的合成方向（本笔记的结论）

**骨架抄 dsh-comfyui，可靠性抄 dsh-comfyui-image，UI 架构抄 canvas（重写实现）。**

1. **工具面**：`comfyui`（action 分流：list/run/get/refresh/skill/status/doctor）+ `comfyui_skill`（可写技能包）+ 可选 `generate_image`（若保留单工具风格）。
2. **可靠性**：doctor 自检 + mock 测试 + hint 错误体系 + 配置四层降级。
3. **能力探测**：`autoFillRequired` + 底模三态 + 采样器双态 + 去背链式探测。
4. **UI**：iframe 分屏嵌入（对端注入范式）+ 自绘面板作兜底。
5. **不要让**：danger-full-access、写用户 ComfyUI 目录无备份、无鉴权桥接、符号链接绕过。
