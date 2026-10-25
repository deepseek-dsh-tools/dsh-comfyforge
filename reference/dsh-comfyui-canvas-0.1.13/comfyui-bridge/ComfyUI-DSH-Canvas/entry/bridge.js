// ComfyUI-DSH-Canvas bridge frontend.
// Injected into the ComfyUI page via app.registerExtension. It watches the
// LiteGraph canvas and posts graph changes to the bridge backend, so the DSH
// plugin can read what is on the canvas without touching the iframe DOM.
//
// M0: passive reporting (read path).
// M1: command listener (write path) — add_node / connect / set_param /
//     remove_node executed directly on LiteGraph, results POSTed back.
// M2: load_workflow (rewrite loop) / run (queuePrompt) / highlight (debug).
// M3: validate (structural checks, no execution) + per-tab targeting.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REPORT_URL = "/dsh-bridge/report";
const RESULT_URL = "/dsh-bridge/result";
const COMMAND_EVENT = "dsh-bridge-command";
const DEBOUNCE_MS = 300;

// Stable per-tab identity: lets the backend route a command to one frontend
// even when several tabs are open (DSH canvas tab + a native ComfyUI tab).
// The backend echoes the last-reported clientId back as `target`, and only
// that tab executes; the others skip the command.
const CLIENT_ID = (crypto?.randomUUID?.() ?? String(Math.random()).slice(2));

// ------- M0: passive reporting -------

function summarize(graph) {
  const nodes = graph?.nodes ?? [];
  return nodes.map((node) => ({
    id: String(node.id),
    type: node.type ?? node.comfyClass ?? "unknown",
    title: node.title || node.type || "",
  }));
}

function serializeGraph(graph) {
  try {
    return graph?.serialize?.() ?? null;
  } catch {
    return null;
  }
}

function report() {
  try {
    const graph = app.graph;
    if (!graph) return;
    const body = {
      clientId: CLIENT_ID,
      nodes: summarize(graph),
      workflow: serializeGraph(graph),
      prompt: null, // API-format prompt lands with the run path (M2)
    };
    fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {
      // Backend may not be up yet during startup; next change retries.
    });
  } catch {
    // Never let a reporting error break the canvas.
  }
}

let timer = null;
function scheduleReport() {
  clearTimeout(timer);
  timer = setTimeout(report, DEBOUNCE_MS);
}

// ------- M1: write path -------

async function resolveLiteGraph() {
  if (window.LiteGraph) return window.LiteGraph;
  try {
    const mod = await import("../../scripts/litegraph.js");
    return mod.LiteGraph ?? window.LiteGraph;
  } catch {
    return window.LiteGraph;
  }
}

// Apply a widget value with combo validation + callback, shared by set_param
// and inject_text. Throws on an unknown combo value so it fails loudly instead
// of silently rendering empty, then lets the widget's own callback react.
function applyWidgetValue(node, widget, value) {
  widget.value = value;
  if (widget.type === "combo" || Array.isArray(widget.options)) {
    const labels = (Array.isArray(widget.options) ? widget.options : widget.options?.values ?? [])
      .map((o) => (typeof o === "object" && o !== null ? (o.value ?? o[0]) : o));
    if (labels.length > 0 && !labels.some((l) => String(l) === String(value))) {
      throw new Error(`value ${JSON.stringify(value)} is not a valid option for ${widget.name} (${labels.join(", ")})`);
    }
  }
  try {
    widget.callback?.(widget.value, widget);
    node.onWidgetChanged?.(widget, widget.value, null, null);
  } catch {
    // The widget value is still applied; the frontend callback may not be
    // ready (e.g. a combo's options initialize asynchronously right after the
    // node is created), so a callback hiccup must not fail the set_param.
  }
  node.setDirtyCanvas?.(true, true);
}

