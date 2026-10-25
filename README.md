# dsh-comfyforge

> DSH 的 ComfyUI 专属插件。**把三款现役插件的长处合成一个，为本机（RTX 3060 6G + 秋叶 ComfyUI + 空模型仓）做定制。**
> 立项：2026-10-20。状态：**规格已定稿，代码未开工**。

---

## 这个目录里有什么

| 文件 | 是什么 | 什么时候读 |
|---|---|---|
| **[SPEC.md](SPEC.md)** | **开发规格书**（交付给新对话用的完整文档） | **先读这份** —— 含环境硬事实、接口契约、可照抄的参数、验收清单、分阶段计划 |
| `reference/吸收笔记-01-主插件.md` | dsh-comfyui 0.5.5 逆向结论（含「直接可抄」表） | 想知道某机制怎么写时 |
| `reference/吸收笔记-02-canvas.md` | dsh-comfyui-canvas 0.1.13 逆向结论（架构范式） | 想做 iframe 嵌入 / 画布操作时 |
| `reference/吸收笔记-03-image.md` | dsh-comfyui-image 0.1.1 逆向结论（可靠性范本） | 想做错误体系 / doctor / 测试时 |
| `reference/dsh-comfyui-0.5.5/` | 主插件完整源码（14021 行） | 需要看具体实现时 |
| `reference/dsh-comfyui-image-0.1.1/` | 单工具插件源码（~2600 行 TS） | 同上 |
| `reference/dsh-comfyui-canvas-0.1.13/` | 嵌入型插件源码（4426 行） | 同上 |

---

## 三句话讲清这个插件要干什么

1. **抄骨架**：dsh-comfyui 的平台能力（工作流库 + action 分流工具 + 技能包三级披露 + 图→API 转换）。
2. **抄可靠性**：dsh-comfyui-image 的工程纪律（分层解耦 + hint 错误体系 + doctor 自检 + mock 测试）。
3. **抄范式不抄实现**：canvas 的 iframe 对端注入嵌入法，但**修掉它的三处安全债**（写用户目录无备份 / `realpath` 缺位 / 桥接无鉴权）。

**同时解决三家共同的短板**：
- 本机**模型仓是空的** → 探测到空要给可执行的补齐方案，不是一句报错
- **6G 显存** → 默认轻量档 + 提前估算告警
- **工具名不能抢** → 一律 `comfy_*` 前缀（`generate_image` 已被 Agnes 占用）

---

## 怎么开工

开一个**新对话**，把这段话发过去：

> 开发 DSH 插件 `dsh-comfyforge`。规格书在 `D:\用户\代码\dsh-comfyforge\SPEC.md`，三家参考源码与我的逆向笔记在 `D:\用户\代码\dsh-comfyforge\reference\`。
> 先读 SPEC.md 全文 + 三份吸收笔记，然后按 SPEC §14 从 V0 骨架开始做。
> **每改 `D:\DSH` 下的东西都走 safe-change 四段流程**（备份→语法→import→headless 冒烟）。

---

## 硬约束速查（详见 SPEC §1）

| 项 | 值 |
|---|---|
| DSH 宿主 | `0.2.1-rc.2`，`engines.dsh` 写 `>=0.2.0-rc.1 <0.3.0-0` |
| ComfyUI | `D:\QWQ\ComfyUI-aki-v3.2`（0.30.2 / Python 3.13.11 / torch 2.13.0+cu130） |
| GPU | RTX 3060 Laptop **6144 MiB** |
| **模型仓** | **空的**（`models/checkpoints` 等只有占位符）← 头号约束 |
| 已装节点 | GGUF / RMBG / WanVideoWrapper / IPAdapter / LTXVideo / Impact-Pack / ControlNet-aux / VideoHelperSuite / UltimateSDUpscale |
| 工具前缀 | `comfy_*`，**不许占 `generate_image`** |

---

## 写代码前的四条铁律

1. **`inject` 只放 `['tools']`** —— 其余服务惰性挂载，headless 宿主也要能跑。
2. **volatile 字段双形态读** —— `Symbol.for('cosmokit.volatile.write')` 探测，别照抄 `.get()`。
3. **安全校验用 `realpath`**，不用 `path.resolve`。
4. **装完必须重启 DSH**（profile 插件改动），且**装前先快照**。
