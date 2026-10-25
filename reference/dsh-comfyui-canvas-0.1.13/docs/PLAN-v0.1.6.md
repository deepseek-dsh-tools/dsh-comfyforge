# dsh-comfyui-canvas v0.1.6 方案 — 一键安装 + 工作流操作模式优化 + 上版本遗留收尾

> **本文档是「新会话接手说明书」**：开发请新开会话，先读本文件 + `docs/architecture.html`（分层架构）+ `docs/architecture-flow.html`（流程图）。
> 状态：**已定稿**（2026-09-09）
> 范围：v0.1.5 → v0.1.6。三个板块：① P0 桥接节点一键安装（降低安装门槛）② P1 工作流操作模式优化（场景化使用约定，来自用户使用反馈）③ P1/P2 上版本（≤v0.1.5）遗留候选收尾。

---

## 0. 现状快照（v0.1.5）

- **包**：`dsh-comfyui-canvas` v0.1.5，npm 已发布 + GitHub Release + awesome-dsh-plugin 已收录（PR #4728 待合并（简介+截图））
- **19 个 agent 工具**：read_workflow / add_node / connect / set_param / remove_node / load_workflow / run / batch_run / get_outputs / debug / config / upgrade / attach_file / attach_image / inject_text / export_api / read_source / edit_source / reload
- **三副本**：源码主仓 `F:\Deepseek-harness\projects\dsh-comfyui-canvas`（权威源）→ DSH 运行时 `node_modules\dsh-comfyui-canvas` → ComfyUI bridge `custom_nodes\ComfyUI-DSH-Canvas`
- **安装门槛（痛点）**：DSH 插件安装 ✅ 一行；但 bridge 节点需**手动复制** `comfyui-bridge/ComfyUI-DSH-Canvas` 到 `<ComfyUI>/custom_nodes/`，还要配置 baseUrl —— 是多步手动操作，转化率断崖主因。
- **已有自动化前提**：settings 有 `installDir`（ComfyUI 安装目录，`comfyui_upgrade` 已在用）；有 `launchCommand`（`comfyui_reload` 在用）；bridge 节点已打包在插件内（`comfyui-bridge/`）；已有 `custom_nodes` 路径解析与校验（`comfyui_read_source` 等）。

---

## 1. 主项（P0）：桥接节点一键安装

### 1.1 目标
把安装从 3 步压缩为 **1+1 步**：
1. `dsh plugin add dsh-comfyui-canvas`（不变）
2. 让 agent 一句"安装 ComfyUI 桥接节点"（或 `comfyui_setup_bridge` 工具）自动完成检测 → 复制 → 校验 → 重启提示

### 1.2 新增工具 `comfyui_setup_bridge`

| 阶段 | 行为 |
|---|---|
| **检测** | 查 `<installDir>/custom_nodes/ComfyUI-DSH-Canvas` 是否存在；读已安装 `__init__.py` 的 `__version__`，与插件内嵌版本比对 → `{ present, version, upToDate }` |
| **安装/更新** | 从插件包内嵌目录递归复制到 `custom_nodes/`（排除 `__pycache__`/`*.pyc`），幂等可重复 |
| **校验** | 复制后确认 `__init__.py` + `entry/bridge.js` 落盘，且路径仍在 `custom_nodes` 前缀内（复用现有 resolve/校验逻辑） |
| **重启提示** | ComfyUI 需重启加载新节点 → `launchCommand` 已配则提示可 `comfyui_reload`，否则提示手动重启 |

参数：`installDir?`（可覆盖 settings）、`restart?`（default false，为 true 时复制后直接调 reload 流程）。

返回：`{ present, version, installed, upToDate, restarted?, files: [...] }`。

### 1.3 配套改动

