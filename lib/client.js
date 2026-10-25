/**
 * ComfyForge 的 ComfyUI HTTP 客户端。
 *
 * 只为插件需要的端点实现最小集合；**刻意不用 ComfyUI 自己的 WebSocket 进度通道**
 * 来做主流程等待（history 轮询更简单、且能穿过代理和远程部署）。
 * 进度另有 ProgressTracker（见 progress.js），是 best-effort 的增强。
 *
 * 吸收自 dsh-comfyui 的 comfyui.js —— 它的注释里全是踩过的坑，这里逐条复刻。
 */
import { randomUUID } from 'node:crypto';
import { comfyUnreachable, notComfyUI, ComfyForgeError } from './errors.js';

/** 与排队任务关联的 client id（ComfyUI 用它把进度广播回提交者）。 */
export const CLIENT_ID = randomUUID();

/**
 * 每个 baseUrl 学到的路由前缀：'' 表示裸路由可用，'/api' 表示只有 /api 镜像可用。
 *
 * ComfyUI 每条路由都有裸的和 /api 前缀的两份，但**只转发 /api/* 的反向代理**
 * 会让裸路由 404。首次请求探测一次，进程内缓存（client 是每次调用新建的）。
 */
const routePrefix = new Map();

function sleep(millis, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ComfyForgeError('ComfyUI generation aborted'));
      return;
    }
    const timer = setTimeout(resolve, millis);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ComfyForgeError('ComfyUI generation aborted'));
    }, { once: true });
  });
}

/** 按文件扩展名猜 content-type（媒体代理与上传都要用）。 */
export function guessContentType(filename) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.avi')) return 'video/x-msvideo';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.opus')) return 'audio/opus';
  return 'application/octet-stream';
}

