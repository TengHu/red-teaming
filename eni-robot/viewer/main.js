import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Page frame (mm, +x right, +y down the page, +z up) maps to three.js as
// X = x - W/2, Z = y - H/2, Y = z. One three.js unit is one millimetre.
const TEX_PX_PER_MM = 5;
const PAPER_Y = 0.25;
const GANTRY_Y = 92;
const COLORS = { paper: "#fbfaf5", ruling: "#b4cde8", margin: "#e6a3a3", ink: "#16181d" };

const $ = (id) => document.getElementById(id);
const dark = matchMedia("(prefers-color-scheme: dark)").matches;

// ---- renderer and scene -----------------------------------------------------

const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(dark ? 0x1b1d21 : 0xe7e3dc);
const camera = new THREE.PerspectiveCamera(36, 1, 1, 8000);
camera.position.set(110, 560, 560);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(70, 0, 10);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-260, 520, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -500, right: 500, top: 500, bottom: -500, near: 10, far: 1500 });
scene.add(sun);

function resize() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

// ---- world objects (built once the config arrives) ---------------------------

let W = 210;
let H = 297;
let cfg = null;
let built = false;
const paper = {};
/** The reference sheet right of the robot's: its commanded strokes, no motion modules, no noise. Viewer only. */
const intended = {};
/** Where the reference sheet and the finished-sheet tray sit, mm right of the sheet centre (set in build). */
let INTENDED_X = 0;
const rig = {};
const tray = new THREE.Group();
scene.add(tray);

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });
}
function box(w, h, d, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

function build() {
  W = cfg.sheet.widthMm;
  H = cfg.sheet.heightMm;
  // Clear of the gantry's right rail (at W/2 + 42, 16 mm wide), so the rail never hides the sheet's left edge.
  INTENDED_X = W + 80;
  const trayX = INTENDED_X + W + 50;
  // The desk runs from past the blank stack on the left to past the tray on the right.
  const deskLeft = -(W + 50) - W / 2 - 40;
  const deskRight = trayX + W / 2 + 40;
  box(deskRight - deskLeft, 24, H * 1.9, mat(0xb4946c, { roughness: 0.8, metalness: 0 }), (deskLeft + deskRight) / 2, -12, 0).castShadow = false;

  // Current sheet: printed paper plus an ink layer, composited into one texture.
  paper.base = document.createElement("canvas");
  paper.ink = document.createElement("canvas");
  paper.tex = document.createElement("canvas");
  for (const c of [paper.base, paper.ink, paper.tex]) {
    c.width = Math.round(W * TEX_PX_PER_MM);
    c.height = Math.round(H * TEX_PX_PER_MM);
  }
  drawPrintedPaper(paper.base.getContext("2d"));
  paper.inkCtx = paper.ink.getContext("2d");
  paper.inkCtx.lineCap = "round";
  paper.inkCtx.lineJoin = "round";
  paper.texture = new THREE.CanvasTexture(paper.tex);
  paper.texture.colorSpace = THREE.SRGBColorSpace;
  paper.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: paper.texture, roughness: 0.9 }));
  sheet.rotation.x = -Math.PI / 2;
  sheet.position.y = PAPER_Y;
  sheet.receiveShadow = true;
  scene.add(sheet);

  // Reference sheet: the same paper, inked from the robot's commanded strokes (intent events) instead of its ink.
  intended.base = document.createElement("canvas");
  intended.ink = document.createElement("canvas");
  intended.tex = document.createElement("canvas");
  for (const c of [intended.base, intended.ink, intended.tex]) {
    c.width = Math.round(W * TEX_PX_PER_MM);
    c.height = Math.round(H * TEX_PX_PER_MM);
  }
  const ib = intended.base.getContext("2d");
  drawPrintedPaper(ib);
  ib.fillStyle = "#8a8f99";
  ib.font = `${Math.round(4.2 * TEX_PX_PER_MM)}px system-ui, sans-serif`;
  ib.fillText("What the robot meant to write: no motion dials, no noise.", 8 * TEX_PX_PER_MM, 10 * TEX_PX_PER_MM);
  ib.fillText("Viewer only; the robot never sees this sheet.", 8 * TEX_PX_PER_MM, 16 * TEX_PX_PER_MM);
  intended.inkCtx = intended.ink.getContext("2d");
  intended.inkCtx.lineCap = "round";
  intended.inkCtx.lineJoin = "round";
  intended.texture = new THREE.CanvasTexture(intended.tex);
  intended.texture.colorSpace = THREE.SRGBColorSpace;
  intended.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ref = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: intended.texture, roughness: 0.9 }));
  ref.rotation.x = -Math.PI / 2;
  ref.position.set(INTENDED_X, PAPER_Y, 0);
  ref.receiveShadow = true;
  scene.add(ref);
  composite();

  // Clamp bar, blank-sheet stack on the left, finished tray on the far right (past the reference sheet).
  box(W + 20, 5, 10, mat(0x4a5563), 0, 2.5, -H / 2 + 2);
  box(W, 10, H, mat(0xf3f1ea, { roughness: 0.95 }), -(W + 50), 5, 0);
  box(W + 18, 3, H + 18, mat(0x56606e), trayX, 1.5, 0);
  tray.position.set(trayX, 3, 0);

  // Gantry: two rails along y, a bridge along x, a carriage and the pen.
  const metal = mat(0x8d96a3, { metalness: 0.6, roughness: 0.35 });
  const dark = mat(0x2f3540, { metalness: 0.4, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 + 42);
    box(16, 14, H + 110, metal, x, GANTRY_Y, 0);
    for (const sz of [-1, 1]) box(12, GANTRY_Y, 12, dark, x, GANTRY_Y / 2, sz * (H / 2 + 49));
  }
  rig.bridge = box(W + 104, 12, 20, metal, 0, GANTRY_Y + 13, 0);
  rig.carriage = box(30, 34, 30, dark, 0, GANTRY_Y + 2, 0);
  rig.pen = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 70, 24), mat(0x1f4e8c));
  body.position.y = 6 + 35;
  const tipCone = new THREE.Mesh(new THREE.ConeGeometry(4.5, 6, 24), mat(0x222222));
  tipCone.rotation.x = Math.PI;
  tipCone.position.y = 3;
  for (const m of [body, tipCone]) m.castShadow = true;
  rig.penBody = body;
  rig.penTip = tipCone;
  rig.pen.add(body, tipCone);
  scene.add(rig.pen);
  built = true;
}