1. **bridge 节点加版本号**：`comfyui-bridge/ComfyUI-DSH-Canvas/__init__.py` 顶部加 `__version__ = "0.1.6"`。当前无版本标识，无法判断"是否过期"，只能盲覆盖。新增 `comfyui-bridge/ComfyUI-DSH-Canvas/version.json`（`{ "version": "0.1.6" }`，JS 端好读）。
2. **`comfyui_config` 增字段**：输出加 `bridgeInstalled` / `bridgeVersion` / `bridgeUpToDate`（一次探测，让 agent 一眼看清桥接状态）。
3. **`installDir` 缺失回退**：settings 未填时，从 `launchCommand` 推断（如 `<dir>\main.py` → `<dir>`），还不行则返回明确指引让用户填一次（错误信息给出示例路径）。
4. **skill 更新**：`comfyui-admin-ops` SOP 加入第 0 步「一键安装桥接节点」（先 `comfyui_config` 看 bridgeInstalled → 未装则 `comfyui_setup_bridge`）。
5. **关键词/标签（SEO，提升目录内检索与曝光）**：
   - `README.md` / `README.zh.md` 顶部（badge 区下、首段前）加一行**关键词标签**，覆盖：`ComfyUI`、`Stable Diffusion`、`文生图 / text-to-image`、`图生图 / img2img`、`音乐 / music`、`视频 / video`、`3D`、`工作流 / workflow`、`AI 绘画 / AI art`、`DeepSeek Harness`、`DSH`。
   - 建议形态（延续现有 shield badge 风格，链接到对应搜索/仓库标签页）：
     ```md
     ![ComfyUI](https://img.shields.io/badge/ComfyUI-0.34%2B-orange) ![Stable Diffusion](https://img.shields.io/badge/Stable%20Diffusion-ready-blue) ![AI 绘画](https://img.shields.io/badge/AI%20绘画-workflow-green)
     ```
   - 同时检查 awesome-dsh-plugin 收录信息（`data/plugins/wbin0001__dsh-comfyui-canvas.yml` 的 description 可含 `ComfyUI` / `workflow` 等关键词，供目录内搜索命中；注意 description 保持单行、必须属实）

### 1.4 边界 / 安全

- 只写 `custom_nodes/ComfyUI-DSH-Canvas`，复用已有的路径前缀校验（`lib/index.js` 中 read/edit_source 的 `resolve(join(root,'custom_nodes'))` 手法），不碰其他目录。
- 幂等；**检测到已装版本较新或用户有本地改动时不覆盖**（先提示备份；`force` 参数显式才覆盖）。
- 云端 ComfyUI（baseUrl 指向非本机）明确提示：bridge 必须装到**跑 ComfyUI 的那台机器**，`installDir` 指向该机器路径（本机路径在云端场景无效）。

### 1.5 云端 ComfyUI 安装说明（文档与 skill 都要写）

> 云端场景（`networkMode: cloud-selfhosted/saas`、baseUrl 指向远程主机）下，`comfyui_setup_bridge` 的 `installDir` 只能是**本机**路径，无法直接装到远程机器。分两种情况：

**A. 云主机可 SSH / 有控制台（推荐，self-hosted 云 GPU 机）**
1. 插件侧：baseUrl 填云端地址；本机 `installDir` 留空或填本地（仅用于本地探测）
2. bridge 侧（在**云端机器**上执行，二选一）：
   - **方式 1（推荐，走 npm 包）**：云机上拉取 `dsh-comfyui-canvas` npm 包，复制其中的 `comfyui-bridge/ComfyUI-DSH-Canvas` 到 `<云机ComfyUI>/custom_nodes/`：
     ```bash
     npm pack dsh-comfyui-canvas   # 或：npm i dsh-comfyui-canvas --no-save
     # 解包后复制 comfyui-bridge/ComfyUI-DSH-Canvas → custom_nodes/
     ```
   - **方式 2（git clone）**：从插件仓库子目录拉取：
     ```bash
     cd <云机ComfyUI>/custom_nodes
     git clone --depth 1 --filter=blob:none --sparse https://github.com/wbin0001/dsh-comfyui-canvas.git
     cd dsh-comfyui-canvas && git sparse-checkout set comfyui-bridge/ComfyUI-DSH-Canvas
     mv comfyui-bridge/ComfyUI-DSH-Canvas ../ComfyUI-DSH-Canvas
     ```
3. 可选共享 Token：两端设置一致的 `DSH_BRIDGE_TOKEN`（ComfyUI 启动环境变量 + 插件设置），实现鉴权（详见 README 安全章节）
4. 重启云端 ComfyUI → 从 DSH 画布打开/验证

**B. 托管 SaaS（无 shell，只有 API）**
- 无法安装自定义节点 → 确认托管方是否允许装 custom node；不允许则该场景**不支持 bridge**，走纯 API/MCP 路径（§2.0：快速验证/批量用 `mcp-comfyui` 或原生 `/prompt`），插件画布能力不可用，`comfyui_config` 应返回明确提示（如 `bridgeInstalled: false` + 原因）。

