# 吸收笔记 02 — dsh-comfyui-canvas 0.1.13（wbin0001）

> 源码根：`D:\用户\工具\Temp\comfy-survey\x-dsh-comfyui-canvas-0.1.13\package\`
> 规模：4426 行（host 1921 / client 1370 / bridge.js 802 / __init__.py 178 / utils 157）。
> 状态：**npm 有包（近月 2633 下载），但 GitHub 仓库与作者账号均 404** → 无 issue 通道、无源码审计、维护性存疑。
> **结论：不建议直接安装。但它的「架构范式」是三家最值钱的，专属插件应当吸收思路、重写实现。**

## 一、四层架构（最值得理解的范式）

```
① DSH host        lib/index.js     —— 26 个 comfyui_* 工具 + 4 个 runtime skill，只发 HTTP
② DSH web         lib/client.js    —— __ModuleLoader__.load，注入 3 个官方槽
③ ComfyUI 节点    custom_nodes/ComfyUI-DSH-Canvas/
                   __init__.py     —— WEB_DIRECTORY="entry" + 4 条 /dsh-bridge/* 路由
                   entry/bridge.js —— 注入 ComfyUI 前端，直接操作 LiteGraph/pinia
④ 通道            host ──GET /dsh-bridge/workflow──> bridge
                  host ──POST /command──> send_sync("dsh-bridge-command") ──WS──> 前端执行
                  host <──GET /result/{id}── 轮询
```

## A. 跨域嵌入范式（核心洞察，直接吸收）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| A1 | **跨域 iframe 不读 contentWindow，改为「对端注入 SDK」** | `client.js:190-197`（iframe 只有 `src`/`allow`）+ `bridge.js:12-13` + `__init__.py:56-62,139` | 宿主**永不依赖同源**，能力由对端主动上报 + 监听命令实现。天然支持云端/远程实例。**这是嵌入任意 Web 应用进 DSH 的通用范式** —— 比 postMessage 握手稳得多（不用管 targetOrigin、不用管跨域策略）。 |
| A2 | **iframe 常驻 body，只改 display/left/top/width/height** | `client.js:38-48, 1015-1018, 1079-1089, 1117` | `removeChild` 会销毁浏览上下文 → 重挂载等于重新加载 ComfyUI（几十秒）。**「切标签秒开不重载」是嵌入类插件的核心体验指标。** |
| A3 | **分屏挤压布局零核心改动** | `client.js:521-544, 1275-1320, 242-246` | 只打 `html[data-dsh-split-on]` / `[data-dsh-rail-closed]` 标记 + 注入 CSS 变量 `--dsh-comfyui-rail-width`；几何从 `[data-conversation-scroll]`/`[data-phase]` 的 `getBoundingClientRect` 算。**不碰 hash 类名、不用私有补丁 → 宿主办升级不裂开。** 这是「插件做布局改造却不 fork 核心」的样板。 |
| A4 | **DOM 标记看门狗** | `client.js:1173-1225, 679-695` | 任何状态变化都重算 `data-dsh-split-on`，兜住 React effect 清理漏跑；强制 `display:none`（`visibility` 会被 iframe 自身 visible 穿透）。**命令式 DOM 标记 + React 生命周期必然残留，看门狗式收敛值得吸收。** |

## B. 跨版本 / 跨环境降级（工程韧性）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| B1 | **配置读写三态降级** | `client.js:13-36, 1126-1137`；host `index.js:375-389` | 优先 `ctx.configForms.get(ns)` → 缺则模块级内存 store（自造 `subscribe`/`getSnapshot` 喂 `useSyncExternalStore`）→ 再缺则纯内存。**跨 DSH 大版本（0.1.6 移除 settingsScope、0.1.7 换 entry Config）不崩。** |
| B2 | **配置当 RPC 总线** | `index.js:64-141`(schema 注释), `393-457, 465-481, 587-649`；`client.js:447-454, 469-471` | 一次性「请求-响应」标志位协议：客户端把意愿写进 config（`launchRequested`/`probeRequested`/`updateRequest`/`comfyControl`），host watcher 执行后写结果字段并清标志。**浏览器跨域调不动 host 能力时，用配置做 RPC —— 比新造 IPC 便宜，且天然可观测、可持久化。** |
| B3 | **鉴权「生效性」探测** | `index.js:245-278, 1102-1107` | 同 URL 发**正确 token 与故意错 token 各一发**，只有 401 才算真生效。**「配了不等于生效」** —— 两端配置必须一致的系统里，这是防哑火的关键探针。 |
| B4 | **能力探测降级要 fail loud** | `bridge.js:606-614, 466-508`；`index.js:1777-1782` | `comfyui_group` 先报 `groupingAvailable:false`（前端无 LGraph groups）；`comfyui_reload` 在非 win32 **直接报错**而非静默 no-op；`ui_probe` 报告 Vue/pinia 链断点。**「不支持就明说」胜过硬报错或假成功。** |
| B5 | **配置写入的 unhandled rejection 视作 fatal boot** | `index.js:334-336, 384-389` | 所有 `settings.update` 经 `safeUpdate` 包 `Promise.resolve(...).catch(()=>{})`。**这是宿主级的真实故障模式，任何写配置的插件都该这么包。** |

## C. 画布层的活操作（另两家完全没有的能力）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| C1 | **LiteGraph 活画布操作** | `bridge.js` 全文 + `index.js` | `add_node`/`connect`/`set_param`/`remove_node`/`move`/`align`/`grid`/`group`/`clear` + `comfyui_export_api`。自管 `_dshNodes` 与 bounding，**patch `LGraphGroup.prototype.serialize` 持久化成员**。另两家只能提交 API workflow，**改不了用户眼前的图**。 |
| C2 | **直驱前端 store 绕过对话框** | `bridge.js` pinia 调用 | `new_canvas`/`rename_workflow`/`save_workflow` 走 pinia `command`/`workflow` store（`Comfy.NewBlankWorkflow`），**失败回退 DOM 点击** —— 双通道冗余。 |
| C3 | **`overrides` 临时改 widget 跑图 + finally 无条件还原** | `bridge.js:300-332`(run), `338-373`(batch_run) | 「跑一次改一次画布」是画布型工具的通病；**快照-还原模式让批量与手动编辑可以并存**，同一张图可反复扫参而不污染现场。 |
| C4 | **`validate` 只做结构检查、绝不提交 `/prompt`** | `bridge.js:391-414, 376-383`；`index.js:1041-1061` | 动态槽（switch/index/`image\d+`）降级为 warnings **不误报**；再把 offendingIds 交给 `highlight` 闪一下。**「校验不花钱」+「不误报用户环境的正常形态」两件事一起做到，是工具可信度的分水岭。** |
| C5 | **声明式批量扫参矩阵** | `utils.js:112-157`；`index.js:856-895` | `matrix.fields[] + mode:'zip'\|'product'` 在 **host 端**展开成 runs，bridge 协议零改动；**zip 长度不等直接报错而不静默裁剪**。**扩展协议面比扩展协议体便宜** —— 把「展开」留在 host 使 ComfyUI 侧保持哑终端。 |
| C6 | **画布状态结构化 + id 类型归一** | `bridge.js:28-43` `summarize(graph)` | `summarize` 出 `{id,type,title}`，`serializeGraph` 出完整 UI workflow；host 侧再把 id **全归一化为 number**。**「字符串 id 导致模型每次都要转类型」是隐性 token 浪费，host 端一次归一化省掉长期成本。** |

## D. 运行账本与产物归属

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| D1 | **运行账本 `Map<promptId,{overrides,timestamp,status}>`** | `index.js:346-358, 996-1016`；`utils.js:90-99` | 上限 500，取图时 **upsert** 进 `runs.json`，用 history 的最终 status 覆盖暂存 `'queued'`。**「这张图是哪组参数出的」是可复现性的最小闭环**；upsert 保证重复下载不产生重复条目。 |
| D2 | **取图全类型 + 显式 KIND_LABEL 表** | `index.js:937-955, 961-1016`；`utils.js:70-83` | 扫 images/videos/gifs/audio 四键，**用显式映射表而非 `slice(0,-1)`**（后者会把 `audio` 变成 `audi`）。 |
| D3 | **产物落项目目录而非 ComfyUI `output/`** | `index.js` | `outputStem` + `nextStemNumber` 自动编号**永不覆盖**。**不污染被管理软件的目录** —— 产出物归属的干净做法。 |
| D4 | **错误结构抽取兼容两种 history 形态** | `utils.js:36-63`；`index.js:834-848, 1029` | 新版 `status.execution_error` / 经典 `status.messages[]` 都接；traceback 截 2000 字符；**`nodeErrors` 时补一发 `/history` 挖具体错误**（提交失败往往掩盖真错）。 |

## E. 被管理组件的安装/升级/体检（三件套）

| # | 机制 | 位置 | 为什么值得吸收 |
|---|---|---|---|
| E1 | **幂等安装 + 版本比对** | `index.js:165-223, 1246-1370, 1108-1124` | `version.json` 优先、`__init__.py` 正则兜底、**rc 感知 semver**、不可比视为相等；`comfyui_config` 暴露 `bridgeInstalled`/`bridgeUpToDate` 一眼可见。**插件自带「被管理组件」的安装/升级/体检，是把安装摩擦降为零的标准打法。** |
| E2 | **SOP 放 skill 而非工具描述** | `index.js:1824-1920` | `ctx.skills.register({source:'runtime'})` 注册 4 份 SOP（画布操作/环境管理/音画/节点开发）。**工具描述受 token 预算约束，SOP 放 skill 才能写细**（含「禁止无脑 load_workflow 覆盖现场」这类约定）。 |
| E3 | **进程生命周期纳入管理** | `index.js:431` 等 | 启动命令（`launchRequested`）+ stop/restart（**记句柄 kill，回退 netstat 按端口杀**）+ `comfyui_reload` + `comfyui_upgrade`（4 路并发 git pull、跳过 dirty 仓库、5 分钟总超时）。 |
| E4 | **多标签单执行者定向** | `bridge.js:152-697, 772-783`；`__init__.py:117-142` | 按「最近上报的 clientId」**只让一个标签执行**；没有上报者就明确报错（**拒绝广播以免多标签重复执行**）。多标签/多会话环境下「命令执行一次」的定向算法，很多插件会漏。 |

## F. 风险与缺陷（专属插件必须避开）

| # | 风险 | 证据 | 我们的对策 |
|---|---|---|---|
| F1 | **直接写用户 ComfyUI 安装目录** | `index.js:1316-1326` `comfyui_setup_bridge`：`mkdirSync`+`copyFileSync` 覆盖 `__init__.py`/`bridge.js`，判据**只有 `__version__` 字符串**（PLAN §6 自认「后续可加内容 hash」），**无备份、无 diff、无内容校验** | 注入前先备份 + 内容指纹校验 + 可一键卸载。 |
| F2 | **前缀校验可被符号链接绕过** | `index.js:1687-1690, 1698-1699, 1753-1754` 全用 `path.resolve` 而非 `realpath`；`custom_nodes` 下的 junction 指向外部即可越界读写，而 `edit_source` 等价于**对 ComfyUI 进程的任意代码执行** | 一律 `realpath` 后再做前缀校验。 |
| F3 | **桥接默认无鉴权且拒不改** | `__init__.py:65-74, 145-152` `/report`、`/result` 刻意不过 token 门（注释只说「id 随机」）；本机任意进程可伪造上报污染全局 `_latest`，可 `POST /command` 触发 `load_workflow`/`run`（**偷 GPU**） | 桥接路由强制 token + 只认 loopback。 |
| F4 | **全局单槽 + 过期定向** | `__init__.py:35` `_latest` 模块级单例，多前端互相覆盖；`_command_results` 上限 200 按**插入序**裁剪（非时间序），可被刷满挤掉真结果 | 按会话隔离；结果表按时间淘汰。 |
| F5 | **沙箱/越权面过大** | 多处 `sandboxPolicy:{mode:'danger-full-access'}`（`index.js:431,550,627,1798,1807`）；`launchCommand` 是用户字符串直接 `shell.start`；`comfyui_reload` 用 `netstat+taskkill /F` 按端口杀 → **可能误杀占用 8188 的其它进程** | 不引入 `danger-full-access`；杀进程前核对进程名。 |
| F6 | **宿主内部结构耦合（隐性）** | `ctx.fiber?.config`、`ctx.get('agents')?.currentInitiator`、`exec.agent.session`、`ctx.shell.start/run/resolve/readOutput`、`settings/document-updated`；客户端依赖 `[data-phase]`/`[data-conversation-scroll]`/`[data-composer-seat]`/`[data-width-handle]`/`[data-slot]` + `__ModuleLoader__` | 上游任一改动 = **静默降级**（不报错、只是不工作）→ 要加装配自检。 |
| F7 | **性能/时序** | host 1500ms 常驻 `setInterval` 跑全部 config watcher（`index.js:656`）；客户端 4s 探 `/system_stats`、`MutationObserver` 观察 `document.body{subtree,characterData}`（`client.js:303-304,419`）→ 空闲也耗电。命令轮询默认 400ms，超时 `load=15s/run=20s/batch=30s`，**product 展开上百组必然超时** | 事件驱动替代轮询；批量用 async job。 |
| F8 | **语义风险靠约定而非代码约束** | `comfyui_clear` 要 `confirm:true`（唯一硬守卫），而 `load_workflow` 覆盖未保存现场、`run` 消耗 GPU 都只写在 skill/描述里 | 破坏性操作全部加硬守卫。 |
| F9 | **遗留/重复代码** | `expandBatchMatrix` 在 `utils.js:112` 与 `index.js:225-235` 各一份；`Config` 保留 legacy `canvasScale`/`activeView`；`comfyui_attach_image` 已弃用未删 | 不留死代码。 |

## G. 独立能力清单（另两家没有，专属插件按需吸收）

1. **把 ComfyUI 原生前端整个嵌进 DSH**（iframe 分屏 + `conversation.view` 全屏标签，常驻保活）
2. **ComfyUI 侧自定义节点桥接** + 一键安装/升级（`/dsh-bridge/*` 4 路由 + `WEB_DIRECTORY` 注入）
3. **LiteGraph 层活画布操作**（增删节点/连线/改参数/分组）+ `comfyui_export_api`
4. **直驱 pinia store 新建/改名/保存工作流**（绕过对话框，DOM 点击兜底）
5. **`matrix` zip/product 声明式批量扫参**
6. **把 ComfyUI 进程生命周期纳入 DSH**（启动/停止/重启/重载/升级）
7. **自定义节点开发闭环**（read_source / edit_source / reload）
8. **会话级画布专注态**（`activeViewBySession` 等，host 侧按 `exec.agent.session` 取值）
9. **鉴权生效性握手**、**多标签单执行者定向**、**运行账本 runs.json**

## H. 取舍判断（给专属插件的建议）

- **值得吸收**：A1 跨域对端注入、A2 iframe 保活、A3 零核心改动的布局标记、B1 三态配置降级、B3 鉴权生效性探测、B5 safeUpdate、C3 overrides 快照还原、C4 validate 不误报、C5 host 端展开矩阵、C6 id 归一、D1 运行账本、D4 双形态错误兼容、E1 安装体检三件套、E4 单执行者定向。
- **不要吸收**：F1–F9 全部。特别是**往用户 ComfyUI 目录写文件**要重做成「备份+指纹+可卸载」，**符号链接校验**要改 `realpath`，**桥接鉴权**必须加，**danger-full-access** 不引入。
- **总体**：它的「架构范式」是三家最值钱的，但它的「工程安全性」是三家最差的。专属插件抄范式、不抄实现。
