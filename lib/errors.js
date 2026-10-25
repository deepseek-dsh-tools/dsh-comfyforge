/**
 * ComfyForge 错误体系。
 *
 * 为什么专门定义：DSH 会把我抛出的 `message` 直接给模型看，
 * 所以报错必须**能指导下一步动作**（去启动 ComfyUI / 补模型 / 换地址），
 * 而不是甩一句 `fetch failed`。
 *
 * 约定：`message` = 发生了什么；`hint` = 下一步怎么办。
 * 这两段会被拼成 `message\n下一步：hint` 交给模型（见 formatError）。
 *
 * 吸收自 dsh-comfyui-image 的 errors.ts（三家可靠性工程最好的那份）。
 */

/** 所有 ComfyForge 主动抛出的错误的基类。 */
export class ComfyForgeError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ComfyForgeError';
    /** 给模型/用户看的下一步建议。（只有有值时才有这个键 —— 保证工具输出是无损 JSON。） */
    if (hint) this.hint = hint;
  }
}

/** 拼一句完整的报错：主信息 + 可选的下一步建议。 */
export function formatError(error) {
  if (error instanceof ComfyForgeError) {
    return error.hint ? `${error.message}\n下一步：${error.hint}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** ComfyUI 连不上（没启动 / 地址写错 / 端口不对）。 */
export function comfyUnreachable(baseUrl, cause) {
  const detail = cause instanceof Error ? `（${cause.message}）` : '';
  return new ComfyForgeError(
    `连不上 ComfyUI：${baseUrl}${detail}`,
    '请先启动本机 ComfyUI（绘世启动器：D:\\QWQ\\ComfyUI-aki-v3.2\\绘世启动器.exe），' +
      '它默认监听 127.0.0.1:8188。也可以用 comfy_doctor 查当前配置；' +
      '要改地址就把 baseUrl 写进 profile 的 cordis.patch.yml（或插件配置文件）。'
  );
}

/** 地址指向的不是 ComfyUI（拿到了 HTML 而不是 JSON）。 */
export function notComfyUI(pathname, snippet) {
  return new ComfyForgeError(
    `地址返回的不是 ComfyUI 的 JSON（${pathname}）：${String(snippet).slice(0, 300)}`,
    '这通常意味着 baseUrl 指向了别的服务（比如一个普通网页服务器，或反向代理挡在了前面）。' +
      '请确认 baseUrl 真的是 ComfyUI 的地址，必要时用 comfy_doctor 测连接。'
  );
}

/** 参数互相冲突（刻意不做黑盒猜测 —— 冲突就报错并给改法）。 */
export function argConflict(message, hint) {
  return new ComfyForgeError(message, hint);
}

/** 参数超范围 / 类型不对 —— 明确报错，不夹到边界。 */
export function argInvalid(message, hint) {
  return new ComfyForgeError(message, hint);
}

/** 需要的 ComfyUI 节点不存在。 */
export function nodeMissing(classType, hint) {
  return new ComfyForgeError(`ComfyUI 里没有节点 \`${classType}\``, hint);
}

/** 输入/输出文件不存在。 */
export function fileMissing(kind, path) {
  return new ComfyForgeError(
    `${kind}不存在：${path}`,
    '请确认路径写对了，且用的是绝对路径或相对于当前工作目录的路径。'
  );
}

/** 工作流在 ComfyUI 里执行失败。 */
export function executionFailed(detail, promptId) {
  return new ComfyForgeError(
    `ComfyUI 执行工作流失败（prompt_id=${promptId}）：${detail}`,
    '常见两个原因：工作流里用到的节点/模型在本机不存在（去 ComfyUI 控制台看红色报错），或者显存不足。' +
      '可以先用 comfy_doctor 体检本机能力。'
  );
}

/** 任务结束但没有任何产出 —— 与「执行失败」是两回事。 */
export function noOutputProduced(promptId, baseUrl) {
  return new ComfyForgeError(
    `ComfyUI 报告任务已结束，但没有任何产出（prompt_id=${promptId}）。`,
    '最常见的原因是工作流末端没有接 SaveImage / PreviewImage 节点；' +
      '也可能是工作流只输出了 mask / latent 之类的非图片结果。' +
      `可以打开 ${baseUrl} 在队列里找到这个 prompt_id 看节点图。`
  );
}

/** 等图超时。 */
export function timedOut(waitedMs, promptId, baseUrl) {
  return new ComfyForgeError(
    `等待 ComfyUI 出图超时（等了 ${Math.round(waitedMs / 1000)} 秒，prompt_id=${promptId}）`,
    `确认 ${baseUrl} 那边的 ComfyUI 是不是卡住了、或正在跑别的任务（可看它的队列）。` +
      '视频/音频类任务请用异步模式（mode: "async"）。'
  );
}

/** 没有任何可用底模 —— 本机头号问题，必须给可执行的补齐方案。 */
export function noCheckpoint(comfyuiDirs) {
  const dirs = comfyuiDirs?.length ? comfyuiDirs.join('、') : '（未配置 comfyuiDirs）';
  return new ComfyForgeError(
    'ComfyUI 报告没有任何可用的底模（models/checkpoints 是空的）。',
    `本机的 ComfyUI 目录：${dirs}。请往 models/checkpoints 放一个 .safetensors / .ckpt 底模。` +
      '按 6G 显存推荐：① SD1.5 系（约 2 GB，最稳）；② SDXL 系 fp16（约 6.5 GB，会紧张）或 fp8/GGUF 量化档（约 3.5 GB，本机已装 ComfyUI-GGUF 节点，优先走这个）。' +
      '下载建议用 ModelScope（国内直连 6~8 MB/s，比 HuggingFace 快十倍）。' +
      '放好后在 ComfyUI 界面里刷新一下，再跑 comfy_doctor 复查。'
  );
}

/** 指定的底模不存在 —— 列出现有可选项。 */
export function checkpointNotFound(preferred, available) {
  const list = available.slice(0, 12).join('、');
  const more = available.length > 12 ? ` 等 ${available.length} 个` : '';
  return new ComfyForgeError(
    `指定的底模不存在：${preferred}`,
    `本机可用的底模有：${list}${more}。请改成其中之一，或清空该参数让插件自动挑。`
  );
}

/** 采样器/调度器不存在。 */
export function samplerNotFound(kind, name, available) {
  return new ComfyForgeError(
    `${kind}不存在：${name}`,
    `本机可用：${available.join('、')}`
  );
}

/** 显存预算不足 —— 本机 6G 专属，提前警告比跑到一半 OOM 友好。 */
export function vramInsufficient(needMiB, haveMiB, advice) {
  return new ComfyForgeError(
    `显存可能不足：这个工作流预计需要约 ${needMiB} MiB，而当前可用约 ${haveMiB} MiB。`,
    advice ??
      '可以：① 调小分辨率或帧数；② 换更低量化的模型（本机已装 ComfyUI-GGUF，优先 GGUF）；' +
        '③ 调小 steps；④ 在 ComfyUI 里先释放内存（/free）再跑。'
  );
}

/** 工具名冲突 —— 防止抢了别的插件的名字。 */
export function toolNameConflict(name, owner) {
  return new ComfyForgeError(
    `工具名 \`${name}\` 已被占用（疑似 ${owner}）。`,
    'ComfyForge 的工具一律用 comfy_ 前缀，不与其它插件抢名。' +
      '请检查 profile 里同时装了哪些出图类插件（例如 dsh-agnes-multimodal 注册了 generate_image）。'
  );
}
