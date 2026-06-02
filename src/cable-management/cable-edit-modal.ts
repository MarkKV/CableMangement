import * as THREE from "three";
import * as OBC from "@thatopen/components";
import {
  Cable,
  CableStatus,
  CableHistoryEntry,
  notifyCableChange,
} from "./cables";
import { getCatalog } from "./catalog";
import { getEditingCable, setEditingCable, showConflictToast } from "./cable-edit-state";
import { openRoutingEdit } from "./cable-panel";

// world-Referenz für Farb-Update der 3D-Linie
let _world: OBC.World | null = null;

export function initCableEditModal(world: OBC.World): void {
  _world = world;
}

// ─────────────────────────────────────────────────────────────────────────────
// Farb-Optionen (entspricht CABLE_COLORS)
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_OPTIONS = [
  { hex: "#3d8bff", name: "Blau" },
  { hex: "#ff8c00", name: "Orange" },
  { hex: "#00e67a", name: "Grün" },
  { hex: "#ff4455", name: "Rot" },
  { hex: "#c87aff", name: "Lila" },
  { hex: "#00d4ff", name: "Cyan" },
  { hex: "#ffdd00", name: "Gelb" },
  { hex: "#ff69b4", name: "Pink" },
];

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Öffentliche API
// ─────────────────────────────────────────────────────────────────────────────