/**
 * The task pads, tablets lying on the blank-sheet stack (whose top is 10 mm above the desk): the stroke pad, sent to the
 * model as pen strokes, and below it the image pad, the second page sent as a picture (only when there is one).
 */
let taskPadMeshes = [];
function placeTaskPads(strokePad, imagePad) {
  for (const m of taskPadMeshes) {
    scene.remove(m);
    m.traverse((o) => o.material?.map?.dispose());
  }
  taskPadMeshes = [];
  if (strokePad) taskPadMeshes.push(taskPadMesh(strokePad, 0x2b2f36));
  if (imagePad) taskPadMeshes.push(taskPadMesh(imagePad, 0x2c3e5c));
  for (const m of taskPadMeshes) scene.add(m);
}

function taskPadMesh(info, bezelColor) {
  const s = 6;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(info.widthMm * s);
  canvas.height = Math.round(info.heightMm * s);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#eef1f3";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#1d2a3a";
  ctx.lineWidth = 0.5 * s;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const st of info.strokes) {
    ctx.beginPath();
    st.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
    if (st.length === 1) ctx.lineTo(st[0][0] * s + 0.01, st[0][1] * s);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const group = new THREE.Group();
  const bezel = 8;
  const body = new THREE.Mesh(new THREE.BoxGeometry(info.widthMm + 2 * bezel, 6, info.heightMm + 2 * bezel), mat(bezelColor, { roughness: 0.5 }));
  body.position.y = 3;
  body.castShadow = true;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(info.widthMm, info.heightMm), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
  screen.rotation.x = -Math.PI / 2;
  screen.position.y = 6.1;
  group.add(body, screen);
  group.position.set(info.xMm + info.widthMm / 2 - W / 2, 10, info.yMm + info.heightMm / 2 - H / 2);
  return group;
}

