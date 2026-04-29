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
// Module-level singletons (panel is created once)
// ─────────────────────────────────────────────────────────────────────────────

let _initialized = false;
let _panelUpdate: (() => void) | null = null;

// Routing state
let _active = false;
let _step: "source" | "trasse" | "target" = "source";
let _cable: Cable | null = null;
let _lastRayPoint: THREE.Vector3 | null = null;

interface TrasseEntry {
  modelId: string;
  expressId: number;
  point: THREE.Vector3;
}
let _trassEntries: TrasseEntry[] = [];
let _sourcePoint: THREE.Vector3 | null = null;
let _targetPoint: THREE.Vector3 | null = null;

let _doCancel: (() => void) | null = null;
let _doConfirm: (() => void) | null = null;
let _mouseX = 0;
let _mouseY = 0;

let _bar: HTMLDivElement | null = null;
let _tooltip: HTMLDivElement | null = null;
let _modal: HTMLDialogElement | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// IFC category via fragments Item.getCategory()
// ─────────────────────────────────────────────────────────────────────────────

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

const SOURCE_TYPES = new Set([
  "IfcElectricDistributionBoard",
  "IfcTransformer",
]);

const isSource = (cat: string | null) =>
  cat === null ? true : SOURCE_TYPES.has(cat); // null = unknown → accept

const isTrasse = (cat: string | null) => cat === "IfcCableTray";

// ─────────────────────────────────────────────────────────────────────────────
// Routing status bar
// ─────────────────────────────────────────────────────────────────────────────

