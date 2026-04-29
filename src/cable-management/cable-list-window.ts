import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import {
  Cable,
  cableRegistry,
  CABLE_TYPES,
  addCableChangeListener,
  notifyCableChange,
} from "./cables";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let _components: OBC.Components | null = null;
let _world: OBC.World | null = null;
let _win: HTMLDivElement | null = null;
let _isOpen = false;
let _selectedCableId: string | null = null;

// Drag state
let _dragging = false;
let _dragOffX = 0;
let _dragOffY = 0;

// Ghost-mode: saved material state
const _savedMaterials = new Map<
  FRAGS.BIMMaterial,
  { color: number; transparent: boolean; opacity: number }
>();

// ─────────────────────────────────────────────────────────────────────────────
// Ghost mode helpers
// ─────────────────────────────────────────────────────────────────────────────

function ghostModel() {
  if (!_components || _savedMaterials.size > 0) return;
  const frags = _components.get(OBC.FragmentsManager);
  for (const mat of frags.core.models.materials.list.values()) {
    if (mat.userData?.customId) continue;
    const color =
      "color" in mat
        ? (mat as any).color.getHex()
        : (mat as any).lodColor.getHex();
    _savedMaterials.set(mat, {
      color,
      transparent: mat.transparent,
      opacity: mat.opacity,
    });
    mat.transparent = true;
    mat.opacity = 0.3;
    mat.needsUpdate = true;
    if ("color" in mat) (mat as any).color.setColorName("white");
    else (mat as any).lodColor.setColorName("white");
  }
}

function unghost() {
  for (const [mat, saved] of _savedMaterials) {
    mat.transparent = saved.transparent;
    mat.opacity = saved.opacity;
    mat.needsUpdate = true;
    if ("color" in mat) (mat as any).color.setHex(saved.color);
    else (mat as any).lodColor.setHex(saved.color);
  }
  _savedMaterials.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlight helpers
// ─────────────────────────────────────────────────────────────────────────────

async function highlightCable(cable: Cable) {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);

  await hl.clear("cable-source");
  await hl.clear("cable-route");
  await hl.clear("cable-target");

  ghostModel();

  if (cable.sourceExpressId >= 0 && cable.sourceModelId) {
    await hl.highlightByID(
      "cable-source",
      { [cable.sourceModelId]: new Set([cable.sourceExpressId]) },
      false,
      false
    );
  }

  if (cable.trassIds.length > 0) {
    const map: OBC.ModelIdMap = {};
    for (const { modelId, expressId } of cable.trassIds) {
      if (!map[modelId]) map[modelId] = new Set();
      map[modelId].add(expressId);
    }
    await hl.highlightByID("cable-route", map, false, false);
  }

  if (cable.targetExpressId >= 0 && cable.targetModelId) {
    await hl.highlightByID(
      "cable-target",
      { [cable.targetModelId]: new Set([cable.targetExpressId]) },
      false,
      false
    );
  }
}

async function clearHighlights() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  await hl.clear("cable-source");
  await hl.clear("cable-route");
  await hl.clear("cable-target");
  unghost();
}

async function toggleHighlight(cable: Cable) {
  if (_selectedCableId === cable.id) {
    _selectedCableId = null;
    await clearHighlights();
  } else {
    if (_selectedCableId) await clearHighlights();
    _selectedCableId = cable.id;
    await highlightCable(cable);
  }
  renderTable();
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete cable
// ─────────────────────────────────────────────────────────────────────────────

function showDeleteConfirm(cable: Cable) {
  if (!_win) return;
  // Remove existing overlay if any
  _win.querySelector(".cw-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "cw-overlay";
  overlay.innerHTML =
    `<div class="cw-confirm">` +
    `<p>Kabel <strong style="color:${cable.color}">${cable.id}</strong> wirklich löschen?</p>` +
    `<div class="cw-confirm-btns">` +
    `<button id="cw-del-yes" class="cw-del-yes">Ja, löschen</button>` +
    `<button id="cw-del-no" class="cw-del-no">Abbrechen</button>` +
    `</div></div>`;
  _win.appendChild(overlay);

  overlay.querySelector("#cw-del-no")?.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#cw-del-yes")?.addEventListener("click", async () => {
    overlay.remove();
    await deleteCable(cable);
  });
}

async function deleteCable(cable: Cable) {
  const idx = cableRegistry.indexOf(cable);
  if (idx !== -1) cableRegistry.splice(idx, 1);

  // Remove Three.js line
  if (_world) {
    const line = _world.scene.three.getObjectByName(`cable-line-${cable.id}`);
    if (line) {
      _world.scene.three.remove(line);
      if ((line as THREE.Line).geometry) (line as THREE.Line).geometry.dispose();
    }
  }

  if (_selectedCableId === cable.id) {
    _selectedCableId = null;
    await clearHighlights();
  }

  notifyCableChange();
  renderTable();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    geplant:         "#3d8bff",
    verlegt:         "#00e67a",
    geprüft:         "#8aaad0",
    "in Bearbeitung":"#ffaa00",
  };
  const c = map[status] ?? "#888";
  return `<span class="cw-badge" style="color:${c};border-color:${c}40;background:${c}18">${esc(status)}</span>`;
}