**文档落点**：
- `README.md` / `README.zh.md` 新增「云端 ComfyUI 安装」小节（AB 两种情况 + 上面的命令）
- skill（`comfyui-admin-ops`）第 0 步一键安装的说明里，注明「`installDir` 是本机路径；云机器请按 README 云端小节操作」
- `comfyui_setup_bridge` 工具 description 里给一句云端引导（baseUrl 非本机 → 提示按 README 云端小节）

### 1.6 涉及文件

- `lib/index.js`：+`comfyui_setup_bridge` 工具；`comfyui_config` 加 bridge 三字段；installDir 回退逻辑
- `comfyui-bridge/ComfyUI-DSH-Canvas/__init__.py`：+`__version__`
- `comfyui-bridge/ComfyUI-DSH-Canvas/version.json`：新增
- `lib/index.js` skills 区：`comfyui-admin-ops` 更新
- `README.md` / `README.zh.md`：安装步骤改为 1+1 步；What you get 加工具行；顶部加关键词标签（§1.3-5）；新增「云端 ComfyUI 安装」小节（§1.5）
- `docs/architecture-flow.html`：可选补「一键安装」一段
- `package.json`：版本 `0.1.5` → `0.1.6`
- `docs/screenshots/`：可选补「一键安装流程」截图 + `screenshots.json` 更新

---

## 2. 工作流操作模式优化（P1，来自用户使用反馈）

> 使用中发现的流程优化点。本质是 **agent 画布操作语义的约定（skill 级）+ bridge 少量命令增强 + README 叙事升级**。

### 2.0 操作模式总则（写进 comfyui-canvas-ops skill，agent 必须遵守）

| 场景 | 正确做法 | 禁止 |
|---|---|---|
| **修改现有工作流** | 直接在当前画布上**增量编辑**：`add_node` / `connect` / `set_param` / `remove_node` / `inject_text`，改完 `run` | 不要用 `load_workflow` 整图替换（会把用户未保存的现场整个冲掉） |
| **新建工作流** | 先 `clear`（开空白画布）再逐步搭节点；或提示用户开新 ComfyUI 标签页 | 不要在当前有内容/有运行记录的画布上直接覆盖 |
| **搭建复杂工作流** | 用**组节点（group）分组**组织逻辑区块（如「提示词区」「采样区」「输出区」），组内连线、组间清晰 | 不要把所有节点平铺成一团 |
| **快速验证 / 批量 / 无人值守** | **走 API 或 MCP 路径**快速搭建，不必可视化：用 ComfyUI 原生 API（`/prompt` 直接提交）或环境已配置的 MCP server（如 `mcp-comfyui`）直接组工作流并跑 | 不要为了"展示"而无谓地在画布上一步步搭（慢且打扰用户） |

> **双路径选择（重要）**：agent 搭建工作流前先判断场景——
> - **可视化画布路径**（bridge 命令，WYSIWYG）：用户在实时看画布、需要调优/调试、希望每一步可见时用；前提是画布可访问（`comfyui_config` 的 activeView=canvas、bridge 可达）。
> - **API/MCP 路径**（不经过画布）：快速验证、批量扫参、无人值守、用户未开画布时用；直接提交 API 格式 workflow（`comfyui_export_api` 可得，或 MCP 工具直接搭），跑完用 `comfyui_get_outputs` 或 MCP 取结果。MCP 仅在用户环境已配置时用（`dsh-mcp-client` 配置了 `mcp-comfyui` → 如 `http://127.0.0.1:8003/mcp`），未配置则回退原生 API。
>
> 例外：只有「读回工作流 → 完整改造 → 整图回写」确实是用户意图（如批量重排）时才用 `load_workflow`，且前先 `comfyui_read_workflow` 保存现场。

### 2.1 bridge 新增命令（`entry/bridge.js` + host 工具）