function renderBar() {
  if (!_bar) {
    _bar = document.createElement("div");
    _bar.id = "cable-routing-bar";
    _bar.style.cssText =
      "position:fixed;bottom:64px;left:50%;transform:translateX(-50%);" +
      "background:#1a1d23;border:1px solid #3d8bff;border-radius:8px;" +
      "padding:10px 20px;z-index:9999;color:white;font-size:13px;" +
      "display:none;align-items:center;gap:16px;" +
      "box-shadow:0 2px 16px rgba(0,0,0,.6);";
    document.body.appendChild(_bar);
  }

  if (!_active) {
    _bar.style.display = "none";
    return;
  }

  const s1Done = _step !== "source";
  const s2Done = _step === "target";
  const tCount = _trassEntries.length;
  const showConfirm = _step === "target" && _cable !== null && _cable.targetExpressId >= 0;

  _bar.style.display = "flex";
  _bar.innerHTML =
    `<span style="color:#3d8bff;font-weight:bold;">&#9679; ROUTING AKTIV</span>` +
    `<span>` +
    `<span style="color:${s1Done ? "#00e67a" : "#3d8bff"};font-weight:${_step === "source" ? "bold" : "normal"};">` +
    `${s1Done ? "✓" : "→"} 1.&nbsp;Quelle</span>` +
    `&nbsp;→&nbsp;` +
    `<span style="color:${s2Done ? "#00e67a" : _step === "trasse" ? "#3d8bff" : "#888"};` +
    `font-weight:${_step === "trasse" ? "bold" : "normal"};">` +
    `${_step === "trasse" ? "→ " : s2Done ? "✓ " : ""}2.&nbsp;Trassen${tCount > 0 ? ` (${tCount})` : ""}</span>` +
    `&nbsp;→&nbsp;` +
    `<span style="color:${_step === "target" ? "#3d8bff" : "#888"};font-weight:${_step === "target" ? "bold" : "normal"};">` +
    `${_step === "target" ? "→ " : ""}3.&nbsp;Ziel</span>` +
    `</span>` +
    (showConfirm
      ? `<button id="rb-confirm" style="background:#00e67a;color:#000;border:none;` +
        `padding:5px 14px;border-radius:5px;cursor:pointer;font-weight:bold;">✓ Bestätigen</button>`
      : "") +
    `<button id="rb-cancel" style="background:#ff4455;color:white;border:none;` +
    `padding:5px 14px;border-radius:5px;cursor:pointer;">✕ Abbrechen</button>`;

  document.getElementById("rb-cancel")?.addEventListener("click", () => _doCancel?.());
  document.getElementById("rb-confirm")?.addEventListener("click", () => _doConfirm?.());
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover tooltip
// ─────────────────────────────────────────────────────────────────────────────

function showTooltip(text: string) {
  if (!_tooltip) {
    _tooltip = document.createElement("div");
    _tooltip.style.cssText =
      "position:fixed;background:rgba(0,0,0,.85);color:white;font-size:12px;" +
      "padding:4px 10px;border-radius:4px;pointer-events:none;z-index:10000;display:none;";
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
  t.style.cssText =
    "position:fixed;top:20px;left:50%;transform:translateX(-50%);" +
    "background:#ff4455;color:white;padding:8px 20px;border-radius:6px;" +
    "z-index:10000;font-size:13px;";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
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
  nameEl.value = "";
  circuitEl.value = "";
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
    modal.close();
    cleanup();
    onConfirm({ name, type: typeEl.value, typeLabel: chosen.label, circuit: circuitEl.value.trim(), voltage: voltageEl.value });
  }
  cancelBtn.addEventListener("click", onCancelClick);
  confirmBtn.addEventListener("click", onConfirmClick);
}

// ─────────────────────────────────────────────────────────────────────────────
// Three.js cable line
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

function lineLength(pts: THREE.Vector3[]) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += pts[i].distanceTo(pts[i - 1]);
  return Math.round(d * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time routing setup
// ─────────────────────────────────────────────────────────────────────────────

function setupRouting(state: CablesPanelState) {
  const { components, world } = state;
  const highlighter = components.get(OBF.Highlighter);
  const fragments = components.get(OBC.FragmentsManager);
  const raycaster = components.get(OBC.Raycasters).get(world);

  // ── Custom highlight styles ──────────────────────────────────────────────
  // Calling highlighter.styles.set() automatically creates highlighter.events[name]
  highlighter.styles.set("cable-source", {
    color: new THREE.Color("#ff4455"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("cable-trasse", {
    color: new THREE.Color("#ff8c00"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  highlighter.styles.set("cable-target", {
    color: new THREE.Color("#00e67a"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1,
    transparent: false,
  });
  // null = no visual effect, but events["cable-hover"] is created
  highlighter.styles.set("cable-hover", null);

  // ── Track mouse position ─────────────────────────────────────────────────
  document.addEventListener("pointermove", (e) => {
    _mouseX = e.clientX;
    _mouseY = e.clientY;
  });

  // ── Capture ray position on click (before highlighter processes it) ───────
  const canvas = world.renderer?.three.domElement;
  if (canvas) {
    canvas.addEventListener("click", async () => {
      if (!_active) return;
      const hit = await raycaster.castRay();
      _lastRayPoint = hit?.point?.clone() ?? null;
    }, true);
  }

  // ── Hover tooltip via debounced highlight("cable-hover") ─────────────────
  // highlighter.events["cable-hover"] exists because we called styles.set above
  let _hoverTimer: ReturnType<typeof setTimeout> | null = null;
  if (canvas) {
    canvas.addEventListener("pointermove", () => {
      if (!_active) { hideTooltip(); return; }
      if (_hoverTimer) clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(async () => {
        if (!_active) return;
        try {
          await highlighter.highlight("cable-hover", true, false);
        } catch {
          hideTooltip();
        }
      }, 60);
    });
  }

  highlighter.events["cable-hover"].onHighlight.add(async (modelIdMap) => {
    if (!_active) return;
    const entry = Object.entries(modelIdMap)[0];
    if (!entry) return;
    const [modelId, expressIds] = entry;
    const expressId = [...expressIds][0];
    if (expressId == null) return;
    const cat = await getCategory(fragments, modelId, expressId);
    if (_step === "source" && isSource(cat)) {
      showTooltip("← Als Quelle wählen");
    } else if (_step === "trasse" && isTrasse(cat)) {
      showTooltip("← Als Trasse hinzufügen");
    } else {
      hideTooltip();
    }
    await highlighter.clear("cable-hover");
  });

  highlighter.events["cable-hover"].onClear.add(() => hideTooltip());

  // ── Cancel routing ───────────────────────────────────────────────────────
  const cancelRouting = async () => {
    _active = false;
    if (_cable) {
      const idx = cableRegistry.indexOf(_cable);
      if (idx !== -1) cableRegistry.splice(idx, 1);
      _cable = null;
    }
    _trassEntries = [];
    _sourcePoint = null;
    _targetPoint = null;
    await highlighter.clear("cable-source");
    await highlighter.clear("cable-trasse");
    await highlighter.clear("cable-target");
    renderBar();
    hideTooltip();
    _panelUpdate?.();
  };

  // ── Confirm routing ──────────────────────────────────────────────────────
  const confirmRouting = () => {
    if (!_cable) return;
    const pts: THREE.Vector3[] = [];
    if (_sourcePoint) pts.push(_sourcePoint);
    for (const e of _trassEntries) pts.push(e.point);
    if (_targetPoint) pts.push(_targetPoint);

    const linePts = pts.length >= 2
      ? pts
      : [_sourcePoint ?? new THREE.Vector3(), _targetPoint ?? new THREE.Vector3()];

    _cable.status = "geplant";
    _cable.length = lineLength(linePts);
    drawCableLine(world, _cable, linePts);

    _active = false;
    _cable = null;
    _trassEntries = [];
    _sourcePoint = null;
    _targetPoint = null;

    highlighter.clear("cable-source");
    highlighter.clear("cable-trasse");
    highlighter.clear("cable-target");
    renderBar();
    hideTooltip();
    _panelUpdate?.();
  };

  _doCancel = cancelRouting;
  _doConfirm = confirmRouting;

  // ── Select / click handler ───────────────────────────────────────────────
  highlighter.events.select.onHighlight.add(async (modelIdMap) => {
    if (!_active || !_cable) return;

    const entry = Object.entries(modelIdMap)[0];
    if (!entry) return;
    const [modelId, expressIds] = entry;
    const expressId = [...expressIds][0];
    if (expressId == null) return;

    const cat = await getCategory(fragments, modelId, expressId);
    const pt = _lastRayPoint?.clone() ?? new THREE.Vector3();

    // Step 1 – Source
    if (_step === "source") {
      if (!isSource(cat)) {
        await highlighter.clear("select");
        showError("Bitte Schaltschrank oder Trafo wählen");
        return;
      }
      _cable.sourceModelId = modelId;
      _cable.sourceExpressId = expressId;
      _cable.sourceLabel = `#${expressId}`;
      _sourcePoint = pt;
      await highlighter.highlightByID("cable-source", { [modelId]: new Set([expressId]) }, false, false);
      await highlighter.clear("select");
      _step = "trasse";
      renderBar();
      _panelUpdate?.();
      return;
    }

    // Step 2 – Trasses
    if (_step === "trasse") {
      if (isTrasse(cat)) {
        const idx = _trassEntries.findIndex((e) => e.modelId === modelId && e.expressId === expressId);
        if (idx !== -1) {
          _trassEntries.splice(idx, 1);
        } else {
          _trassEntries.push({ modelId, expressId, point: pt });
        }
        if (_trassEntries.length > 0) {
          const map: OBC.ModelIdMap = {};
          for (const e of _trassEntries) {
            if (!map[e.modelId]) map[e.modelId] = new Set();
            map[e.modelId].add(e.expressId);
          }
          await highlighter.highlightByID("cable-trasse", map, false, false);
        } else {
          await highlighter.clear("cable-trasse");
        }
        await highlighter.clear("select");
        renderBar();
        _panelUpdate?.();
        return;
      }
      // Non-trasse → auto-advance to step 3
      _step = "target";
      _cable.targetModelId = modelId;
      _cable.targetExpressId = expressId;
      _cable.targetLabel = `#${expressId}`;
      _targetPoint = pt;
      await highlighter.highlightByID("cable-target", { [modelId]: new Set([expressId]) }, false, false);
      await highlighter.clear("select");
      renderBar();
      _panelUpdate?.();
      return;
    }

    // Step 3 – Target update
    if (_step === "target") {
      _cable.targetModelId = modelId;
      _cable.targetExpressId = expressId;
      _cable.targetLabel = `#${expressId}`;
      _targetPoint = pt;
      await highlighter.clear("cable-target");
      await highlighter.highlightByID("cable-target", { [modelId]: new Set([expressId]) }, false, false);
      await highlighter.clear("select");
      renderBar();
      _panelUpdate?.();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cable list entry renderer
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
        name,
        type,
        typeLabel,
        circuit,
        voltage,
        sourceModelId: "",
        sourceExpressId: -1,
        sourceLabel: "",
        targetModelId: "",
        targetExpressId: -1,
        targetLabel: "",
        trassIds: [],
        status: "in Bearbeitung",
        color: getNextColor(),
        length: 0,
      };
      cableRegistry.push(cable);
      _active = true;
      _step = "source";
      _cable = cable;
      _trassEntries = [];
      _sourcePoint = null;
      _targetPoint = null;
      renderBar();
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