function drawPrintedPaper(ctx) {
  const s = TEX_PX_PER_MM;
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, W * s, H * s);
  const { rulingMm, firstLineMm, lastLineMm, marginLineMm } = cfg.sheet;
  ctx.lineWidth = Math.max(1, 0.25 * s);
  if (rulingMm) {
    ctx.strokeStyle = COLORS.ruling;
    for (let y = firstLineMm; y <= lastLineMm + 1e-6; y += rulingMm) {
      ctx.beginPath();
      ctx.moveTo(0, y * s);
      ctx.lineTo(W * s, y * s);
      ctx.stroke();
    }
  }
  if (marginLineMm !== null) {
    ctx.strokeStyle = COLORS.margin;
    ctx.beginPath();
    ctx.moveTo(marginLineMm * s, 0);
    ctx.lineTo(marginLineMm * s, H * s);
    ctx.stroke();
  }
}

let textureDirty = false;
let lastComposite = 0;
function composite() {
  const ctx = paper.tex.getContext("2d");
  ctx.drawImage(paper.base, 0, 0);
  ctx.drawImage(paper.ink, 0, 0);
  paper.texture.needsUpdate = true;
  if (intended.tex) {
    const ic = intended.tex.getContext("2d");
    ic.drawImage(intended.base, 0, 0);
    ic.drawImage(intended.ink, 0, 0);
    intended.texture.needsUpdate = true;
  }
  textureDirty = false;
}

function placePen() {
  const [x, y, z] = state.tip;
  rig.pen.position.set(x - W / 2, PAPER_Y + Math.max(0, z), y - H / 2);
  rig.carriage.position.x = x - W / 2;
  rig.carriage.position.z = y - H / 2;
  rig.bridge.position.z = y - H / 2;
}

// ---- event playback ----------------------------------------------------------

const state = { tip: [15, 15, 3], tool: "pen", sheet: 0, simTime: 0, queue: [], motion: null };
let speed = 8;
// Live viewers skip ahead when far behind; replays play from the start.
let autoCatchUp = true;

function reset() {
  state.tip = [15, 15, cfg.pen.hoverMm];
  state.tool = "pen";
  state.sheet = 0;
  state.simTime = 0;
  state.queue = [];
  state.motion = null;
  paper.inkCtx.clearRect(0, 0, paper.ink.width, paper.ink.height);
  intended.inkCtx.clearRect(0, 0, intended.ink.width, intended.ink.height);
  composite();
  for (const child of [...tray.children]) tray.remove(child);
  setTool("pen");
  placePen();
}

function setTool(tool) {
  state.tool = tool;
  rig.penTip.material.color.set(tool === "eraser" ? 0xf48fb1 : 0x222222);
  rig.penBody.material.color.set(tool === "eraser" ? 0xd9d9d9 : 0x1f4e8c);
}