// v0.1.12: some LiteGraph builds ship LGraphGroup without addNode /
// computeBounding, so the bridge owns group membership and the bounding box
// instead of relying on those methods. `bounding` stays pos.concat(size), so
// saved workflows render the same box on load. The top edge keeps extra room
// (`titlePad`) so the group's title row never sits under a node.
function groupBounds(nodeObjs, pad = 20, titlePad = 50) {
  if (!nodeObjs.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of nodeObjs) {
    const [x, y] = n.pos;
    const [w, h] = n.size;
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + w);
    y2 = Math.max(y2, y + h);
  }
  return [x1 - pad, y1 - pad - titlePad, x2 - x1 + 2 * pad, y2 - y1 + 2 * pad + titlePad];
}

function groupSetNodes(group, nodeObjs, keepBounds = false) {
  // LGraphGroup.nodes is a read-only getter in some frontends, so membership
  // lives on a bridge-owned property instead of the group's own array.
  group._dshNodes = Array.isArray(nodeObjs) ? nodeObjs.slice() : [];
  if (keepBounds) return;
  const bb = groupBounds(group._dshNodes);
  if (bb) {
    group.pos = [bb[0], bb[1]];
    group.size = [bb[2], bb[3]];
  }
}

// v0.1.12: re-fit the bounding box of every group a moved node belongs to.
function refitNodeGroups(graph, node) {
  for (const g of graph?._groups ?? []) {
    if (Array.isArray(g._dshNodes) && g._dshNodes.includes(node)) {
      const bb = groupBounds(g._dshNodes);
      if (bb) {
        g.pos = [bb[0], bb[1]];
        g.size = [bb[2], bb[3]];
      }
    }
  }
}