/** ComfyUI REST API 客户端。 */
export class ComfyUIClient {
  constructor(baseUrl, apiKey, connectTimeoutMs, maxMediaBytes) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxMediaBytes = maxMediaBytes;
  }

  base() {
    return this.baseUrl.replace(/\/+$/, '');
  }

  endpoint(path) {
    if (path.startsWith('/api/')) return `${this.base()}${path}`;
    return `${this.base()}${routePrefix.get(this.base()) ?? ''}${path}`;
  }

  /** fetch 一条路由；404 时重试 /api 前缀，直到前缀被学到。 */
  async fetchRoute(path, init) {
    const base = this.base();
    let response;
    try {
      response = await fetch(this.endpoint(path), init);
    } catch (error) {
      // fetch 本身失败 = 连不上（没启动 / 端口不对 / DNS）。
      throw comfyUnreachable(base, error);
    }
    if (path.startsWith('/api/') || routePrefix.has(base)) return response;
    if (response.ok) {
      routePrefix.set(base, '');
      return response;
    }
    if (response.status !== 404) return response;
    const retry = await fetch(`${base}/api${path}`, init);
    if (!retry.ok) {
      await retry.body?.cancel().catch(() => undefined);
      return response;
    }
    routePrefix.set(base, '/api');
    await response.body?.cancel().catch(() => undefined);
    return retry;
  }

  async request(path, init = {}, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.connectTimeoutMs);
    try {
      const headers = { ...init.headers };
      if (this.apiKey !== undefined && this.apiKey !== '') headers['Authorization'] = `Bearer ${this.apiKey}`;
      const response = await this.fetchRoute(path, { ...init, headers, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ComfyForgeError(
          `ComfyUI ${path} failed: HTTP ${response.status}${body !== '' ? ` — ${body.slice(0, 300)}` : ''}`,
          response.status === 404
            ? '这个端点可能在本机 ComfyUI 版本上不存在（版本差异），或地址不对。'
            : '请确认 ComfyUI 正常运行；若是 400，多半是提交的工作流里有不存在的节点或模型名。'
        );
      }
      const text = await response.text();
      if (text === '') return undefined;
      try {
        return JSON.parse(text);
      } catch {
        // 拿到 HTML 而不是 JSON —— 地址多半指向了别的服务。
        throw notComfyUI(path, text);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** best-effort GET：404 / 网络错误一律吞掉返 false，不阻断主流程。 */
  async getOk(path, timeoutMs) {
    try {
      await this.request(path, {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 放一个文件进 ComfyUI 的输入目录（图片/视频/音频同理）。
   *
   * ⚠️ /upload/image **只接受 multipart/form-data**：把字节当原始 body 直发会 HTTP 400。
   * form 的字段名必须是 `image`；`overwrite=true` 防止重复选同一文件时堆出 "name (1).png"。
   */
  async uploadMedia(bytes, filename, contentType, opts = {}) {
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename);
    form.append('overwrite', opts.overwrite === false ? 'false' : 'true');
    if (opts.subfolder !== undefined && opts.subfolder !== '') form.append('subfolder', opts.subfolder);
    // 视频文件很大：连接超时对它太紧，放宽到 120 秒。
    const data = await this.request(
      '/upload/image',
      { method: 'POST', body: form },
      opts.timeoutMs ?? Math.max(this.connectTimeoutMs, 120_000)
    );
    return data ?? {};
  }

  /** 提交一份 API 格式工作流，返回 prompt_id。 */
  async queuePrompt(workflow, options = {}) {
    const payload = { prompt: workflow, client_id: CLIENT_ID };
    if (options.promptId !== undefined) payload['prompt_id'] = options.promptId;
    if (options.front === true) payload['front'] = true;
    if (options.extraData !== undefined && Object.keys(options.extraData).length > 0) {
      payload['extra_data'] = options.extraData;
    }
    const data = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (typeof data?.prompt_id !== 'string') {
      throw new ComfyForgeError('ComfyUI /prompt 没有返回 prompt_id');
    }
    return data.prompt_id;
  }

  /** 读一条 prompt 的 history；未知名/被清掉时返回 undefined。 */
  async getHistory(promptId) {
    const data = await this.request(`/history/${encodeURIComponent(promptId)}`);
    return data?.[promptId];
  }

  /** 服务器队列：running + pending。 */
  async getQueue() {
    const raw = await this.request('/queue');
    // ComfyUI 把每个队列槽序列化成 [number, prompt_id, prompt, ...]；只要前两项。
    const parse = (list) => {
      if (!Array.isArray(list)) return [];
      const items = [];
      for (const entry of list) {
        if (Array.isArray(entry) && typeof entry[1] === 'string' && entry[1] !== '') {
          items.push({ number: typeof entry[0] === 'number' ? entry[0] : 0, prompt_id: entry[1] });
        }
      }
      return items;
    };
    return { queue_running: parse(raw?.queue_running), queue_pending: parse(raw?.queue_pending) };
  }

  /** 从 pending 队列里删掉指定 prompt。 */
  async deleteQueueItems(promptIds) {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: promptIds })
    });
  }

  /** 清空整个 pending 队列（不影响正在跑的那个）。 */
  async clearQueue() {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true })
    });
  }

  /** 打断正在跑的 prompt；不给 id 会打断全局。 */
  async interruptPrompt(promptId) {
    await this.request('/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promptId !== undefined ? { prompt_id: promptId } : {})
    });
  }

  /**
   * 只取消**自己那一条** prompt：pending 就删队列项，running 才打断，已跑完就什么都不做。
   *
   * ⚠️ 裸 `interrupt()` 会打断**任何**正在跑的任务 —— 可能是另一个会话的，
   * 也可能是用户自己在 ComfyUI 界面点的。所以必须先查队列。
   * （老版本 ComfyUI 会忽略 interrupt 的 prompt_id，所以这个队列检查是必需的。）
   */
  async cancelPrompt(promptId) {
    const queue = await this.getQueue();
    if (queue.queue_pending.some((item) => item.prompt_id === promptId)) {
      await this.deleteQueueItems([promptId]);
      return;
    }
    if (queue.queue_running.some((item) => item.prompt_id === promptId)) {
      await this.interruptPrompt(promptId);
    }
  }

  /** 清空 history。 */
  async clearHistory() {
    await this.request('/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true })
    });
  }

  /** 删指定 history 条目。 */
  async deleteHistory(promptIds) {
    await this.request('/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: promptIds })
    });
  }

  /** 让 ComfyUI 卸载模型 / 释放内存。 */
  async freeMemory(options = {}) {
    await this.request('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        unload_models: options.unloadModels === true,
        free_memory: options.freeMemory === true
      })
    });
  }

  /**
   * 列一个 user-data 子目录（如 'workflows'）。
   * ⚠️ 有些版本没有 /v2/userdata（0.35 桌面版）→ 404 时落回 v1 的 /userdata 并归一化。
   */
  async listUserData(subdir) {
    let data;
    try {
      data = await this.request(`/v2/userdata?path=${encodeURIComponent(subdir)}`);
    } catch (error) {
      if (!(error instanceof ComfyForgeError) || !/HTTP 404/.test(error.message)) throw error;
      const legacy = await this.request(
        `/userdata?dir=${encodeURIComponent(subdir)}&recurse=true&split=false&full_info=true`
      );
      if (!Array.isArray(legacy)) return [];
      return legacy.map((item) => {
        const rel = (typeof item === 'string' ? item : item.path).replace(/\\/g, '/');
        const entry = { name: rel, path: `${subdir}/${rel}`, type: 'file' };
        if (typeof item !== 'string' && item.size !== undefined) entry.size = item.size;
        if (typeof item !== 'string' && item.modified !== undefined) entry.modified = item.modified;
        return entry;
      });
    }
    if (!Array.isArray(data)) return [];
    if (typeof data[0] === 'string') {
      return data.map((name) => ({ name, path: `${subdir}/${name}`, type: 'file' }));
    }
    return data;
  }

  /** 读一个 user-data 文件（相对 user 根的路径，如 'workflows/x.json'）。 */
  async getUserDataFile(relPath) {
    // {file} 路由只匹配单段，所以相对路径要 URL 编码（handler 会解回来）。
    return this.request(`/userdata/${encodeURIComponent(relPath)}`);
  }

  /** 节点定义（手写工作流前查节点与模型名用）。 */
  async objectInfo() {
    return this.request('/object_info');
  }

  /** 单节点定义；失败回退整表。 */
  async nodeInfo(classType, signal) {
    try {
      const data = await this.request(`/object_info/${encodeURIComponent(classType)}`);
      if (data && typeof data === 'object' && data[classType]) return data[classType];
      return data?.[classType] ?? (data && data.input ? data : undefined);
    } catch {
      const all = await this.objectInfo();
      return all?.[classType];
    }
  }

  /** 服务器健康/版本探针。 */
  async systemStats() {
    return this.request('/system_stats');
  }

  /**
   * 流式取一个产出文件（GET /view），不缓冲，支持 Range 让浏览器能拖进度条。
   *
   * ComfyUI 自己处理 Range：合法区间答 206 + Content-Range，越界答 416 —— 两者都原样透传。
   * HEAD 转 HEAD，不下 body。maxMediaBytes 只对完整 200 响应生效（分段天然有界）。
   */
  async fetchViewStreamed(ref, rangeHeader, method = 'GET') {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type ?? 'output'
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    try {
      const headers = {};
      if (this.apiKey !== undefined && this.apiKey !== '') headers['Authorization'] = `Bearer ${this.apiKey}`;
      if (rangeHeader !== undefined) headers['Range'] = rangeHeader;
      const response = await this.fetchRoute(`/view?${params.toString()}`, { headers, method, signal: controller.signal });
      if (response.status !== 206 && response.status !== 416 && !response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ComfyForgeError(`ComfyUI /view failed: HTTP ${response.status}`, undefined);
      }
      if (response.status === 200) {
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null && Number(contentLength) > this.maxMediaBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new ComfyForgeError(
            `ComfyUI 媒体文件太大：${contentLength} 字节，超过 maxMediaBytes ${this.maxMediaBytes}`,
            '可以在配置里调大 maxMediaBytes，或用 ComfyUI 界面直接看这个文件。'
          );
        }
      }
      return { status: response.status, headers: response.headers, body: response.body };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 轮询 history 直到完成 / 失败 / 预算耗尽。
   * signal 中止时**只取消自己这条** prompt，然后抛「已中断」。
   * `onPoll` 每次轮询调一次，供调用方发布进度。
   */
  async waitForCompletion(opts) {
    const { promptId, timeoutMs, pollIntervalMs, signal, onPoll } = opts;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) {
        await this.cancelPrompt(promptId).catch(() => undefined);
        throw new ComfyForgeError(`ComfyUI generation interrupted (prompt ${promptId})`);
      }
      onPoll?.();
      const entry = await this.getHistory(promptId);
      if (entry !== undefined) {
        const status = entry.status;
        if (status?.status_str === 'success' || status?.completed === true || hasMedia(entry)) return entry;
        if (status?.status_str === 'error') throw executionFailedFromHistory(promptId, entry);
      }
      if (Date.now() >= deadline) {
        throw new ComfyForgeError(`ComfyUI generation timed out after ${timeoutMs} ms (prompt ${promptId})`);
      }
      await sleep(pollIntervalMs, signal).catch(() => undefined);
    }
  }
}