/** Draw a commanded stroke onto the reference sheet in one go. */
function inkIntent(e) {
  const ctx = intended.inkCtx;
  const s = TEX_PX_PER_MM;
  ctx.globalCompositeOperation = e.tool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = COLORS.ink;
  ctx.fillStyle = COLORS.ink;
  if (e.pts.length === 1) {
    ctx.beginPath();
    ctx.arc(e.pts[0][0] * s, e.pts[0][1] * s, (e.widthMm * s) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.lineWidth = e.widthMm * s;
    ctx.beginPath();
    ctx.moveTo(e.pts[0][0] * s, e.pts[0][1] * s);
    for (const [x, y] of e.pts.slice(1)) ctx.lineTo(x * s, y * s);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  textureDirty = true;
}

function inkSegment(a, b, width, erase) {
  const ctx = paper.inkCtx;
  const s = TEX_PX_PER_MM;
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = COLORS.ink;
  ctx.fillStyle = COLORS.ink;
  if (!b) {
    ctx.beginPath();
    ctx.arc(a[0] * s, a[1] * s, (width * s) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.lineWidth = width * s;
    ctx.beginPath();
    ctx.moveTo(a[0] * s, a[1] * s);
    ctx.lineTo(b[0] * s, b[1] * s);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  textureDirty = true;
}

/** Turn the next queued event into a motion along a polyline, or apply it at once. */
function begin(e) {
  if (e.t === "move") {
    return { pts: [state.tip.slice(), e.to], speed: cfg.pen.travelMmPerS, ink: null };
  }
  if (e.t === "ink") {
    const pts = e.pts.map(([x, y]) => [x, y, 0]);
    const ink = { width: e.widthMm, erase: e.tool === "eraser" };
    if (pts.length === 1) {
      inkSegment(pts[0], null, ink.width, ink.erase);
      state.tip = pts[0];
      return null;
    }
    return { pts, speed: cfg.pen.writeMmPerS, ink };
  }
  if (e.t === "intent") inkIntent(e);
  if (e.t === "tool") setTool(e.tool);
  if (e.t === "sheet" && e.index > 0) fileSheet(e.index);
  return null;
}

/** Advance the current motion by up to `seconds` of sim time; returns the time used. */
function advance(m, seconds) {
  let budget = seconds * m.speed;
  const start = budget;
  m.i ??= 0;
  while (budget > 0 && m.i < m.pts.length - 1) {
    const a = state.tip;
    const b = m.pts[m.i + 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d <= budget) {
      if (m.ink) inkSegment(a, b, m.ink.width, m.ink.erase);
      state.tip = b.slice();
      m.i++;
      budget -= d;
    } else {
      const t = budget / d;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (m.ink) inkSegment(a, p, m.ink.width, m.ink.erase);
      state.tip = p;
      budget = 0;
    }
  }
  if (m.i >= m.pts.length - 1) m.done = true;
  return (start - budget) / m.speed;
}

function play(seconds) {
  while (seconds > 1e-6 && (state.motion || state.queue.length)) {
    if (!state.motion) {
      state.motion = begin(state.queue.shift());
      continue;
    }
    const used = advance(state.motion, seconds);
    seconds -= used;
    state.simTime += used;
    if (state.motion.done) state.motion = null;
    else if (used === 0) break;
  }
}

function catchUp() {
  play(1e9);
}

function fileSheet(index) {
  const snap = document.createElement("canvas");
  snap.width = paper.tex.width;
  snap.height = paper.tex.height;
  if (textureDirty) composite();
  snap.getContext("2d").drawImage(paper.tex, 0, 0);
  const tex = new THREE.CanvasTexture(snap);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = tray.children.length * 0.6 + 0.3;
  m.receiveShadow = true;
  tray.add(m);
  paper.inkCtx.clearRect(0, 0, paper.ink.width, paper.ink.height);
  intended.inkCtx.clearRect(0, 0, intended.ink.width, intended.ink.height);
  textureDirty = true;
  state.sheet = index;
}

// ---- side panel ----------------------------------------------------------------

function onEvent(e) {
  switch (e.t) {
    case "hello":
      cfg = e.cfg;
      if (!built) build();
      reset();
      placeTaskPads(e.taskPad, e.imagePad);
      $("title").textContent = e.title ?? "Scribe";
      // Runs recorded before the images option always sent the images.
      $("viewsTitle").textContent = cfg?.images === false ? "Cameras, latest (not sent to the agent)" : "What the agent sees, latest";
      $("task").textContent = e.task ?? "";
      $("status").textContent = e.status ?? "running";
      $("statusError").hidden = true;
      autoCatchUp = e.status !== "replay";
      resetIo();
      break;
    case "move":
    case "ink":
    case "intent":
    case "tool":
    case "sheet":
      state.queue.push(e);
      break;
    case "turn":
      $("turn").textContent = e.turn;
      break;
    case "page":
      // Slides: the operator turned the page; the pad now shows it.
      placeTaskPads(e.taskPad, null);
      break;
    case "agent": {
      const text = [e.text, e.reasoning ? `(thinking) ${e.reasoning}` : null].filter(Boolean).join("\n\n");
      $("agentText").textContent = e.error ? `Request #${e.request} failed: ${e.error}` : text || "(no text, tool calls only)";
      const counts = {};
      for (const c of e.calls ?? []) counts[c] = (counts[c] ?? 0) + 1;
      $("calls").textContent = e.error ? "no reply" : Object.entries(counts).map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(", ") || "no tool calls";
      if (e.total_cost_usd != null) $("cost").textContent = `$${e.total_cost_usd.toFixed(3)}`;
      if (e.request != null) addExchange(e);
      break;
    }
    case "obs":
      $("views").hidden = false;
      for (const img of e.images) {
        const el = $({ overview: "ovImg", detail: "dtImg" }[img.name]);
        if (el) el.src = img.png ? `data:image/png;base64,${img.png}` : img.url;
      }
      break;
    case "status":
      $("status").textContent = e.text;
      $("statusError").hidden = !e.error;
      $("statusError").textContent = e.error ?? "";
      break;
  }
}

// ---- model I/O drawer -----------------------------------------------------------
// Each agent turn names the request it came from; the files live in the run directory under llm/.

const io = { list: [], cache: new Map(), current: null, tab: "input", mode: "readable" };

function resetIo() {
  io.list = [];
  io.cache.clear();
  io.current = null;
  $("ioSelect").replaceChildren();
  $("ioOpen").hidden = true;
}

function addExchange(e) {
  if (io.list.some((x) => x.request === e.request)) return;
  io.list.push({ request: e.request, turn: e.turn, calls: (e.calls ?? []).length });
  const n = (e.calls ?? []).length;
  const label = `Request #${e.request} · turn ${e.turn} · ${e.error ? "failed" : `${n} call${n === 1 ? "" : "s"}`}`;
  $("ioSelect").append(el("option", { value: e.request }, label));
  $("ioOpen").hidden = false;
  if (io.current === null || $("ioFollow").checked) showRequest(e.request);
}

function showRequest(n) {
  io.current = n;
  $("ioSelect").value = String(n);
  if (!$("io").hidden) renderIo();
}

async function loadIo(kind, n) {
  const key = `${kind}-${n}`;
  if (!io.cache.has(key)) {
    const url = `/run/llm/${kind}-${String(n).padStart(4, "0")}.json`;
    io.cache.set(
      key,
      fetch(url).then((r) => (r.ok ? r.json() : { error: `Not recorded for this run (${url} returned ${r.status}).` })),
    );
  }
  return io.cache.get(key);
}

async function renderIo() {
  const body = $("ioBody");
  const n = io.current;
  if (n === null) return body.replaceChildren(el("p", { class: "note" }, "No model requests yet."));
  const data = await loadIo(io.tab === "input" ? "request" : "response", n);
  if (n !== io.current) return; // a newer selection won the race
  io.shown = data;
  if (io.mode === "raw") {
    // Both backends (OpenRouter, Gemini API) are logged in the same chat shape; each client translates to its own API.
    const note = io.tab === "input"
      ? "The request as the agent built it, in the common chat shape the model client translates for its backend. Base64 image data is shown as saved:<file>, the same PNG saved in the run folder."
      : "The reply in the common chat shape, as the model client returned it. reasoning_details holds what is sent back on later turns, unchanged.";
    body.replaceChildren(el("p", { class: "note" }, note), el("pre", {}, JSON.stringify(data, null, 2)));
  } else {
    body.replaceChildren(...(io.tab === "input" ? inputView(data) : outputView(data)));
  }
}

function inputView(req) {
  if (req.error) return [el("pre", {}, req.error)];
  const { messages = [], tools = [], ...params } = req;
  const out = [kv(Object.entries(params).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]))];
  out.push(
    details(`Tools (${tools.length})`, tools.map((t) => t.function?.name).join(", "), false, [el("pre", {}, JSON.stringify(tools, null, 2))]),
  );
  out.push(el("p", { class: "note" }, `${messages.length} messages. The last one is the observation the model is answering.`));
  messages.forEach((m, i) => out.push(messageBlock(m, i, i === messages.length - 1)));
  return out;
}

function messageBlock(m, i, open) {
  const parts = [];
  let preview = "";
  if (typeof m.content === "string") {
    parts.push(el("pre", {}, m.role === "tool" ? prettyJson(m.content) : m.content));
    preview = m.content;
  } else if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p.type === "text") {
        parts.push(el("pre", {}, p.text));
        preview ||= p.text;
      } else if (p.type === "image_url") {
        const url = p.image_url?.url ?? "";
        const src = url.startsWith("saved:") ? `/run/${url.slice(6)}` : url;
        parts.push(el("figure", {}, el("img", { src, alt: "Image sent to the model", loading: "lazy" }), el("figcaption", {}, url.startsWith("saved:") ? url.slice(6) : "inline image")));
      }
    }
  }
  for (const tc of m.tool_calls ?? []) {
    parts.push(callBlock(tc));
    preview ||= `${tc.function?.name}(…)`;
  }
  if (m.tool_calls?.length) preview = m.tool_calls.map((tc) => tc.function?.name).join(", ");
  if (m.reasoning_details?.length) {
    parts.push(details(`reasoning_details (${m.reasoning_details.length})`, "", false, [el("pre", {}, JSON.stringify(m.reasoning_details, null, 2))]));
  }
  const title = `#${i} ${m.role}${m.tool_call_id ? ` · ${m.tool_call_id}` : ""}`;
  return details(title, preview.replace(/\s+/g, " ").slice(0, 110), open, parts);
}