async function executeCommand(cmd, payload) {
  const graph = app.graph;
  const LiteGraph = await resolveLiteGraph();

  switch (cmd) {
    case "add_node": {
      const type = payload.class ?? payload.type;
      if (!type) throw new Error("add_node requires payload.class");
      const node = LiteGraph?.createNode?.(type) ?? null;
      if (!node) throw new Error(`unknown node class: ${type}`);
      if (Array.isArray(payload.pos)) node.pos = [payload.pos[0], payload.pos[1]];
      graph.add(node);
      scheduleReport();
      return { nodeId: String(node.id), type: node.type };
    }

    case "connect": {
      const { srcId, srcSlot, dstId, dstSlot } = payload;
      const src = graph.getNodeById(+srcId);
      const dst = graph.getNodeById(+dstId);
      if (!src) throw new Error(`source node not found: ${srcId}`);
      if (!dst) throw new Error(`destination node not found: ${dstId}`);
      const ok = src.connect(+srcSlot, dst, +dstSlot);
      if (!ok) throw new Error("connection rejected by LiteGraph");
      scheduleReport();
      return { connected: `${srcId}:${srcSlot} -> ${dstId}:${dstSlot}` };
    }

    case "set_param": {
      const { nodeId, key, value } = payload;
      const node = graph.getNodeById(+nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      const widget = (node.widgets ?? []).find((w) => w.name === key);
      if (!widget) throw new Error(`widget not found: ${key}`);
      applyWidgetValue(node, widget, value);
      scheduleReport();
      return { key, value };
    }

    case "remove_node": {
      const { nodeId } = payload;
      const node = graph.getNodeById(+nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      graph.remove(node);
      scheduleReport();
      return { removed: String(nodeId) };
    }

    // v0.1.12: move a node (absolute `pos` or relative `offset`) and re-fit
    // the bounding boxes of any groups the node belongs to.
    case "move_node": {
      const { nodeId, pos, offset } = payload;
      const node = graph.getNodeById(+nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      if (Array.isArray(pos) && pos.length >= 2 && isFinite(+pos[0]) && isFinite(+pos[1])) {
        node.pos = [+pos[0], +pos[1]];
      } else if (Array.isArray(offset) && offset.length >= 2 && isFinite(+offset[0]) && isFinite(+offset[1])) {
        node.pos = [node.pos[0] + +offset[0], node.pos[1] + +offset[1]];
      } else {
        throw new Error("move_node requires payload.pos [x,y] or payload.offset [dx,dy] as numbers");
      }
      refitNodeGroups(graph, node);
      scheduleReport();
      return { nodeId: String(node.id), pos: node.pos.slice() };
    }

    // v0.1.12: tidy a set of nodes — align edges/centers, distribute evenly
    // along an axis, or reflow into a grid. Re-fits the groups the nodes
    // belong to, so aligned group members stay wrapped by their group box.
    case "align_nodes": {
      const { nodeIds, mode = "align", edge = "left", axis = "horizontal" } = payload ?? {};
      const cols = Math.max(1, Math.floor(+payload?.cols || 2));
      const gap = Math.max(0, +payload?.gap || 40);
      const nodes = (Array.isArray(nodeIds) ? nodeIds : []).map((id) => graph.getNodeById(+id)).filter(Boolean);
      if (!nodes.length) throw new Error("align_nodes requires payload.nodeIds");
      const x1 = Math.min(...nodes.map((n) => n.pos[0]));
      const x2 = Math.max(...nodes.map((n) => n.pos[0] + n.size[0]));
      const y1 = Math.min(...nodes.map((n) => n.pos[1]));
      const y2 = Math.max(...nodes.map((n) => n.pos[1] + n.size[1]));
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      if (mode === "grid") {
        const colW = Math.max(...nodes.map((n) => n.size[0])) + gap;
        const rowH = Math.max(...nodes.map((n) => n.size[1])) + gap;
        nodes.forEach((n, i) => {
          n.pos = [x1 + (i % cols) * colW, y1 + Math.floor(i / cols) * rowH];
        });
      } else if (mode === "distribute") {
        const sorted = [...nodes].sort((a, b) => axis === "vertical"
          ? (a.pos[1] + a.size[1] / 2) - (b.pos[1] + b.size[1] / 2)
          : (a.pos[0] + a.size[0] / 2) - (b.pos[0] + b.size[0] / 2));
        if (sorted.length < 3) {
          const mid = axis === "vertical" ? cy : cx;
          sorted.forEach((n) => {
            if (axis === "vertical") n.pos[1] = mid - n.size[1] / 2;
            else n.pos[0] = mid - n.size[0] / 2;
          });
        } else {
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const from = axis === "vertical" ? first.pos[1] + first.size[1] / 2 : first.pos[0] + first.size[0] / 2;
          const to = axis === "vertical" ? last.pos[1] + last.size[1] / 2 : last.pos[0] + last.size[0] / 2;
          const step = (to - from) / (sorted.length - 1);
          sorted.forEach((n, i) => {
            const c = from + i * step;
            if (axis === "vertical") n.pos[1] = c - n.size[1] / 2;
            else n.pos[0] = c - n.size[0] / 2;
          });
        }
      } else {
        nodes.forEach((n) => {
          if (edge === "left") n.pos[0] = x1;
          else if (edge === "right") n.pos[0] = x2 - n.size[0];
          else if (edge === "top") n.pos[1] = y1;
          else if (edge === "bottom") n.pos[1] = y2 - n.size[1];
          else if (edge === "hcenter") n.pos[0] = cx - n.size[0] / 2;
          else if (edge === "vcenter") n.pos[1] = cy - n.size[1] / 2;
        });
      }
      for (const n of nodes) refitNodeGroups(graph, n);
      scheduleReport();
      return {
        moved: nodes.map((n) => String(n.id)),
        mode,
        edge: mode === "align" ? edge : null,
        axis: mode === "distribute" ? axis : null,
        cols: mode === "grid" ? cols : null,
      };
    }

    // M2: load a whole workflow back onto the canvas (rewrite loop).
    case "load_workflow": {
      const data = payload.workflow;
      if (!data) throw new Error("load_workflow requires payload.workflow");
      if (typeof data === "string") {
        try { payload.workflow = JSON.parse(data); } catch {
          throw new Error("payload.workflow is not valid JSON");
        }
      }
      await app.loadGraphData(payload.workflow);
      scheduleReport();
      return { loaded: true };
    }

    // M2: run the current canvas graph (queuePrompt) and report the task id.
    // `overrides` (optional) temporarily sets widget values before the graph
    // is compiled, then restores them — the canvas is left untouched, so the
    // same graph can be run repeatedly with different seeds/prompts.
    case "run": {
      if (typeof app.graphToPrompt !== "function") {
        throw new Error("this ComfyUI frontend lacks app.graphToPrompt");
      }
      const overrides = Array.isArray(payload.overrides) ? payload.overrides : [];
      // Snapshot the touched widgets so we can restore them afterwards.
      const saved = [];
      for (const o of overrides) {
        const node = graph.getNodeById(+o.nodeId);
        if (!node) throw new Error(`override node not found: ${o.nodeId}`);
        const widget = (node.widgets ?? []).find((w) => w.name === o.key);
        if (!widget) throw new Error(`override widget not found: ${o.nodeId}.${o.key}`);
        saved.push({ node, widget, prev: widget.value });
        widget.value = o.value;
      }
      try {
        const { output } = await app.graphToPrompt();
        const resp = await api.fetchApi("/prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: output }),
        });
        const json = await resp.json().catch(() => null);
        if (!resp.ok) throw new Error(json?.error?.message ?? `prompt HTTP ${resp.status}`);
        return { promptId: json.prompt_id, nodeErrors: json.node_errors ?? null };
      } finally {
        // Restore regardless of outcome so the canvas is never left altered.
        for (const s of saved) {
          s.widget.value = s.prev;
          s.node.setDirtyCanvas?.(true, true);
        }
      }
    }

    // M4: batch run — execute the graph once per override set (a parameter
    // matrix), queueing each as its own prompt. Returns the prompt ids in the
    // same order as the runs. ComfyUI executes the queue serially, so this is
    // a convenient way to sweep seeds / prompts / strengths.
    case "batch_run": {
      if (typeof app.graphToPrompt !== "function") {
        throw new Error("this ComfyUI frontend lacks app.graphToPrompt");
      }
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const results = [];
      for (const run of runs ?? []) {
        const overrides = Array.isArray(run.overrides) ? run.overrides : [];
        const saved = [];
        for (const o of overrides) {
          const node = graph.getNodeById(+o.nodeId);
          if (!node) throw new Error(`override node not found: ${o.nodeId}`);
          const widget = (node.widgets ?? []).find((w) => w.name === o.key);
          if (!widget) throw new Error(`override widget not found: ${o.nodeId}.${o.key}`);
          saved.push({ node, widget, prev: widget.value });
          widget.value = o.value;
        }
        try {
          const { output } = await app.graphToPrompt();
          const resp = await api.fetchApi("/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: output }),
          });
          const json = await resp.json().catch(() => null);
          if (!resp.ok) throw new Error(json?.error?.message ?? `prompt HTTP ${resp.status}`);
          results.push({ promptId: json.prompt_id, nodeErrors: json.node_errors ?? null });
        } finally {
          for (const s of saved) {
            s.widget.value = s.prev;
            s.node.setDirtyCanvas?.(true, true);
          }
        }
      }
      return { queued: results.length, runs: results };
    }

    // M2: flash/highlight nodes by id (debug output).
    case "highlight": {
      const ids = Array.isArray(payload.ids) ? payload.ids : [];
      for (const id of ids) {
        const node = graph.getNodeById(+id);
        if (node && typeof node.flash === "function") node.flash();
      }
      return { highlighted: ids.map(String) };
    }

    // M3: validate — structural checks only, never submits /prompt, so a valid
    // graph is NOT queued (unlike `run`). Flags nodes with unconnected required
    // inputs so the agent can locate/fix errors without spending a generation.
    // Dynamic-slot nodes (switch / index / selector, or numbered inputs like
    // `image15`) intentionally leave trailing slots unconnected — those are
    // reported as warnings, never as errors, so debug does not false-flag them.
    case "validate": {
      const nodeErrors = {};
      const warnings = {};
      for (const node of graph?.nodes ?? []) {
        const missing = [];
        const dynamic = [];
        for (const input of node.inputs ?? []) {
          if (input.link == null && !input.optional && !input.widget) {
            const type = String(node.type ?? "");
            const isDynamicSlot = /switch|index|selector|multi/i.test(type)
              || /^(image|input|value|mask|opt|optional)\d+$/i.test(input.name);
            (isDynamicSlot ? dynamic : missing).push(
              isDynamicSlot
                ? `dynamic slot "${input.name}" unconnected (switch/index node — expected)`
                : `missing required input "${input.name}"`,
            );
          }
        }
        if (missing.length) nodeErrors[String(node.id)] = missing;
        if (dynamic.length) warnings[String(node.id)] = dynamic;
      }
      const offendingIds = Object.keys(nodeErrors);
      return { valid: offendingIds.length === 0, nodeErrors, warnings, offendingIds };
    }

    // M3: ask the frontend to re-report the current graph immediately, so
    // comfyui_read_workflow does not serve a stale cache when the page is
    // open but idle (no recent change to trigger a debounced report).
    case "refresh_report": {
      report();
      return { reported: true };
    }

    // v0.1.1: inject text into the canvas. Mode 2 (newClass): create a source
    // node, set its widget, optionally connect to a target input — a one-step
    // "conversation text → canvas node". Mode 1 (nodeId): write an existing
    // widget directly. Both reuse applyWidgetValue so combo validation + the
    // widget callback fire identically to set_param.
    case "inject_text": {
      const { text, nodeId, widgetKey = "text", newClass, targetId, targetSlot, sourceSlot = 0 } = payload;
      if (newClass) {
        const node = LiteGraph?.createNode?.(newClass) ?? null;
        if (!node) throw new Error(`unknown node class: ${newClass}`);
        graph.add(node);
        const widget = (node.widgets ?? []).find((w) => w.name === widgetKey);
        if (widget) applyWidgetValue(node, widget, text);
        const connected = targetId != null && targetSlot != null;
        if (connected) {
          const dst = graph.getNodeById(+targetId);
          if (!dst) throw new Error(`target node not found: ${targetId}`);
          const ok = node.connect(+sourceSlot, dst, +targetSlot);
          if (!ok) throw new Error("connection rejected by LiteGraph");
        }
        scheduleReport();
        return { nodeId: String(node.id), created: true, type: node.type, connected };
      }
      if (nodeId == null) throw new Error("inject_text requires nodeId or newClass");
      const node = graph.getNodeById(+nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      const widget = (node.widgets ?? []).find((w) => w.name === widgetKey);
      if (!widget) throw new Error(`widget not found: ${widgetKey}`);
      applyWidgetValue(node, widget, text);
      scheduleReport();
      return { nodeId: String(nodeId), key: widgetKey, value: text };
    }

    // v0.1.6: clear the canvas to a blank workflow (new-workflow semantics).
    // graph.clear() is the LiteGraph-native reset; afterwards the canvas is
    // empty and ready to be built up node by node.
    case "clear": {
      graph.clear?.();
      scheduleReport();
      return { cleared: true, nodes: 0 };
    }

    // v0.1.12: probe which UI affordances exist so the agent can pick the
    // right element to drive (e.g. the New-workflow button may live in the
    // topbar, sidebar or menu depending on the frontend's current view).
    case "ui_probe": {
      const selectors = Array.isArray(payload.selectors) ? payload.selectors : [
        ".new-blank-workflow-button",
        "[aria-label*='new']",
        "[aria-label*='New']",
        "[data-testid*='workflow']",
        "[data-testid*='Workflow']",
        "button:has(> i.pi-plus)",
      ];
      const found = [];
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length) {
            const first = els[0];
            found.push({
              selector: sel,
              count: els.length,
              tag: first.tagName,
              cls: String(first.className || "").slice(0, 80),
              aria: first.getAttribute("aria-label") || "",
              text: (first.textContent || "").trim().slice(0, 30),
            });
          }
        } catch {
          /* invalid selector */
        }
      }
      // Vue app chain diagnostic (which hop breaks the pinia command store).
      const rootEl = document.querySelector("#vue-app") ?? document.querySelector("#app") ?? document.body;
      const vueApp = rootEl?.__vue_app__ ?? null;
      const pinia = vueApp?.config?.globalProperties?.$pinia ?? null;
      const vue = {
        appElId: rootEl.id || rootEl.tagName,
        hasVueApp: Boolean(vueApp),
        hasPinia: Boolean(pinia),
        storeIds: pinia?._s ? Array.from(pinia._s.keys()).slice(0, 50) : null,
      };
      return { probed: selectors, found, vue };
    }

    // v0.1.12: start a brand-new workflow through the frontend's own command
    // (Comfy.NewBlankWorkflow — the sidebar/topbar "新建" action), invoked via
    // the pinia command store instead of a DOM click. Falls back to clicking
    // the topbar button when the store is unreachable.
    case "new_canvas": {
      const rootEl = document.querySelector("#vue-app") ?? document.querySelector("#app") ?? document.body;
      const pinia = rootEl.__vue_app__?.config?.globalProperties?.$pinia;
      const store = pinia?._s?.get("command");
      if (store && typeof store.execute === "function") {
        await store.execute("Comfy.NewBlankWorkflow");
        scheduleReport();
        return { triggered: true, via: "command-store" };
      }
      const btn = document.querySelector(".new-blank-workflow-button");
      if (btn && typeof btn.click === "function") {
        btn.click();
        scheduleReport();
        return { triggered: true, via: "topbar-new-button" };
      }
      throw new Error("new-blank-workflow not reachable (no command store, no button)");
    }

    // v0.1.12: name / rename the active workflow directly through the
    // workflow store (no dialog). Without payload.name it reports the current
    // workflow name, path and persistence state.
    case "rename_workflow": {
      const rootEl = document.querySelector("#vue-app") ?? document.querySelector("#app") ?? document.body;
      const pinia = rootEl?.__vue_app__?.config?.globalProperties?.$pinia;
      const workflowStore = pinia?._s?.get("workflow");
      const workflow = workflowStore?.activeWorkflow ?? null;
      if (!workflow) throw new Error("no active workflow");
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name) {
        return {
          filename: workflow.filename ?? "",
          path: workflow.path ?? "",
          isPersisted: Boolean(workflow.isPersisted),
          isTemporary: Boolean(workflow.isTemporary),
        };
      }
      // Filename safety: cap length and reject path/control characters so a
      // crafted name cannot escape the workflow directory (mirrors the
      // frontend's own 1-50 char filename rule).
      if (name.length > 50 || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
        throw new Error(`invalid workflow name: 1-50 chars, no path or control characters (${JSON.stringify(name)})`);
      }
      if (typeof workflowStore.renameWorkflow !== "function") {
        throw new Error("workflow store lacks renameWorkflow");
      }
      const suffix = workflow.suffix || "json";
      const finalName = /\.\w+$/.test(name) ? name : `${name}.${suffix}`;
      const newPath = workflow.directory
        ? `${workflow.directory}/${finalName}`
        : finalName;
      await workflowStore.renameWorkflow(workflow, newPath);
      scheduleReport();
      return { renamed: true, filename: finalName, path: newPath };
    }

    // v0.1.12: execute any frontend command by id through the command store
    // (e.g. Comfy.SaveWorkflow / Comfy.SaveWorkflowAs), no dialog, no click.
    case "command": {
      const rootEl = document.querySelector("#vue-app") ?? document.querySelector("#app") ?? document.body;
      const pinia = rootEl?.__vue_app__?.config?.globalProperties?.$pinia;
      const store = pinia?._s?.get("command");
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id) throw new Error("command requires payload.id");
      if (!store || typeof store.execute !== "function") {
        throw new Error("command store not reachable");
      }
      await store.execute(id, payload.options);
      scheduleReport();
      return { executed: id };
    }

    // v0.1.12: persist the active workflow directly through the workflow
    // store (no dialog) — the reliable no-UI equivalent of Comfy.SaveWorkflow.
    case "save_workflow": {
      const rootEl = document.querySelector("#vue-app") ?? document.querySelector("#app") ?? document.body;
      const pinia = rootEl?.__vue_app__?.config?.globalProperties?.$pinia;
      const workflowStore = pinia?._s?.get("workflow");
      const workflow = workflowStore?.activeWorkflow ?? null;
      if (!workflow) throw new Error("no active workflow");
      if (typeof workflowStore.saveWorkflow !== "function") {
        throw new Error("workflow store lacks saveWorkflow");
      }
      await workflowStore.saveWorkflow(workflow);
      scheduleReport();
      return { saved: true, filename: workflow.filename ?? "", path: workflow.path ?? "" };
    }

    // v0.1.8: group nodes into named groups (complex-workflow organization).
    // The bridge manages membership and the bounding box itself (groupSetNodes)
    // because not every LiteGraph build ships LGraphGroup.addNode. Availability
    // varies across custom frontends, so `list` reports groupingAvailable so
    // the agent can degrade gracefully instead of hard-failing.
    case "group": {
      const { action, title, id, nodeIds } = payload ?? {};
      const groups = graph?._groups ?? null;
      if (!Array.isArray(groups)) {
        return {
          groupingAvailable: false,
          error: "this ComfyUI frontend does not expose LiteGraph groups",
        };
      }
      switch (action) {
        case "add": {
          if (!title || typeof title !== "string") throw new Error("group add requires payload.title");
          const nodeObjs = (Array.isArray(nodeIds) ? nodeIds : []).map((n) => graph.getNodeById(+n)).filter(Boolean);
          const group = new LiteGraph.LGraphGroup(title);
          if (Array.isArray(payload.bounding)) {
            group.pos = [payload.bounding[0], payload.bounding[1]];
            group.size = [payload.bounding[2], payload.bounding[3]];
          }
          groupSetNodes(group, nodeObjs, Array.isArray(payload.bounding));
          groups.push(group);
          scheduleReport();
          return { groupingAvailable: true, id: groups.indexOf(group), title: group.title, nodes: group._dshNodes.map((n) => String(n.id)) };
        }
        case "rename": {
          const g = groups[+id];
          if (!g) throw new Error(`group not found: ${id}`);
          g.title = String(title ?? g.title);
          scheduleReport();
          return { groupingAvailable: true, id: +id, title: g.title };
        }
        case "add_nodes": {
          const g = groups[+id];
          if (!g) throw new Error(`group not found: ${id}`);
          const seen = new Set((g._dshNodes ?? []).map((n) => n.id));
          const merged = (g._dshNodes ?? []).slice();
          const added = [];
          for (const n of Array.isArray(nodeIds) ? nodeIds : []) {
            const node = graph.getNodeById(+n);
            if (!node || seen.has(node.id)) continue;
            seen.add(node.id);
            merged.push(node);
            added.push(String(n));
          }
          groupSetNodes(g, merged);
          scheduleReport();
          return { groupingAvailable: true, id: +id, added };
        }
        case "remove_nodes": {
          const g = groups[+id];
          if (!g) throw new Error(`group not found: ${id}`);
          const ids = new Set((Array.isArray(nodeIds) ? nodeIds : []).map((n) => String(n)));
          const removed = [];
          groupSetNodes(g, (g._dshNodes ?? []).filter((n) => {
            if (ids.has(String(n.id))) {
              removed.push(String(n.id));
              return false;
            }
            return true;
          }));
          scheduleReport();
          return { groupingAvailable: true, id: +id, removed };
        }
        case "list": {
          return {
            groupingAvailable: true,
            groups: groups.map((g, i) => ({
              id: i,
              title: g.title ?? "",
              nodes: (g._dshNodes ?? []).map((n) => String(n.id)),
            })),
          };
        }
        default:
          throw new Error(`group action must be add|rename|add_nodes|remove_nodes|list, got ${String(action)}`);
      }
    }

    // v0.1.1: export the current canvas as API-format workflow JSON — the
    // format /prompt and comfy-cli run_workflow consume. Bridges the live
    // canvas to headless/MCP batch runs.
    case "export_api": {
      if (typeof app.graphToPrompt !== "function") {
        throw new Error("this ComfyUI frontend lacks app.graphToPrompt");
      }
      const { output } = await app.graphToPrompt();
      return { workflow: output, nodeCount: Object.keys(output || {}).length };
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

function postResult(cmdId, ok, raw) {
  const body = { id: cmdId, ok };
  if (ok) {
    body.result = raw;
  } else {
    body.error = raw?.message ?? String(raw ?? "unknown error");
  }
  fetch(RESULT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

app.registerExtension({
  name: "ComfyUI-DSH-Canvas",
  setup() {
    const graph = app.graph;
    if (!graph) return;

    // M0: report on canvas changes, preserving any existing handler.
    // The arrow keeps `this` from the setup scope; forward the graph itself so
    // a handler that relies on `this` still sees the graph.
    const prevOnChange = graph.onChange;
    graph.onChange = (...args) => {
      if (typeof prevOnChange === "function") {
        try { prevOnChange.apply(graph, args); } catch { /* ignore */ }
      }
      scheduleReport();
    };
    const prevGraphConfigure = graph.configure ?? null;
    if (typeof graph.configure === "function") {
      graph.configure = function (...args) {
        const out = prevGraphConfigure.apply(this, args);
        scheduleReport();
        // v0.1.11: re-attach persisted group membership after a graph load so
        // saved workflows restore which nodes belong to each group.
        const data = args[0];
        const groupsData = Array.isArray(data?.groups) ? data.groups : null;
        const groups = this?._groups ?? null;
        if (groupsData && Array.isArray(groups)) {
          for (let i = 0; i < groups.length && i < groupsData.length; i++) {
            const ids = groupsData[i]?.nodes;
            if (!Array.isArray(ids)) continue;
            const nodeObjs = ids.map((id) => this.getNodeById(+id)).filter(Boolean);
            groupSetNodes(groups[i], nodeObjs, true);
          }
        }
        return out;
      };
    }

    // v0.1.11: persist group membership in saved workflows — patch the group
    // serializer so member ids land in the workflow JSON next to
    // title/bounding/color, and the configure hook above restores them on load.
    resolveLiteGraph().then((LG) => {
      const proto = LG?.LGraphGroup?.prototype;
      const orig = proto?.serialize;
      if (!proto || typeof orig !== "function" || proto._dshSerializePatched) return;
      proto._dshSerializePatched = true;
      proto.serialize = function () {
        const data = orig.call(this) ?? {};
        if (Array.isArray(this._dshNodes) && this._dshNodes.length) {
          data.nodes = this._dshNodes.map((n) => n.id);
        }
        return data;
      };
    });

    // M1: listen for write commands pushed over the WebSocket.
    // Per-tab targeting (M3): when the backend names a target clientId (the
    // last one that reported), only that tab executes — several open ComfyUI
    // tabs must not each run the same command. No target = any tab may run.
    api.addEventListener(COMMAND_EVENT, async (event) => {
      const msg = event?.detail;
      if (!msg || !msg.id || !msg.cmd) return;
      if (msg.target && msg.target !== CLIENT_ID) return;
      try {
        const raw = await executeCommand(msg.cmd, msg.payload ?? {});
        postResult(msg.id, true, raw);
      } catch (err) {
        console.error("[ComfyUI-DSH-Canvas] command failed", msg.cmd, err);
        postResult(msg.id, false, err);
      }
    });

    // v0.1.1 fix: node previews (SaveImage/PreviewImage thumbnails) sometimes
    // do not appear after a manual run inside the DSH canvas iframe, even
    // though the images land in output/. ComfyUI's own executed handler sets
    // node.imgs, but inside the nested iframe the canvas redraw (driven by
    // requestAnimationFrame) may not fire afterwards, so the preview stays
    // empty. Forcing a redraw here on every executed event closes that gap —
    // harmless when ComfyUI already redrew, and it is exactly the event the
    // README previously noted the bridge did not touch.
    api.addEventListener("executed", () => {
      try {
        app.canvas?.setDirty?.(true, true);
      } catch { /* never break the canvas over a redraw */ }
    });

    // Initial report once the canvas is ready.
    setTimeout(report, 1500);
  },
});