import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import * as BUI from "@thatopen/ui";
import {
  Cable,
  cableRegistry,
  nextCableId,
  getNextColor,
  CABLE_TYPES,
  VOLTAGE_OPTIONS,
} from "./cables";

// ─────────────────────────────────────────────────────────────────────────────
// Panel state
// ─────────────────────────────────────────────────────────────────────────────

export interface CablesPanelState {
  components: OBC.Components;
  world: OBC.World;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PickedElement {
  modelId: string;
  expressId: number;
  point: THREE.Vector3;
  label: string;
  category: string;
}

interface TrasseEntry {
  modelId: string;
  expressId: number;
  point: THREE.Vector3;
  label: string;
  length: number; // metres, estimated from bounding box
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singletons
// ─────────────────────────────────────────────────────────────────────────────

let _initialized = false;
let _panelUpdate: (() => void) | null = null;

// Routing state
let _active = false;
let _cable: Cable | null = null;
let _sourceData: PickedElement | null = null;
let _targetData: PickedElement | null = null;
let _trassEntries: TrasseEntry[] = [];
let _dragSrcIdx: number | null = null;

// Shared refs
let _components: OBC.Components | null = null;
let _world: OBC.World | null = null;
let _mouseX = 0;
let _mouseY = 0;
let _lastRayPoint: THREE.Vector3 | null = null;

// DOM singletons
let _routingPanel: HTMLDivElement | null = null;
let _tooltip: HTMLDivElement | null = null;
let _modal: HTMLDialogElement | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// IFC helpers
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_TYPES = new Set([
  "IfcElectricDistributionBoard",
  "IfcTransformer",
]);

const isSource = (cat: string | null) =>
  cat === null ? true : SOURCE_TYPES.has(cat);

const isTrasse = (cat: string | null) => cat === "IfcCableTray";

async function getCategory(
  fragments: OBC.FragmentsManager,
  modelId: string,
  expressId: number
): Promise<string | null> {
  const model = fragments.list.get(modelId);
  if (!model) return null;
  try {
    return await model.getItem(expressId).getCategory();
  } catch {
    return null;
  }
}

async function getElementLabel(
  fragments: OBC.FragmentsManager,
  modelId: string,
  expressId: number
): Promise<string> {
  const model = fragments.list.get(modelId);
  if (!model) return `#${expressId}`;
  try {
    const attrs = await model.getItem(expressId).getAttributes();
    const name = attrs?.get("Name")?.value;
    return typeof name === "string" && name.trim() ? name.trim() : `#${expressId}`;
  } catch {
    return `#${expressId}`;
  }
}

async function getElementLength(
  components: OBC.Components,
  modelId: string,
  expressId: number
): Promise<number> {
  try {
    const boxer = components.get(OBC.BoundingBoxer);
    boxer.list.clear();
    await boxer.addFromModelIdMap({ [modelId]: new Set([expressId]) });
    const box = boxer.get();
    const size = new THREE.Vector3();
    box.getSize(size);
    boxer.list.clear();
    return Math.round(Math.max(size.x, size.y, size.z) * 10) / 10;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing panel helpers
// ─────────────────────────────────────────────────────────────────────────────

function activeSection(): "source" | "trasse" | "target" | "none" {
  if (!_sourceData) return "source";
  if (_trassEntries.length === 0) return "trasse";
  if (!_targetData) return "target";
  return "none";
}

function canConfirm(): boolean {
  return _sourceData !== null && _trassEntries.length > 0 && _targetData !== null;
}

function totalTrasseLength(): number {
  return Math.round(_trassEntries.reduce((s, e) => s + e.length, 0) * 10) / 10;
}

function totalLineLength(): number {
  const pts: THREE.Vector3[] = [];
  if (_sourceData) pts.push(_sourceData.point);
  for (const e of _trassEntries) pts.push(e.point);
  if (_targetData) pts.push(_targetData.point);
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += pts[i].distanceTo(pts[i - 1]);
  return Math.round(d * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing panel DOM
// ─────────────────────────────────────────────────────────────────────────────

function buildSourcePlaceholder(): string {
  return `<div class="rp-placeholder">Im Viewer Schaltschrank oder Trafo anklicken</div>`;
}

function buildTrasseRows(): string {
  if (_trassEntries.length === 0) {
    return `
      <div class="rp-placeholder">IfcCableTray Elemente anklicken</div>
      <div class="rp-placeholder-sub">Mehrfachauswahl möglich</div>`;
  }
  const total = totalTrasseLength();
  const rows = _trassEntries.map((e, i) => `
    <div class="rp-trasse-row" draggable="true" data-idx="${i}">
      <span class="rp-drag-handle" title="Ziehen zum Sortieren">⠿</span>
      <span class="rp-td-name">${esc(e.label)}</span>
      <span class="rp-td-len">${e.length > 0 ? e.length + "m" : "—"}</span>
      <button class="rp-x" data-action="remove-trasse" data-idx="${i}">✕</button>
    </div>`).join("");
  return `
    <div class="rp-trasse-list" id="rp-trasse-list">${rows}</div>
    <div class="rp-trasse-total">
      <span>TOTAL</span>
      <span>${total > 0 ? total + "m" : "—"}</span>
    </div>`;
}

function buildSummary(): string {
  const src = _sourceData?.label ?? "—";
  const tgt = _targetData?.label ?? "—";
  const tCount = _trassEntries.length;
  const len = totalLineLength();
  const check = (ok: boolean) => ok ? `<span class="rp-ok">✓</span>` : "";
  return `
    <div class="rp-summary">
      <div class="rp-summary-title">ZUSAMMENFASSUNG</div>
      <div class="rp-summary-row">
        <span>Quelle:</span><span>${esc(src)} ${check(!!_sourceData)}</span>
      </div>
      <div class="rp-summary-row">
        <span>Trassen:</span><span>${tCount > 0 ? tCount + " gewählt" : "—"} ${check(tCount > 0)}</span>
      </div>
      <div class="rp-summary-row">
        <span>Ziel:</span><span>${esc(tgt)} ${check(!!_targetData)}</span>
      </div>
      <div class="rp-summary-row rp-summary-len">
        <span>Länge:</span><span>${len > 0 ? len + " m" : "—"}</span>
      </div>
    </div>`;
}

function renderRoutingPanel() {
  if (!_routingPanel) {
    _routingPanel = document.createElement("div");
    _routingPanel.id = "rp-panel";
    _routingPanel.className = "rp-panel";
    document.body.appendChild(_routingPanel);
  }

  if (!_active || !_cable) {
    _routingPanel.classList.remove("rp-panel--open");
    return;
  }

  const act = activeSection();
  const shortType = CABLE_TYPES.find((t) => t.value === _cable!.type)
    ?.label.split("—")[0].trim() ?? _cable.type;
  const ok = canConfirm();

  _routingPanel.innerHTML = `
    <div class="rp-header">
      <div class="rp-header-title">KABELWEG DEFINIEREN</div>
      <div class="rp-header-sub">${esc(_cable.id)} · ${esc(shortType)} · ${esc(_cable.voltage)}</div>
    </div>

    <div class="rp-body">
      <div class="rp-section${act === "source" ? " rp-section--active" : ""}">
        <div class="rp-section-title">
          <span class="rp-dot${_sourceData ? " rp-dot--ok" : ""}">●</span>
          ① QUELLE
        </div>
        ${_sourceData ? buildPickedRow(_sourceData, "remove-source") : buildSourcePlaceholder()}
      </div>

      <div class="rp-section${act === "trasse" ? " rp-section--active" : ""}">
        <div class="rp-section-title">
          <span class="rp-dot${_trassEntries.length > 0 ? " rp-dot--ok" : ""}">●</span>
          ② KABELTRASSEN
          ${_trassEntries.length > 0
            ? `<span class="rp-count">(${_trassEntries.length} gewählt)</span>` : ""}
        </div>
        ${buildTrasseRows()}
      </div>

      <div class="rp-section${act === "target" ? " rp-section--active" : ""}">
        <div class="rp-section-title">
          <span class="rp-dot${_targetData ? " rp-dot--ok" : ""}">●</span>
          ③ ZIEL
        </div>
        ${_targetData ? buildPickedRow(_targetData, "remove-target") : buildSourcePlaceholder()}
      </div>

      ${buildSummary()}
    </div>

    <div class="rp-actions">
      <button id="rp-create" class="rp-btn-primary${ok ? "" : " rp-btn--disabled"}"
        ${ok ? "" : 'disabled title="Bitte alle 3 Felder ausfüllen"'}>
        ✓ Kabel erstellen
      </button>
      <button id="rp-cancel" class="rp-btn-cancel">✕ Abbrechen</button>
    </div>
  `;

  _routingPanel.classList.add("rp-panel--open");

  // Attach button listeners
  document.getElementById("rp-cancel")?.addEventListener("click", () => cancelRouting());
  document.getElementById("rp-create")?.addEventListener("click", () => { if (ok) confirmRouting(); });

  // Attach ✕ buttons
  _routingPanel.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action!;
      if (action === "remove-source") removeSource();
      if (action === "remove-target") removeTarget();
      if (action === "remove-trasse") removeTrasse(Number(btn.dataset.idx));
    });
  });

  setupDragDrop();
}

function buildPickedRow(data: PickedElement, removeAction: string): string {
  const cat = data.category.replace("Ifc", "Ifc​");
  return `
    <table class="rp-table">
      <thead><tr><th>Name</th><th>IFC-Typ</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td class="rp-td-name">${esc(data.label)}</td>
          <td class="rp-td-cat" title="${esc(data.category)}">${esc(cat)}</td>
          <td><button class="rp-x" data-action="${removeAction}">✕</button></td>
        </tr>
      </tbody>
    </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag & Drop for trasse reordering
// ─────────────────────────────────────────────────────────────────────────────

function setupDragDrop() {
  const rows = document.querySelectorAll<HTMLElement>(".rp-trasse-row");
  rows.forEach((row) => {
    row.addEventListener("dragstart", () => {
      _dragSrcIdx = Number(row.dataset.idx);
      row.classList.add("rp-dragging");
    });
    row.addEventListener("dragend", () => {
      _dragSrcIdx = null;
      row.classList.remove("rp-dragging");
      document.querySelectorAll(".rp-drag-over").forEach((el) => el.classList.remove("rp-drag-over"));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      document.querySelectorAll(".rp-drag-over").forEach((el) => el.classList.remove("rp-drag-over"));
      row.classList.add("rp-drag-over");
    });
    row.addEventListener("drop", () => {
      const destIdx = Number(row.dataset.idx);
      if (_dragSrcIdx !== null && _dragSrcIdx !== destIdx) {
        const moved = _trassEntries.splice(_dragSrcIdx, 1)[0];
        _trassEntries.splice(destIdx, 0, moved);
        renderRoutingPanel();
        // Re-sync orange highlight to match new order
        syncTrasseHighlight();
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove actions
// ─────────────────────────────────────────────────────────────────────────────

async function removeSource() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  await hl.clear("cable-source");
  _sourceData = null;
  renderRoutingPanel();
  _panelUpdate?.();
}

async function removeTarget() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  await hl.clear("cable-target");
  _targetData = null;
  renderRoutingPanel();
  _panelUpdate?.();
}

async function removeTrasse(idx: number) {
  if (!_components) return;
  _trassEntries.splice(idx, 1);
  await syncTrasseHighlight();
  renderRoutingPanel();
  _panelUpdate?.();
}

async function syncTrasseHighlight() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  if (_trassEntries.length === 0) {
    await hl.clear("cable-trasse");
    return;
  }
  const map: OBC.ModelIdMap = {};
  for (const e of _trassEntries) {
    if (!map[e.modelId]) map[e.modelId] = new Set();
    map[e.modelId].add(e.expressId);
  }
  await hl.highlightByID("cable-trasse", map, false, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover tooltip
// ─────────────────────────────────────────────────────────────────────────────

function showTooltip(text: string) {
  if (!_tooltip) {
    _tooltip = document.createElement("div");
    _tooltip.className = "rp-tooltip";
    document.body.appendChild(_tooltip);
  }
  _tooltip.textContent = text;
  _tooltip.style.left = `${_mouseX + 16}px`;
  _tooltip.style.top = `${_mouseY}px`;
  _tooltip.style.display = "block";
}

function hideTooltip() {
  if (_tooltip) _tooltip.style.display = "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// Error toast
// ─────────────────────────────────────────────────────────────────────────────

function showError(msg: string) {
  const t = document.createElement("div");
  t.className = "rp-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel / Confirm
// ─────────────────────────────────────────────────────────────────────────────

async function cancelRouting() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  _active = false;
  if (_cable) {
    const idx = cableRegistry.indexOf(_cable);
    if (idx !== -1) cableRegistry.splice(idx, 1);
    _cable = null;
  }
  _sourceData = null;
  _targetData = null;
  _trassEntries = [];
  await hl.clear("cable-source");
  await hl.clear("cable-trasse");
  await hl.clear("cable-target");
  renderRoutingPanel();
  hideTooltip();
  _panelUpdate?.();
}

function confirmRouting() {
  if (!_cable || !_sourceData || !_targetData || !_world) return;

  // Write routing data into cable object
  _cable.sourceModelId = _sourceData.modelId;
  _cable.sourceExpressId = _sourceData.expressId;
  _cable.sourceLabel = _sourceData.label;
  _cable.targetModelId = _targetData.modelId;
  _cable.targetExpressId = _targetData.expressId;
  _cable.targetLabel = _targetData.label;
  _cable.trassIds = _trassEntries.map((e) => ({ modelId: e.modelId, expressId: e.expressId }));
  _cable.status = "geplant";

  // Build 3D line points
  const pts: THREE.Vector3[] = [_sourceData.point, ..._trassEntries.map((e) => e.point), _targetData.point];
  _cable.length = totalLineLength();
  drawCableLine(_world, _cable, pts);

  // Clean up routing state (highlights stay as cable color)
  _active = false;
  _cable = null;
  _sourceData = null;
  _targetData = null;
  _trassEntries = [];

  if (_components) {
    const hl = _components.get(OBF.Highlighter);
    hl.clear("cable-source");
    hl.clear("cable-trasse");
    hl.clear("cable-target");
  }

  renderRoutingPanel();
  hideTooltip();
  _panelUpdate?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Three.js line
// ─────────────────────────────────────────────────────────────────────────────

function drawCableLine(world: OBC.World, cable: Cable, pts: THREE.Vector3[]) {
  if (pts.length < 2) return;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: new THREE.Color(cable.color), depthTest: false })
  );
  line.renderOrder = 999;
  line.name = `cable-line-${cable.id}`;
  world.scene.three.add(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time routing setup
// ─────────────────────────────────────────────────────────────────────────────

function setupRouting(state: CablesPanelState) {
  const { components, world } = state;
  _components = components;
  _world = world;

  const highlighter = components.get(OBF.Highlighter);
  const fragments = components.get(OBC.FragmentsManager);
  const raycaster = components.get(OBC.Raycasters).get(world);

  // Register highlight styles (also creates highlighter.events[name])
  highlighter.styles.set("cable-source", {
    color: new THREE.Color("#ff4455"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1, transparent: false,
  });
  highlighter.styles.set("cable-trasse", {
    color: new THREE.Color("#ffaa00"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1, transparent: false,
  });
  highlighter.styles.set("cable-target", {
    color: new THREE.Color("#00e67a"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1, transparent: false,
  });
  // null style = no visual effect but creates the events entry
  highlighter.styles.set("cable-hover", null);

  // Track mouse
  document.addEventListener("pointermove", (e) => {
    _mouseX = e.clientX;
    _mouseY = e.clientY;
  });

  // Capture ray point on click (capture phase = before highlighter bubble)
  const canvas = world.renderer?.three.domElement;
  if (canvas) {
    canvas.addEventListener("click", async () => {
      if (!_active) return;
      const hit = await raycaster.castRay();
      _lastRayPoint = hit?.point?.clone() ?? null;
    }, true);
  }

  // ── Hover tooltip ──────────────────────────────────────────────────────────
  let _hoverTimer: ReturnType<typeof setTimeout> | null = null;
  if (canvas) {
    canvas.addEventListener("pointermove", () => {
      if (!_active) { hideTooltip(); return; }
      if (_hoverTimer) clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(async () => {
        if (!_active) return;
        try { await highlighter.highlight("cable-hover", true, false); } catch { hideTooltip(); }
      }, 60);
    });
    canvas.addEventListener("mouseleave", () => hideTooltip());
  }

  highlighter.events["cable-hover"].onHighlight.add(async (modelIdMap) => {
    if (!_active) return;
    const entry = Object.entries(modelIdMap)[0];
    if (!entry) return;
    const [modelId, expressIds] = entry;
    const expressId = [...expressIds][0];
    if (expressId == null) return;

    const cat = await getCategory(fragments, modelId, expressId);
    await highlighter.clear("cable-hover");

    if (isSource(cat)) {
      if (!_sourceData) {
        showTooltip("Als Quelle wählen");
      } else if (_sourceData.expressId === expressId) {
        showTooltip("Quelle bereits gewählt");
      } else {
        showTooltip("Als Ziel wählen");
      }
    } else if (isTrasse(cat)) {
      const already = _trassEntries.some((e) => e.expressId === expressId);
      showTooltip(already ? "Entfernen" : "Zur Route hinzufügen");
    } else {
      showTooltip("Dieses Element kann nicht gewählt werden");
    }
  });

  highlighter.events["cable-hover"].onClear.add(() => hideTooltip());

  // ── Select / click handler ─────────────────────────────────────────────────
  highlighter.events.select.onHighlight.add(async (modelIdMap) => {
    if (!_active || !_cable) return;

    const entry = Object.entries(modelIdMap)[0];
    if (!entry) return;
    const [modelId, expressIds] = entry;
    const expressId = [...expressIds][0];
    if (expressId == null) return;

    const cat = await getCategory(fragments, modelId, expressId);
    const pt = _lastRayPoint?.clone() ?? new THREE.Vector3();
    await highlighter.clear("select");

    if (isSource(cat)) {
      if (!_sourceData) {
        // Set as source
        const label = await getElementLabel(fragments, modelId, expressId);
        _sourceData = { modelId, expressId, point: pt, label, category: cat ?? "IfcUnknown" };
        await highlighter.highlightByID("cable-source", { [modelId]: new Set([expressId]) }, false, false);
      } else if (_sourceData.expressId === expressId) {
        // Clicked again → deselect source
        await removeSource();
        return;
      } else if (!_targetData) {
        // Source set, no target yet → set as target
        if (_sourceData.expressId === expressId) {
          showError("Quelle und Ziel müssen verschieden sein");
          return;
        }
        const label = await getElementLabel(fragments, modelId, expressId);
        _targetData = { modelId, expressId, point: pt, label, category: cat ?? "IfcUnknown" };
        await highlighter.highlightByID("cable-target", { [modelId]: new Set([expressId]) }, false, false);
      } else if (_targetData.expressId === expressId) {
        // Clicked again → deselect target
        await removeTarget();
        return;
      } else {
        // Replace target
        const label = await getElementLabel(fragments, modelId, expressId);
        await highlighter.clear("cable-target");
        _targetData = { modelId, expressId, point: pt, label, category: cat ?? "IfcUnknown" };
        await highlighter.highlightByID("cable-target", { [modelId]: new Set([expressId]) }, false, false);
      }
    } else if (isTrasse(cat)) {
      const idx = _trassEntries.findIndex((e) => e.expressId === expressId);
      if (idx !== -1) {
        // Toggle off
        _trassEntries.splice(idx, 1);
      } else {
        // Add - start with placeholder length, load async
        const label = await getElementLabel(fragments, modelId, expressId);
        _trassEntries.push({ modelId, expressId, point: pt, label, length: 0 });
        // Load length asynchronously and re-render
        getElementLength(components, modelId, expressId).then((len) => {
          const entry = _trassEntries.find((e) => e.expressId === expressId);
          if (entry) { entry.length = len; renderRoutingPanel(); }
        });
      }
      await syncTrasseHighlight();
    } else {
      showError("Dieses Element kann nicht gewählt werden");
      return;
    }

    renderRoutingPanel();
    _panelUpdate?.();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────────────────

function ensureModal() {
  if (_modal) return _modal;
  _modal = document.createElement("dialog");
  _modal.innerHTML =
    `<div class="cm-modal">` +
    `<h3 class="cm-modal-title">Neues Kabel anlegen</h3>` +
    `<div class="cm-field"><label>Bezeichnung</label>` +
    `<input id="cm-name" type="text" placeholder="z.B. Einspeisung UV EG-01"></div>` +
    `<div class="cm-field"><label>Kabeltyp</label>` +
    `<select id="cm-type">${CABLE_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join("")}</select></div>` +
    `<div class="cm-field"><label>Funktion / Stromkreis</label>` +
    `<input id="cm-circuit" type="text" placeholder="z.B. Haupteinspeisung"></div>` +
    `<div class="cm-field"><label>Spannung</label>` +
    `<select id="cm-voltage">${VOLTAGE_OPTIONS.map((v) => `<option value="${v}">${v}</option>`).join("")}</select></div>` +
    `<div class="cm-modal-buttons">` +
    `<button id="cm-confirm" class="cm-btn-primary">Anlegen &amp; Routing starten</button>` +
    `<button id="cm-cancel" class="cm-btn-secondary">Abbrechen</button>` +
    `</div></div>`;
  document.body.appendChild(_modal);
  return _modal;
}

function openModal(
  onConfirm: (d: { name: string; type: string; typeLabel: string; circuit: string; voltage: string }) => void
) {
  const modal = ensureModal();
  const nameEl = document.getElementById("cm-name") as HTMLInputElement;
  const typeEl = document.getElementById("cm-type") as HTMLSelectElement;
  const circuitEl = document.getElementById("cm-circuit") as HTMLInputElement;
  const voltageEl = document.getElementById("cm-voltage") as HTMLSelectElement;
  nameEl.value = ""; circuitEl.value = "";
  modal.showModal();

  const cancelBtn = document.getElementById("cm-cancel")!;
  const confirmBtn = document.getElementById("cm-confirm")!;
  const cleanup = () => {
    cancelBtn.removeEventListener("click", onCancelClick);
    confirmBtn.removeEventListener("click", onConfirmClick);
  };
  function onCancelClick() { modal.close(); cleanup(); }
  function onConfirmClick() {
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    const chosen = CABLE_TYPES.find((t) => t.value === typeEl.value)!;
    modal.close(); cleanup();
    onConfirm({ name, type: typeEl.value, typeLabel: chosen.label, circuit: circuitEl.value.trim(), voltage: voltageEl.value });
  }
  cancelBtn.addEventListener("click", onCancelClick);
  confirmBtn.addEventListener("click", onConfirmClick);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cable list entry
// ─────────────────────────────────────────────────────────────────────────────

function renderCableEntry(cable: Cable) {
  const statusColor = cable.status === "geplant" ? "#00e67a" : cable.status === "in Bearbeitung" ? "#ff8c00" : "#888";
  const typeLabel = CABLE_TYPES.find((t) => t.value === cable.type)?.label ?? cable.type;
  return BUI.html`
    <div class="cm-cable-entry" style="border-left:3px solid ${cable.color};">
      <div class="cm-cable-header">
        <span class="cm-cable-id">${cable.id}</span>
        <span class="cm-cable-status" style="color:${statusColor};">[${cable.status}]</span>
      </div>
      <div class="cm-cable-name">${cable.name}</div>
      <div class="cm-cable-info">${typeLabel}${cable.length > 0 ? ` · ${cable.length}m` : ""}</div>
      ${cable.sourceLabel && cable.targetLabel
        ? BUI.html`<div class="cm-cable-route">${cable.sourceLabel} → ${cable.targetLabel}</div>`
        : ""}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported panel template
// ─────────────────────────────────────────────────────────────────────────────

export const cablesPanelTemplate: BUI.StatefullComponent<CablesPanelState> = (
  state,
  update
) => {
  if (!_initialized) {
    _initialized = true;
    try {
      setupRouting(state);
    } catch (err) {
      console.error("[CablePanel] setupRouting failed:", err);
    }
  }
  _panelUpdate = update;

  const onNewCable = () => {
    openModal(({ name, type, typeLabel, circuit, voltage }) => {
      const cable: Cable = {
        id: nextCableId(),
        name, type, typeLabel, circuit, voltage,
        sourceModelId: "", sourceExpressId: -1, sourceLabel: "",
        targetModelId: "", targetExpressId: -1, targetLabel: "",
        trassIds: [],
        status: "in Bearbeitung",
        color: getNextColor(),
        length: 0,
      };
      cableRegistry.push(cable);
      _active = true;
      _cable = cable;
      _sourceData = null;
      _targetData = null;
      _trassEntries = [];
      renderRoutingPanel();
      update();
    });
  };

  return BUI.html`
    <bim-panel-section fixed icon="material-symbols:cable" label="KABELREGISTER">
      <bim-button label="+ Neues Kabel" icon="mdi:plus" @click=${onNewCable}></bim-button>
      <div class="cm-cable-list">
        ${cableRegistry.length === 0
          ? BUI.html`<div class="cm-empty">Noch keine Kabel angelegt.</div>`
          : cableRegistry.map(renderCableEntry)}
      </div>
    </bim-panel-section>
  `;
};
