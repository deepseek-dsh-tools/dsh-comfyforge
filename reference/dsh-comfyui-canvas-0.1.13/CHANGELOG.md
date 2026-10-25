# Changelog

本仓库变更记录（与版本号对应）。

## [0.1.13] - 2026-10-01

### Fixed
- `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 改为必需 peer 依赖（移除 optional 标记）——修复 dsh.so 隔离沙盒安装时解析不到 DSH 运行时包导致的 L5 Web 冒烟 boot failed
- 离线/检测中启动卡片改为「嵌入面板」样式：不再用深色遮罩浮在背景上，卡片直接嵌在画布区

### Changed
- README 顶部截图 01 替换为纵向长截图（DSH 内操作 ComfyUI 的连续画面）
- README 代码块中含 shell 高亮红色符号（`&&`、`<占位符>`）的 8 处从 `bash`/`powershell` 改标 `text`，消除 GitHub 深色主题下的异常红色
- 版本对齐 0.1.13（插件 package.json + 桥接节点 version.json / `__version__` + README 徽章）

## [0.1.12] - 2026-09-28

### Added
- 工作流生命周期：`new_canvas`（调用前端"新建空白工作流"命令，无需清空/模拟点击）、`rename_workflow`（命名/重命名，无对话框）、`save_workflow`（直接持久化）
- 布局整理：`move_node`（绝对/偏移移动）、`align_nodes`（对齐 left/right/top/bottom/hcenter/vcenter、均匀分布 horizontal/vertical、网格重排 cols+gap）
- 通用前端命令桥接 `command`（执行任意注册命令，如 Comfy.SaveWorkflow）
- UI 探测 `ui_probe`（诊断 Vue/pinia 链路与界面元素）
- 组边界框顶部标题留白（50px），节点不再压盖组标题；移动/整理组内成员时组框自动重新贴合

### Changed
- host 工具新增 5 个：`comfyui_new_canvas` / `comfyui_rename_workflow` / `comfyui_save_workflow` / `comfyui_move_node` / `comfyui_align_nodes`
- 内置技能 SOP：新建工作流优先 `comfyui_new_canvas`，复杂工作流用 `group` + `align_nodes` 整理布局
- 版本对齐 0.1.12（插件 package.json + 桥接节点）

### Security
- `rename_workflow` 文件名安全校验（1-50 字符、拒绝路径/控制字符，防路径穿越）
- `move_node` 数字校验（NaN 防护）、`align_nodes` 参数规整（cols≥1、gap≥0）
- `set_param` 对前端回调容错（combo 选项异步初始化时不失败）

## [0.1.11] - 2026-09-28

> 覆盖 v0.1.10 发布（tag `333b009`）之后到 0.1.11 的全部更新：`0987ef5`（画布专注模式修复）+ `4a8871a`（分组功能）+ `9ca2f25`（CHANGELOG 纳入 npm files），均随 npm 0.1.11 发布。

### Added
- 工作流分组：`comfyui_group` 创建组（可传 `bounding` 显式定位）、增删成员、组边界框按节点坐标自动贴合
- 组成员持久化：保存工作流时把成员 id（`nodes`）写入组对象 JSON，加载时自动重建成员关联（序列化补丁 + configure 钩子）——重开工作流分组原样恢复
- 画布专注模式（会话隔离，v0.1.10 标签后补的修复）：独立画布标签写入 `activeViewBySession`，`comfyui_config` 可感知当前会话的画布专注状态

### Fixed
- 修复分组成员此前静默失效的根因：LiteGraph 缺 `addNode` 方法且 `LGraphGroup.nodes` 为只读 getter，改为桥接自管成员（`_dshNodes`）
- 修复组边界框固定为默认值的问题：创建 / 增删成员时按节点坐标自动计算贴合

### Changed
- 版本号对齐：插件 `package.json` 与桥接节点（`version.json` / `__version__`）统一为 `0.1.11`
- README 版本徽章更新为 0.1.11，并补充分组功能文档
- `CHANGELOG.md` 纳入 npm 发布文件清单（`files`），随下一版本进入 npm 包
