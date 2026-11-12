// Interface editor webview. The host renders the interface into `frame.rgba`; this file
// shows it, draws editor marks on the overlay canvas and turns mouse/keyboard/form input
// into intents (see src/ifedit/edits.ts) posted back to the host.
// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const pixels = /** @type {HTMLCanvasElement} */ ($("pixels"));
  const overlay = /** @type {HTMLCanvasElement} */ ($("overlay"));

  /** @type {any} */ let frame = null;
  /** @type {any} */ let catalog = null;
  const saved = vscode.getState() || {};
  /** The runescript.interfaceEditor settings, for a panel without saved state. */
  const defaults = JSON.parse(document.body.dataset.defaults || "{}");
  let zoom = saved.zoom || defaults.zoom || 2;
  let grid = !!(saved.grid ?? defaults.grid);
  /** Smart guides: snap to the layer's and siblings' edges and centres while moving or resizing. */
  let snapGuides = (saved.snapGuides ?? defaults.smartGuides) !== false;
  /** The selection in draw order of picking; `selected` (the last one) is what the inspector edits. */
  /** @type {string[]} */ let selection = saved.selection || [];
  /** @type {string | null} */ let selected = selection[selection.length - 1] ?? null;
  /** @type {any} */ let drag = null;
  /** Editor-only layer state from the host: hidden (eye), locked, collapsed. */
  let view = { hidden: [], locked: [], collapsed: [] };
  const GRID = defaults.gridSize || 8;

  const save = () => vscode.setState({ zoom, grid, snapGuides, selection, tab, tool, treeWidth: widths.tree, sideWidth: widths.side });
  const send = (intent) => vscode.postMessage({ type: "intent", intent });
  const setState = (state) => vscode.postMessage({ type: "state", state });
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
    return e;
  };

  // ---- component helpers ----

  /** Last-wins key lookup like the packer. */
  const get = (com, key) => {
    if (!com) return undefined;
    for (let i = com.keys.length - 1; i >= 0; i--) if (com.keys[i][0] === key) return com.keys[i][1];
    return undefined;
  };
  const num = (v) => {
    if (v === undefined || !/^-?(0x[0-9a-fA-F]+|\d+)$/.test(v)) return 0;
    const neg = v.startsWith("-");
    const s = neg ? v.slice(1) : v;
    const n = /^0x/i.test(s) ? parseInt(s.slice(2), 16) : parseInt(s, 10);
    return neg ? -n : n;
  };
  const com = (name) => frame && frame.coms.find((c) => c.name === name);
  const box = (name) => frame && frame.boxes.find((b) => b.com === name);
  /** Where a component is on screen even when the preview does not draw it (for the selection marks). */
  const place = (name) => box(name) || (frame && frame.layout && frame.layout.find((b) => b.com === name));
  const snap = (v) => (grid ? Math.round(v / GRID) * GRID : v);
  const set = (name, key, value) => ({ kind: "set", com: name, key, value });
  const RESIZABLE = new Set(["rect", "text", "layer", "inv", "invtext", "model", "rectangle", "graphic", "line", "circle", "inputfield", "tooltip"]);
  /** A `.if3` file: positions and sizes go through each component's modes (src/ifedit/render3.ts). */
  const if3 = () => !!catalog && catalog.schema.format === "if3";
  /** The parent's laid-out size: the layer's box, or the whole area for the root. */
  const parentSize = (name) => {
    const p = parentOf(name);
    const b = p ? place(p) : null;
    return b ? [b.w, b.h] : [frame.width, frame.height];
  };
  /**
   * Intents putting `name` at screen box (x, y, w, h): raw x/y/width/height keys in a `.if`, a `place`
   * (converted through the modes by the host) in a `.if3`. `b` is its current box.
   */
  function placeIntents(name, b, x, y, w, h) {
    if (if3()) return [{ kind: "place", com: name, box: [x - b.originX, y - b.originY, w, h], parent: parentSize(name) }];
    const c = com(name);
    const out = [];
    if (x !== b.x) out.push(set(name, "x", String(num(get(c, "x")) + x - b.x)));
    if (y !== b.y) out.push(set(name, "y", String(num(get(c, "y")) + y - b.y)));
    const [kw, kh] = sizeKeys(b, w, h);
    if (w !== b.w) out.push(set(name, "width", String(kw)));
    if (h !== b.h) out.push(set(name, "height", String(kh)));
    return out;
  }

  /** A component is locked when it or any layer above it is locked in the layers panel. */
  function isLocked(name) {
    for (let n = name; n; n = parentOf(n)) if (view.locked.includes(n)) return true;
    return false;
  }

  /** Topmost unlocked box under (x, y), honouring each box's clip. */
  function hit(x, y, filter = () => true) {
    if (!frame) return null;
    for (let i = frame.boxes.length - 1; i >= 0; i--) {
      const b = frame.boxes[i];
      if (isLocked(b.com)) continue;
      const [cx1, cy1, cx2, cy2] = b.clip;
      if (x < cx1 || y < cy1 || x >= cx2 || y >= cy2) continue;
      if (x >= b.x && y >= b.y && x < b.x + Math.max(b.w, 1) && y < b.y + Math.max(b.h, 1) && filter(b)) return b;
    }
    return null;
  }

  /** Width/height keys for a pixel size: inv and invtext sizes are in cells. */
  function sizeKeys(b, w, h) {
    const c = com(b.com);
    const [mx, my] = (get(c, "margin") || "0,0").split(",").map(num);
    if (b.type === "inv") return [Math.max(1, Math.round((w + mx) / (32 + mx))), Math.max(1, Math.round((h + my) / (32 + my)))];
    if (b.type === "invtext") return [Math.max(1, Math.round(w / (115 + mx))), Math.max(1, Math.round(h / (12 + my)))];
    return [Math.max(1, w), Math.max(1, h)];
  }

  function setSelection(names) {
    // names an intent just created may arrive before the frame that has them; frames prune the rest
    selection = [...new Set(names)];
    selected = selection[selection.length - 1] ?? null;
    save();
    drawOverlay();
    renderPanels();
  }
  const select = (name) => setSelection(name ? [name] : []);
  /** Ctrl-click: add or remove one name, keeping the rest. */
  const toggleSelected = (name) => setSelection(selection.includes(name) ? selection.filter((n) => n !== name) : [...selection, name]);
  /** The selection without names inside another selected layer (they move with it). */
  const selectionRoots = () => selection.filter((n) => !selection.some((p) => p !== n && descendants(p).includes(n)));

  // ---- canvas ----

  function showFrame() {
    pixels.width = frame.width;
    pixels.height = frame.height;
    // whole pixels: a canvas truncates a fractional size, and the overlay must line up with the preview
    overlay.width = Math.round(frame.width * zoom);
    overlay.height = Math.round(frame.height * zoom);
    for (const c of [pixels, overlay]) {
      c.style.width = `${overlay.width}px`;
      c.style.height = `${overlay.height}px`;
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (pixels.getContext("2d"));
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba.buffer ? frame.rgba : Object.values(frame.rgba)), frame.width, frame.height), 0, 0);
    drawOverlay();
  }

  // ---- models ----
  // Model components drawn with WebGL on a canvas between the pixels and the overlay, placed
  // as the client places them: view-space meshes from the host (src/modelview/ifmodel.ts)
  // projected about the component's centre with `origin + (x << 9) / z`, clipped to its layer.
  // Close to the client, not pixel-exact (a depth buffer instead of face priorities), and drawn
  // above the components after them.
  const modelCanvas = /** @type {HTMLCanvasElement} */ ($("models"));
  const mgl = modelCanvas.getContext("webgl2", { antialias: true, premultipliedAlpha: false });
  /** @type {{ com: string, frames: WebGLBuffer[], colours: WebGLBuffer[], delays: number[], faces: number, opaqueFaces: number, frame: number, elapsed: number }[]} */
  let meshes = [];
  let modelsLast = performance.now();
  /** @type {any} */ let modelGl = null;
  if (mgl) {
    const shader = (type, src) => {
      const s = /** @type {WebGLShader} */ (mgl.createShader(type));
      mgl.shaderSource(s, src);
      mgl.compileShader(s);
      return s;
    };
    const program = /** @type {WebGLProgram} */ (mgl.createProgram());
    mgl.attachShader(program, shader(mgl.VERTEX_SHADER, `#version 300 es
      uniform mat4 mvp;
      in vec3 pos;
      in vec4 col;
      out vec4 v_col;
      void main() { gl_Position = mvp * vec4(pos, 1.0); v_col = col; }`));
    mgl.attachShader(program, shader(mgl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      in vec4 v_col;
      out vec4 colour;
      void main() { colour = v_col; }`));
    mgl.linkProgram(program);
    modelGl = { program, mvp: mgl.getUniformLocation(program, "mvp"), pos: mgl.getAttribLocation(program, "pos"), col: mgl.getAttribLocation(program, "col"), vao: mgl.createVertexArray() };
  }

  function setModels(list) {
    if (!mgl) return;
    for (const m of meshes) [...m.frames, ...m.colours].forEach((b) => mgl.deleteBuffer(b));
    const upload = (data, Type) => {
      const b = mgl.createBuffer();
      mgl.bindBuffer(mgl.ARRAY_BUFFER, b);
      mgl.bufferData(mgl.ARRAY_BUFFER, new Type(data), mgl.STATIC_DRAW);
      return b;
    };
    meshes = list.map(({ com, scene }) => ({
      com,
      frames: scene.frames.map((f) => upload(f, Float32Array)),
      colours: scene.colours.map((c) => upload(c, Uint8Array)),
      delays: scene.delays,
      faces: scene.faces,
      opaqueFaces: scene.opaqueFaces,
      frame: 0,
      elapsed: 0,
    }));
    if (frame) drawOverlay();
  }

  function drawModels(now) {
    requestAnimationFrame(drawModels);
    const dt = now - modelsLast;
    modelsLast = now;
    if (!mgl || !modelGl || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(overlay.width * dpr));
    const ch = Math.max(1, Math.round(overlay.height * dpr));
    if (modelCanvas.width !== cw || modelCanvas.height !== ch) {
      modelCanvas.width = cw;
      modelCanvas.height = ch;
    }
    modelCanvas.style.width = `${overlay.width}px`;
    modelCanvas.style.height = `${overlay.height}px`;
    mgl.disable(mgl.SCISSOR_TEST);
    mgl.viewport(0, 0, cw, ch);
    mgl.clearColor(0, 0, 0, 0);
    mgl.clear(mgl.COLOR_BUFFER_BIT | mgl.DEPTH_BUFFER_BIT);
    if (meshes.length === 0) return;
    const W = frame.width;
    const H = frame.height;
    const s = cw / W;
    const [n, f] = [1, 100000];
    mgl.useProgram(modelGl.program);
    mgl.bindVertexArray(modelGl.vao);
    mgl.enable(mgl.SCISSOR_TEST);
    mgl.enable(mgl.DEPTH_TEST);
    mgl.disable(mgl.CULL_FACE);
    for (const m of meshes) {
      const box = frame.boxes.find((b) => b.com === m.com && b.type === "model");
      if (!box || m.faces === 0) continue;
      if (m.frames.length > 1) {
        m.elapsed += dt;
        while (m.elapsed >= m.delays[m.frame]) {
          m.elapsed -= m.delays[m.frame];
          m.frame = (m.frame + 1) % m.frames.length;
        }
      }
      // screen = origin + (x << 9) / z over the whole frame; w = z
      const ox = box.x + (box.w >> 1);
      const oy = box.y + (box.h >> 1);
      const mvp = [1024 / W, 0, 0, 0, 0, -1024 / H, 0, 0, (2 * ox) / W - 1, 1 - (2 * oy) / H, (f + n) / (f - n), 1, 0, 0, (-2 * f * n) / (f - n), 0];
      const [x0, y0, x1, y1] = box.clip;
      mgl.scissor(Math.round(x0 * s), Math.round((H - y1) * s), Math.round((x1 - x0) * s), Math.round((y1 - y0) * s));
      mgl.clear(mgl.DEPTH_BUFFER_BIT);
      mgl.uniformMatrix4fv(modelGl.mvp, false, mvp);
      mgl.bindBuffer(mgl.ARRAY_BUFFER, m.frames[m.frame]);
      mgl.enableVertexAttribArray(modelGl.pos);
      mgl.vertexAttribPointer(modelGl.pos, 3, mgl.FLOAT, false, 0, 0);
      mgl.bindBuffer(mgl.ARRAY_BUFFER, m.colours[m.frame]);
      mgl.enableVertexAttribArray(modelGl.col);
      mgl.vertexAttribPointer(modelGl.col, 4, mgl.UNSIGNED_BYTE, true, 0, 0);
      mgl.disable(mgl.BLEND);
      mgl.depthMask(true);
      mgl.drawArrays(mgl.TRIANGLES, 0, m.opaqueFaces * 3);
      if (m.faces > m.opaqueFaces) {
        mgl.enable(mgl.BLEND);
        mgl.blendFunc(mgl.SRC_ALPHA, mgl.ONE_MINUS_SRC_ALPHA);
        mgl.depthMask(false);
        mgl.drawArrays(mgl.TRIANGLES, m.opaqueFaces * 3, (m.faces - m.opaqueFaces) * 3);
      }
    }
  }
  requestAnimationFrame(drawModels);

  function drawOverlay() {
    if (!frame) return;
    const ctx = /** @type {CanvasRenderingContext2D} */ (overlay.getContext("2d"));
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const z = zoom;
    ctx.lineWidth = 1;
    ctx.font = "10px sans-serif";
    if (grid) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      for (let x = 0; x < frame.width; x += GRID) (ctx.moveTo(x * z + 0.5, 0), ctx.lineTo(x * z + 0.5, overlay.height));
      for (let y = 0; y < frame.height; y += GRID) (ctx.moveTo(0, y * z + 0.5), ctx.lineTo(overlay.width, y * z + 0.5));
      ctx.stroke();
    }
    for (const b of frame.boxes) {
      ctx.save();
      const [cx1, cy1, cx2, cy2] = b.clip;
      ctx.beginPath();
      ctx.rect(cx1 * z, cy1 * z, (cx2 - cx1) * z, (cy2 - cy1) * z);
      ctx.clip();
      if (b.type === "model") {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(120,200,255,0.8)";
        ctx.strokeRect(b.x * z + 0.5, b.y * z + 0.5, b.w * z - 1, b.h * z - 1);
        ctx.setLineDash([]);
        // the name only where no model is drawn (none set, unknown, or inactive without activemodel)
        if (!meshes.some((m) => m.com === b.com)) {
          ctx.fillStyle = "rgba(120,200,255,0.9)";
          ctx.fillText(get(com(b.com), "model") || "model", b.x * z + 3, b.y * z + 11);
        }
      } else if (b.type === "inv" || b.type === "invtext") {
        const c = com(b.com);
        const [mx, my] = (get(c, "margin") || "0,0").split(",").map(num);
        const [cw, ch] = b.type === "inv" ? [32, 32] : [115, 12];
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        for (let r = 0; r < num(get(c, "height")); r++)
          for (let k = 0; k < num(get(c, "width")); k++) ctx.strokeRect((b.x + k * (cw + mx)) * z + 0.5, (b.y + r * (ch + my)) * z + 0.5, cw * z - 1, ch * z - 1);
      }
      ctx.restore();
    }
    const moving = drag && drag.moved && drag.mode === "move";
    ctx.setLineDash([]);
    // the layer each selected component sits in gets darker ants, drawn first so the selection's sit on top
    const parents = new Set(selection.map(parentOf).filter((p) => p && !selection.includes(p)));
    for (const name of parents) {
      const b = place(name);
      if (!b) continue;
      const rect = [b.x * z + 0.5, b.y * z + 0.5, Math.max(b.w, 1) * z - 1, Math.max(b.h, 1) * z - 1];
      ctx.strokeStyle = "#7a7a7a";
      ctx.strokeRect(...rect);
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -ants;
      ctx.strokeStyle = "#1e1e1e";
      ctx.strokeRect(...rect);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    for (const name of selection) {
      const b = place(name);
      if (!b) continue;
      const resizing = drag && drag.moved && drag.mode === "resize" && drag.box.com === name;
      const [x, y, w, h] = resizing ? drag.rect : moving ? [b.x + drag.dx, b.y + drag.dy, b.w, b.h] : [b.x, b.y, b.w, b.h];
      // marching ants: a white line under a black dash that crawls (see the timer below)
      const rect = [x * z + 0.5, y * z + 0.5, Math.max(w, 1) * z - 1, Math.max(h, 1) * z - 1];
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(...rect);
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -ants;
      ctx.strokeStyle = name === selected ? "#000000" : "#555555";
      ctx.strokeRect(...rect);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      if (selection.length === 1 && RESIZABLE.has(b.type) && box(name) && HANDLE_TOOLS.has(tool) && !isLocked(name)) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#000000";
        for (const [hx, hy] of corners(x, y, w, h)) {
          ctx.fillRect(hx * z - 3, hy * z - 3, 6, 6);
          ctx.strokeRect(hx * z - 2.5, hy * z - 2.5, 5, 5);
        }
      }
    }
    drawToolMarks(ctx, z);
  }

  /** Marching-ants phase; advanced ten times a second while something is selected. */
  let ants = 0;
  setInterval(() => {
    if (!frame || !selection.length || document.hidden) return;
    ants = (ants + 1) % 8;
    drawOverlay();
  }, 100);

  // ---- tools ----

  const marqueeRect = (d) => [Math.min(d.sx, d.ex), Math.min(d.sy, d.ey), Math.abs(d.ex - d.sx), Math.abs(d.ey - d.sy)];

  const corners = (x, y, w, h) => [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];

  const at = (e) => {
    const r = overlay.getBoundingClientRect();
    return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
  };

  const stage = $("stage");
  /** [id, key, label, what it does] in toolbox order; null separates groups. */
  const TOOL_LIST = [
    ["move", "V", "Move", "drag moves the selection; press an unselected component to pick it first"],
    ["select", "M", "Select", "click, or drag a box to select what it touches (Alt: only what is fully inside)"],
    ["hand", "H", "Hand", "drag to pan the preview (or hold Space)"],
    ["zoom", "Z", "Zoom", "click to zoom in, Alt-click to zoom out (Ctrl+wheel anywhere)"],
    null,
    ["rect", "R", "Rect", "drag a box to draw a rect"],
    ["text", "T", "Text", "drag a box to add a text component"],
    ["layer", "L", "Layer", "drag a box to add a layer"],
    null,
    ["eyedropper", "I", "Eyedropper", "click to take a colour into the focused colour field or the selection (Alt: hover colour)"],
    ["measure", "U", "Measure", "drag to measure; hover a component to see its gaps to the selection"],
  ];
  const TOOLS_ONLY = /** @type {string[][]} */ (TOOL_LIST.filter(Boolean));
  /** One 16x16 outline icon per tool, drawn with the same 1.5px stroke so the set reads as one family. */
  const ICONS = {
    move: "M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2",
    select: "M2 2h3M7 2h2M11 2h3v3M14 7v2M14 11v3h-3M9 14H7M5 14H2v-3M2 9V7M2 5V2",
    hand: "M5 9V4a1 1 0 0 1 2 0v4M7 7.5V2.5a1 1 0 0 1 2 0V8M9 7.5V3.5a1 1 0 0 1 2 0V8.5M11 8V5.5a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5h-1a4 4 0 0 1-3.3-1.7L2.4 10.3a1.1 1.1 0 0 1 1.8-1.3L5 10",
    zoom: "M11 11l3.5 3.5M6.5 4.5v4M4.5 6.5h4M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0z",
    rect: "M2.5 3.5h11v9h-11z",
    text: "M3 3.5h10M8 3.5v9.5M6 13h4M3 3.5v1.5M13 3.5v1.5",
    layer: "M8 2 14.5 5.5 8 9 1.5 5.5zM1.5 8.5 8 12l6.5-3.5M1.5 11.5 8 15l6.5-3.5",
    eyedropper: "M9.5 3.5l3 3M11 2a1.4 1.4 0 0 1 3 3l-1.5 1.5-3-3zM10.5 5.5 4 12l-2 .5.5-2 6.5-6.5",
    measure: "M1.5 11 11 1.5l3.5 3.5L5 14.5zM4.5 8l1.5 1.5M6.5 6l1 1M8.5 4l1.5 1.5",
  };
  const SVG = "http://www.w3.org/2000/svg";
  function icon(id) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", ICONS[id]);
    for (const [k, v] of [["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.5"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) path.setAttribute(k, v);
    svg.append(path);
    return svg;
  }
  const DRAW_TYPES = { rect: "rect", text: "text", layer: "layer" };
  let tool = TOOLS_ONLY.some(([id]) => id === saved.tool) ? saved.tool : "select";
  /** The tool to go back to when Space (temporary hand) is released. */
  /** @type {string | null} */ let spaceTool = null;
  /** Where the mouse is over the preview, for the eyedropper swatch and measure gaps. */
  /** @type {number[] | null} */ let pointer = null;
  /** The last measured line, shown until the next measurement or tool change. */
  /** @type {number[] | null} */ let measureLine = null;
  let altDown = false;

  // the toolbox runs along the top of the preview: a column holding the tools row and the stage
  const toolsEl = el("div", { id: "tools", role: "toolbar", "aria-label": "Tools" });
  const center = el("div", { id: "center" });
  stage.before(center);
  center.append(toolsEl, stage);

  function setTool(id) {
    tool = id;
    drag = null;
    measureLine = null;
    save();
    renderTools();
    updateCursor();
    drawOverlay();
  }
  function renderTools() {
    toolsEl.replaceChildren(...TOOL_LIST.map((t) => t === null
      ? el("span", { class: "sep" })
      : el("button", { class: t[0] === tool ? "tool on" : "tool", title: `${t[2]} (${t[1]}): ${t[3]}`, "aria-label": t[2], "aria-pressed": String(t[0] === tool), onclick: () => setTool(t[0]) }, icon(t[0]))));
  }
  function updateCursor() {
    overlay.style.cursor = {
      move: "default", select: "crosshair", hand: drag ? "grabbing" : "grab", zoom: altDown ? "zoom-out" : "zoom-in",
      rect: "crosshair", text: "crosshair", layer: "crosshair", eyedropper: "copy", measure: "crosshair",
    }[tool];
  }

  /** Zooms to `z` (1-8, fractions allowed), keeping the preview pixel under the mouse where it is when `e` is given. */
  function setZoom(z, e) {
    z = Math.max(1, Math.min(8, z));
    // whole levels snap exactly, so wheeling back and forth can land on 2x again
    if (Math.abs(z - Math.round(z)) < 0.02) z = Math.round(z);
    if (z === zoom || !frame) return;
    const p = e ? at(e) : null;
    zoom = z;
    save();
    showFrame();
    renderToolbar();
    if (p && e) {
      const r = overlay.getBoundingClientRect();
      stage.scrollLeft += r.left + p[0] * zoom - e.clientX;
      stage.scrollTop += r.top + p[1] * zoom - e.clientY;
    }
  }

  /** The 0xRRGGBB of the preview pixel at (x, y), or null outside it. */
  function pixelAt(x, y) {
    const [px, py] = [Math.floor(x), Math.floor(y)];
    if (!frame || px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null;
    const i = (py * frame.width + px) * 4;
    return (frame.rgba[i] << 16) | (frame.rgba[i + 1] << 8) | frame.rgba[i + 2];
  }

  /** The topmost unlocked layer at (x, y) and the origin its children are placed from ("" = the root). */
  function layerAt(x, y) {
    const layer = hit(x, y, (b) => isLayer(b.com));
    return layer ? { parent: layer.com, ox: layer.x, oy: layer.y - (frame.state.scroll[layer.com] || 0) } : { parent: "", ox: 0, oy: 0 };
  }

  /** Tools that show and use the resize handles of a single selection. */
  const HANDLE_TOOLS = new Set(["move", "select"]);
  /** Which corner handle (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) is under (x, y), if any. */
  function handleAt(x, y) {
    if (!HANDLE_TOOLS.has(tool)) return null;
    const sb = selection.length === 1 && box(selected);
    if (!sb || !RESIZABLE.has(sb.type) || isLocked(sb.com)) return null;
    const i = corners(sb.x, sb.y, sb.w, sb.h).findIndex(([hx, hy]) => Math.abs(hx - x) * zoom <= 6 && Math.abs(hy - y) * zoom <= 6);
    return i === -1 ? null : { corner: i, box: sb };
  }
  /** Starts resizing when (x, y) is on a handle; the gesture is finished by the Move tool's handlers. */
  function startResize(x, y) {
    const h = handleAt(x, y);
    if (!h) return false;
    const sb = h.box;
    drag = { tool: "move", mode: "resize", corner: h.corner, box: sb, sx: x, sy: y, rect: [sb.x, sb.y, sb.w, sb.h], moved: false, guides: [],
      targets: snapTargets(sb.parent, new Set([sb.com, ...descendants(sb.com)])) };
    return true;
  }

  /** Per tool: down starts a gesture (usually by setting `drag`), move updates it, up finishes it. */
  const TOOLS = {
    move: {
      down(e, x, y) {
        if (startResize(x, y)) return;
        const b = hit(x, y);
        if (b) {
          reveal(b.com);
          if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelected(b.com);
          else if (!selection.includes(b.com)) select(b.com);
        }
        if (!selection.length) return;
        // grabbing a selected component snaps it to the grid; grabbing empty space moves by the raw delta
        const grabbed = b && selection.includes(b.com) ? b : null;
        const roots = selectionRoots().filter((n) => !isLocked(n));
        const boxes = roots.map(place).filter(Boolean);
        const bounds = boxes.length && {
          x: Math.min(...boxes.map((r) => r.x)), y: Math.min(...boxes.map((r) => r.y)),
          r: Math.max(...boxes.map((r) => r.x + r.w)), b: Math.max(...boxes.map((r) => r.y + r.h)),
        };
        const parent = grabbed ? grabbed.parent : (place(selected) || { parent: "" }).parent;
        const exclude = new Set(roots.flatMap((n) => [n, ...descendants(n)]));
        drag = { tool: "move", mode: "move", box: grabbed, sx: x, sy: y, dx: 0, dy: 0, moved: false, guides: [], bounds, targets: snapTargets(parent, exclude) };
      },
      move(e, x, y, dx, dy) {
        const b = drag.box;
        const th = 6 / zoom;
        drag.guides = [];
        if (drag.mode === "move") {
          drag.dx = b ? b.originX + snap(b.x - b.originX + dx) - b.x : snap(dx);
          drag.dy = b ? b.originY + snap(b.y - b.originY + dy) - b.y : snap(dy);
          const bb = drag.bounds;
          if (snapGuides && bb) {
            // a guide match replaces the grid result on its axis
            const gx = snapAxis([bb.x + dx, (bb.x + bb.r) / 2 + dx, bb.r + dx], drag.targets.xs, th);
            const gy = snapAxis([bb.y + dy, (bb.y + bb.b) / 2 + dy, bb.b + dy], drag.targets.ys, th);
            if (gx) ((drag.dx = Math.round(dx + gx.delta)), drag.guides.push(...gx.guides.map((t) => ({ axis: "x", ...t }))));
            if (gy) ((drag.dy = Math.round(dy + gy.delta)), drag.guides.push(...gy.guides.map((t) => ({ axis: "y", ...t }))));
          }
          return;
        }
        let [x1, y1, x2, y2] = [b.x, b.y, b.x + b.w, b.y + b.h];
        const left = drag.corner % 2 === 0;
        const top = drag.corner < 2;
        if (left) x1 = b.originX + snap(x1 - b.originX + dx);
        else x2 = b.originX + snap(x2 - b.originX + dx);
        if (top) y1 = b.originY + snap(y1 - b.originY + dy);
        else y2 = b.originY + snap(y2 - b.originY + dy);
        if (snapGuides) {
          // only the dragged edges snap
          const rawX = (left ? b.x : b.x + b.w) + dx;
          const rawY = (top ? b.y : b.y + b.h) + dy;
          const gx = snapAxis([rawX], drag.targets.xs, th);
          const gy = snapAxis([rawY], drag.targets.ys, th);
          if (gx) {
            const v = Math.round(rawX + gx.delta);
            if (left) x1 = v;
            else x2 = v;
            drag.guides.push(...gx.guides.map((t) => ({ axis: "x", ...t })));
          }
          if (gy) {
            const v = Math.round(rawY + gy.delta);
            if (top) y1 = v;
            else y2 = v;
            drag.guides.push(...gy.guides.map((t) => ({ axis: "y", ...t })));
          }
        }
        drag.rect = [Math.min(x1, x2 - 1), Math.min(y1, y2 - 1), Math.max(1, x2 - x1), Math.max(1, y2 - y1)];
      },
      up(e, d) {
        const intents = [];
        if (d.mode === "move") {
          for (const name of selectionRoots()) {
            const b = place(name);
            if (!b || !com(name) || isLocked(name)) continue;
            if (d.dx || d.dy) intents.push(...placeIntents(name, b, b.x + d.dx, b.y + d.dy, b.w, b.h));
          }
        } else {
          intents.push(...placeIntents(d.box.com, d.box, ...d.rect));
        }
        if (intents.length) send({ kind: "batch", intents });
      },
    },
    select: {
      down(e, x, y) {
        if (startResize(x, y)) return;
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;
        drag = { tool: "select", mode: "marquee", sx: x, sy: y, ex: x, ey: y, base: additive ? selection : [], additive, pick: hit(x, y), moved: false };
      },
      move(e, x, y) {
        [drag.ex, drag.ey] = [x, y];
      },
      up(e, d) {
        if (!d.moved) {
          if (!d.pick) return d.additive ? undefined : select(null);
          reveal(d.pick.com);
          return d.additive ? toggleSelected(d.pick.com) : select(d.pick.com);
        }
        const [mx, my, mw, mh] = marqueeRect(d);
        const inside = (b) => b.x >= mx && b.y >= my && b.x + b.w <= mx + mw && b.y + b.h <= my + mh;
        const touches = (b) => b.x < mx + mw && b.x + Math.max(b.w, 1) > mx && b.y < my + mh && b.y + Math.max(b.h, 1) > my;
        const picked = frame.boxes.filter((b) => !isLocked(b.com) && (e.altKey ? inside(b) : touches(b))).map((b) => b.com);
        if (picked.length) reveal(picked[picked.length - 1]);
        setSelection([...d.base, ...picked]);
      },
    },
    hand: {
      down(e) {
        drag = { tool: "hand", cx: e.clientX, cy: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, sx: 0, sy: 0, moved: false };
        updateCursor();
      },
      move(e) {
        stage.scrollLeft = drag.sl - (e.clientX - drag.cx);
        stage.scrollTop = drag.st - (e.clientY - drag.cy);
      },
      up() {
        drag = null;
        updateCursor();
      },
    },
    zoom: {
      down(e) {
        setZoom(e.altKey ? Math.ceil(zoom) - 1 : Math.floor(zoom) + 1, e);
      },
      move() {},
      up() {},
    },
    draw: {
      down(e, x, y) {
        drag = { tool: "draw", type: (if3() && catalog.schema.DRAW[tool]) || DRAW_TYPES[tool], mode: "draw", sx: x, sy: y, ex: x, ey: y, moved: false };
      },
      move(e, x, y) {
        [drag.ex, drag.ey] = [x, y];
      },
      up(e, d) {
        if (!catalog) return;
        const { parent, ox, oy } = layerAt(d.sx, d.sy);
        const keys = catalog.schema.NEW_COM[d.type].map((kv) => [...kv]);
        let [x, y] = [snap(Math.floor(d.sx - ox)), snap(Math.floor(d.sy - oy))];
        if (d.moved) {
          const [x1, y1, w, h] = marqueeRect(d);
          [x, y] = [snap(Math.floor(x1 - ox)), snap(Math.floor(y1 - oy))];
          const size = { width: Math.max(1, snap(Math.round(x1 + w - ox)) - x), height: Math.max(1, snap(Math.round(y1 + h - oy)) - y) };
          for (const kv of keys) if (kv[0] in size) kv[1] = String(size[kv[0]]);
        }
        keys.splice(1, 0, ["x", String(x)], ["y", String(y)]);
        send({ kind: "add", com: nextComName(), parent, keys });
      },
    },
    eyedropper: {
      down(e, x, y) {
        const n = pixelAt(x, y);
        if (n === null) return;
        if (!e.altKey && colourField && document.body.contains(colourField)) return applyColour(n);
        const key = e.altKey ? "overcolour" : "colour";
        const types = e.altKey ? ["rect", "text"] : ["rect", "text", "invtext", "rectangle", "circle", "line", "inputfield"];
        const targets = selection.filter((s) => types.includes(typeOf(s)));
        if (!targets.length) return note("Select a rect or text (or focus a colour field) to take the colour.");
        send({ kind: "batch", intents: targets.map((s) => set(s, key, hex(n))) });
      },
      move() {},
      up() {},
    },
    measure: {
      down(e, x, y) {
        measureLine = null;
        drag = { tool: "measure", mode: "measure", sx: x, sy: y, ex: x, ey: y, moved: false };
      },
      move(e, x, y) {
        [drag.ex, drag.ey] = [x, y];
      },
      up(e, d) {
        if (d.moved) measureLine = [d.sx, d.sy, d.ex, d.ey].map(Math.floor);
      },
    },
  };
  const toolFor = (id) => TOOLS[DRAW_TYPES[id] ? "draw" : id];

  overlay.addEventListener("mousedown", (e) => {
    if (!frame || e.button !== 0) return;
    const [x, y] = at(e);
    toolFor(tool).down(e, x, y);
  });

  window.addEventListener("mousemove", (e) => {
    if (!frame) return;
    const [x, y] = at(e);
    pointer = e.target === overlay ? [x, y] : null;
    if (drag) {
      const dx = Math.round(x - drag.sx);
      const dy = Math.round(y - drag.sy);
      if (!drag.moved && drag.tool !== "hand" && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!drag.moved && drag.tool === "hand" && Math.abs(e.clientX - drag.cx) + Math.abs(e.clientY - drag.cy) < 2) return;
      drag.moved = true;
      toolFor(drag.tool).move(e, x, y, dx, dy);
      drawOverlay();
      return;
    }
    if (e.target !== overlay) return;
    const h = handleAt(x, y);
    if (h) overlay.style.cursor = h.corner === 0 || h.corner === 3 ? "nwse-resize" : "nesw-resize";
    else updateCursor();
    sendMouse([Math.floor(x), Math.floor(y)]);
    if (tool === "eyedropper" || tool === "measure") drawOverlay();
  });

  /** The mouse position for the host's hover rule, at most once per animation frame. */
  let mouseSent = null;
  let mouseNext = null;
  let mouseQueued = false;
  function sendMouse(m) {
    mouseNext = m;
    if (mouseQueued) return;
    mouseQueued = true;
    requestAnimationFrame(() => {
      mouseQueued = false;
      if (JSON.stringify(mouseNext) === JSON.stringify(mouseSent)) return;
      mouseSent = mouseNext;
      setState({ mouse: mouseSent });
    });
  }

  window.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const t = toolFor(d.tool);
    if (d.moved || d.tool === "select" || d.tool === "draw") t.up(e, d);
    else if (d.tool === "hand") t.up(e, d);
    drawOverlay();
  });

  overlay.addEventListener("mouseleave", () => {
    pointer = null;
    if (frame) (sendMouse(null), drawOverlay());
  });

  overlay.addEventListener("wheel", (e) => {
    if (!frame) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // multiplicative, so a notch feels the same at any zoom: ~x1.16 per mouse notch, smooth on trackpads
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      return setZoom(zoom * Math.exp(-dy * 0.0015), e);
    }
    const [x, y] = at(e);
    const scrollKey = if3() ? "scrollheight" : "scroll";
    const b = hit(x, y, (b) => b.type === "layer" && num(get(com(b.com), scrollKey)) > b.h);
    if (!b) return;
    e.preventDefault();
    const max = num(get(com(b.com), scrollKey)) - b.h;
    const cur = frame.state.scroll[b.com] || 0;
    const scroll = { ...frame.state.scroll, [b.com]: Math.max(0, Math.min(max, cur + Math.sign(e.deltaY) * 16)) };
    setState({ scroll });
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !altDown) ((altDown = true), updateCursor());
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (!frame) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const run = (f) => (e.preventDefault(), f());
    if (e.key === " ") {
      e.preventDefault();
      if (!e.repeat && tool !== "hand") ((spaceTool = tool), setTool("hand"));
      return;
    }
    if (e.key === "Escape") return run(() => (drag ? ((drag = null), drawOverlay()) : setTool("select")));
    if (!ctrl && !e.altKey) {
      const picked = TOOLS_ONLY.find(([, k]) => k.toLowerCase() === key);
      if (picked) return run(() => setTool(picked[0]));
    }
    if (ctrl && key === "v") return run(paste);
    if (!selection.length) return;
    if (ctrl && key === "c") return run(copy);
    if (ctrl && key === "d") return run(duplicate);
    if (ctrl && key === "g") return run(e.shiftKey ? ungroup : group);
    if (ctrl && e.shiftKey && key === "h") return run(() => toggleHidden(selection));
    if (key === "f2") return run(() => startRename(selected));
    if (e.key === "Delete") return run(() => askDelete(selection));
    const step = e.shiftKey ? 10 : 1;
    const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!m) return;
    e.preventDefault();
    const intents = [];
    for (const name of selectionRoots()) {
      const b = place(name);
      if (!b || !com(name) || isLocked(name)) continue;
      intents.push(...placeIntents(name, b, b.x + m[0], b.y + m[1], b.w, b.h));
    }
    if (intents.length) send({ kind: "batch", intents });
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") ((altDown = false), updateCursor());
    if (e.key === " " && spaceTool) {
      const back = spaceTool;
      spaceTool = null;
      setTool(back);
    }
  });

  /** Edges and centres (per axis) of `parent` (the whole area for the root) and its drawn children not in `exclude`. */
  function snapTargets(parent, exclude) {
    const xs = [];
    const ys = [];
    const add = (b, layer) => {
      for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) xs.push({ v, box: b, layer });
      for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) ys.push({ v, box: b, layer });
    };
    const layer = parent ? place(parent) : { com: "", x: 0, y: 0, w: frame.width, h: frame.height };
    if (layer) add(layer, true);
    for (const b of frame.boxes) if (b.parent === parent && !exclude.has(b.com)) add(b, false);
    return { xs, ys };
  }

  /** The closest moving line within `threshold` of a target: the shift to apply and every target it then lines up with. */
  function snapAxis(moving, targets, threshold) {
    let delta = null;
    for (const m of moving) for (const t of targets) {
      const d = t.v - m;
      if (Math.abs(d) <= threshold && (delta === null || Math.abs(d) < Math.abs(delta))) delta = d;
    }
    if (delta === null) return null;
    const lined = targets.filter((t) => moving.some((m) => Math.abs(Math.round(m + delta) - Math.round(t.v)) <= 0.5));
    return { delta, guides: lined };
  }

  /** Magenta lines through each snapped coordinate, spanning the moving box and what it snapped to. */
  function drawGuides(ctx, z) {
    if (!drag || !drag.moved || !drag.guides || !drag.guides.length) return;
    const bb = drag.mode === "resize"
      ? { x: drag.rect[0], y: drag.rect[1], r: drag.rect[0] + drag.rect[2], b: drag.rect[1] + drag.rect[3] }
      : { x: drag.bounds.x + drag.dx, y: drag.bounds.y + drag.dy, r: drag.bounds.r + drag.dx, b: drag.bounds.b + drag.dy };
    ctx.strokeStyle = "#ff3df5";
    ctx.setLineDash([]);
    for (const g of drag.guides) {
      const t = g.box;
      ctx.beginPath();
      if (g.axis === "x") {
        const x = Math.round(g.v) * z + 0.5;
        ctx.moveTo(x, (Math.min(bb.y, t.y) - 2) * z);
        ctx.lineTo(x, (Math.max(bb.b, t.y + t.h) + 2) * z);
      } else {
        const y = Math.round(g.v) * z + 0.5;
        ctx.moveTo((Math.min(bb.x, t.x) - 2) * z, y);
        ctx.lineTo((Math.max(bb.r, t.x + t.w) + 2) * z, y);
      }
      ctx.stroke();
      if (!g.layer) ctx.strokeRect(t.x * z + 0.5, t.y * z + 0.5, Math.max(t.w, 1) * z - 1, Math.max(t.h, 1) * z - 1);
    }
    // where an x and a y guide cross, mark the point
    const xs = [...new Set(drag.guides.filter((g) => g.axis === "x").map((g) => Math.round(g.v)))];
    const ys = [...new Set(drag.guides.filter((g) => g.axis === "y").map((g) => Math.round(g.v)))];
    ctx.beginPath();
    for (const gx of xs) for (const gy of ys) {
      const [cx, cy] = [gx * z + 0.5, gy * z + 0.5];
      ctx.moveTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 4, cy + 4);
      ctx.moveTo(cx + 4, cy - 4);
      ctx.lineTo(cx - 4, cy + 4);
    }
    ctx.stroke();
  }

  /** Tool marks on the overlay: draw box, measure line and gaps, eyedropper swatch. */
  function drawToolMarks(ctx, z) {
    drawGuides(ctx, z);
    const label = (text, x, y) => {
      ctx.font = "11px sans-serif";
      const w = ctx.measureText(text).width + 6;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(x, y - 12, w, 15);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, x + 3, y);
    };
    if (drag && drag.moved && (drag.mode === "marquee" || drag.mode === "draw")) {
      const [x, y, w, h] = marqueeRect(drag);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = drag.mode === "draw" ? "rgba(120,200,255,0.95)" : "rgba(255,255,255,0.8)";
      ctx.strokeRect(x * z + 0.5, y * z + 0.5, w * z, h * z);
      ctx.setLineDash([]);
      if (drag.mode === "draw") label(`${Math.round(w)} × ${Math.round(h)}`, (x + w) * z + 4, (y + h) * z + 4);
    }
    const line = drag && drag.mode === "measure" && drag.moved ? [drag.sx, drag.sy, drag.ex, drag.ey].map(Math.floor) : measureLine;
    if (tool === "measure" && line) {
      const [x1, y1, x2, y2] = line;
      ctx.strokeStyle = "#ff40ff";
      ctx.beginPath();
      ctx.moveTo((x1 + 0.5) * z, (y1 + 0.5) * z);
      ctx.lineTo((x2 + 0.5) * z, (y2 + 0.5) * z);
      ctx.stroke();
      const [dx, dy] = [x2 - x1, y2 - y1];
      label(`dx ${dx}  dy ${dy}  ${Math.hypot(dx, dy).toFixed(1)} px`, (x2 + 1) * z + 4, (y2 + 1) * z);
    }
    if (tool === "measure" && pointer && selection.length && !drag) measureGaps(ctx, z, label);
    if (tool === "eyedropper" && pointer) {
      const n = pixelAt(pointer[0], pointer[1]);
      if (n !== null) {
        const [px, py] = [pointer[0] * z + 14, pointer[1] * z + 14];
        ctx.fillStyle = `#${n.toString(16).padStart(6, "0")}`;
        ctx.fillRect(px, py, 18, 18);
        ctx.strokeStyle = "#ffffff";
        ctx.strokeRect(px + 0.5, py + 0.5, 17, 17);
        label(hex(n), px + 22, py + 14);
      }
    }
  }

  /** Distances between the selection's bounds and the component under the mouse. */
  function measureGaps(ctx, z, label) {
    const boxes = selection.map(place).filter(Boolean);
    const t = hit(pointer[0], pointer[1]);
    if (!boxes.length || !t || selection.includes(t.com)) return;
    const s = {
      x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)),
      r: Math.max(...boxes.map((b) => b.x + b.w)), b: Math.max(...boxes.map((b) => b.y + b.h)),
    };
    const o = { x: t.x, y: t.y, r: t.x + t.w, b: t.y + t.h };
    ctx.strokeStyle = "rgba(255,64,255,0.9)";
    ctx.strokeRect(o.x * z + 0.5, o.y * z + 0.5, (o.r - o.x) * z - 1, (o.b - o.y) * z - 1);
    const hline = (x1, x2, y) => {
      if (x2 <= x1) return;
      ctx.beginPath();
      ctx.moveTo(x1 * z, y * z + 0.5);
      ctx.lineTo(x2 * z, y * z + 0.5);
      ctx.stroke();
      label(String(x2 - x1), ((x1 + x2) / 2) * z - 8, y * z - 4);
    };
    const vline = (y1, y2, x) => {
      if (y2 <= y1) return;
      ctx.beginPath();
      ctx.moveTo(x * z + 0.5, y1 * z);
      ctx.lineTo(x * z + 0.5, y2 * z);
      ctx.stroke();
      label(String(y2 - y1), x * z + 4, ((y1 + y2) / 2) * z + 4);
    };
    const midY = (Math.max(s.y, o.y) + Math.min(s.b, o.b)) / 2;
    const midX = (Math.max(s.x, o.x) + Math.min(s.r, o.r)) / 2;
    const cy = (s.y + s.b) / 2;
    const cx = (s.x + s.r) / 2;
    // apart on an axis: the gap between them; nested on an axis: the distance to both edges
    if (o.x >= s.r) hline(s.r, o.x, s.b > o.y && s.y < o.b ? midY : cy);
    else if (o.r <= s.x) hline(o.r, s.x, s.b > o.y && s.y < o.b ? midY : cy);
    else if (o.x <= s.x && o.r >= s.r) (hline(o.x, s.x, cy), hline(s.r, o.r, cy));
    if (o.y >= s.b) vline(s.b, o.y, s.r > o.x && s.x < o.r ? midX : cx);
    else if (o.b <= s.y) vline(o.b, s.y, s.r > o.x && s.x < o.r ? midX : cx);
    else if (o.y <= s.y && o.b >= s.b) (vline(o.y, s.y, cx), vline(s.b, o.b, cx));
  }

  renderTools();
  updateCursor();

  // ---- toolbar ----

  function renderToolbar() {
    const s = frame.state;
    const warn = frame.warnings;
    const bar = $("toolbar");
    bar.replaceChildren(...[
      el("span", { class: "title" }, frame.name),
      el("select", { title: "Where the client shows this interface", onchange: (e) => setState({ area: e.target.value }) },
        Object.entries(catalog ? catalog.areas : { main: [512, 334], side: [190, 261], chat: [479, 96] }).map(([a, [w, h]]) =>
          el("option", { value: a, selected: a === s.area }, `${{ main: "Main", side: "Side tab", chat: "Chatbox" }[a]} ${w}x${h}`))),
      el("select", { title: "Zoom (Z tool, Ctrl+wheel)", onchange: (e) => setZoom(+e.target.value) },
        [...new Set([1, 2, 3, 4, 5, 6, 7, 8, zoom])].sort((a, b) => a - b).map((z) => el("option", { value: z, selected: z === zoom }, `${+z.toFixed(2)}x`))),
      if3() ? null : toggle("Active", s.active, "Preview components whose conditions are true", () => setState({ active: !s.active })),
      toggle("Hidden", s.showHidden, if3() ? "Show hide=yes components and where tooltips pop up" : "Show layers marked hide=yes", () => setState({ showHidden: !s.showHidden })),
      toggle("Grid", grid, `Snap to ${GRID}px`, () => ((grid = !grid), save(), renderToolbar(), drawOverlay())),
      toggle("Snap", snapGuides, "Snap to layer and sibling edges and centres while moving or resizing", () => ((snapGuides = !snapGuides), save(), renderToolbar())),
      if3() ? null : el("span", { class: "vars", title: "Values shown for %1..%5 in text" }, "%1-5",
        s.vars.map((v, i) => el("input", { value: v, size: 3, onchange: (e) => setState({ vars: s.vars.map((x, j) => (j === i ? e.target.value : x)) }) }))),
      el("span", { class: warn.length ? "warn" : "warn none", title: warn.map((w) => `line ${w.line + 1}: ${w.message}`).join("\n") || "No problems" },
        warn.length ? `⚠ ${warn.length}` : "✓"),
      el("button", { onclick: () => vscode.postMessage({ type: "openText" }) }, "Open as Text"),
    ].filter(Boolean));
  }

  const toggle = (label, on, title, onclick) => el("button", { class: on ? "toggle on" : "toggle", title, onclick }, label);

  // ---- panels (tree, palettes, inspector) ----

  let tab = saved.tab || "inspect";
  let treeSig = "";
  let sideSig = "";
  /** @type {HTMLInputElement | null} */ let colourField = null;
  const sheetCanvases = new Map();

  function renderPanels(force = false) {
    if (!frame) return;
    const tsig = JSON.stringify([frame.tree, frame.coms, selection, confirming, renaming, view, search, !!catalog]);
    const typing = $("tree").contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (force || (tsig !== treeSig && !typing)) (treeSig = tsig), renderLayers();
    // the inspector follows every frame unless one of its inputs is being edited
    const ssig = tab === "inspect" ? JSON.stringify([selected, com(selected), frame.state.area, scripts]) : tab + (catalog ? "c" : "");
    const a = /** @type {HTMLInputElement} */ (document.activeElement);
    const editing = $("side").contains(a) && a.tagName === "INPUT" && a.type !== "checkbox";
    if (force || (ssig !== sideSig && !editing)) (sideSig = ssig), renderSide();
  }

  // ---- layers panel ----

  const typeOf = (name) => get(com(name), "type") || "?";
  const descendants = (name) => ((frame && frame.tree[name]) || []).flatMap((c) => [c, ...descendants(c)]);
  const parentOf = (name) => (frame ? Object.keys(frame.tree).find((p) => frame.tree[p].includes(name)) ?? "" : "");
  const ancestors = (name) => {
    const out = [];
    for (let p = parentOf(name); p; p = parentOf(p)) out.push(p);
    return out;
  };
  const isLayer = (name) => ["layer", "overlay"].includes(typeOf(name));
  /** @type {string | string[] | null} */ let confirming = null;
  /** @type {string | null} */ let renaming = null;
  let search = "";
  /** The hidden list saved by a solo (alt-click on an eye), restored by the next one. */
  /** @type {string[] | null} */ let soloBackup = null;
  /** The last row clicked without shift, for shift-click ranges. */
  /** @type {string | null} */ let anchor = null;

  const setView = (patch) => {
    view = { ...view, ...patch };
    vscode.postMessage({ type: "view", view });
    renderPanels(true);
  };
  const toggleIn = (list, names) => {
    const all = names.every((n) => list.includes(n));
    return all ? list.filter((n) => !names.includes(n)) : [...new Set([...list, ...names])];
  };
  const toggleHidden = (names) => setView({ hidden: toggleIn(view.hidden, names) });

  /** Shows only `name` (its layers and children stay visible); a second solo restores the eyes. */
  function solo(name) {
    if (soloBackup) {
      setView({ hidden: soloBackup });
      soloBackup = null;
      return;
    }
    soloBackup = view.hidden;
    const keep = new Set([name, ...ancestors(name), ...descendants(name)]);
    setView({ hidden: frame.coms.map((c) => c.name).filter((n) => !keep.has(n)) });
  }

  /** Where new and pasted components go: into the selected layer, else beside the selection. */
  const targetLayer = () => (selected ? (isLayer(selected) ? selected : parentOf(selected)) : "");

  function newLayer() {
    const keys = catalog.schema.NEW_COM.layer.map((kv) => [...kv]);
    keys.splice(1, 0, ["x", "0"], ["y", "0"]);
    send({ kind: "add", com: nextComName(), parent: targetLayer(), keys });
  }
  const copy = () => vscode.postMessage({ type: "copy", coms: selectionRoots() });
  const paste = () => vscode.postMessage({ type: "paste", parent: targetLayer() });
  const duplicate = () => send({ kind: "duplicate", coms: selectionRoots() });
  function group() {
    const roots = selectionRoots();
    if (new Set(roots.map(parentOf)).size !== 1) return note("Select components in the same layer to group them.");
    send({ kind: "group", coms: roots, name: nextComName() });
  }
  function ungroup() {
    if (!selected || !isLayer(selected)) return note("Select a layer to ungroup.");
    send({ kind: "ungroup", com: selected });
  }
  /** The row the next panel render scrolls to. */
  /** @type {string | null} */ let revealing = null;

  /** Makes a component picked on the preview visible in the layers panel: opens its layers and drops a search that hides it. */
  function reveal(name) {
    revealing = name;
    const closed = ancestors(name).filter((a) => view.collapsed.includes(a));
    if (search && !visibleRows().some((r) => r.name === name)) search = "";
    if (closed.length) setView({ collapsed: view.collapsed.filter((c) => !closed.includes(c)) });
  }

  function startRename(name) {
    if (!name) return;
    renaming = name;
    renderPanels(true);
  }
  function askDelete(names) {
    confirming = Array.isArray(names) ? names : [names];
    renderPanels(true);
  }
  /**
   * A right-click menu at (x, y), kept on screen, of `[label, shortcut, action, enabled = true]` items
   * (`null` draws a separator); a click elsewhere, Escape or blur closes it.
   */
  function openMenu(x, y, items) {
    closeMenu();
    const m = el("div", { class: "menu" }, items.map((it) => {
      if (!it) return el("div", { class: "sep" });
      const [label, keys, f, enabled = true] = it;
      return el("div", { class: enabled ? "item" : "item disabled", onclick: () => enabled && (closeMenu(), f()) },
        el("span", {}, label), el("span", { class: "keys" }, keys));
    }));
    document.body.append(m);
    m.style.left = `${Math.max(0, Math.min(x, innerWidth - m.offsetWidth))}px`;
    m.style.top = `${Math.max(0, Math.min(y, innerHeight - m.offsetHeight))}px`;
  }
  const closeMenu = () => document.querySelector(".menu")?.remove();
  window.addEventListener("mousedown", (e) => !(/** @type {HTMLElement} */ (e.target)).closest?.(".menu") && closeMenu());
  window.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  window.addEventListener("blur", closeMenu);
  /** A short message at the top of the layers panel. */
  let message = "";
  function note(text) {
    message = text;
    renderPanels(true);
    setTimeout(() => ((message = ""), renderPanels(true)), 4000);
  }

  /** A 16x16 preview of a component for its row. */
  function thumb(c) {
    const type = get(c, "type");
    const glyph = (text, style = "") => el("span", { class: "thumb", style }, text);
    if (type === "graphic" && catalog) {
      const spec = get(c, "graphic") || "";
      const comma = spec.lastIndexOf(",");
      const sheet = catalog.sheets.find((s) => s.name === spec.slice(0, comma));
      const i = parseInt(spec.slice(comma + 1), 10);
      if (sheet && i >= 0 && i < sheet.cols * sheet.rows) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 16;
        cv.className = "thumb";
        const scale = Math.min(16 / sheet.tileW, 16 / sheet.tileH, 1);
        const [w, h] = [sheet.tileW * scale, sheet.tileH * scale];
        /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d")).drawImage(sheetCanvas(sheet),
          (i % sheet.cols) * sheet.tileW, Math.floor(i / sheet.cols) * sheet.tileH, sheet.tileW, sheet.tileH, (16 - w) / 2, (16 - h) / 2, w, h);
        return cv;
      }
      return glyph("▣");
    }
    const colour = `#${num(get(c, "colour")).toString(16).padStart(6, "0")}`;
    if (type === "rect" || type === "rectangle") return glyph("", `background:${colour}`);
    if (type === "text") return glyph("T", `color:${colour}`);
    return glyph({ layer: "▤", overlay: "▤", inv: "▦", invtext: "≡", model: "◆", line: "╱", circle: "◯", inputfield: "⌶", tooltip: "💬" }[type] || "?");
  }

  /** Rows in draw order with their depth; collapsed layers hide their children unless searching. */
  function visibleRows() {
    const q = search.toLowerCase();
    const matches = (n) => {
      const c = com(n);
      return [n, get(c, "type"), get(c, "graphic"), get(c, "text")].some((v) => v && v.toLowerCase().includes(q));
    };
    const keep = new Set();
    if (q) for (const c of frame.coms) if (matches(c.name)) [c.name, ...ancestors(c.name)].forEach((n) => keep.add(n));
    const rows = [];
    const walk = (parent, depth) => {
      for (const name of frame.tree[parent] || []) {
        if (q && !keep.has(name)) continue;
        rows.push({ name, depth });
        if (q || !view.collapsed.includes(name)) walk(name, depth + 1);
      }
    };
    walk("", 0);
    return rows;
  }

  function rowClick(e, name, rows) {
    if (e.shiftKey && anchor) {
      const names = rows.map((r) => r.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (a !== -1) return setSelection([...(e.ctrlKey || e.metaKey ? selection : []), ...names.slice(a, b + 1)]);
    }
    anchor = name;
    if (e.ctrlKey || e.metaKey) toggleSelected(name);
    else select(name);
  }

  /** Reorders the dragged rows before `target`, or into it when `into` (as its topmost children). */
  function dropRows(names, target, into) {
    const parent = into ? target : parentOf(target);
    const moving = names.filter((n) => n !== target && !descendants(n).includes(target) && !ancestors(target).includes(n));
    if (!moving.length) return;
    send({ kind: "batch", intents: moving.map((n) => ({ kind: "reorder", com: n, parent, before: into ? null : target })) });
  }

  function renderLayers() {
    const rows = visibleRows();
    const out = [];
    out.push(el("input", { class: "search", placeholder: "Search layers", value: search, oninput: (e) => ((search = e.target.value), renderPanels(true)) }));
    if (message) out.push(el("div", { class: "confirm" }, message));
    if (confirming) {
      const names = confirming.filter((n) => com(n) && !confirming.some((p) => p !== n && descendants(p).includes(n)));
      const total = new Set(names.flatMap((n) => [n, ...descendants(n)])).size;
      out.push(el("div", { class: "confirm" }, `Delete ${names.length === 1 ? names[0] : `${names.length} components`}${total > names.length ? ` (${total} with children)` : ""}? `,
        el("button", { class: "primary", onclick: () => (send({ kind: "batch", intents: names.map((n) => ({ kind: "delete", com: n })) }), (confirming = null), renderPanels(true)) }, "Delete"), " ",
        el("button", { onclick: () => ((confirming = null), renderPanels(true)) }, "Cancel")));
    }
    const list = el("div", { class: "rows" });
    for (const { name, depth } of rows) {
      const c = com(name);
      const hidden = view.hidden.includes(name);
      const locked = view.locked.includes(name);
      const layer = isLayer(name);
      const collapsed = view.collapsed.includes(name);
      const label = renaming === name
        ? el("input", { class: "rename", value: name, onkeydown: (e) => {
            if (e.key === "Enter") e.target.blur();
            if (e.key === "Escape") ((renaming = null), renderPanels(true));
          }, onblur: (e) => {
            const to = e.target.value.trim();
            if (renaming === name && to && to !== name) vscode.postMessage({ type: "rename", com: name, to });
            renaming = null;
            renderPanels(true);
          } })
        : el("span", { class: "name", ondblclick: () => startRename(name) }, name);
      const row = el("div", {
        class: ["node", selection.includes(name) ? "selected" : "", hidden ? "hidden" : "", locked ? "locked" : ""].join(" "),
        style: `padding-left:${4 + depth * 12}px`,
        draggable: renaming === name ? "false" : "true",
        title: `${name} (${typeOf(name)})`,
        "data-name": name,
        onclick: (e) => rowClick(e, name, rows),
        oncontextmenu: (e) => {
          e.preventDefault();
          // like a file tree: right-clicking outside the selection selects that row
          if (!selection.includes(name)) ((anchor = name), select(name));
          openMenu(e.clientX, e.clientY, [
            ["Rename", "F2", () => startRename(name), selection.length === 1],
            ["Duplicate", "Ctrl+D", duplicate],
            null,
            ["Copy", "Ctrl+C", copy],
            ["Paste", "Ctrl+V", paste],
            null,
            ["Group", "Ctrl+G", group],
            ["Ungroup", "Ctrl+Shift+G", ungroup, isLayer(name) && selection.length === 1],
            null,
            ["Delete", "Del", () => askDelete(selection)],
          ]);
        },
        ondragstart: (e) => e.dataTransfer.setData("application/x-ifedit-node", JSON.stringify(selection.includes(name) ? selectionRoots() : [name])),
        ondragover: (e) => {
          if (!e.dataTransfer.types.includes("application/x-ifedit-node")) return;
          e.preventDefault();
          const into = layer && e.offsetY > row.offsetHeight / 3 && e.offsetY < (row.offsetHeight * 2) / 3;
          row.classList.toggle("drop-into", into);
          row.classList.toggle("drop-before", !into);
        },
        ondragleave: () => row.classList.remove("drop-into", "drop-before"),
        ondrop: (e) => {
          e.preventDefault();
          e.stopPropagation();
          const into = row.classList.contains("drop-into");
          row.classList.remove("drop-into", "drop-before");
          const raw = e.dataTransfer.getData("application/x-ifedit-node");
          if (raw) dropRows(JSON.parse(raw), name, into);
        },
      },
        el("span", { class: "twisty", onclick: (e) => (e.stopPropagation(), layer && setView({ collapsed: toggleIn(view.collapsed, [name]) })) }, layer ? (collapsed ? "▸" : "▾") : ""),
        el("span", { class: hidden ? "icon off" : "icon", title: "Show or hide in the preview (Ctrl+Shift+H; Alt-click: show only this)",
          onclick: (e) => (e.stopPropagation(), e.altKey ? solo(name) : toggleHidden(selection.includes(name) ? selection : [name])) }, hidden ? "◌" : "👁"),
        el("span", { class: locked ? "icon" : "icon off", title: "Lock: cannot be picked or moved on the preview",
          onclick: (e) => (e.stopPropagation(), setView({ locked: toggleIn(view.locked, selection.includes(name) ? selection : [name]) })) }, locked ? "🔒" : "🔓"),
        thumb(c), label, el("span", { class: "badge" }, typeOf(name)));
      list.append(row);
    }
    // dropping below the last row moves to the top level, drawn last
    const end = el("div", { class: "node end", title: "Drop here to move to the top level, drawn on top" }, "⤓ top level");
    end.addEventListener("dragover", (e) => (e.preventDefault(), end.classList.add("drop-before")));
    end.addEventListener("dragleave", () => end.classList.remove("drop-before"));
    end.addEventListener("drop", (e) => {
      e.preventDefault();
      end.classList.remove("drop-before");
      const raw = e.dataTransfer.getData("application/x-ifedit-node");
      if (raw) send({ kind: "batch", intents: JSON.parse(raw).map((n) => ({ kind: "reorder", com: n, parent: "", before: null })) });
    });
    list.append(end);
    out.push(list);
    const button = (label, title, onclick, enabled = true) => el("button", { title, onclick, disabled: !enabled }, label);
    const one = selection.length > 0;
    out.push(el("div", { class: "footer" },
      button("+ Layer", "New layer in the selected layer", () => catalog && newLayer(), !!catalog),
      button("Group", "Group the selection into a new layer (Ctrl+G)", group, one),
      button("Ungroup", "Move the layer's children out and remove it (Ctrl+Shift+G)", ungroup, !!selected && isLayer(selected)),
      button("Duplicate", "Duplicate (Ctrl+D)", duplicate, one),
      button("Delete", "Delete (Del)", () => askDelete(selection), one)));
    // the rows are rebuilt on every render: keep the list where it was scrolled to
    const scrollTop = $("tree").querySelector(".rows")?.scrollTop ?? 0;
    $("tree").replaceChildren(...out);
    list.scrollTop = scrollTop;
    const r = $("tree").querySelector("input.rename");
    if (r) (r.focus(), r.select());
    if (revealing) {
      const row = [...$("tree").querySelectorAll(".rows .node")].find((n) => n.dataset.name === revealing);
      if (row) row.scrollIntoView({ block: "nearest" });
      revealing = null;
    }
  }

  // ---- side panel ----

  const TABS = { inspect: "Inspect", add: "Add", sprites: "Sprites", fonts: "Fonts", colours: "Colours" };

  function renderSide() {
    const tabs = el("div", { class: "tabs" }, Object.entries(TABS).map(([k, label]) =>
      el("button", { class: k === tab ? "on" : "", onclick: () => ((tab = k), save(), renderPanels(true)) }, label)));
    const pane = el("div", { class: "pane" });
    if (!catalog && tab !== "inspect") pane.append("Loading…");
    else if (tab === "inspect") renderInspector(pane);
    else if (tab === "add") renderAdd(pane);
    else if (tab === "sprites") renderSprites(pane);
    else if (tab === "fonts") renderFonts(pane);
    else if (tab === "colours") renderColours(pane);
    $("side").replaceChildren(tabs, pane);
  }

  // ---- inspector ----

  const NUMBERS = new Set(["x", "y", "width", "height", "scroll", "trans", "zoom", "xan", "yan", "clientcode"]);
  const BOOLS = new Set(["hide", "fill", "center", "shadowed", "draggable", "interactable", "usable", "swappable"]);
  const COLOURS = ["colour", "activecolour", "overcolour", "activeovercolour"];
  const SPRITES = new Set(["graphic", "activegraphic"]);
  const LISTS = { model: "model", activemodel: "model", anim: "seq", activeanim: "seq", modelanim: "seq" };
  const LABELS = { center: "centred", shadowed: "shadow", activecolour: "active colour", overcolour: "hover colour", activeovercolour: "active hover", activetext: "active text",
    activegraphic: "active graphic", activemodel: "active model", activeanim: "active anim", clientcode: "client code", overlayer: "over layer", xan: "x angle", yan: "y angle" };
  /** @type {string | null} */ let pickKey = null;

  /** Sets one key of `c` (the component the form was rendered for), or deletes it when empty. */
  const committer = (c) => (key, value) => send(set(c.name, key, value === "" ? null : value));

  function field(c, key) {
    const commit = committer(c);
    const v = get(c, key);
    const label = el("label", { title: key }, LABELS[key] || key);
    let input;
    const S = catalog.schema;
    if (if3() && S.ENUMS[key]) {
      input = el("select", { onchange: (e) => commit(key, e.target.value) }, el("option", { value: "" }, `(default ${S.ENUMS[key][0]})`),
        S.ENUMS[key].map((o) => el("option", { value: o, selected: o === v }, o)));
    } else if (if3() ? S.BOOLS.includes(key) : BOOLS.has(key)) {
      input = el("input", { type: "checkbox", checked: v === "yes", onchange: (e) => commit(key, e.target.checked ? "yes" : "") });
    } else if (if3() ? S.NUMBERS.includes(key) : NUMBERS.has(key)) {
      input = el("input", { type: "number", value: v === undefined ? "" : num(v), onchange: (e) => commit(key, e.target.value) });
    } else if (key === "buttontype") {
      input = el("select", { onchange: (e) => commit(key, e.target.value) }, el("option", { value: "" }, "none"),
        catalog.schema.BUTTON_TYPES.map((b) => el("option", { value: b, selected: b === v }, b)));
    } else if (key === "font") {
      input = el("select", { onchange: (e) => commit(key, e.target.value) }, el("option", { value: "" }, "none (draws nothing)"),
        catalog.schema.FONTS.map((f) => el("option", { value: f, selected: f === v }, f)));
    } else if (key === "layer") {
      input = el("span", { title: "Change it by dragging in the tree" }, v || "(top level)");
    } else if (key === "overlayer") {
      input = el("select", { onchange: (e) => commit(key, e.target.value) }, el("option", { value: "" }, "none"),
        frame.coms.map((x) => el("option", { value: x.name, selected: x.name === v }, x.name)));
    } else if (if3() ? S.COLOURS.includes(key) : COLOURS.includes(key)) {
      const text = el("input", { value: v || "", placeholder: "0xRRGGBB", onfocus: (e) => (colourField = e.target), onchange: (e) => commit(key, e.target.value) });
      const n = num(v);
      input = el("span", { class: "colour" }, el("span", { class: "swatch", style: `background:#${n.toString(16).padStart(6, "0")}`, title: "Pick from the Colours tab",
        onclick: () => ((colourField = text), (tab = "colours"), renderPanels(true)) }), text);
    } else if (SPRITES.has(key) || key.startsWith("slot")) {
      input = el("span", { class: "colour" },
        el("input", { value: v || "", placeholder: key.startsWith("slot") ? "sprite,index:dx,dy" : "sprite,index", onchange: (e) => commit(key, e.target.value) }),
        el("button", { title: "Pick from the Sprites tab", onclick: () => ((pickKey = key), (tab = "sprites"), renderPanels(true)) }, "pick"));
    } else {
      input = el("input", { value: v || "", "data-list": LISTS[key], onchange: (e) => commit(key, e.target.value) });
    }
    return el("div", { class: "field" }, label, input);
  }

  /** Right-click options: one `option`, a target verb + flags, or an option1..5 list. */
  function optionsBlock(c, fields) {
    const commit = committer(c);
    const type = get(c, "type");
    const bt = get(c, "buttontype");
    const out = [];
    if (fields.includes("option")) {
      out.push(el("div", { class: "field" }, el("label", {}, "option"),
        el("input", { value: get(c, "option") || "", placeholder: catalog.schema.BUTTON_DEFAULT_OPTION[bt], onchange: (e) => commit("option", e.target.value) })));
    }
    if (fields.includes("actiontarget")) {
      const flags = (get(c, "actiontarget") || "").split(",").filter(Boolean);
      out.push(field(c, "actionverb"), field(c, "action"),
        el("div", { class: "field" }, el("label", {}, "targets"), el("span", {}, catalog.schema.TARGET_FLAGS.map((f) =>
          el("label", { style: "margin-right:6px" }, el("input", { type: "checkbox", checked: flags.includes(f), onchange: (e) => {
            const next = catalog.schema.TARGET_FLAGS.filter((g) => (g === f ? e.target.checked : flags.includes(g)));
            commit("actiontarget", next.join(","));
          } }), f)))));
    }
    if (fields.includes("option1")) {
      const opts = [1, 2, 3, 4, 5].map((i) => get(c, `option${i}`)).filter((o) => o !== undefined);
      const write = (list) => send({ kind: "batch", intents: [1, 2, 3, 4, 5].map((i) => set(c.name, `option${i}`, i <= list.length ? list[i - 1] : null)) });
      out.push(el("div", { class: "options" },
        opts.map((o, i) => el("div", { class: "row" },
          el("span", { class: "note" }, `${i + 1}.`),
          el("input", { value: o, onchange: (e) => ((opts[i] = e.target.value), write(opts)) }),
          el("button", { title: "Move up", disabled: i === 0, onclick: () => write(opts.map((x, j) => (j === i - 1 ? opts[i] : j === i ? opts[i - 1] : x))) }, "↑"),
          el("button", { title: "Remove", onclick: () => write(opts.filter((_, j) => j !== i)) }, "✕"))),
        opts.length < 5 ? el("button", { onclick: () => write([...opts, type === "inv" ? "Use" : "Option"]) }, "+ option") : null));
    }
    return out;
  }

  /** One script op in words, e.g. `count of coins in inventory:inv`. */
  function describeOp(op) {
    const info = catalog.schema.SCRIPT_OP_INFO[op[0]];
    const a = (i) => op[i] || "?";
    switch (op[0]) {
      case "inv_count": return `count of ${a(2)} in ${a(1)}`;
      case "inv_contains": return `holds ${a(2)} in ${a(1)}`;
      case "pushvar": return `varp ${a(1)}`;
      case "testbit": return `bit ${a(2)} of varp ${a(1)}`;
      case "push_varbit": return `varbit ${a(1)}`;
      case "push_constant": return a(1);
      case "stat_level": return `${a(1)} level`;
      case "stat_base_level": return `${a(1)} base level`;
      case "stat_xp": return `${a(1)} xp`;
      case "stat_xp_remaining": return `${a(1)} xp to next level`;
      default: return info ? info.label.toLowerCase() : op[0];
    }
  }

  /** A script's ops as a left-to-right formula: values add unless a maths op comes between. */
  function formula(ops) {
    const S = catalog.schema;
    let out = "";
    let operator = "";
    for (const op of ops) {
      if (S.MATHS_OPS.includes(op[0])) operator = S.SCRIPT_OP_INFO[op[0]].label;
      else {
        out = out === "" ? (operator ? `0 ${operator} ` : "") + describeOp(op) : `${out} ${operator || "+"} ${describeOp(op)}`;
        operator = "";
      }
    }
    return out || "0";
  }

  /** scriptN / scriptNopK as cards: a formula computing a value (%N in text) and an optional comparison. */
  function scriptsBlock(c) {
    const S = catalog.schema;
    const conds = c.conds.map((x) => ({ cmp: x.cmp, value: x.value, ops: x.ops && x.ops.map((o) => [...o]) }));
    const write = () => send({ kind: "conditions", com: c.name, conds });
    // comparisons pair with script1..n in order, so scripts with one come before value-only ones
    const firstOpen = () => { const i = conds.findIndex((x) => x.cmp === null); return i === -1 ? conds.length : i; };
    const move = (list, i, to) => list.splice(to, 0, ...list.splice(i, 1));
    const LISTS = { invcom: "interface", obj: "obj", varp: "varp", varbit: "varbit" };
    const operand = (kind, value, onchange) => {
      if (kind === "stat") return el("select", { onchange }, S.STATS.map((s) => el("option", { value: s, selected: s === value }, s)));
      if (kind === "int") return el("input", { type: "number", value: value ?? "0", onchange });
      const names = catalog.lists[LISTS[kind]] || [];
      const problem = !value ? `${kind} is empty` : names.length && !names.includes(value) ? `no ${LISTS[kind]} named ${value}` : null;
      return el("input", { value: value ?? "", "data-list": LISTS[kind], placeholder: kind, class: problem ? "bad" : "", title: problem || undefined, onchange });
    };
    const groups = [...new Set(Object.values(S.SCRIPT_OP_INFO).map((x) => x.group))].filter((g) => g !== "Maths");
    const opPicker = (op, onchange) => el("select", { title: op[0], onchange },
      groups.map((g) => el("optgroup", { label: g }, Object.entries(S.SCRIPT_OP_INFO).filter(([, x]) => x.group === g)
        .map(([name, x]) => el("option", { value: name, selected: name === op[0], title: name }, x.label)))));
    const tests = (frame.state && frame.state.tests) || {};

    const cards = conds.map((cond, i) => {
      const ops = cond.ops || [];
      const setOps = (next) => ((cond.ops = next), write());
      const steps = ops.map((op, k) => {
        const tools = [
          el("button", { title: "Move up", disabled: k === 0, onclick: () => (move(ops, k, k - 1), setOps(ops)) }, "↑"),
          el("button", { title: "Move down", disabled: k === ops.length - 1, onclick: () => (move(ops, k, k + 1), setOps(ops)) }, "↓"),
          el("button", { title: "Remove", onclick: () => (ops.splice(k, 1), setOps(ops)) }, "✕")];
        if (S.MATHS_OPS.includes(op[0])) {
          return el("div", { class: "row maths" }, el("select", { title: "How the next value combines", onchange: (e) => ((op[0] = e.target.value), setOps(ops)) },
            S.MATHS_OPS.map((m) => el("option", { value: m, selected: m === op[0], title: m }, S.SCRIPT_OP_INFO[m].label))), ...tools);
        }
        const plus = k > 0 && !S.MATHS_OPS.includes(ops[k - 1][0]) ? el("span", { class: "note", title: "Values next to each other add up" }, "+") : null;
        return el("div", { class: "row" }, plus,
          opPicker(op, (e) => ((op.length = 0), op.push(e.target.value, ...(S.SCRIPT_OPS[e.target.value] || []).map((kind) => (kind === "stat" ? "attack" : kind === "int" ? "0" : ""))), setOps(ops))),
          (S.SCRIPT_OPS[op[0]] || []).map((kind, a) => operand(kind, op[a + 1], (e) => ((op[a + 1] = e.target.value), setOps(ops)))),
          ...tools);
      });
      const compare = cond.cmp !== null;
      const swappable = (j) => j >= 0 && j < conds.length && (conds[j].cmp === null) === (cond.cmp === null);
      const result = c.conds[i].result;
      const pass = c.conds[i].pass;
      return el("div", { class: "cond" },
        el("div", { class: "row" }, el("b", {}, `%${i + 1}`), el("span", { class: "summary", title: "What the client computes" }, `= ${formula(ops)}`), el("span", { style: "flex:1" }),
          el("button", { title: "Move up", disabled: !swappable(i - 1), onclick: () => (move(conds, i, i - 1), write()) }, "↑"),
          el("button", { title: "Move down", disabled: !swappable(i + 1), onclick: () => (move(conds, i, i + 1), write()) }, "↓"),
          el("button", { title: "Remove script", onclick: () => (conds.splice(i, 1), write()) }, "✕")),
        ...steps,
        el("div", { class: "row" },
          el("button", { onclick: () => setOps([...ops, ["pushvar", ""]]) }, "+ value"),
          ops.length ? el("button", { onclick: () => setOps([...ops, ["subtract"], ["push_constant", "0"]]) }, "+ operator") : null),
        el("div", { class: "row" },
          el("label", { title: "Turning this on or off reorders the scripts, which renumbers %N" }, el("input", { type: "checkbox", checked: compare, onchange: (e) => {
            // firstOpen() before setting cmp: it is then at or before i
            if (e.target.checked) { const to = firstOpen(); (cond.cmp = "eq"), (cond.value = cond.value || "0"), move(conds, i, to); }
            else ((cond.cmp = null), move(conds, i, conds.length - 1));
            write();
          } }), ` active when %${i + 1}`),
          compare ? el("select", { onchange: (e) => ((cond.cmp = e.target.value), write()) }, S.COMPARATORS.map((x) => el("option", { value: x, selected: x === cond.cmp, title: x }, S.COMPARATOR_LABELS[x]))) : null,
          compare ? el("input", { type: "number", value: num(cond.value), onchange: (e) => ((cond.value = e.target.value), write()) }) : null,
          compare && cond.cmp === "gt" ? el("span", { class: "note" }, `(at least ${num(cond.value) + 1})`) : null,
          el("span", { style: "flex:1" }),
          el("span", { class: pass === false ? "test fail" : "test", title: "With the test values below" }, `→ ${result}${pass === null ? "" : pass ? " ✓" : " ✗"}`)));
    });

    // test values: one input per distinct value op the scripts read
    const inputs = new Map();
    for (const op of conds.flatMap((x) => x.ops || [])) {
      if (!S.MATHS_OPS.includes(op[0]) && op[0] !== "push_constant") inputs.set(op.join(","), op);
    }
    const testRows = [...inputs].map(([key, op]) => el("div", { class: "testrow" }, el("span", { class: "testlabel" }, describeOp(op)),
      el("input", { type: "number", value: String(tests[key] ?? 0), onchange: (e) => setState({ tests: { ...tests, [key]: parseInt(e.target.value, 10) || 0 } }) })));

    const compared = conds.filter((x) => x.cmp !== null);
    const missing = [...new Set([get(c, "text"), get(c, "activetext")].join(" ").match(/%[1-5]/g) || [])].filter((p) => +p[1] > conds.length);
    const presets = el("select", { onchange: (e) => {
      const p = e.target.value === "" ? null : S.SCRIPT_PRESETS[+e.target.value];
      const cond = p ? JSON.parse(JSON.stringify(p.cond)) : { cmp: null, value: "", ops: [["pushvar", ""]] };
      if (cond.cmp === null) conds.push(cond);
      else conds.splice(firstOpen(), 0, cond);
      write();
    } }, el("option", { selected: true, disabled: true }, "+ script…"), S.SCRIPT_PRESETS.map((p, i) => el("option", { value: String(i) }, p.label)), el("option", { value: "" }, "Blank"));

    return [el("h4", {}, "Scripts"),
      el("p", { class: "summary" }, compared.length
        ? `Active when ${compared.map((x) => `${formula(x.ops || [])} ${S.COMPARATOR_LABELS[x.cmp]} ${x.value}`).join(" and ")}`
        : conds.length ? "Never active (no comparisons); scripts only fill %N in text." : "No scripts."),
      ...missing.map((p) => el("p", { class: "bad" }, `The text uses ${p} but there is no script ${p[1]}.`)),
      ...cards,
      conds.length < 5 ? presets : null,
      ...(testRows.length ? [el("h4", {}, "Test values"), el("p", { class: "note" }, "Try values to see each script's result (→) and whether its comparison holds."), ...testRows] : [])];
  }

  // ---- .if3 inspector: modes, hooks (CS2 clientscripts), ops, params ----

  /** `[clientscript]`s from the language server: { name, params: ["type $name"] }. */
  /** @type {{ name: string, params: string[] }[]} */ let scripts = [];
  /** Hooks added in the panel but not written yet (no script chosen), per component. */
  const pendingHooks = new Map();

  /** A name-suggestion list (catalog.lists key) for an argument of `type`. */
  function argList(type) {
    const S = catalog.schema;
    const key = `_arg_${type}`;
    catalog.lists[key] = type === "component" ? [...S.EVENTS.component, ...frame.coms.map((x) => `${frame.name}:${x.name}`)]
      : type === "int" ? S.EVENTS.int
      : type === "boolean" ? ["true", "false"]
      : type === "string" ? S.EVENTS.string
      : ["null", ...(catalog.lists[type] || [])];
    return key;
  }
  const defaultArg = (param) => ({ component: "event_com", int: "0", boolean: "false", string: '""' })[param.split(" ")[0]] ?? "null";

  function hooksBlock(c) {
    const S = catalog.schema;
    const pend = pendingHooks.get(c.name) || new Set();
    pendingHooks.set(c.name, pend);
    const keys = S.HOOKS.filter((h) => c.hooks[h] || pend.has(h));
    const cards = keys.map((key) => {
      const old = c.hooks[key] || { script: "", args: [], triggers: [] };
      const h = { script: old.script, args: [...old.args], triggers: [...old.triggers] };
      const sig = scripts.find((s) => s.name === h.script);
      const commit = () => {
        if (!h.script) return;
        pend.delete(key);
        send({ kind: "hook", com: c.name, key, hook: h });
      };
      const unknown = h.script && scripts.length && !sig;
      const script = el("input", { value: h.script, "data-list": "clientscript", placeholder: "clientscript", class: unknown ? "bad" : "",
        title: unknown ? `no clientscript ${h.script}` : undefined,
        onfocus: () => vscode.postMessage({ type: "wantScripts" }),
        onchange: (e) => {
          h.script = e.target.value.trim();
          const s = scripts.find((x) => x.name === h.script);
          if (s) h.args = s.params.map((p, i) => h.args[i] ?? defaultArg(p));
          commit();
        } });
      const args = sig
        ? sig.params.map((p, i) => el("div", { class: "field" }, el("label", { title: p }, p),
          el("input", { value: h.args[i] ?? "", "data-list": argList(p.split(" ")[0]), onchange: (e) => ((h.args[i] = e.target.value.trim()), commit()) })))
        : h.script ? [el("div", { class: "field" }, el("label", { title: "Arguments, comma-separated (the language server lists each clientscript's parameters)" }, "args"),
          el("input", { value: h.args.join(", "), placeholder: "event_com", onchange: (e) => ((h.args = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)), commit()) }))] : [];
      const arity = sig && h.args.length !== sig.params.length ? el("p", { class: "bad" }, `${h.script} takes ${sig.params.length} arguments, found ${h.args.length}`) : null;
      let triggers = null;
      if (S.TRIGGERS[key]) {
        const list = `_trig_${key}`;
        catalog.lists[list] = S.TRIGGERS[key].flatMap((p) => catalog.lists[p] || []);
        triggers = el("div", { class: "row triggers" }, el("span", { class: "note", title: "Runs when any of these change" }, "on"),
          h.triggers.map((t, i) => el("span", { class: "trigger" },
            el("input", { value: t, size: 10, "data-list": list, onchange: (e) => ((e.target.value.trim() ? (h.triggers[i] = e.target.value.trim()) : h.triggers.splice(i, 1)), commit()) }),
            el("button", { title: "Remove", onclick: () => (h.triggers.splice(i, 1), commit()) }, "✕"))),
          el("input", { size: 10, "data-list": list, placeholder: `+ ${S.TRIGGERS[key].join("/")}`, onchange: (e) => e.target.value.trim() && (h.triggers.push(e.target.value.trim()), commit()) }));
      }
      return el("div", { class: "cond hook" },
        el("div", { class: "row" }, el("b", {}, key), el("span", { class: "note" }, S.HOOK_INFO[key] || ""), el("span", { style: "flex:1" }),
          el("button", { title: "Remove hook", onclick: () => (pend.delete(key), c.hooks[key] ? send({ kind: "hook", com: c.name, key, hook: null }) : renderPanels(true)) }, "✕")),
        el("div", { class: "row" }, script,
          el("button", { title: "Open the clientscript", disabled: !h.script, onclick: () => vscode.postMessage({ type: "openScript", name: h.script }) }, "Open"),
          el("button", { title: "Add a new [clientscript] stub to this area's .cs2 and use it here", onclick: () => vscode.postMessage({ type: "newScript", com: c.name, hook: key }) }, "New…")),
        ...args, arity, triggers);
    });
    const free = S.HOOKS.filter((h) => !keys.includes(h));
    const add = el("select", { onchange: (e) => (pend.add(e.target.value), vscode.postMessage({ type: "wantScripts" }), renderPanels(true)) },
      el("option", { selected: true, disabled: true }, "+ hook…"), free.map((h) => el("option", { value: h, title: S.HOOK_INFO[h] }, h)));
    return [el("h4", {}, "Hooks (clientscripts)"), ...(keys.length ? [] : [el("p", { class: "note" }, "No hooks.")]), ...cards, free.length ? add : null];
  }

  /** `param=name,value` lines, in file order. */
  function paramsBlock(c) {
    const values = c.keys.filter(([k]) => k === "param").map(([, v]) => v);
    const write = (list) => send({ kind: "params", com: c.name, values: list.filter((v) => v.trim() !== "") });
    return [el("h4", {}, "Params"),
      ...values.map((v, i) => el("div", { class: "row" },
        el("input", { value: v, placeholder: "param,value", onchange: (e) => ((values[i] = e.target.value), write(values)) }),
        el("button", { title: "Remove", onclick: () => write(values.filter((_, j) => j !== i)) }, "✕"))),
      el("input", { placeholder: "+ param,value", "data-list": "param", onchange: (e) => write([...values, e.target.value]) })];
  }

  /** op1..op10, what the server hears (transmitop), targeting and dragging. */
  function opsBlock(c) {
    const commit = committer(c);
    const S = catalog.schema;
    const mask = (get(c, "targetmask") || "").split(",").filter(Boolean);
    return el("details", { open: S.OP_KEYS.some((k) => get(c, k) !== undefined) || undefined }, el("summary", {}, "Ops and targeting"),
      ...["opbase", ...Array.from({ length: 10 }, (_, i) => `op${i + 1}`)].map((k) => field(c, k)),
      el("div", { class: "field" }, el("label", { title: "Ops (1-10) that also run [if_button<n>] on the server" }, "transmitop"),
        el("input", { value: get(c, "transmitop") || "", placeholder: "1,2", onchange: (e) => commit("transmitop", e.target.value.replace(/\s/g, "")) })),
      el("div", { class: "field" }, el("label", {}, "targetmask"), el("span", {}, S.TARGETS.map((f) =>
        el("label", { style: "margin-right:6px" }, el("input", { type: "checkbox", checked: mask.includes(f), onchange: (e) =>
          commit("targetmask", S.TARGETS.filter((g) => (g === f ? e.target.checked : mask.includes(g))).join(",")) }), f)))),
      ...["targetverb", "dragdeadzone", "dragdeadtime", "dragrenderbehaviour"].map((k) => field(c, k)));
  }

  function renderInspector3(pane, c) {
    const S = catalog.schema;
    const commit = committer(c);
    const type = get(c, "type") || "";
    const fields = (S.FIELDS[type] || { "": [] })[""];
    const LAYOUT = ["x", "y", "width", "height", "xmode", "ymode", "widthmode", "heightmode", "layer"];
    const known = new Set([...Object.values(S.FIELDS).flatMap((t) => t[""]), ...S.HOOKS, "type", "param"]);
    const appearance = fields.filter((k) => !LAYOUT.includes(k) && !["hide", "clientcode"].includes(k) && !S.OP_KEYS.includes(k));
    const unpacked = [...new Set(c.keys.map(([k]) => k))].filter((k) => known.has(k) && !fields.includes(k) && !S.HOOKS.includes(k) && k !== "type" && k !== "param");
    const other = c.keys.filter(([k]) => !known.has(k));
    pane.append(
      el("div", { class: "field" }, el("label", {}, "name"), el("b", {}, selected)),
      el("div", { class: "field" }, el("label", {}, "type"), el("select", { onchange: (e) => commit("type", e.target.value) },
        S.TYPES.map((t) => el("option", { value: t, selected: t === type }, t)))),
      el("h4", {}, "Position and size"), ...LAYOUT.map((k) => field(c, k)),
      el("p", { class: "note" }, "minus: the parent's size less the value; rel: 16384 = the parent's size. Dragging keeps the modes."),
      ...(appearance.length ? [el("h4", {}, "Appearance"), ...appearance.map((k) => field(c, k))] : []),
      ...hooksBlock(c),
      opsBlock(c),
      ...paramsBlock(c),
      el("h4", {}, "Advanced"), field(c, "hide"), field(c, "clientcode"),
      ...(unpacked.length ? [el("p", { class: "bad" }, `Not taken by type=${type} (the packer fails): ${unpacked.join(", ")}`)] : []),
      ...(other.length ? [el("h4", {}, "Unknown keys (the packer fails)"), ...other.map(([k, v]) => el("div", { class: "other" }, `${k}=${v}`)),
        el("button", { onclick: () => vscode.postMessage({ type: "openText" }) }, "Edit as text")] : []),
    );
  }

  function renderInspector(pane) {
    if (!catalog) return pane.append("Loading…");
    const c = com(selected);
    if (if3()) {
      if (selection.length > 1) pane.append(el("p", { class: "note" }, `${selection.length} selected: editing ${selected}.`));
      return c ? renderInspector3(pane, c) : pane.append(el("p", { class: "note" }, "Select a component in the preview or the tree."));
    }
    const commit = c && committer(c);
    if (selection.length > 1) pane.append(el("p", { class: "note" }, `${selection.length} selected: editing ${selected}. Drag, arrow keys, group, duplicate and delete act on all of them.`));
    if (!c) {
      const overlay = frame.root.some(([k, v]) => k === "type" && v === "overlay");
      return pane.append(el("p", { class: "note" }, "Select a component in the preview or the tree."),
        el("label", {}, el("input", { type: "checkbox", checked: overlay, onchange: (e) => send({ kind: "set", com: "", key: "type", value: e.target.checked ? "overlay" : null }) }),
          " Overlay interface (type=overlay on the root)"));
    }
    const type = get(c, "type") || "";
    const bt = get(c, "buttontype");
    const fields = (catalog.schema.FIELDS[type] || catalog.schema.FIELDS.layer)[bt && catalog.schema.FIELDS.layer[bt] ? bt : ""];
    const known = new Set(Object.values(catalog.schema.FIELDS).flatMap((t) => Object.values(t).flat()));
    const used = new Set(c.keys.map(([k]) => k));
    const section = (title, keys) => {
      const shown = keys.filter((k) => fields.includes(k));
      return shown.length ? [el("h4", {}, title), ...shown.map((k) => field(c, k))] : [];
    };
    const rest = fields.filter((k) => !["x", "y", "width", "height", "layer", "buttontype", "clientcode", "overlayer", "option", "actionverb", "action", "actiontarget"].includes(k) && !/^(option|slot)\d+$/.test(k));
    const unpacked = [...used].filter((k) => known.has(k) && !fields.includes(k) && k !== "type");
    const other = c.keys.filter(([k]) => !known.has(k) && k !== "type" && !/^script\d(op\d+)?$/.test(k));
    pane.append(
      el("div", { class: "field" }, el("label", {}, "name"), el("b", {}, selected)),
      el("div", { class: "field" }, el("label", {}, "type"), el("select", { onchange: (e) => commit("type", e.target.value) },
        catalog.schema.TYPES.map((t) => el("option", { value: t, selected: t === type }, t)))),
      ...section("Position and size", ["x", "y", "width", "height", "layer"]),
      ...(type === "inv" || type === "invtext" ? [el("p", { class: "note" }, "width and height count slots, not pixels.")] : []),
      el("h4", {}, "Button and options"), field(c, "buttontype"), ...optionsBlock(c, fields),
      ...section("Appearance", rest),
      ...(fields.includes("slot1") ? [el("details", {}, el("summary", {}, "Slot backgrounds (slot1-20)"), ...fields.filter((k) => k.startsWith("slot")).map((k) => field(c, k)))] : []),
      ...scriptsBlock(c),
      ...section("Advanced", ["clientcode", "overlayer"]),
      ...(unpacked.length ? [el("p", { class: "note" }, `Not packed for this type/button: ${unpacked.join(", ")}`)] : []),
      ...(other.length ? [el("h4", {}, "Other keys"), ...other.map(([k, v]) => el("div", { class: "other" }, `${k}=${v}`)),
        el("button", { onclick: () => vscode.postMessage({ type: "openText" }) }, "Edit as text")] : []),
    );
  }

  // ---- name suggestions ----
  // Inputs with `data-list` (model and seq names) suggest from catalog.lists in an in-page list.
  // A native <datalist> popup in a VS Code webview has no scrollbar and ignores the wheel, so
  // with thousands of names most were unreachable. Prefix matches come first; the list shows at
  // most SUGGEST_MAX and says how many more there are.
  const SUGGEST_MAX = 500;
  const popup = el("div", { class: "suggest", hidden: true });
  document.body.append(popup);
  /** @type {HTMLInputElement | null} */ let suggestFor = null;
  /** @type {string[]} */ let suggestItems = [];
  let suggestIndex = -1;
  /** false until the user types: a field opened with a value lists everything, at that value */
  let suggestFiltering = false;

  function closeSuggest() {
    suggestFor = null;
    popup.hidden = true;
  }

  function fillSuggest() {
    if (!suggestFor) return;
    const values = (catalog && catalog.lists[suggestFor.dataset.list || ""]) || [];
    const q = suggestFiltering ? suggestFor.value.trim().toLowerCase() : "";
    const prefix = [];
    const inside = [];
    for (const v of values) {
      const at = v.toLowerCase().indexOf(q);
      if (at === 0) prefix.push(v);
      else if (at > 0) inside.push(v);
    }
    const matches = [...prefix, ...inside];
    let start = 0;
    if (!suggestFiltering) {
      // unfiltered: a window of the list around the current value, which is highlighted
      const at = matches.indexOf(suggestFor.value.trim());
      if (at >= 0) {
        start = Math.max(0, Math.min(at - (SUGGEST_MAX >> 1), matches.length - SUGGEST_MAX));
        if (suggestIndex < 0) suggestIndex = at - start;
      }
    }
    suggestItems = matches.slice(start, start + SUGGEST_MAX);
    if (suggestIndex >= suggestItems.length) suggestIndex = suggestItems.length - 1;
    popup.replaceChildren(
      ...suggestItems.map((v, i) => el("div", { class: i === suggestIndex ? "item active" : "item", onmousedown: (e) => (e.preventDefault(), chooseSuggest(v)) }, v)),
      ...(matches.length > SUGGEST_MAX ? [el("div", { class: "more" }, `${matches.length - SUGGEST_MAX} more: type to narrow`)] : []),
    );
    popup.hidden = suggestItems.length === 0;
    // under the input, or above it when there is more room there
    const r = suggestFor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const height = Math.min(320, Math.max(below, above));
    popup.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - Math.max(r.width, 220)))}px`;
    popup.style.width = `${Math.max(r.width, 220)}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.top = below >= Math.min(320, above) ? `${r.bottom + 2}px` : `${Math.max(0, r.top - 2 - Math.min(height, popup.scrollHeight))}px`;
  }

  function chooseSuggest(v) {
    const input = suggestFor;
    closeSuggest();
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  document.addEventListener("focusin", (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.tagName === "INPUT" && t.dataset.list) {
      suggestFor = t;
      suggestIndex = -1;
      suggestFiltering = false;
      fillSuggest();
      popup.children[suggestIndex]?.scrollIntoView({ block: "center" });
    }
  });
  document.addEventListener("focusout", (e) => {
    if (e.target === suggestFor) closeSuggest();
  });
  document.addEventListener("input", (e) => {
    if (e.target === suggestFor) {
      suggestIndex = -1;
      suggestFiltering = true;
      fillSuggest();
    }
  });
  // capture, so Escape closes the list before the editor treats it as "deselect"
  document.addEventListener("keydown", (e) => {
    if (!suggestFor || e.target !== suggestFor) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (popup.hidden) fillSuggest();
      const n = suggestItems.length;
      if (!n) return;
      suggestIndex = e.key === "ArrowDown" ? (suggestIndex + 1) % n : (suggestIndex - 1 + n) % n;
      popup.querySelectorAll(".item").forEach((item, i) => item.classList.toggle("active", i === suggestIndex));
      popup.children[suggestIndex]?.scrollIntoView({ block: "nearest" });
      e.preventDefault();
    } else if (e.key === "Enter" && !popup.hidden && suggestIndex >= 0) {
      chooseSuggest(suggestItems[suggestIndex]);
      e.preventDefault();
    } else if (e.key === "Escape" && !popup.hidden) {
      popup.hidden = true;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  // the input moves when its panel scrolls or the window resizes: follow it (the list's own
  // scrolling is left alone)
  document.addEventListener("scroll", (e) => {
    if (suggestFor && e.target !== popup) fillSuggest();
  }, true);
  window.addEventListener("resize", () => suggestFor && fillSuggest());

  function renderAdd(pane) {
    pane.append(el("p", { class: "note" }, "Drag onto the preview. Dropping inside a layer adds it to that layer."),
      el("div", { class: "palette" }, Object.keys(catalog.schema.NEW_COM).map((type) =>
        el("div", { class: "item", draggable: "true", ondragstart: (e) => dragData(e, { kind: "type", type }) }, type))));
  }

  function sheetCanvas(sheet) {
    let c = sheetCanvases.get(sheet.name);
    if (!c) {
      c = document.createElement("canvas");
      c.width = sheet.width;
      c.height = sheet.height;
      /** @type {CanvasRenderingContext2D} */ (c.getContext("2d")).putImageData(new ImageData(new Uint8ClampedArray(sheet.rgba), sheet.width, sheet.height), 0, 0);
      sheetCanvases.set(sheet.name, c);
    }
    return c;
  }

  let spriteFilter = "";
  function renderSprites(pane) {
    const list = el("div");
    const fill = () => {
      list.replaceChildren(...catalog.sheets.filter((s) => s.name.includes(spriteFilter)).map((s) => {
        const src = sheetCanvas(s);
        const tiles = [];
        for (let i = 0; i < s.cols * s.rows; i++) {
          const t = document.createElement("canvas");
          t.width = s.tileW;
          t.height = s.tileH;
          const sx = (i % s.cols) * s.tileW;
          const sy = Math.floor(i / s.cols) * s.tileH;
          /** @type {CanvasRenderingContext2D} */ (t.getContext("2d")).drawImage(src, sx, sy, s.tileW, s.tileH, 0, 0, s.tileW, s.tileH);
          t.title = `${s.name},${i} (${s.tileW}x${s.tileH})`;
          t.draggable = true;
          t.addEventListener("dragstart", (e) => dragData(e, { kind: "sprite", spec: `${s.name},${i}`, w: s.tileW, h: s.tileH }));
          t.addEventListener("click", () => {
            const c = com(selected);
            if (c && pickKey) {
              // a slot keeps its :dx,dy offset
              const offset = pickKey.startsWith("slot") ? (get(c, pickKey) || "").split(":")[1] : undefined;
              send(set(selected, pickKey, `${s.name},${i}${offset !== undefined ? `:${offset}` : ""}`));
              pickKey = null;
              tab = "inspect";
              renderPanels(true);
            } else if (c && get(c, "type") === "graphic") {
              send(set(selected, "graphic", `${s.name},${i}`));
            }
          });
          tiles.push(t);
        }
        return el("div", { class: "sheet" }, el("div", { class: "name" }, s.name), el("div", { class: "tiles" }, tiles));
      }));
    };
    const search = el("input", { placeholder: "Filter sheets", value: spriteFilter, oninput: (e) => ((spriteFilter = e.target.value), fill()) });
    pane.append(el("p", { class: "note" }, "Drag a tile onto the preview to add it; click a tile to swap the selected graphic."), search, list);
    fill();
  }

  function renderFonts(pane) {
    const c = com(selected);
    const fontKey = if3() ? "textfont" : "font";
    const ok = c && ["text", "invtext", "inputfield", "tooltip"].includes(get(c, "type"));
    pane.append(el("p", { class: "note" }, ok ? `Click to set the font of ${selected}.` : "Select a text component to set its font."));
    for (const f of catalog.fonts) {
      const cv = document.createElement("canvas");
      cv.width = f.width;
      cv.height = f.height;
      /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d")).putImageData(new ImageData(new Uint8ClampedArray(f.rgba), f.width, f.height), 0, 0);
      cv.style.width = `${f.width * 2}px`;
      pane.append(el("div", { class: ok && get(c, fontKey) === f.name ? "font on" : "font", title: f.name, onclick: () => ok && send(set(selected, fontKey, f.name)) },
        el("div", { class: "note" }, f.name), cv));
    }
  }

  const CLIENT_COLOURS = { orange: 0xff981f, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, cyan: 0x00ffff, magenta: 0xff00ff, white: 0xffffff, black: 0x000000,
    lightred: 0xff9040, darkred: 0x800000, darkblue: 0x000080, orange1: 0xffb000, orange2: 0xff7000, orange3: 0xff3000, green1: 0xc0ff00, green2: 0x80ff00, green3: 0x40ff00 };
  const hex = (n) => "0x" + n.toString(16).padStart(6, "0");

  function applyColour(n) {
    if (colourField && document.body.contains(colourField)) {
      colourField.value = hex(n);
      colourField.dispatchEvent(new Event("change"));
    } else if (selected) {
      send(set(selected, "colour", hex(n)));
    }
  }

  function renderColours(pane) {
    const swatches = (list) => el("div", { class: "palette" }, list.map(([name, n]) =>
      el("div", { class: "swatch", title: `${name} ${hex(n)}`, style: `background:#${n.toString(16).padStart(6, "0")}`, onclick: () => applyColour(n) })));
    const input = el("input", { placeholder: "0xRRGGBB" });
    pane.append(el("p", { class: "note" }, "Click to set the focused colour field, or the selected component's colour."),
      el("h4", {}, "In this file"), swatches(catalog.colours.map((n) => [hex(n), n])),
      el("h4", {}, "Client colours"), swatches(Object.entries(CLIENT_COLOURS)),
      el("h4", {}, "Custom"), el("div", { class: "row" }, input, " ", el("button", { onclick: () => /^0x[0-9a-fA-F]{6}$/.test(input.value) && applyColour(parseInt(input.value.slice(2), 16)) }, "Apply")));
  }

  // ---- dropping palette items on the preview ----

  const dragData = (e, data) => e.dataTransfer.setData("application/x-ifedit", JSON.stringify(data));

  function nextComName() {
    let max = -1;
    for (const c of frame.coms) {
      const m = /^com_(\d+)$/.exec(c.name);
      if (m) max = Math.max(max, +m[1]);
    }
    return `com_${max + 1}`;
  }

  overlay.addEventListener("dragover", (e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes("application/x-ifedit")) e.preventDefault();
  });
  overlay.addEventListener("drop", (e) => {
    const raw = e.dataTransfer && e.dataTransfer.getData("application/x-ifedit");
    if (!raw || !frame) return;
    e.preventDefault();
    dropItem(JSON.parse(raw), ...at(e).map(Math.floor));
  });

  /** Adds a palette item at preview pixel (x, y): into the topmost layer there, else the root. */
  function dropItem(data, x, y) {
    const target = hit(x, y);
    if (data.kind === "sprite" && target && target.com === selected && target.type === "graphic") return send(set(selected, "graphic", data.spec));
    const layer = hit(x, y, (b) => isLayer(b.com));
    const parent = layer ? layer.com : "";
    const ox = layer ? layer.x : 0;
    const oy = layer ? layer.y - (frame.state.scroll[layer.com] || 0) : 0;
    const keys = data.kind === "sprite"
      ? [["type", "graphic"], ["width", String(data.w)], ["height", String(data.h)], ["graphic", data.spec]]
      : catalog.schema.NEW_COM[data.type].map((kv) => [...kv]);
    keys.splice(1, 0, ["x", String(snap(x - ox))], ["y", String(snap(y - oy))]);
    send({ kind: "add", com: nextComName(), parent, keys });
  }

  // ---- messages ----

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "frame") {
      frame = msg;
      view = { hidden: [], locked: [], collapsed: [], ...msg.view };
      if (selection.some((n) => !com(n))) {
        selection = selection.filter((n) => com(n));
        selected = selection[selection.length - 1] ?? null;
      }
      showFrame();
      renderToolbar();
      renderPanels();
    } else if (msg.type === "models") {
      setModels(msg.models);
    } else if (msg.type === "scripts") {
      scripts = msg.scripts;
      if (catalog) catalog.lists.clientscript = scripts.map((s) => s.name);
      renderPanels();
    } else if (msg.type === "catalog") {
      catalog = msg;
      catalog.lists.clientscript = scripts.map((s) => s.name);
      sheetCanvases.clear();
      fillSuggest();
      if (frame) (renderToolbar(), renderPanels(true));
    } else if (msg.type === "select") {
      // components an intent just created (add, duplicate, paste, group) or renamed
      if (msg.names.length) reveal(msg.names[msg.names.length - 1]);
      setSelection(msg.names);
    } else if (msg.type === "error") {
      document.body.replaceChildren(el("p", { class: "error" }, msg.message));
    }
  });

  // ---- resizable side panels ----

  /** Splitters between the layers panel, the preview and the side panel; widths are remembered. */
  const widths = { tree: saved.treeWidth || 240, side: saved.sideWidth || 300 };
  const applyWidths = () => {
    $("tree").style.width = `${widths.tree}px`;
    $("side").style.width = `${widths.side}px`;
  };
  for (const [panel, after] of [["tree", true], ["side", false]]) {
    const bar = el("div", { class: "splitter", title: "Drag to resize, double-click to reset" });
    const target = $(panel);
    if (after) target.after(bar);
    else target.before(bar);
    bar.addEventListener("dblclick", () => {
      widths[panel] = panel === "tree" ? 240 : 300;
      applyWidths();
      save();
    });
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = widths[panel];
      bar.classList.add("active");
      const move = (ev) => {
        const delta = after ? ev.clientX - startX : startX - ev.clientX;
        widths[panel] = Math.max(140, Math.min(window.innerWidth * 0.6, start + delta));
        applyWidths();
      };
      const up = () => {
        bar.classList.remove("active");
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        save();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  }
  applyWidths();

  vscode.postMessage({ type: "ready" });
})();