function buildTableHTML(): string {
  if (cableRegistry.length === 0) {
    return `<div class="cw-empty-msg">Noch keine Kabel angelegt.<br>
      <span class="cw-empty-sub">Klicke "+ Neues Kabel" in der Toolbar um loszulegen.</span>
    </div>`;
  }

  const rows = cableRegistry
    .map((c) => {
      const sel = _selectedCableId === c.id;
      const typeShort =
        CABLE_TYPES.find((t) => t.value === c.type)
          ?.label.split("—")[0].trim() ?? c.type;
      return (
        `<tr class="cw-row${sel ? " cw-row--sel" : ""}" data-cid="${c.id}">` +
        `<td><span class="cw-id" style="color:${c.color}">${esc(c.id)}</span></td>` +
        `<td class="cw-td-name" title="${esc(c.name)}">${esc(c.name)}</td>` +
        `<td class="cw-td-ep" title="${esc(typeShort)}">${esc(typeShort)}</td>` +
        `<td class="cw-td-ep" title="${esc(c.sourceLabel || "—")}">${esc(c.sourceLabel || "—")}</td>` +
        `<td class="cw-td-ep" title="${esc(c.targetLabel || "—")}">${esc(c.targetLabel || "—")}</td>` +
        `<td class="cw-td-len">${c.length > 0 ? c.length + "m" : "—"}</td>` +
        `<td>${statusBadge(c.status)}</td>` +
        `<td class="cw-td-act">` +
        `<button class="cw-act-btn cw-act-view" data-cid="${c.id}" title="Im Modell anzeigen">👁</button>` +
        `<button class="cw-act-btn cw-act-del"  data-cid="${c.id}" title="Löschen">✕</button>` +
        `</td></tr>`
      );
    })
    .join("");

  return (
    `<table class="cw-table">` +
    `<thead><tr>` +
    `<th>Kabel-ID</th><th>Bezeichnung</th><th>Typ</th>` +
    `<th>Quelle</th><th>Ziel</th><th>Länge</th><th>Status</th><th>Aktionen</th>` +
    `</tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `</table>`
  );
}

function renderTable() {
  const body = _win?.querySelector<HTMLDivElement>(".cw-body");
  if (!body) return;
  body.innerHTML = buildTableHTML();
  attachTableListeners();
}

function attachTableListeners() {
  if (!_win) return;
  _win.querySelectorAll<HTMLElement>(".cw-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if ((e.target as Element).closest("[data-cid].cw-act-btn")) return;
      const cid = row.dataset.cid!;
      const cable = cableRegistry.find((c) => c.id === cid);
      if (cable) toggleHighlight(cable);
    });
  });

  _win.querySelectorAll<HTMLElement>(".cw-act-view").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cable = cableRegistry.find((c) => c.id === btn.dataset.cid);
      if (cable) toggleHighlight(cable);
    });
  });

  _win.querySelectorAll<HTMLElement>(".cw-act-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cable = cableRegistry.find((c) => c.id === btn.dataset.cid);
      if (cable) showDeleteConfirm(cable);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Full window render
// ─────────────────────────────────────────────────────────────────────────────

function renderWindowFull() {
  if (!_win) return;
  const count = cableRegistry.length;
  _win.innerHTML =
    `<div class="cw-header" id="cw-header">` +
    `<span class="cw-title">ERSTELLTE KABEL` +
    `${count > 0 ? `<span class="cw-count">${count}</span>` : ""}</span>` +
    `<button class="cw-close" id="cw-close-btn">✕ Schliessen</button>` +
    `</div>` +
    `<div class="cw-body">${buildTableHTML()}</div>`;

  document.getElementById("cw-close-btn")?.addEventListener("click", closeCableWindow);

  attachTableListeners();
  setupHeaderDrag(_win.querySelector("#cw-header")!);
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag
// ─────────────────────────────────────────────────────────────────────────────

function setupHeaderDrag(header: HTMLElement) {
  header.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button")) return;
    _dragging = true;
    const rect = _win!.getBoundingClientRect();
    _dragOffX = e.clientX - rect.left;
    _dragOffY = e.clientY - rect.top;
    e.preventDefault();
  });
}

function ensureDragListeners() {
  document.addEventListener("mousemove", (e) => {
    if (!_dragging || !_win) return;
    _win.style.left   = `${e.clientX - _dragOffX}px`;
    _win.style.top    = `${e.clientY - _dragOffY}px`;
    _win.style.transform = "none";
  });
  document.addEventListener("mouseup", () => { _dragging = false; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure window exists
// ─────────────────────────────────────────────────────────────────────────────

function ensureWindow() {
  if (_win) return;
  _win = document.createElement("div");
  _win.id = "cw-window";
  _win.className = "cw-window";
  document.body.appendChild(_win);
  ensureDragListeners();
  // Refresh when cable registry changes
  addCableChangeListener(() => { if (_isOpen) renderTable(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function openCableWindow(
  components: OBC.Components,
  world: OBC.World
): void {
  if (!_components) { _components = components; _world = world; }
  ensureWindow();
  _isOpen = true;
  renderWindowFull();
  _win!.style.display = "flex";
}

export function closeCableWindow(): void {
  _isOpen = false;
  if (_win) _win.style.display = "none";
  clearHighlights();
  _selectedCableId = null;
}