function outputView(res) {
  const tries = res.attempts ?? [];
  if (res.error) return [el("pre", {}, `Request failed: ${res.error}`), ...attemptsView(tries)];
  const choice = res.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const u = res.usage ?? {};
  const out = [
    kv([
      ["model", res.model],
      ["provider", res.provider ?? "–"],
      ["finish_reason", choice.finish_reason ?? "–"],
      ["prompt_tokens", u.prompt_tokens],
      ["completion_tokens", u.completion_tokens],
      ["reasoning_tokens", u.completion_tokens_details?.reasoning_tokens ?? "–"],
      ["cost", u.cost != null ? `$${u.cost.toFixed(4)}` : "–"],
    ]),
  ];
  out.push(el("p", { class: "note" }, "Message text"), el("pre", {}, msg.content || "(empty)"));
  if (msg.reasoning) out.push(details("Reasoning", "", false, [el("pre", {}, msg.reasoning)]));
  const calls = msg.tool_calls ?? [];
  out.push(el("p", { class: "note" }, `${calls.length} tool call${calls.length === 1 ? "" : "s"}`));
  calls.forEach((tc) => out.push(callBlock(tc)));
  if (msg.reasoning_details?.length) {
    out.push(details(`reasoning_details (${msg.reasoning_details.length})`, "", false, [el("pre", {}, JSON.stringify(msg.reasoning_details, null, 2))]));
  }
  if (tries.length > 1) out.push(...attemptsView(tries));
  return out;
}

