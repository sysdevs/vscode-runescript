// Model preview webview: draws the triangle lists the host builds (src/modelview/*.ts) with
// WebGL2. Lighting is baked into the per-frame corner colours by the host, as the client does,
// so the shader only transforms and interpolates. Drag orbits, wheel zooms, double-click
// resets; the obj inventory view instead uses the icon's fixed camera inside a 32x32 frame.
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById("view");
  const title = document.getElementById("title");
  const viewSelect = document.getElementById("viewpick");
  const seqSelect = document.getElementById("seq");
  const playButton = document.getElementById("play");
  const status = document.getElementById("status");
  const message = document.getElementById("message");
  const labels = document.getElementById("labels");
  const iconFrame = document.getElementById("iconframe");

  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) {
    message.textContent = "WebGL2 is not available in this webview.";
    return;
  }

  const VS = `#version 300 es
    uniform mat4 mvp;
    in vec3 pos;
    in vec4 col;
    out vec4 v_col;
    void main() {
      // client axes are y down, z away from the viewer: turn them into GL's y up, z towards
      gl_Position = mvp * vec4(pos.x, -pos.y, -pos.z, 1.0);
      v_col = col;
    }`;
  const FS = `#version 300 es
    precision mediump float;
    in vec4 v_col;
    out vec4 colour;
    void main() { colour = v_col; }`;

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  const mvpAt = gl.getUniformLocation(program, "mvp");
  const posAt = gl.getAttribLocation(program, "pos");
  const colAt = gl.getAttribLocation(program, "col");
  const vao = gl.createVertexArray();

  // the eyedropper draws each face in a colour encoding its index (+1) into an offscreen buffer
  // and reads the pixel under the click; same shaders, the id colours as the vertex colours
  const pickFbo = gl.createFramebuffer();
  const pickColour = gl.createRenderbuffer();
  const pickDepth = gl.createRenderbuffer();
  let pickSize = [0, 0];
  let lastMvp = null;
  let lastViewport = [0, 0, 1, 1];

  /** @type {{ frames: WebGLBuffer[], colours: WebGLBuffer[], delays: number[], faces: number, opaqueFaces: number, centre: number[], radius: number, parts: {label: string, anchor: number[], el: HTMLElement}[], icon: boolean } | null} */
  let scene = null;
  let shownName = null;
  let frame = 0;
  let elapsed = 0;
  let playing = true;
  let last = performance.now();
  // a three-quarter view, so thin models (doors, walls) are not seen edge-on
  const HOME = { yaw: 0.5, pitch: 0.25, zoom: 1 };
  const camera = { ...HOME };

  function buffers(list, Type) {
    return list.map((data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Type(data), gl.STATIC_DRAW);
      return b;
    });
  }

  function choices(select, options, selected) {
    select.replaceChildren(...options.map(([label, value]) => new Option(label, value, false, value === selected)));
  }

  function upload(msg) {
    const s = msg.scene;
    if (scene) [...scene.frames, ...scene.colours, scene.ids].forEach((b) => gl.deleteBuffer(b));
    const ids = new Uint8Array(s.faces * 12);
    for (let f = 0; f < s.faces; f++) {
      const id = f + 1;
      for (let j = 0; j < 3; j++) ids.set([id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, 255], (f * 3 + j) * 4);
    }
    const [x0, y0, z0, x1, y1, z1] = s.bounds;
    // centre in GL axes (y and z flipped, as in the vertex shader)
    const centre = [(x0 + x1) / 2, -(y0 + y1) / 2, -(z0 + z1) / 2];
    const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
    labels.replaceChildren();
    const parts = s.parts.map((p) => {
      const el = document.createElement("div");
      el.className = "label";
      el.textContent = p.label;
      labels.append(el);
      return { ...p, el };
    });
    scene = {
      frames: buffers(s.frames, Float32Array),
      colours: buffers(s.colours, Uint8Array),
      ids: buffers([ids], Uint8Array)[0],
      faceSource: Int32Array.from(s.faceSource),
      delays: s.delays,
      faces: s.faces,
      opaqueFaces: s.opaqueFaces,
      centre,
      radius,
      parts,
      icon: s.camera === "icon",
    };
    if (frame >= s.frames.length) frame = 0;
    if (msg.name !== shownName) {
      shownName = msg.name;
      Object.assign(camera, HOME);
      frame = 0;
      elapsed = 0;
    }

    title.textContent = msg.name;
    choices(viewSelect, s.views.map((v) => [v.label, v.key]), s.view);
    viewSelect.hidden = s.views.length < 2;
    choices(seqSelect, [...s.seqs.map((c) => [`${c.key}: ${c.seq}`, c.seq]), ["(none)", ""]], s.seq);
    seqSelect.hidden = s.seqs.length === 0;
    playButton.hidden = s.frames.length < 2;
    iconFrame.hidden = !scene.icon;
    canvas.style.cursor = scene.icon ? "default" : "grab";
    status.textContent = `${s.faces} faces · ${s.frames.length} frame${s.frames.length === 1 ? "" : "s"}`;
    message.textContent = s.warnings.join("\n");
    message.className = s.warnings.length ? "warn" : "";
  }

  // column-major 4x4 helpers
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  }
  function orbit(aspect) {
    const { centre, radius } = scene;
    const dist = (radius * 2.6) / camera.zoom;
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    // rotate the model about its centre (yaw about y, then pitch about x), then step back
    const ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
    const rx = [1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1];
    const toCentre = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -centre[0], -centre[1], -centre[2], 1];
    const back = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -dist, 1];
    const proj = perspective(Math.PI / 4, aspect, dist / 100, dist * 10);
    return multiply(proj, multiply(back, multiply(rx, multiply(ry, toCentre))));
  }
  // the icon's projection: screen = 16 + (x << 9) / z inside 32 pixels, i.e. a focal length of 32 half-widths
  const ICON = perspective(2 * Math.atan(1 / 32), 1, 10, 100000);

  function background() {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    return m ? [m[1] / 255, m[2] / 255, m[3] / 255] : [0.12, 0.12, 0.12];
  }

  function draw(now) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const [r, g, b] = background();
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (scene && scene.faces > 0) {
      if (playing && scene.frames.length > 1) {
        elapsed += now - last;
        while (elapsed >= scene.delays[frame]) {
          elapsed -= scene.delays[frame];
          frame = (frame + 1) % scene.frames.length;
        }
      }
      let mvp;
      if (scene.icon) {
        // a square viewport standing for the 32x32 icon, outlined by #iconframe
        const side = Math.floor(Math.min(w, h) * 0.8);
        lastViewport = [(w - side) >> 1, (h - side) >> 1, side, side];
        Object.assign(iconFrame.style, { width: `${side / dpr}px`, height: `${side / dpr}px` });
        mvp = ICON;
      } else {
        lastViewport = [0, 0, w, h];
        mvp = orbit(w / h);
      }
      gl.viewport(...lastViewport);
      lastMvp = mvp;
      gl.useProgram(program);
      gl.uniformMatrix4fv(mvpAt, false, mvp);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, scene.frames[frame]);
      gl.enableVertexAttribArray(posAt);
      gl.vertexAttribPointer(posAt, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, scene.colours[frame]);
      gl.enableVertexAttribArray(colAt);
      gl.vertexAttribPointer(colAt, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.drawArrays(gl.TRIANGLES, 0, scene.opaqueFaces * 3);
      if (scene.faces > scene.opaqueFaces) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, scene.opaqueFaces * 3, (scene.faces - scene.opaqueFaces) * 3);
      }
      // part labels follow the point under their part (in GL axes)
      for (const p of scene.parts) {
        const [x, y, z] = [p.anchor[0], -p.anchor[1], -p.anchor[2]];
        const clip = [0, 1, 2, 3].map((i) => mvp[i] * x + mvp[4 + i] * y + mvp[8 + i] * z + mvp[12 + i]);
        p.el.hidden = clip[3] <= 0;
        p.el.style.left = `${((clip[0] / clip[3] + 1) / 2) * canvas.clientWidth}px`;
        p.el.style.top = `${((1 - clip[1] / clip[3]) / 2) * canvas.clientHeight}px`;
      }
    }
    last = now;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (picking) {
      const face = pickAt(e.clientX, e.clientY);
      const hsl = face >= 0 ? scene.faceSource[face] : undefined;
      if (hsl === undefined) message.textContent = "No face there; click on the model (Esc cancels).";
      else if (hsl < 0) message.textContent = "That face is textured: its retex# keys change it, not recol#.";
      else {
        vscode.postMessage({ type: "pick", hsl, slot: picking.slot });
        message.textContent = "";
        disarm();
      }
      return;
    }
    if (scene?.icon) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    camera.yaw += (e.clientX - drag.x) * 0.01;
    camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", () => (drag = null));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (scene?.icon) return;
    camera.zoom = Math.max(0.2, Math.min(20, camera.zoom * Math.exp(-e.deltaY * 0.001)));
  }, { passive: false });
  canvas.addEventListener("dblclick", () => Object.assign(camera, HOME));

  viewSelect.addEventListener("change", () => vscode.postMessage({ type: "view", view: viewSelect.value }));
  seqSelect.addEventListener("change", () => {
    frame = 0;
    elapsed = 0;
    vscode.postMessage({ type: "seq", seq: seqSelect.value });
  });
  playButton.addEventListener("click", () => {
    playing = !playing;
    playButton.textContent = playing ? "Pause" : "Play";
  });

  // sliders for the block's visual keys: dragging previews (the host rebuilds without touching
  // the file), releasing or typing a number writes the key, ↺ removes it (back to the default)
  const controlsBox = document.getElementById("controls");
  let controlKeys = "";
  /** @type {Map<string, {row: HTMLElement, range: HTMLInputElement, number: HTMLInputElement, reset: HTMLButtonElement, spec: any}>} */
  const rows = new Map();
  let dragging = null;
  let previewQueued = null;

  function preview(key, value) {
    const first = previewQueued === null;
    previewQueued = { key, value };
    if (first) {
      requestAnimationFrame(() => {
        vscode.postMessage({ type: "preview", ...previewQueued });
        previewQueued = null;
      });
    }
  }
  const clamp = (spec, v) => Math.min(spec.max, Math.max(spec.min, Math.round(v)));

  function renderControls(controls) {
    controlsBox.hidden = controls.length === 0;
    const keys = controls.map((c) => c.key).join(",");
    if (keys !== controlKeys) {
      controlKeys = keys;
      rows.clear();
      controlsBox.replaceChildren();
      for (const c of controls) {
        const row = document.createElement("div");
        row.className = "control";
        const label = document.createElement("label");
        label.textContent = c.key;
        const range = document.createElement("input");
        range.type = "range";
        const number = document.createElement("input");
        number.type = "number";
        const reset = document.createElement("button");
        reset.textContent = "↺";
        reset.title = "Remove the key (use the default)";
        row.append(label, range, number, reset);
        controlsBox.append(row);
        const entry = { row, range, number, reset, spec: c };
        rows.set(c.key, entry);
        range.addEventListener("pointerdown", () => (dragging = c.key));
        range.addEventListener("input", () => {
          number.value = range.value;
          row.classList.remove("unset");
          preview(c.key, Number(range.value));
        });
        range.addEventListener("change", () => {
          dragging = null;
          vscode.postMessage({ type: "set", key: c.key, value: Number(range.value) });
        });
        number.addEventListener("change", () => {
          if (number.value === "") return;
          const v = clamp(entry.spec, Number(number.value));
          number.value = String(v);
          vscode.postMessage({ type: "set", key: c.key, value: v });
        });
        reset.addEventListener("click", () => vscode.postMessage({ type: "set", key: c.key, value: null }));
      }
    }
    for (const c of controls) {
      const e = rows.get(c.key);
      e.spec = c;
      // leave the control being used alone; its value comes back through the file
      if (dragging === c.key) continue;
      Object.assign(e.range, { min: c.lo, max: c.hi, step: c.step });
      Object.assign(e.number, { min: c.min, max: c.max, step: c.step });
      e.range.value = String(c.value);
      if (document.activeElement !== e.number) e.number.value = String(c.value);
      e.row.classList.toggle("unset", !c.set);
      e.reset.disabled = !c.set;
      e.range.title = e.number.title = `${c.key}: ${c.min} to ${c.max}${c.set ? "" : ` (not set: default ${c.def})`}`;
    }
  }
  window.addEventListener("pointerup", () => (dragging = null));

  /** The index (drawing order) of the face under a client point in the frame on screen, or -1. */
  function pickAt(clientX, clientY) {
    if (!scene || !lastMvp || scene.faces === 0) return -1;
    const rect = canvas.getBoundingClientRect();
    const [w, h] = [canvas.width, canvas.height];
    const x = Math.floor(((clientX - rect.left) * w) / rect.width);
    const y = h - 1 - Math.floor(((clientY - rect.top) * h) / rect.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
    if (pickSize[0] !== w || pickSize[1] !== h) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, pickColour);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, pickColour);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
      pickSize = [w, h];
    }
    gl.viewport(...lastViewport);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniformMatrix4fv(mvpAt, false, lastMvp);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, scene.frames[frame]);
    gl.vertexAttribPointer(posAt, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, scene.ids);
    gl.vertexAttribPointer(colAt, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, scene.faces * 3);
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (px[0] | (px[1] << 8) | (px[2] << 16)) - 1;
  }

  // recolour slots: the source swatch, a picker for the destination (previewed while choosing,
  // written when the picker closes), an eyedropper re-picking the source off the model, remove
  const coloursBox = document.getElementById("colours");
  const hex = (rgb15) => "#" + [(rgb15 >> 10) & 31, (rgb15 >> 5) & 31, rgb15 & 31].map((v) => (v << 3).toString(16).padStart(2, "0")).join("");
  const rgb15Of = (h) => {
    const n = parseInt(h.slice(1), 16);
    return (((n >> 19) & 31) << 10) | (((n >> 11) & 31) << 5) | ((n >> 3) & 31);
  };
  let colourSlots = null;
  const colourRows = new Map();
  let choosing = null;
  /** the armed eyedropper: { slot } re-picks that slot's source, {} adds a slot */
  let picking = null;

  function arm(slot) {
    picking = { slot };
    canvas.style.cursor = "crosshair";
    message.textContent = slot ? `Click a face to use its colour as recol${slot}s (Esc cancels)` : "Click a face to recolour its colour (Esc cancels)";
    message.className = "info";
  }
  function disarm() {
    picking = null;
    canvas.style.cursor = scene?.icon ? "default" : "grab";
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) {
      disarm();
      message.textContent = "";
    }
  });

  function renderColours(recols) {
    coloursBox.hidden = !scene || scene.faces === 0;
    const slots = recols.map((r) => r.slot).join(",");
    if (slots !== colourSlots) {
      colourSlots = slots;
      colourRows.clear();
      const header = document.createElement("div");
      header.className = "colours-header";
      const title = document.createElement("span");
      title.textContent = "Colours";
      const add = document.createElement("button");
      add.textContent = "Pick from model";
      add.title = "Click a face: its colour becomes a new recol slot's source";
      add.addEventListener("click", () => arm(undefined));
      header.append(title, add);
      coloursBox.replaceChildren(header);
      for (const r of recols) {
        const row = document.createElement("div");
        row.className = "colour";
        const label = document.createElement("label");
        label.textContent = `recol${r.slot}`;
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        const arrow = document.createElement("span");
        arrow.textContent = "→";
        const dest = document.createElement("input");
        dest.type = "color";
        dest.title = `recol${r.slot}d`;
        const dropper = document.createElement("button");
        dropper.textContent = "Pick";
        dropper.title = `Click a face: its colour becomes recol${r.slot}s`;
        dropper.addEventListener("click", () => arm(r.slot));
        const remove = document.createElement("button");
        remove.textContent = "✕";
        remove.title = `Remove recol${r.slot}s and recol${r.slot}d`;
        remove.addEventListener("click", () => vscode.postMessage({ type: "setKeys", changes: [[`recol${r.slot}s`, null], [`recol${r.slot}d`, null]] }));
        dest.addEventListener("input", () => {
          choosing = r.slot;
          preview(`recol${r.slot}d`, rgb15Of(dest.value));
        });
        dest.addEventListener("change", () => {
          choosing = null;
          vscode.postMessage({ type: "set", key: `recol${r.slot}d`, value: rgb15Of(dest.value) });
        });
        row.append(label, swatch, arrow, dest, dropper, remove);
        coloursBox.append(row);
        colourRows.set(r.slot, { swatch, dest });
      }
    }
    for (const r of recols) {
      const e = colourRows.get(r.slot);
      e.swatch.style.background = r.s === undefined ? "transparent" : hex(r.s);
      e.swatch.title = r.s === undefined ? `recol${r.slot}s is not set` : `recol${r.slot}s=${r.s}`;
      if (choosing !== r.slot) e.dest.value = hex(r.d ?? r.s ?? 0);
    }
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "scene") {
      upload(msg);
      renderControls(msg.controls ?? []);
      renderColours(msg.recols ?? []);
    }
    else if (msg.type === "message") {
      // nothing to preview here (not a config block, no Content root): keep the last model, say why
      message.textContent = msg.message;
      message.className = "info";
    }
  });
  vscode.postMessage({ type: "ready" });
})();