1. **`clear`** —— 清空当前画布到空白工作流（新建语义）：调用 `app.graph.clear()`（LiteGraph 原生），`scheduleReport()`，返回 `{ cleared: true, nodes: 0 }`。host 侧可经 `comfyui_clear` 工具暴露（或在 `load_workflow` 的 description 里提示交替用）。
2. **`group`** —— 组节点分组：LiteGraph 原生分组 API：
   - `{ cmd: 'group', action: 'add', title, nodeIds? }` → 新建组并纳入节点
   - `{ cmd: 'group', action: 'rename', id, title }` → 改组名
   - `{ cmd: 'group', action: 'add_nodes', id, nodeIds }` / `{ cmd: 'group', action: 'remove_nodes', id, nodeIds }` → 调整组成员
   - `{ cmd: 'group', action: 'list' }` → 返回各组 `{ id, title, nodes }`
   - host 侧加 `comfyui_group` 工具（schema 覆盖上述 action）。
   - **依赖探测**：`list` 时同时返回 `groupingAvailable: true/false` —— 若用户的 ComfyUI 前端/LiteGraph 版本不支持分组（极少数定制环境），工具返回明确提示而非报错（对应「如果用户的环境中的对应的comfyui插件」的关切）。

### 2.2 skill 更新（`comfyui-canvas-ops`）

- 开头加「操作模式总则」段落（2.0 表格原文），让 agent 在任何画布任务前先判断场景（改/新建/复杂搭建）。
- 复杂搭建流程示范：clear → 分区建组（group add）→ 各组内 add_node/connect → debug 校验 → run。
- 明确：**禁止无脑 load_workflow 整图覆盖**；只有 read→改→写回闭环且用户确认时才用。

### 2.3 涉及文件

- `comfyui-bridge/ComfyUI-DSH-Canvas/entry/bridge.js`：+`clear`、+`group`（含分组可用性探测）
- `lib/index.js`：+`comfyui_clear`、+`comfyui_group`；skill（comfyui-canvas-ops）更新
- `README.md` / `README.zh.md`：工具表加 2 项；用法章节加「工作流操作模式」小节
- `docs/architecture-flow.html`：可选补「分组搭建」示意

### 2.4 README「Canvas vs MCP」改写为「组合能力展现」（文档叙事升级）

**现状**：README（中英）现有「Canvas vs MCP — two ways to drive ComfyUI」对比表（README.md L137-157 / README.zh.md L151-170），叙事是**二选一对比**（画布插件 vs Comfy CLI 谁有谁没有）。

**改法**：改为**叠加组合**叙事——同一个 ComfyUI 两种驾驶方式互补，构成完整工作流闭环。建议结构：

```
### Canvas + MCP — 同一个 ComfyUI 的两种驾驶方式

画布插件：人在环上的**可视调优**（活画布增删连线、改参、run、debug、取回出图）
MCP / comfy-cli：**无人值守执行**（批量队列、模板、模型管理、托管模型）
二者指向同一个 ComfyUI 实例，可以并存并用。

| 工作流阶段 | 使用方式 | 具体能力 |
|---|---|---|
| 搭建 / 调优 | 画布插件（bridge） | 活画布增删连线、改参、run、debug 校验、get_outputs 取回出图 |
| 固化 / 导出 | 画布插件 | comfyui_export_api 一键导出 API workflow |
| 批量 / 无人值守 | MCP / comfy-cli | 跑同一工作流规模化：批量队列、官方模板、模型管理、托管模型 |
| 结果回流 | 画布插件 | get_outputs 把 MCP 跑出的结果带回对话 |

**组合闭环**：画布上调好（构建/调优）→ export_api 导出 → 交 MCP/comfy-cli 规模化跑 → 结果回对话。
全程不离开 DSH，画布 ↔ 无头互转，能力是叠加而非替代。
```

**要点**：
- 表格从「谁有谁没有」改为「阶段 × 使用方式 × 能力」——体现组合后覆盖全场景
- 保留一句等价说明：纯 API/MCP 路径（§2.0）在快速验证/批量时优先，画布路径在可视调优时优先
- 中英同步；标题去掉 "vs"（避免对立感），如 "Canvas + MCP"
- 与 §2.0 操作总则的「双路径选择」呼应（一个讲 agent 用哪个，一个讲向用户阐述两者关系）

---

## 3. 上版本遗留候选（按优先级 P1/P2 收尾）

来自 ≤v0.1.5 各版本 PLAN 的「不做清单 / 候选项」，与主项无冲突、工作量小的优先。

### P1