/** Every try at a request; a failed one also shows whatever the model had streamed before it ended. */
function attemptsView(tries) {
  if (!tries.length) return [];
  const secs = (v) => (v == null ? "–" : `${v.toFixed(1)} s`);
  return [
    el("p", { class: "note" }, `${tries.length} attempt${tries.length === 1 ? "" : "s"}`),
    ...tries.map((a) => {
      const r = a.received ?? {};
      const kids = [
        kv([
          ["provider", a.provider ?? "–"],
          ["http status", a.status ?? "no response"],
          ["first byte", secs(a.first_byte_s)],
          ["first output", secs(a.first_output_s)],
          ["duration", secs(a.duration_s)],
          ["finish_reason", a.finish_reason ?? "–"],
          ["native_finish_reason", a.native_finish_reason ?? "–"],
          ["received", `${r.reasoning_chars ?? 0} reasoning, ${r.content_chars ?? 0} text, ${r.tool_call_chars ?? 0} tool-call chars`],
        ]),
      ];
      if (a.error) kids.push(el("pre", {}, a.error));
      const p = a.partial;
      if (p?.reasoning) kids.push(details("Partial reasoning", "", false, [el("pre", {}, p.reasoning)]));
      if (p?.content) kids.push(details("Partial text", "", false, [el("pre", {}, p.content)]));
      for (const tc of p?.tool_calls ?? []) kids.push(callBlock(tc));
      const title = `Attempt ${a.attempt} · ${a.ok ? "ok" : "failed"} · ${secs(a.duration_s)}`;
      return details(title, a.provider ?? "", !a.ok, kids);
    }),
  ];
}