export function openCableEditModal(cable: Cable): void {
  // Konflikt-Schutz
  const editing = getEditingCable();
  if (editing && editing.cableId !== cable.id) {
    showConflictToast();
    return;
  }

  setEditingCable({ cableId: cable.id, mode: "attributes" });

  const cat = getCatalog();

  // ── Kabeltyp-Optionen aus Katalog ────────────────────────────────────────
  const typeOptions = cat.voltageLevels
    .map((vl) => {
      const types = cat.cableTypes.filter((t) => t.voltageLevel === vl.id);
      if (types.length === 0) return "";
      const opts = types
        .map(
          (t) =>
            `<option value="${esc(t.id)}" ${t.id === cable.type ? "selected" : ""}>${esc(t.name)} — ${t.maxCurrent} A</option>`
        )
        .join("");
      return `<optgroup label="── ${esc(vl.name)} ${esc(vl.voltage)} ──">${opts}</optgroup>`;
    })
    .join("");

  const fallbackTypeOpt = typeOptions
    ? ""
    : `<option value="${esc(cable.type)}" selected>${esc(cable.typeLabel || cable.type)}</option>`;

  // ── Spannungsebenen-Optionen ─────────────────────────────────────────────
  const voltageOptions = cat.voltageLevels
    .map(
      (vl) =>
        `<option value="${esc(vl.voltage)}" ${vl.voltage === cable.voltage ? "selected" : ""}>${esc(vl.name)} — ${esc(vl.voltage)}</option>`
    )
    .join("");

  const fallbackVoltageOpt = voltageOptions
    ? ""
    : `<option value="${esc(cable.voltage)}" selected>${esc(cable.voltage)}</option>`;

  // ── Status-Optionen ──────────────────────────────────────────────────────
  const statuses: CableStatus[] = ["geplant", "in Bearbeitung", "verlegt", "geprüft"];
  const statusOpts = statuses
    .map((s) => `<option value="${s}" ${s === cable.status ? "selected" : ""}>${esc(s)}</option>`)
    .join("");

  // ── Farb-Optionen ────────────────────────────────────────────────────────
  const colorOpts = COLOR_OPTIONS.map(
    (c) =>
      `<option value="${c.hex}" ${c.hex === cable.color ? "selected" : ""}>${c.name}</option>`
  ).join("");

  // ── Routing-Zusammenfassung ──────────────────────────────────────────────
  const routeCount = cable.trassIds.length;
  const hasRouting = cable.sourceExpressId >= 0 || cable.targetExpressId >= 0;

  const routeSection = hasRouting
    ? `<div class="ce-route-box">
        <div class="ce-route-box-title">
          AKTUELLES ROUTING
          <span class="ce-route-readonly">(nur Anzeige)</span>
        </div>
        <div class="ce-route-row">
          <span>Quelle:</span>
          <span>${esc(cable.sourceLabel || "—")}</span>
        </div>
        <div class="ce-route-row">
          <span>Elemente:</span>
          <span>${routeCount} Element${routeCount !== 1 ? "e" : ""}${cable.length > 0 ? " · " + cable.length + "m" : ""}</span>
        </div>
        <div class="ce-route-row">
          <span>Ziel:</span>
          <span>${esc(cable.targetLabel || "—")}</span>
        </div>
        <button class="ce-routing-btn" id="ce-open-routing">↺ Routing ändern</button>
      </div>`
    : `<div class="ce-route-box ce-route-box--empty">
        <div class="ce-route-box-title">ROUTING</div>
        <div class="ce-route-empty-msg">Noch kein Routing definiert.</div>
        <button class="ce-routing-btn" id="ce-open-routing">↺ Routing definieren</button>
      </div>`;

  // ── Overlay + Modal aufbauen ─────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "ce-overlay";
  overlay.id = "ce-overlay";

  overlay.innerHTML = `
    <div class="ce-modal" id="ce-modal">
      <div class="ce-modal-header">
        <span class="ce-modal-title">
          Kabel bearbeiten —
          <span class="ce-modal-id" style="color:${cable.color}">${esc(cable.id)}</span>
        </span>
        <button class="ce-modal-close" id="ce-close" title="Schliessen">✕</button>
      </div>

      <div class="ce-modal-body">
        <div class="ce-field">
          <label class="ce-label">KABEL-ID</label>
          <input class="ce-input ce-input--readonly" type="text" value="${esc(cable.id)}" readonly>
        </div>

        <div class="ce-field">
          <label class="ce-label">BEZEICHNUNG <span class="ce-required">*</span></label>
          <input class="ce-input" id="ce-name" type="text"
            value="${esc(cable.name)}" placeholder="z.B. Einspeisung UV EG-01">
        </div>

        <div class="ce-field">
          <label class="ce-label">KABELTYP <span class="ce-required">*</span></label>
          <select class="ce-select" id="ce-type">
            ${typeOptions || fallbackTypeOpt}
          </select>
        </div>

        <div class="ce-field">
          <label class="ce-label">SPANNUNGSEBENE <span class="ce-required">*</span></label>
          <select class="ce-select" id="ce-voltage">
            ${voltageOptions || fallbackVoltageOpt}
          </select>
        </div>

        <div class="ce-field">
          <label class="ce-label">FUNKTION / STROMKREIS</label>
          <input class="ce-input" id="ce-circuit" type="text"
            value="${esc(cable.circuit)}" placeholder="z.B. Haupteinspeisung">
        </div>

        <div class="ce-field">
          <label class="ce-label">STATUS</label>
          <select class="ce-select" id="ce-status">${statusOpts}</select>
        </div>

        <div class="ce-field">
          <label class="ce-label">FARBE (3D-Visualisierung)</label>
          <div class="ce-color-row">
            <span class="ce-color-preview" id="ce-color-preview" style="background:${cable.color}"></span>
            <select class="ce-select" id="ce-color">${colorOpts}</select>
          </div>
        </div>

        <div class="ce-field">
          <label class="ce-label">BEMERKUNG</label>
          <textarea class="ce-textarea" id="ce-remarks" rows="3"
            placeholder="Optionale Bemerkungen...">${esc(cable.remarks || "")}</textarea>
        </div>

        ${routeSection}
      </div>

      <div class="ce-modal-footer">
        <button class="ce-btn-primary" id="ce-save">💾 Speichern</button>
        <button class="ce-btn-secondary" id="ce-cancel">Abbrechen</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // ── Farb-Vorschau live aktualisieren ─────────────────────────────────────
  const colorSelect  = document.getElementById("ce-color")         as HTMLSelectElement;
  const colorPreview = document.getElementById("ce-color-preview") as HTMLSpanElement;
  colorSelect.addEventListener("change", () => {
    colorPreview.style.background = colorSelect.value;
  });

  // ── Spannung auto-aktualisieren wenn Kabeltyp gewechselt ─────────────────
  const typeEl    = document.getElementById("ce-type")    as HTMLSelectElement;
  const voltageEl = document.getElementById("ce-voltage") as HTMLSelectElement;
  typeEl.addEventListener("change", () => {
    const chosen = cat.cableTypes.find((t) => t.id === typeEl.value);
    if (chosen) {
      const matchingVl = cat.voltageLevels.find((vl) => vl.id === chosen.voltageLevel);
      if (matchingVl) voltageEl.value = matchingVl.voltage;
    }
  });

  // ── Schliessen ───────────────────────────────────────────────────────────
  function close() {
    overlay.remove();
    setEditingCable(null);
  }

  document.getElementById("ce-close")!.addEventListener("click", close);
  document.getElementById("ce-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if ((e.target as Element).id === "ce-overlay") close();
  });

  // ── Routing-Editor öffnen ────────────────────────────────────────────────
  document.getElementById("ce-open-routing")?.addEventListener("click", () => {
    close();
    void openRoutingEdit(cable);
  });

  // ── Speichern ────────────────────────────────────────────────────────────
  document.getElementById("ce-save")!.addEventListener("click", () => {
    const nameEl    = document.getElementById("ce-name")    as HTMLInputElement;
    const circuitEl = document.getElementById("ce-circuit") as HTMLInputElement;
    const statusEl  = document.getElementById("ce-status")  as HTMLSelectElement;
    const remarksEl = document.getElementById("ce-remarks") as HTMLTextAreaElement;

    const newName = nameEl.value.trim();
    if (!newName) { nameEl.focus(); return; }

    // History-Snapshot: nur geänderte Felder aufzeichnen
    const changedFields: string[] = [];
    const previousValues: Record<string, unknown> = {};

    function track(field: string, oldVal: unknown, newVal: unknown) {
      if (oldVal !== newVal) {
        changedFields.push(field);
        previousValues[field] = oldVal;
      }
    }

    const chosenType = cat.cableTypes.find((t) => t.id === typeEl.value);
    const newTypeLabel = chosenType?.name ?? typeEl.value;

    track("name",     cable.name,              newName);
    track("type",     cable.type,              typeEl.value);
    track("typeLabel",cable.typeLabel,          newTypeLabel);
    track("voltage",  cable.voltage,            voltageEl.value);
    track("circuit",  cable.circuit,            circuitEl.value.trim());
    track("status",   cable.status,             statusEl.value);
    track("color",    cable.color,              colorSelect.value);
    track("remarks",  cable.remarks || "",      remarksEl.value.trim());

    if (changedFields.length > 0) {
      const entry: CableHistoryEntry = {
        changedAt: new Date().toISOString(),
        changedFields,
        previousValues,
      };
      cable.history = cable.history ?? [];
      cable.history.push(entry);
    }

    // Kabel-Objekt aktualisieren
    cable.name      = newName;
    cable.type      = typeEl.value;
    cable.typeLabel = newTypeLabel;
    cable.voltage   = voltageEl.value;
    cable.circuit   = circuitEl.value.trim();
    cable.status    = statusEl.value as CableStatus;
    cable.remarks   = remarksEl.value.trim();
    cable.updatedAt = new Date().toISOString();

    // Farbe + 3D-Linie aktualisieren
    const oldColor = cable.color;
    cable.color = colorSelect.value;
    if (oldColor !== cable.color && _world) {
      const line = _world.scene.three.getObjectByName(`cable-line-${cable.id}`);
      if (line) {
        ((line as THREE.Line).material as THREE.LineBasicMaterial).color.set(cable.color);
      }
    }

    notifyCableChange();
    close();
  });
}