/** history 条目里有没有任何媒体输出。 */
export function hasMedia(entry) {
  for (const output of Object.values(entry.outputs ?? {})) {
    if ((output.images?.length ?? 0) > 0 || (output.videos?.length ?? 0) > 0
      || (output.gifs?.length ?? 0) > 0 || (output.audio?.length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

/** 从 history 的 status.messages 里拼出可读的失败原因。 */
export function historyErrorMessage(promptId, entry) {
  const details = [];
  for (const message of entry.status?.messages ?? []) {
    if (Array.isArray(message) && typeof message[0] === 'string') {
      const payload = message[1];
      if (typeof payload === 'object' && payload !== null) {
        if (typeof payload.exception_message === 'string') details.push(payload.exception_message.slice(0, 500));
        else if (typeof payload.exception_type === 'string') details.push(payload.exception_type);
      }
    }
  }
  return `ComfyUI execution failed (prompt ${promptId}): ${details.join('; ') || 'unknown error'}`;
}

/** 统一的执行失败错误（带 hint）。 */
function executionFailedFromHistory(promptId, entry) {
  return new ComfyForgeError(
    historyErrorMessage(promptId, entry),
    '常见两个原因：工作流里用到的节点/模型在本机不存在（去 ComfyUI 控制台看红色报错），或者显存不足。' +
      '可以先用 comfy_doctor 体检本机能力。'
  );
}