#### 3.1 batch_run zip 式参数矩阵增强
- **来源**：NEXT-VERSION-PLAN §2.4 候选 2（v0.1.1 时期记录，至今未做）
- **现状**：`batch_run` 收 `runs`（独立 override 组数组），每组解耦；无「多字段同步扫参」便捷语义
- **目标**：新增 `matrix` 参数形态——`{ fields: [{nodeId, key, values: [...]}], mode: 'zip'|'product' }`，自动展开为 runs 数组后再走现有逐组入队。返回每组的 `get_outputs` 摘要（promptId + 文件数）。
- **改动**：`lib/index.js` batch_run 分支；`entry/bridge.js` batch_run 命令可不动（展开在 host 端）。README 加用法示例。
- **验收**：`fields=[seed 1..3, prompt A..C]`，`mode=product` → 9 次运行全部入队且各恢复画布。

#### 3.2 命令级授权审批钩子
- **来源**：NEXT-VERSION-PLAN §2.4 候选 3
- **现状**：DSH 已有授权遮罩/审批流；插件命令（load_workflow / run / upgrade）未区分级别
- **目标**：高影响命令（`run` / `batch_run` / `upgrade` / `reload` / `setup_bridge` 覆盖安装）触发一次确认审批（复用 DSH 审批机制，不重造轮子）。低风险读命令（read_workflow / debug / config）不触发。
- **改动**：host 工具执行前按命令白名单分级；确认实现方式调研 DSH 现有审批 API 后定（保持可选/默认不打扰）。

### P2（记录在案，不在 v0.1.6 实现）

- **WebSocket 推送替代轮询**（PLAN-v0.1.3 不做清单）：bridge→host 结果回传改 WS，省轮询延迟。改动大、收益中等，留 v0.2+。
- **工作流链式组合**（同上）：单链封装 set_param+run 的可用性验证。
- **README 演示 GIF**：录一段画布驱动演示（含一键安装 → 对话改节点 → 运行 → 取图）。纯内容，时间允许可做。
- **`/dsh-bridge/report` 鉴权**（v0.1.3 不做清单）：localhost-only 已可接受，远期选项。

---

## 4. 版本声明与质量

- 版本 `0.1.5` → `0.1.6`；README 徽章同步
- `npm run check` + `npm test`（16 用例保持绿）+ `python -m py_compile`
- 三副本同步（源码 → node_modules；bridge → node_modules + ComfyUI custom_nodes）
- 发布：npm publish + GitHub Release v0.1.6；awesome-dsh-plugin 简介/截图更新经 PR #4728（已提交，待合并）

### 4.1 推送前安全审查（每次 push / 发布前必过）

> 设计文档保留本地、不推送：`.gitignore` 已含 `docs/PLAN-*.md` + `docs/NEXT-VERSION-PLAN.md`（本地保留、GitHub 不可见），新方案文档落盘到 `docs/PLAN-*.md` 即自动受保护。推送/发布前按此清单审查：