/** A tool call with its JSON-string arguments decoded; program code is shown as code. */
function callBlock(tc) {
  const name = tc.function?.name ?? "?";
  const raw = tc.function?.arguments ?? "";
  let args;
  try {
    args = raw ? JSON.parse(raw) : {};
  } catch {
    return el("div", { class: "call" }, el("b", {}, `${name} (arguments are not valid JSON)`), el("pre", {}, raw));
  }
  const { code, ...rest } = args;
  const kids = [el("b", {}, `${name}${tc.id ? `  · ${tc.id}` : ""}`)];
  if (Object.keys(rest).length) kids.push(el("pre", {}, JSON.stringify(rest, null, 2)));
  if (typeof code === "string") kids.push(el("pre", {}, code));
  return el("div", { class: "call" }, ...kids);
}

function details(title, preview, open, children) {
  const d = el("details", open ? { open: "" } : {}, el("summary", {}, title, el("span", { class: "preview" }, preview)), el("div", { class: "inner" }, ...children));
  return d;
}

function kv(rows) {
  return el("div", { class: "kv" }, ...rows.flatMap(([k, v]) => [el("span", {}, k), el("span", {}, String(v ?? "–"))]));
}

function prettyJson(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** Build DOM with text nodes only, so model output is never parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function openIo() {
  $("io").hidden = false;
  renderIo();
}
function closeIo() {
  $("io").hidden = true;
}
function stepRequest(delta) {
  const i = io.list.findIndex((x) => x.request === io.current);
  const next = io.list[i + delta];
  if (!next) return;
  $("ioFollow").checked = false;
  showRequest(next.request);
}

$("ioOpen").addEventListener("click", openIo);
$("ioClose").addEventListener("click", closeIo);
$("io").addEventListener("click", (ev) => {
  if (ev.target === $("io")) closeIo();
});
document.addEventListener("keydown", (ev) => {
  if ($("io").hidden) return;
  if (ev.key === "Escape") closeIo();
  if (ev.key === "ArrowLeft" && ev.target.tagName !== "SELECT") stepRequest(-1);
  if (ev.key === "ArrowRight" && ev.target.tagName !== "SELECT") stepRequest(1);
});
$("ioPrev").addEventListener("click", () => stepRequest(-1));
$("ioNext").addEventListener("click", () => stepRequest(1));
$("ioSelect").addEventListener("change", (ev) => {
  $("ioFollow").checked = false;
  showRequest(Number(ev.target.value));
});
$("ioFollow").addEventListener("change", (ev) => {
  if (ev.target.checked && io.list.length) showRequest(io.list[io.list.length - 1].request);
});
for (const [group, key] of [["ioTabs", "tab"], ["ioModes", "mode"]]) {
  $(group).addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    io[key] = b.dataset[key];
    for (const x of $(group).querySelectorAll("button")) x.classList.toggle("on", x === b);
    renderIo();
  });
}
$("ioCopy").addEventListener("click", async () => {
  if (!io.shown) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(io.shown, null, 2));
    $("ioCopy").textContent = "Copied";
  } catch {
    $("ioCopy").textContent = "Copy failed";
  }
  setTimeout(() => ($("ioCopy").textContent = "Copy JSON"), 1200);
});

// ---- wiring -------------------------------------------------------------------

$("speed").addEventListener("input", (ev) => {
  speed = Number(ev.target.value);
  $("speedLabel").textContent = `${speed}×`;
});
$("skip").addEventListener("click", catchUp);

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (msg) => {
    for (const e of JSON.parse(msg.data)) onEvent(e);
  };
  ws.onclose = () => {
    $("status").textContent = "disconnected, retrying…";
    setTimeout(connect, 1500);
  };
}
connect();

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (built) {
    if (autoCatchUp && state.queue.length > 4000) catchUp();
    else play(dt * speed);
    placePen();
    if (textureDirty && now - lastComposite > 50) {
      composite();
      lastComposite = now;
    }
    $("simtime").textContent = `${Math.round(state.simTime)} s`;
    $("sheet").textContent = state.sheet + 1;
    $("backlog").textContent = state.queue.length ? `${state.queue.length} queued` : "";
  }
  controls.update();
  renderer.render(scene, camera);
});
