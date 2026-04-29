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
  notifyCableChange,
} from "./cables";

// ─────────────────────────────────────────────────────────────────────────────
// Exported panel state (used by content grid)
// ─────────────────────────────────────────────────────────────────────────────

export interface CablesPanelState {
  components: OBC.Components;
  world: OBC.World;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

type StepStatus = "inactive" | "editing" | "confirmed";

interface PickedElement {
  modelId: string;
  expressId: number;
  point: THREE.Vector3;
  label: string;
  category: string;
}

interface RouteElement extends PickedElement {
  length: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing state  (one object, reset on cancel / start)
// ─────────────────────────────────────────────────────────────────────────────

interface RoutingState {
  cable: Cable | null;
  step1: StepStatus;
  step2: StepStatus;
  step3: StepStatus;
  source: PickedElement | null;    // pending in step-1 edit, locked after OK
  route: RouteElement[];            // built in step-2
  target: PickedElement | null;    // pending in step-3 edit, locked after OK
}

function makeEmptyState(): RoutingState {
  return {
    cable: null,
    step1: "inactive",
    step2: "inactive",
    step3: "inactive",
    source: null,
    route: [],
    target: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singletons
// ─────────────────────────────────────────────────────────────────────────────

let _initialized = false;
let _panelUpdate: (() => void) | null = null;
let _active = false;
let _rs: RoutingState = makeEmptyState();
let _dragSrcIdx: number | null = null;
let _components: OBC.Components | null = null;
let _world: OBC.World | null = null;
let _mouseX = 0;
let _mouseY = 0;
let _lastRayPoint: THREE.Vector3 | null = null;

// DOM singletons
let _panel: HTMLDivElement | null = null;
let _tooltip: HTMLDivElement | null = null;
let _modal: HTMLDialogElement | null = null;
let _panelListenerAttached = false;

// ─────────────────────────────────────────────────────────────────────────────
// IFC / fragment helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getCategory(
  fragments: OBC.FragmentsManager,
  modelId: string,
  expressId: number
): Promise<string> {
  const model = fragments.list.get(modelId);
  if (!model) return "IfcBuildingElement";
  try {
    return (await model.getItem(expressId).getCategory()) ?? "IfcBuildingElement";
  } catch {
    return "IfcBuildingElement";
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
// Schritt 2: Bounding Box eines IFC-Elements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gibt die 3D-BoundingBox (THREE.Box3) eines Elements zurück.
 * Fallback: null wenn das Element keine Geometrie hat.
 */
async function getElementBBox(
  components: OBC.Components,
  modelId: string,
  expressId: number
): Promise<THREE.Box3 | null> {
  try {
    const boxer = components.get(OBC.BoundingBoxer);
    boxer.list.clear();
    await boxer.addFromModelIdMap({ [modelId]: new Set([expressId]) });
    const box = boxer.get();
    boxer.list.clear();
    // Eine leere Box hat min > max — ungültig zurückgeben
    if (box.isEmpty()) return null;
    return box;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schritt 5: Steigtrassen-Erkennung
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erkennt ob ein Element eine vertikale Steigtrasse ist.
 * Kriterium: Höhe (Y) deutlich grösser als Breite und Tiefe.
 */
function isSteigtrasse(box: THREE.Box3): boolean {
  const height = box.max.y - box.min.y;
  const width  = box.max.x - box.min.x;
  const depth  = box.max.z - box.min.z;
  return height > width * 2 && height > depth * 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schritt 7 (Korrektur): clampToBBox
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Klemmt einen Punkt auf die BoundingBox — stellt sicher dass der Punkt
 * auf oder innerhalb des Elements liegt (kein "Phantom-Punkt" im Leeren).
 */
function clampToBBox(pt: THREE.Vector3, box: THREE.Box3): THREE.Vector3 {
  return new THREE.Vector3(
    Math.max(box.min.x, Math.min(box.max.x, pt.x)),
    Math.max(box.min.y, Math.min(box.max.y, pt.y)),
    Math.max(box.min.z, Math.min(box.max.z, pt.z))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Schritt 2: Orthogonaler Eintrittspunkt auf Element-Oberfläche
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Berechnet den Eintrittspunkt auf der Oberfläche von `toBBox`
 * ausgehend vom letzten akkumulierten Punkt `fromPt`.
 *
 * Strategie (Reihenfolge der Prüfung):
 *   1. Steigtrasse → Ober- oder Unterkante (Y-Fläche)
 *   2. Hauptsächlich Y-Bewegung → Y-Fläche
 *   3. Hauptsächlich X-Bewegung → X-Fläche (links/rechts)
 *   4. Hauptsächlich Z-Bewegung → Z-Fläche (vorne/hinten)
 *
 * Y und Z (bzw. Y und X) des vorherigen Punkts bleiben erhalten →
 * Eintrittspunkt hat schon die richtige Höhe/Tiefe für den Abbiegepunkt.
 */
function getOrthogonalConnectionPoint(
  fromPt: THREE.Vector3,
  toBBox: THREE.Box3
): THREE.Vector3 {
  const toCenter = new THREE.Vector3();
  toBBox.getCenter(toCenter);

  const dx = Math.abs(toCenter.x - fromPt.x);
  const dy = Math.abs(toCenter.y - fromPt.y);
  const dz = Math.abs(toCenter.z - fromPt.z);

  if (isSteigtrasse(toBBox) || dy > Math.max(dx, dz)) {
    // Vertikal — oben oder unten eintreten
    const faceY = fromPt.y < toCenter.y ? toBBox.min.y : toBBox.max.y;
    return new THREE.Vector3(fromPt.x, faceY, fromPt.z);
  }

  if (dx >= dz) {
    // Hauptsächlich X → linke oder rechte Fläche
    const faceX = fromPt.x < toCenter.x ? toBBox.min.x : toBBox.max.x;
    return new THREE.Vector3(faceX, fromPt.y, fromPt.z);
  } else {
    // Hauptsächlich Z → vordere oder hintere Fläche
    const faceZ = fromPt.z < toCenter.z ? toBBox.min.z : toBBox.max.z;
    return new THREE.Vector3(fromPt.x, fromPt.y, faceZ);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schritt 3: makeOrthogonalPath — Achsenparallele Zwischenpunkte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erzeugt einen rein orthogonalen (achsenparallelen) Pfad von A nach B.
 * Maximal 2 Zwischenpunkte, Reihenfolge immer: erst X, dann Y, dann Z.
 *
 * Ergebnisformen:
 *   2 Punkte  [A, B]:          bereits auf gleicher Achse
 *   3 Punkte  [A, K, B]:       L-Form (kein Höhenunterschied)
 *   4 Punkte  [A, K1, K2, B]:  U-/S-Form (mit Höhenunterschied)
 */
function makeOrthogonalPath(A: THREE.Vector3, B: THREE.Vector3): THREE.Vector3[] {
  const T  = 0.1; // 10 cm Schwellwert: darunter = "gleiche Achse"
  const dx = Math.abs(B.x - A.x);
  const dy = Math.abs(B.y - A.y);
  const dz = Math.abs(B.z - A.z);

  // ── Gleicher Punkt oder nur eine Achse verschieden → kein Knick nötig ────
  if (dx < T && dy < T && dz < T) return [A.clone(), B.clone()];
  if (dy < T && dz < T)           return [A.clone(), B.clone()]; // nur X
  if (dx < T && dz < T)           return [A.clone(), B.clone()]; // nur Y
  if (dx < T && dy < T)           return [A.clone(), B.clone()]; // nur Z

  // ── L-Form: gleiche Höhe (dy < T), horizontale Bewegung in X und Z ───────
  // Strategie: erst X, dann Z
  if (dy < T) {
    return [
      A.clone(),
      new THREE.Vector3(B.x, A.y, A.z), // Knick: X bewegt, Z noch alt
      B.clone(),                          // Z bewegt
    ];
  }

  // ── U-/S-Form: Höhenunterschied → X, dann Y, dann Z ─────────────────────
  return [
    A.clone(),
    new THREE.Vector3(B.x, A.y, A.z), // Knick 1: X bewegt
    new THREE.Vector3(B.x, B.y, A.z), // Knick 2: Y bewegt (hoch/runter)
    B.clone(),                          // Z bewegt
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Schritt 4: calculateRoutePoints — vollständig orthogonaler Kabelweg
// ─────────────────────────────────────────────────────────────────────────────

interface RouteCalcResult {
  pts:       THREE.Vector3[]; // alle Linienpunkte (für THREE.Line)
  entryPts:  THREE.Vector3[]; // Eintrittspunkte auf Elementen (blau im Debug)
  cornerPts: THREE.Vector3[]; // Knickpunkte vom orthogonalen Routing (gelb)
}

/**
 * Berechnet für den gesamten Kabelweg einen vollständig orthogonalen Pfad.
 *
 * Ablauf je Element (ausser Quelle):
 *   1. getOrthogonalConnectionPoint → Eintrittspunkt auf Element-Oberfläche
 *   2. clampToBBox → Korrektur damit kein Phantom-Punkt entsteht
 *   3. makeOrthogonalPath → L- oder U-förmige Verbindung zum Eintrittspunkt
 *
 * Letztes Element: zusätzlich orthogonaler Pfad zum Mittelpunkt.
 * Fallback: wenn keine BBox vorhanden → orthogonaler Pfad zum Klick-Punkt.
 */
async function calculateRoutePoints(
  components: OBC.Components,
  source:     PickedElement,
  route:      RouteElement[],
  target:     PickedElement
): Promise<RouteCalcResult> {
  const all   = [source, ...route, target];
  const boxes = await Promise.all(
    all.map((el) => getElementBBox(components, el.modelId, el.expressId))
  );

  const pts:       THREE.Vector3[] = [];
  const entryPts:  THREE.Vector3[] = [];
  const cornerPts: THREE.Vector3[] = [];

  for (let i = 0; i < all.length; i++) {
    const box = boxes[i];

    if (i === 0) {
      // Quelle: Startpunkt = Mittelpunkt (oder Klick-Punkt wenn keine BBox)
      if (box) {
        const c = new THREE.Vector3();
        box.getCenter(c);
        pts.push(c);
      } else {
        pts.push(all[0].point.clone());
      }
      continue;
    }

    const prevPt = pts[pts.length - 1];

    if (!box) {
      // Kein BBox → orthogonaler Pfad zum gespeicherten Klick-Punkt
      const seg = makeOrthogonalPath(prevPt, all[i].point.clone());
      cornerPts.push(...seg.slice(1, -1));
      pts.push(...seg.slice(1));
      continue;
    }

    // ── Eintrittspunkt auf Element-Oberfläche berechnen ───────────────────
    let entryPt = getOrthogonalConnectionPoint(prevPt, box);
    entryPt = clampToBBox(entryPt, box);
    entryPts.push(entryPt.clone());

    // ── Orthogonaler Pfad vom letzten Punkt zum Eintrittspunkt ────────────
    const seg = makeOrthogonalPath(prevPt, entryPt);
    cornerPts.push(...seg.slice(1, -1)); // nur Zwischenpunkte (keine Start/Ziel)
    pts.push(...seg.slice(1));

    // ── Letztes Element: zusätzlich zum Mittelpunkt weiterrouten ──────────
    if (i === all.length - 1) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      if (center.distanceTo(entryPt) > 0.1) {
        const endSeg = makeOrthogonalPath(pts[pts.length - 1], center);
        cornerPts.push(...endSeg.slice(1, -1));
        pts.push(...endSeg.slice(1));
      }
    }
  }

  return { pts, entryPts, cornerPts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schritt 6: Debug-Visualisierung (farbige Kugeln je Punkt-Typ)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zeichnet farbige Kugeln an jedem berechneten Punkt.
 *
 * Aktivieren in der Browser-Konsole (F12):
 *   window.debugCableRouting = true
 * Deaktivieren:
 *   window.debugCableRouting = false
 *
 * Farben:
 *   ROT  (r=0.08m) — alle finalen Linienpunkte
 *   GELB (r=0.10m) — Knickpunkte vom orthogonalen Routing
 *   BLAU (r=0.12m) — Eintrittspunkte auf Elementen
 */
function drawDebugSpheres(
  world:   OBC.World,
  result:  RouteCalcResult,
  cableId: string
) {
  const group = new THREE.Group();
  group.name = `cable-debug-${cableId}`;

  const addSpheres = (
    points: THREE.Vector3[],
    color:  number,
    radius: number,
    order:  number
  ) => {
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
    for (const pt of points) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 8), mat);
      mesh.position.copy(pt);
      mesh.renderOrder = order;
      group.add(mesh);
    }
  };

  addSpheres(result.pts,       0xff2222, 0.08, 1000); // Rot:  alle Punkte
  addSpheres(result.cornerPts, 0xffdd00, 0.10, 1001); // Gelb: Knickpunkte
  addSpheres(result.entryPts,  0x4488ff, 0.12, 1002); // Blau: Eintrittspunkte

  world.scene.three.add(group);
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing state transitions
// ─────────────────────────────────────────────────────────────────────────────

function editingStep(): 1 | 2 | 3 | null {
  if (_rs.step1 === "editing") return 1;
  if (_rs.step2 === "editing") return 2;
  if (_rs.step3 === "editing") return 3;
  return null;
}

function startRouting(cable: Cable) {
  _active = true;
  _rs = makeEmptyState();
  _rs.cable = cable;
  _rs.step1 = "editing";
}

async function cancelRouting() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  _active = false;
  if (_rs.cable) {
    const idx = cableRegistry.indexOf(_rs.cable);
    if (idx !== -1) cableRegistry.splice(idx, 1);
  }
  _rs = makeEmptyState();
  await hl.clear("cable-source");
  await hl.clear("cable-route");
  await hl.clear("cable-target");
  renderPanel();
  hideTooltip();
  notifyCableChange();
  _panelUpdate?.();
}

function okStep1() {
  if (!_rs.source) return;
  _rs.step1 = "confirmed";
  _rs.step2 = "editing";
  renderPanel();
}

function okStep2() {
  if (_rs.route.length === 0) return;
  _rs.step2 = "confirmed";
  _rs.step3 = "editing";
  renderPanel();
}

function okStep3() {
  if (!_rs.target) return;
  _rs.step3 = "confirmed";
  renderPanel();
}

async function editStep(n: 1 | 2 | 3) {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);

  if (n === 1) {
    _rs.step1 = "editing";
    // Clear steps 2 + 3
    _rs.step2 = "inactive";
    _rs.step3 = "inactive";
    _rs.route = [];
    _rs.target = null;
    await hl.clear("cable-route");
    await hl.clear("cable-target");
  } else if (n === 2) {
    _rs.step2 = "editing";
    _rs.step3 = "inactive";
    _rs.target = null;
    await hl.clear("cable-target");
  } else {
    _rs.step3 = "editing";
    _rs.target = null;
    await hl.clear("cable-target");
  }
  renderPanel();
}

function allConfirmed(): boolean {
  return _rs.step1 === "confirmed" && _rs.step2 === "confirmed" && _rs.step3 === "confirmed";
}

async function confirmCable() {
  if (!_rs.cable || !_rs.source || !_rs.target || !_world || !_components) return;

  const c = _rs.cable;
  c.sourceModelId   = _rs.source.modelId;
  c.sourceExpressId = _rs.source.expressId;
  c.sourceLabel     = _rs.source.label;
  c.targetModelId   = _rs.target.modelId;
  c.targetExpressId = _rs.target.expressId;
  c.targetLabel     = _rs.target.label;
  c.trassIds        = _rs.route.map((e) => ({ modelId: e.modelId, expressId: e.expressId }));
  c.status = "geplant";

  // ── Optimierten, orthogonalen Kabelweg berechnen ────────────────────────
  const routeResult = await calculateRoutePoints(
    _components,
    _rs.source,
    _rs.route,
    _rs.target
  );
  const { pts } = routeResult;

  // ── Länge aus echten 3D-Punkten (Summe der Segmentlängen) ───────────────
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += pts[i].distanceTo(pts[i - 1]);
  c.length = Math.round(d * 10) / 10;

  // ── Three.js Linie zeichnen ──────────────────────────────────────────────
  if (pts.length >= 2) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(c.color), depthTest: false })
    );
    line.renderOrder = 999;
    line.name = `cable-line-${c.id}`;
    _world.scene.three.add(line);

    // ── Debug-Kugeln (Aktivieren: window.debugCableRouting = true) ──────────
    if ((window as any).debugCableRouting) {
      drawDebugSpheres(_world, routeResult, c.id);
    }
  }

  // Clear routing highlights
  const hl = _components.get(OBF.Highlighter);
  hl.clear("cable-source");
  hl.clear("cable-route");
  hl.clear("cable-target");

  _active = false;
  _rs = makeEmptyState();
  renderPanel();
  hideTooltip();
  notifyCableChange();
  _panelUpdate?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlight sync helpers
// ─────────────────────────────────────────────────────────────────────────────

async function syncRouteHighlight() {
  if (!_components) return;
  const hl = _components.get(OBF.Highlighter);
  if (_rs.route.length === 0) { await hl.clear("cable-route"); return; }
  const map: OBC.ModelIdMap = {};
  for (const e of _rs.route) {
    if (!map[e.modelId]) map[e.modelId] = new Set();
    map[e.modelId].add(e.expressId);
  }
  await hl.highlightByID("cable-route", map, false, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML helpers
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel HTML builders
// ─────────────────────────────────────────────────────────────────────────────

function buildProgress(): string {
  const dot = (s: StepStatus) =>
    s === "confirmed" ? "rp-prog-dot--done" : s === "editing" ? "rp-prog-dot--active" : "rp-prog-dot--off";
  const icon = (s: StepStatus) => (s === "confirmed" ? "✓" : s === "editing" ? "●" : "○");

  return `
    <div class="rp-progress">
      <span class="rp-prog-step">
        <span class="rp-prog-dot ${dot(_rs.step1)}">${icon(_rs.step1)}</span>
        <span class="rp-prog-label">① Quelle</span>
      </span>
      <span class="rp-prog-arrow">→</span>
      <span class="rp-prog-step">
        <span class="rp-prog-dot ${dot(_rs.step2)}">${icon(_rs.step2)}</span>
        <span class="rp-prog-label">② Kabelweg</span>
      </span>
      <span class="rp-prog-arrow">→</span>
      <span class="rp-prog-step">
        <span class="rp-prog-dot ${dot(_rs.step3)}">${icon(_rs.step3)}</span>
        <span class="rp-prog-label">③ Ziel</span>
      </span>
    </div>`;
}

function buildPickedTable(el: PickedElement, removeAction: string): string {
  return `
    <table class="rp-table">
      <thead><tr><th>Name</th><th>IFC-Typ</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td class="rp-td-name" title="${esc(el.label)}">${esc(el.label)}</td>
          <td class="rp-td-cat" title="${esc(el.category)}">${esc(el.category.replace("Ifc", ""))}</td>
          <td><button class="rp-x" data-action="${removeAction}">✕</button></td>
        </tr>
      </tbody>
    </table>`;
}

function buildSection1(): string {
  const s = _rs.step1;

  if (s === "confirmed") {
    const src = _rs.source!;
    return `
      <div class="rp-section rp-section--confirmed">
        <div class="rp-section-title">
          <span class="rp-dot rp-dot--done">✓</span>① QUELLE
          <button class="rp-edit-btn" data-action="edit-step" data-step="1" title="Schritt bearbeiten">✎</button>
        </div>
        <div class="rp-section-compact">
          <span class="rp-compact-name">${esc(src.label)}</span>
          <span class="rp-compact-cat">${esc(src.category)}</span>
        </div>
      </div>`;
  }

  if (s === "inactive") {
    return `
      <div class="rp-section rp-section--inactive">
        <div class="rp-section-title">
          <span class="rp-dot">○</span>① QUELLE
        </div>
        <div class="rp-section-locked">Wird aktiv nach Start</div>
      </div>`;
  }

  // editing
  const hasSrc = _rs.source !== null;
  return `
    <div class="rp-section rp-section--active">
      <div class="rp-section-title">
        <span class="rp-dot rp-dot--active">●</span>① QUELLE
      </div>
      <div class="rp-section-body">
        ${hasSrc
          ? buildPickedTable(_rs.source!, "remove-source")
          : '<div class="rp-placeholder">Klicke ein Element im Viewer<br><span class="rp-ph-sub">Schaltschrank, Trafo oder beliebig</span></div>'}
        <button class="rp-ok-btn${hasSrc ? "" : " rp-ok-btn--disabled"}"
          data-action="ok-step1" ${hasSrc ? "" : "disabled"}>
          OK →
        </button>
      </div>
    </div>`;
}

function buildRouteRows(): string {
  if (_rs.route.length === 0) return "";
  const total = Math.round(_rs.route.reduce((s, e) => s + e.length, 0) * 10) / 10;
  const rows = _rs.route.map((e, i) => `
    <div class="rp-trasse-row" draggable="true" data-idx="${i}">
      <span class="rp-drag-handle" title="Ziehen zum Sortieren">⠿</span>
      <span class="rp-td-name" title="${esc(e.label)}">${esc(e.label)}</span>
      <span class="rp-td-cat">${esc(e.category.replace("Ifc", ""))}</span>
      <span class="rp-td-len">${e.length > 0 ? e.length + "m" : "—"}</span>
      <button class="rp-x" data-action="remove-route" data-idx="${i}">✕</button>
    </div>`).join("");
  return `
    <div class="rp-trasse-list" id="rp-trasse-list">${rows}</div>
    <div class="rp-trasse-total">
      <span>TOTAL</span><span></span><span></span>
      <span>${total > 0 ? total + "m" : "—"}</span><span></span>
    </div>`;
}

function buildSection2(): string {
  const s = _rs.step2;

  if (s === "confirmed") {
    const total = Math.round(_rs.route.reduce((acc, e) => acc + e.length, 0) * 10) / 10;
    return `
      <div class="rp-section rp-section--confirmed">
        <div class="rp-section-title">
          <span class="rp-dot rp-dot--done">✓</span>② KABELWEG
          <span class="rp-count">${_rs.route.length} Element${_rs.route.length !== 1 ? "e" : ""}${total > 0 ? " · " + total + "m" : ""}</span>
          <button class="rp-edit-btn" data-action="edit-step" data-step="2" title="Schritt bearbeiten">✎</button>
        </div>
      </div>`;
  }

  if (s === "inactive") {
    return `
      <div class="rp-section rp-section--inactive">
        <div class="rp-section-title">
          <span class="rp-dot">○</span>② KABELWEG
        </div>
        <div class="rp-section-locked">Wird aktiv nach Schritt 1</div>
      </div>`;
  }

  // editing
  const hasRoute = _rs.route.length > 0;
  return `
    <div class="rp-section rp-section--active">
      <div class="rp-section-title">
        <span class="rp-dot rp-dot--active">●</span>② KABELWEG
        ${hasRoute ? `<span class="rp-count">${_rs.route.length} gewählt</span>` : ""}
      </div>
      <div class="rp-section-body">
        ${!hasRoute
          ? `<div class="rp-placeholder">Klicke Elemente im Viewer<br>
             <span class="rp-ph-sub">Mehrfachauswahl · beliebige IFC-Elemente</span></div>`
          : ""}
        ${buildRouteRows()}
        ${hasRoute
          ? `<div class="rp-drag-hint">Zeilen verschiebbar per Drag &amp; Drop</div>`
          : ""}
        <button class="rp-ok-btn${hasRoute ? "" : " rp-ok-btn--disabled"}"
          data-action="ok-step2" ${hasRoute ? "" : "disabled"}>
          OK →
        </button>
      </div>
    </div>`;
}

function buildSection3(): string {
  const s = _rs.step3;

  if (s === "confirmed") {
    const tgt = _rs.target!;
    return `
      <div class="rp-section rp-section--confirmed">
        <div class="rp-section-title">
          <span class="rp-dot rp-dot--done">✓</span>③ ZIEL
          <button class="rp-edit-btn" data-action="edit-step" data-step="3" title="Schritt bearbeiten">✎</button>
        </div>
        <div class="rp-section-compact">
          <span class="rp-compact-name">${esc(tgt.label)}</span>
          <span class="rp-compact-cat">${esc(tgt.category)}</span>
        </div>
      </div>`;
  }

  if (s === "inactive") {
    return `
      <div class="rp-section rp-section--inactive">
        <div class="rp-section-title">
          <span class="rp-dot">○</span>③ ZIEL
        </div>
        <div class="rp-section-locked">Wird aktiv nach Schritt 2</div>
      </div>`;
  }

  // editing
  const hasTgt = _rs.target !== null;
  return `
    <div class="rp-section rp-section--active">
      <div class="rp-section-title">
        <span class="rp-dot rp-dot--active">●</span>③ ZIEL
      </div>
      <div class="rp-section-body">
        ${hasTgt
          ? buildPickedTable(_rs.target!, "remove-target")
          : '<div class="rp-placeholder">Klicke ein Element im Viewer<br><span class="rp-ph-sub">Darf nicht dasselbe wie die Quelle sein</span></div>'}
        <button class="rp-ok-btn${hasTgt ? "" : " rp-ok-btn--disabled"}"
          data-action="ok-step3" ${hasTgt ? "" : "disabled"}>
          OK →
        </button>
      </div>
    </div>`;
}

function buildSummary(): string {
  if (!allConfirmed()) return "";
  const routeCount = _rs.route.length;
  const routeTotal = Math.round(_rs.route.reduce((s, e) => s + e.length, 0) * 10) / 10;
  return `
    <div class="rp-summary">
      <div class="rp-summary-title">ZUSAMMENFASSUNG</div>
      <div class="rp-summary-row">
        <span>Quelle:</span>
        <span>${esc(_rs.source!.label)} <span class="rp-ok">✓</span></span>
      </div>
      <div class="rp-summary-row">
        <span>Elemente:</span>
        <span>${routeCount} Element${routeCount !== 1 ? "e" : ""}${routeTotal > 0 ? " · " + routeTotal + "m" : ""} <span class="rp-ok">✓</span></span>
      </div>
      <div class="rp-summary-row">
        <span>Ziel:</span>
        <span>${esc(_rs.target!.label)} <span class="rp-ok">✓</span></span>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main panel renderer
// ─────────────────────────────────────────────────────────────────────────────

function renderPanel() {
  if (!_panel) {
    _panel = document.createElement("div");
    _panel.id = "rp-panel";
    _panel.className = "rp-panel";
    document.body.appendChild(_panel);
  }

  if (!_active || !_rs.cable) {
    _panel.classList.remove("rp-panel--open");
    return;
  }

  const shortType =
    CABLE_TYPES.find((t) => t.value === _rs.cable!.type)
      ?.label.split("—")[0].trim() ?? _rs.cable.type;

  _panel.innerHTML = `
    <div class="rp-header">
      <div class="rp-header-title">KABELWEG DEFINIEREN</div>
      <div class="rp-header-sub">${esc(_rs.cable.id)} · ${esc(shortType)} · ${esc(_rs.cable.voltage)}</div>
    </div>
    ${buildProgress()}
    <div class="rp-body">
      ${buildSection1()}
      ${buildSection2()}
      ${buildSection3()}
      ${buildSummary()}
    </div>
    <div class="rp-actions">
      ${allConfirmed()
        ? `<button class="rp-btn-primary" data-action="create-cable">✓ Kabel erstellen</button>`
        : `<button class="rp-btn-primary rp-btn--disabled" disabled
            title="Bitte alle 3 Schritte abschliessen">✓ Kabel erstellen</button>`}
      <button class="rp-btn-cancel" data-action="cancel-routing">✕ Abbrechen</button>
    </div>`;

  _panel.classList.add("rp-panel--open");

  // Attach event listener only once (event delegation)
  if (!_panelListenerAttached) {
    _panelListenerAttached = true;
    _panel.addEventListener("click", onPanelClick);
  }

  setupDragDrop();
}

function onPanelClick(e: Event) {
  const btn = (e.target as Element).closest<HTMLElement>("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action!;

  if (action === "ok-step1") { okStep1(); return; }
  if (action === "ok-step2") { okStep2(); return; }
  if (action === "ok-step3") { okStep3(); return; }
  if (action === "create-cable") { void confirmCable(); return; }
  if (action === "cancel-routing") { cancelRouting(); return; }

  if (action === "edit-step") {
    editStep(Number(btn.dataset.step) as 1 | 2 | 3);
    return;
  }

  if (action === "remove-source") {
    removeSource();
    return;
  }
  if (action === "remove-target") {
    removeTarget();
    return;
  }
  if (action === "remove-route") {
    removeRouteElement(Number(btn.dataset.idx));
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove actions
// ─────────────────────────────────────────────────────────────────────────────

async function removeSource() {
  if (!_components) return;
  await _components.get(OBF.Highlighter).clear("cable-source");
  _rs.source = null;
  renderPanel();
}

async function removeTarget() {
  if (!_components) return;
  await _components.get(OBF.Highlighter).clear("cable-target");
  _rs.target = null;
  renderPanel();
}

async function removeRouteElement(idx: number) {
  _rs.route.splice(idx, 1);
  await syncRouteHighlight();
  renderPanel();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag & Drop for route element reordering
// ─────────────────────────────────────────────────────────────────────────────

function setupDragDrop() {
  document.querySelectorAll<HTMLElement>(".rp-trasse-row").forEach((row) => {
    row.addEventListener("dragstart", () => {
      _dragSrcIdx = Number(row.dataset.idx);
      row.classList.add("rp-dragging");
    });
    row.addEventListener("dragend", () => {
      _dragSrcIdx = null;
      row.classList.remove("rp-dragging");
      document.querySelectorAll(".rp-drag-over").forEach((el) =>
        el.classList.remove("rp-drag-over")
      );
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      document.querySelectorAll(".rp-drag-over").forEach((el) =>
        el.classList.remove("rp-drag-over")
      );
      row.classList.add("rp-drag-over");
    });
    row.addEventListener("drop", () => {
      const dest = Number(row.dataset.idx);
      if (_dragSrcIdx !== null && _dragSrcIdx !== dest) {
        const moved = _rs.route.splice(_dragSrcIdx, 1)[0];
        _rs.route.splice(dest, 0, moved);
        renderPanel();
        syncRouteHighlight();
      }
    });
  });
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
// One-time setup: highlights, event wiring
// ─────────────────────────────────────────────────────────────────────────────

function setupRouting(state: CablesPanelState) {
  const { components, world } = state;
  _components = components;
  _world = world;

  const hl = components.get(OBF.Highlighter);
  const fragments = components.get(OBC.FragmentsManager);
  const raycaster = components.get(OBC.Raycasters).get(world);

  // Register highlight styles (side effect: creates hl.events[name])
  hl.styles.set("cable-source", {
    color: new THREE.Color("#ff4455"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1, transparent: false,
  });
  hl.styles.set("cable-route", {
    color: new THREE.Color("#ffaa00"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1, transparent: false,
  });
  hl.styles.set("cable-target", {
    color: new THREE.Color("#00e67a"),
    renderedFaces: FRAGS.RenderedFaces.ONE,
    opacity: 1, transparent: false,
  });
  hl.styles.set("cable-hover", null); // no visual, but creates hl.events["cable-hover"]

  // Mouse tracking
  document.addEventListener("pointermove", (e) => {
    _mouseX = e.clientX;
    _mouseY = e.clientY;
  });

  // Capture ray point before highlighter bubble handler
  const canvas = world.renderer?.three.domElement;
  if (canvas) {
    canvas.addEventListener("click", async () => {
      if (!_active) return;
      const hit = await raycaster.castRay();
      _lastRayPoint = hit?.point?.clone() ?? null;
    }, true);
  }

  // ── Hover tooltip ────────────────────────────────────────────────────────
  let _hoverTimer: ReturnType<typeof setTimeout> | null = null;
  if (canvas) {
    canvas.addEventListener("pointermove", () => {
      if (!_active) { hideTooltip(); return; }
      if (_hoverTimer) clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(async () => {
        if (!_active) return;
        try { await hl.highlight("cable-hover", true, false); }
        catch { hideTooltip(); }
      }, 60);
    });
    canvas.addEventListener("mouseleave", () => hideTooltip());
  }

  hl.events["cable-hover"].onHighlight.add(async (modelIdMap) => {
    if (!_active) return;
    const entry = Object.entries(modelIdMap)[0];
    if (!entry) return;
    const [, expressIds] = entry;
    const expressId = [...expressIds][0];
    if (expressId == null) return;
    await hl.clear("cable-hover");

    const step = editingStep();
    if (step === 1) {
      showTooltip("Als Quelle wählen");
    } else if (step === 2) {
      const already = _rs.route.some((e) => e.expressId === expressId);
      showTooltip(already ? "Entfernen" : "Zum Kabelweg hinzufügen");
    } else if (step === 3) {
      if (_rs.source?.expressId === expressId) {
        showTooltip("Bereits als Quelle gewählt");
      } else {
        showTooltip("Als Ziel wählen");
      }
    } else {
      hideTooltip();
    }
  });

  hl.events["cable-hover"].onClear.add(() => hideTooltip());

  // ── Viewer click → routing ───────────────────────────────────────────────
  hl.events.select.onHighlight.add(async (modelIdMap) => {
    if (!_active) return;
    const step = editingStep();
    if (step === null) return; // all steps confirmed, no interaction

    const entry = Object.entries(modelIdMap)[0];
    if (!entry) return;
    const [modelId, expressIds] = entry;
    const expressId = [...expressIds][0];
    if (expressId == null) return;
    await hl.clear("select");

    const pt = _lastRayPoint?.clone() ?? new THREE.Vector3();

    if (step === 1) {
      // Replace current source selection
      await hl.clear("cable-source");
      const label = await getElementLabel(fragments, modelId, expressId);
      const category = await getCategory(fragments, modelId, expressId);
      _rs.source = { modelId, expressId, point: pt, label, category };
      await hl.highlightByID("cable-source", { [modelId]: new Set([expressId]) }, false, false);
      renderPanel();
      _panelUpdate?.();
    } else if (step === 2) {
      // Toggle route element
      const idx = _rs.route.findIndex((e) => e.expressId === expressId);
      if (idx !== -1) {
        _rs.route.splice(idx, 1);
      } else {
        const label = await getElementLabel(fragments, modelId, expressId);
        const category = await getCategory(fragments, modelId, expressId);
        _rs.route.push({ modelId, expressId, point: pt, label, category, length: 0 });
        // Load length async, re-render when done
        getElementLength(components, modelId, expressId).then((len) => {
          const el = _rs.route.find((e) => e.expressId === expressId);
          if (el) { el.length = len; renderPanel(); }
        });
      }
      await syncRouteHighlight();
      renderPanel();
      _panelUpdate?.();
    } else if (step === 3) {
      // Validate: not the same as source
      if (_rs.source?.expressId === expressId) {
        showError("Quelle und Ziel müssen verschieden sein");
        return;
      }
      await hl.clear("cable-target");
      const label = await getElementLabel(fragments, modelId, expressId);
      const category = await getCategory(fragments, modelId, expressId);
      _rs.target = { modelId, expressId, point: pt, label, category };
      await hl.highlightByID("cable-target", { [modelId]: new Set([expressId]) }, false, false);
      renderPanel();
      _panelUpdate?.();
    }
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
// Public exports for toolbar / main.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface CableRoutingState {
  components: OBC.Components;
  world: OBC.World;
}

/** Call once from main.ts to set up routing event wiring. */
export function initCableRouting(state: CablesPanelState): void {
  if (!_initialized) {
    _initialized = true;
    try {
      setupRouting(state);
    } catch (err) {
      console.error("[CablePanel] setupRouting failed:", err);
    }
  }
}

/** Call from toolbar "+ Neues Kabel" button. */
export function openNewCableModal(): void {
  openModal(({ name, type, typeLabel, circuit, voltage }) => {
    const cable: Cable = {
      id: nextCableId(),
      name, type, typeLabel, circuit, voltage,
      sourceModelId: "", sourceExpressId: -1, sourceLabel: "",
      targetModelId: "", targetExpressId: -1, targetLabel: "",
      trassIds: [], status: "in Bearbeitung",
      color: getNextColor(), length: 0,
    };
    cableRegistry.push(cable);
    startRouting(cable);
    renderPanel();
    notifyCableChange();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cable list entry (legacy, kept for reference)
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
// Exported BUI panel template (the sidebar section in the grid)
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
        trassIds: [], status: "in Bearbeitung",
        color: getNextColor(), length: 0,
      };
      cableRegistry.push(cable);
      startRouting(cable);
      renderPanel();
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