1. **敏感信息扫描**：`git diff` / 待推送文件不得含——token / API key / 密码 / `~/.ssh` 路径 / 本机绝对路径（如 `F:\Deepseek-harness\`、`E:\AI-ComfyUI\`、`C:\Users\...`）内嵌硬编码
2. **设计文档确认未跟踪**：`git status --short --ignored docs/` 应显示 `PLAN-*.md` 为 `!!`（ignored）；若出现 `??`（untracked）或 `M`（modified），禁止推送
3. **运行时/敏感目录不入包**：`__pycache__`、`*.pyc`、`.dsh-market/`、本地 settings 副本——package.json `files` 白名单已排除（发布前 `npm pack --dry-run` 复核清单）
4. **发布账号确认**：`npm whoami` = 预期账号（wbin0001）；发布前确认 registry 指向官方（`registry.npmjs.org`，非 npmmirror）
5. **改动范围核对**：`git log --stat` 确认只含预期文件（工具/skill/README/版本），无本地环境文件混入
6. **CI 通过后再发布**：GitHub Actions（test.yml）绿；awesome-dsh-plugin PR 的 check 绿（或已知上游 bug 且有记录）再 npm publish

> 若审查发现敏感内容：先 `git rm --cached` / 从提交中剔除 → 重写提交历史（`git rebase` / `filter-repo`，未推送时直接 amend/软重置）→ 确认干净再推。

---

## 5. 实施步骤（建议顺序）

```
step 0  读本文件 + 两张架构图；npm run check、npm test 确认基线
step 1  bridge 加版本号（__init__.py __version__ + version.json）→ 同步自定义_nodes，重启 ComfyUI 验证
step 2  实现 comfyui_setup_bridge（检测→复制→校验→重启提示），复用现有路径校验
step 3  comfyui_config 加 bridge 三字段；installDir 缺失回退
step 4  skill（comfyui-admin-ops）第 0 步加一键安装
step 5  三副本同步 + 真机验证（本机 ComfyUI）
step 6  P1 工作流操作模式优化（§2）：bridge 加 clear/group 命令 + host 工具 + comfyui-canvas-ops 操作总则
step 7  P1 遗留候选（§3）：batch_run zip（3.1）；审批钩子先调研再定（3.2）
step 8  README 中英更新（安装 1+1 步 + 新工具 + 关键词标签 + 操作模式小节 + 「Canvas vs MCP」改为「Canvas + MCP」组合能力展现（§2.4））
step 9  推送/发布安全审查（§4.1 六项清单全过）→ npm run check + npm test → 提交推送 → npm publish → GitHub Release v0.1.6
step 10 截图/README 更新 → awesome-dsh-plugin PR 跟进（同步新简介截图）
```

---

## 6. 风险 / 开放问题

- **installDir 探测准确性**：windows 常见 `ComfyUI_windows_portable\ComfyUI` 与裸 `ComfyUI/` 两种布局，custom_nodes 定位要兼容两者的解析（upgrade 已有逻辑，复用）。
- **覆盖安全**："检测到本地改动不覆盖"依赖文件比对；简单起见先比对 `__version__`（版本高于等于内嵌则跳过），后续可加内容 hash。
- **审批钩子**：DSH 审批 API 的确切接入点需先调研（开放问题：调研结论决定 3.2 是否本期落地，否则降为 P2 记录）。
- **batch_run zip**：与现有 runs 形态的互斥/合并需定义清楚（推荐：`matrix` 与 `runs` 二选一，同时给报错）。
- **group 命令可用性**：依赖 LiteGraph 分组 API（graph._groups / 原生分组），不同 ComfyUI 定制前端可能缺失——`list` 时做能力探测（`groupingAvailable`），缺失则明确提示，不硬报错。
- **clear 命令风险**：清空画布不可逆，host 工具 `comfyui_clear` 执行前应先 `comfyui_read_workflow` 留存现场（或要求确认参数 `confirm: true`）。

### 开放：桥接插件是否拆独立仓库（本期不拆，记录触发条件）

**结论**：bridge 内嵌（随插件包分发）保持不变，**v0.1.6 不拆独立仓库**。理由：
- bridge 没有独立生态位——`ComfyUI-DSH-Canvas` 所有 `/dsh-bridge/*` 命令都只为 DSH host 服务，ComfyUI 生态用户不会单独装它（"独立仓库方便 ComfyUI Manager 收录"在此不成立）
- bridge 与插件强耦合（命令协议两端同时演进、版本需对应），双仓库 = 双份发布负担（改两处 / 两 tag / 两 CI），单人维护不划算
- 真正痛点（手动复制麻烦）由 `comfyui_setup_bridge` 一键安装解决，与是否拆仓库无关

**触发条件（满足任一再评估拆分）**：
1. **云端 ComfyUI 场景变多**：云机器只需 bridge、不想装整个 DSH 插件；独立仓库 `git clone` 进 custom_nodes 更干净（现状：`installDir` 指向云机器，未到非拆不可）
2. **bridge 被第二方复用**：未来有其他工具/插件要调 `/dsh-bridge/*` 协议
3. **用户持续反馈想用 ComfyUI Manager 管理**（习惯 `git clone` 路径）

**迁移路径（若未来触发）**：
1. 插件仓库加 CI：把 `comfyui-bridge/` 子树同步推送到新仓库 `ComfyUI-DSH-Canvas`（如 `wbin0001/ComfyUI-DSH-Canvas`）
2. 拆分过渡期**保留内嵌副本**兜底，独立仓库稳定后，`comfyui_setup_bridge` 的数据源从"插件内嵌目录"切换为"拉取独立仓库"（或二选一配置）
3. 拆分后插件包 `files` 中 `comfyui-bridge/` 是否保留 → 保留（作为离线兜底），体积可接受（~15KB）