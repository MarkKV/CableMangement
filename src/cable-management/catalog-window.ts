import {
  getCatalog,
  saveCableType,
  deleteCableType,
  saveVoltageLevel,
  deleteVoltageLevel,
  exportCatalog,
  importCatalogJson,
  generateId,
  CableType,
  VoltageLevel,
} from "./catalog";

// ─────────────────────────────────────────────────────────────────────────────
// Modul-State
// ─────────────────────────────────────────────────────────────────────────────

type Tab = "cableTypes" | "voltageLevels";

let _win: HTMLDivElement | null = null;
let _activeTab: Tab = "cableTypes";

// Kabeltyp-Formular
let _ctFormOpen = false;
let _ctEditId: string | null = null; // null = neuer Eintrag
let _ctIdAuto = true;                // ID automatisch aus Name generieren?

// Spannungsebene-Formular
let _vlFormOpen = false;
let _vlEditId: string | null = null;
let _vlIdAuto = true;

// Drag
let _dragging = false;
let _dragOffX = 0;
let _dragOffY = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_OPTIONS: { value: string; label: string; hex: string }[] = [
  { value: "black",  label: "Schwarz", hex: "#1a1a1a" },
  { value: "gray",   label: "Grau",    hex: "#888888" },
  { value: "green",  label: "Grün",    hex: "#2d7d2d" },
  { value: "red",    label: "Rot",     hex: "#cc2200" },
  { value: "blue",   label: "Blau",    hex: "#1a3a99" },
];

const FREQ_OPTIONS = ["50 Hz", "60 Hz", "DC"];

const INSTALL_OPTIONS: { value: string; label: string }[] = [
  { value: "tray",        label: "Auf Trasse"  },
  { value: "conduit",     label: "In Rohr"     },
  { value: "underground", label: "Im Erdreich" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hilfs-Funktionen
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colorHex(val: string): string {
  return COLOR_OPTIONS.find((c) => c.value === val)?.hex ?? "#888";
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function showKkToast(msg: string): void {
  const t = document.createElement("div");
  t.className = "rp-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function getInput(id: string): string {
  return (_win!.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "").trim();
}

function getTextarea(id: string): string {
  return (_win!.querySelector<HTMLTextAreaElement>(`#${id}`)?.value ?? "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML-Bausteine — Header + Tabs
// ─────────────────────────────────────────────────────────────────────────────

function buildHeader(): string {
  return `
    <div class="kk-header" id="kk-drag-handle">
      <span class="kk-title">KABELKATALOG — STANDARD</span>
      <div class="kk-header-actions">
        <button class="kk-btn-sm" data-action="export">⬇ Exportieren</button>
        <button class="kk-btn-sm" data-action="import">⬆ Importieren</button>
        <button class="kk-close" data-action="close">✕</button>
      </div>
    </div>`;
}

function buildTabs(): string {
  const active = (t: Tab) => _activeTab === t ? " kk-tab--active" : "";
  return `
    <div class="kk-tabs">
      <button class="kk-tab${active("cableTypes")}"
        data-action="tab" data-tab="cableTypes">KABELTYPEN</button>
      <button class="kk-tab${active("voltageLevels")}"
        data-action="tab" data-tab="voltageLevels">SPANNUNGSEBENEN</button>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML-Bausteine — Tab 1: Kabeltypen
// ─────────────────────────────────────────────────────────────────────────────

function buildCableTypesTable(): string {
  const cat = getCatalog();
  const rows = cat.cableTypes.map((t) => {
    const vl  = cat.voltageLevels.find((v) => v.id === t.voltageLevel);
    const sel = _ctEditId === t.id ? " kk-row--selected" : "";
    return `
      <tr class="kk-row${sel}">
        <td class="kk-td-name" title="${esc(t.name)}">${esc(t.name)}</td>
        <td>${t.crossSection}</td>
        <td>${t.maxCurrent} A</td>
        <td title="${esc(vl?.name ?? t.voltageLevel)}">${esc(vl?.voltage ?? t.voltageLevel)}</td>
        <td>${esc(t.manufacturer || "—")}</td>
        <td><span class="kk-color-dot" style="background:${colorHex(t.color)}"></span></td>
        <td class="kk-td-actions">
          <button class="kk-act-btn" data-action="ct-edit" data-id="${esc(t.id)}" title="Bearbeiten">✎</button>
          <button class="kk-act-btn kk-act-btn--del" data-action="ct-del" data-id="${esc(t.id)}" title="Löschen">✕</button>
        </td>
      </tr>`;
  }).join("");

  const empty = `<tr><td colspan="7" style="text-align:center;color:#446;padding:20px">
    Keine Kabeltypen — klicke "+ Neuer Kabeltyp"</td></tr>`;

  return `
    <div class="kk-table-wrap">
      <table class="kk-table">
        <thead>
          <tr>
            <th>Bezeichnung</th><th>mm²</th><th>Max. A</th>
            <th>Spannung</th><th>Hersteller</th><th>●</th><th></th>
          </tr>
        </thead>
        <tbody>${rows || empty}</tbody>
      </table>
    </div>
    <div class="kk-table-footer">
      <button class="kk-add-btn" data-action="ct-new">+ Neuer Kabeltyp</button>
    </div>`;
}

function buildCableTypeForm(): string {
  if (!_ctFormOpen) {
    return `<div class="kk-form-empty">Wähle einen Kabeltyp zum Bearbeiten<br>oder klicke "+ Neuer Kabeltyp".</div>`;
  }

  const cat   = getCatalog();
  const isNew = _ctEditId === null;
  const t     = isNew ? null : cat.cableTypes.find((x) => x.id === _ctEditId);

  if (!isNew && !t) return `<div class="kk-form-empty">Kabeltyp nicht gefunden.</div>`;

  const title = isNew ? "Neuer Kabeltyp" : `Bearbeiten: ${esc(t!.name)}`;

  const vlOptions = cat.voltageLevels
    .map((v) => `<option value="${esc(v.id)}" ${(t?.voltageLevel ?? "") === v.id ? "selected" : ""}>${esc(v.name)} — ${esc(v.voltage)}</option>`)
    .join("");

  const colorOpts = COLOR_OPTIONS
    .map((c) => `<option value="${c.value}" ${(t?.color ?? "black") === c.value ? "selected" : ""}>${c.label}</option>`)
    .join("");

  const installOpts = INSTALL_OPTIONS
    .map((o) => `<option value="${o.value}" ${(t?.installationType ?? "tray") === o.value ? "selected" : ""}>${o.label}</option>`)
    .join("");

  const conductorOpts = [1, 2, 3, 4, 5]
    .map((n) => `<option value="${n}" ${(t?.conductors ?? 3) === n ? "selected" : ""}>${n}</option>`)
    .join("");

  return `
    <div class="kk-form-title">${title}</div>
    <div class="kk-field">
      <label>BEZEICHNUNG *</label>
      <input id="kk-ct-name" type="text" placeholder="z.B. NYY-J 3×6 mm²"
        value="${esc(t?.name ?? "")}">
    </div>
    <div class="kk-field">
      <label>NORM-KURZBEZEICHNUNG (ID)</label>
      <input id="kk-ct-id" type="text" placeholder="z.B. NYY-J-3x6"
        value="${esc(t?.id ?? "")}" ${isNew ? "" : "readonly style=\"opacity:0.5\""}>
      <div class="kk-hint">${isNew
        ? "Wird automatisch aus Bezeichnung generiert — kann manuell geändert werden"
        : "ID kann nach dem Anlegen nicht mehr geändert werden"}</div>
    </div>
    <div class="kk-field-row">
      <div class="kk-field">
        <label>QUERSCHNITT (mm²) *</label>
        <input id="kk-ct-cs" type="number" step="0.1" min="0.1" placeholder="z.B. 6"
          value="${t?.crossSection ?? ""}">
      </div>
      <div class="kk-field">
        <label>MAX. STROM Iz (A) *</label>
        <input id="kk-ct-mc" type="number" min="1" placeholder="z.B. 38"
          value="${t?.maxCurrent ?? ""}">
      </div>
    </div>
    <div class="kk-field">
      <label>VERLEGEART</label>
      <select id="kk-ct-it">${installOpts}</select>
    </div>
    <div class="kk-field">
      <label>SPANNUNGSEBENE *</label>
      <select id="kk-ct-vl">
        <option value="">— bitte wählen —</option>
        ${vlOptions}
      </select>
    </div>
    <div class="kk-field-row">
      <div class="kk-field">
        <label>ANZAHL LEITER</label>
        <select id="kk-ct-cond">${conductorOpts}</select>
      </div>
      <div class="kk-field">
        <label>LEITERMATERIAL</label>
        <select id="kk-ct-mat">
          <option value="copper"   ${(t?.material ?? "copper") === "copper"   ? "selected" : ""}>Kupfer</option>
          <option value="aluminum" ${(t?.material)              === "aluminum" ? "selected" : ""}>Aluminium</option>
        </select>
      </div>
    </div>
    <div class="kk-field">
      <label>MANTELFARBE</label>
      <select id="kk-ct-color">${colorOpts}</select>
    </div>
    <div class="kk-field">
      <label>HERSTELLER</label>
      <input id="kk-ct-manuf" type="text" placeholder="optional" value="${esc(t?.manufacturer ?? "")}">
    </div>
    <div class="kk-field">
      <label>ARTIKELNUMMER</label>
      <input id="kk-ct-art" type="text" placeholder="optional" value="${esc(t?.articleNumber ?? "")}">
    </div>
    <div class="kk-field">
      <label>BEMERKUNG</label>
      <textarea id="kk-ct-notes" rows="2">${esc(t?.notes ?? "")}</textarea>
    </div>
    <div class="kk-form-actions">
      <button class="kk-btn-primary" data-action="ct-save">💾 Speichern</button>
      <button class="kk-btn-secondary" data-action="ct-cancel">Abbrechen</button>
    </div>`;
}

function buildCableTypesTab(): string {
  return `
    <div class="kk-split">
      <div class="kk-split-left">${buildCableTypesTable()}</div>
      <div class="kk-split-right">${buildCableTypeForm()}</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML-Bausteine — Tab 2: Spannungsebenen
// ─────────────────────────────────────────────────────────────────────────────

function buildVoltageLevelsTable(): string {
  const cat  = getCatalog();
  const rows = cat.voltageLevels.map((v) => {
    const sel = _vlEditId === v.id ? " kk-row--selected" : "";
    return `
      <tr class="kk-row${sel}">
        <td class="kk-td-name" title="${esc(v.name)}">${esc(v.name)}</td>
        <td>${esc(v.voltage)}</td>
        <td>${esc(v.frequency)}</td>
        <td><span class="kk-color-dot" style="background:${esc(v.color)}"></span></td>
        <td class="kk-td-actions">
          <button class="kk-act-btn" data-action="vl-edit" data-id="${esc(v.id)}" title="Bearbeiten">✎</button>
          <button class="kk-act-btn kk-act-btn--del" data-action="vl-del" data-id="${esc(v.id)}" title="Löschen">✕</button>
        </td>
      </tr>`;
  }).join("");

  const empty = `<tr><td colspan="5" style="text-align:center;color:#446;padding:20px">
    Keine Spannungsebenen — klicke "+ Neue Spannungsebene"</td></tr>`;

  return `
    <div class="kk-table-wrap">
      <table class="kk-table">
        <thead>
          <tr>
            <th>Bezeichnung</th><th>Spannung</th><th>Frequenz</th><th>●</th><th></th>
          </tr>
        </thead>
        <tbody>${rows || empty}</tbody>
      </table>
    </div>
    <div class="kk-table-footer">
      <button class="kk-add-btn" data-action="vl-new">+ Neue Spannungsebene</button>
    </div>`;
}

function buildVoltageLevelForm(): string {
  if (!_vlFormOpen) {
    return `<div class="kk-form-empty">Wähle eine Spannungsebene zum Bearbeiten<br>oder klicke "+ Neue Spannungsebene".</div>`;
  }

  const cat   = getCatalog();
  const isNew = _vlEditId === null;
  const v     = isNew ? null : cat.voltageLevels.find((x) => x.id === _vlEditId);

  if (!isNew && !v) return `<div class="kk-form-empty">Spannungsebene nicht gefunden.</div>`;

  const title = isNew ? "Neue Spannungsebene" : `Bearbeiten: ${esc(v!.name)}`;

  const freqOpts = FREQ_OPTIONS
    .map((f) => `<option value="${f}" ${(v?.frequency ?? "50 Hz") === f ? "selected" : ""}>${f}</option>`)
    .join("");

  return `
    <div class="kk-form-title">${title}</div>
    <div class="kk-field">
      <label>BEZEICHNUNG *</label>
      <input id="kk-vl-name" type="text" placeholder="z.B. Niederspannung"
        value="${esc(v?.name ?? "")}">
    </div>
    <div class="kk-field">
      <label>KURZBEZEICHNUNG (ID)</label>
      <input id="kk-vl-id" type="text" placeholder="z.B. 0.6-1kV"
        value="${esc(v?.id ?? "")}" ${isNew ? "" : "readonly style=\"opacity:0.5\""}>
      <div class="kk-hint">${isNew
        ? "Wird automatisch aus Bezeichnung generiert"
        : "Kann nicht geändert werden"}</div>
    </div>
    <div class="kk-field">
      <label>NENNSPANNUNG *</label>
      <input id="kk-vl-volt" type="text" placeholder="z.B. 0,6/1 kV"
        value="${esc(v?.voltage ?? "")}">
    </div>
    <div class="kk-field-row">
      <div class="kk-field">
        <label>FREQUENZ</label>
        <select id="kk-vl-freq">${freqOpts}</select>
      </div>
      <div class="kk-field">
        <label>FARBE</label>
        <input id="kk-vl-color" type="color" value="${esc(v?.color ?? "#3d8bff")}"
          style="height:30px;padding:2px;width:100%;cursor:pointer">
      </div>
    </div>
    <div class="kk-field">
      <label>BEMERKUNG</label>
      <textarea id="kk-vl-notes" rows="3">${esc(v?.notes ?? "")}</textarea>
    </div>
    <div class="kk-form-actions">
      <button class="kk-btn-primary" data-action="vl-save">💾 Speichern</button>
      <button class="kk-btn-secondary" data-action="vl-cancel">Abbrechen</button>
    </div>`;
}

function buildVoltageLevelsTab(): string {
  return `
    <div class="kk-split">
      <div class="kk-split-left">${buildVoltageLevelsTable()}</div>
      <div class="kk-split-right">${buildVoltageLevelForm()}</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Haupt-Render
// ─────────────────────────────────────────────────────────────────────────────

function renderAll(): void {
  if (!_win) return;
  _win.innerHTML =
    buildHeader() +
    buildTabs() +
    `<div class="kk-content">${
      _activeTab === "cableTypes"
        ? buildCableTypesTab()
        : buildVoltageLevelsTab()
    }</div>`;

  setupHeaderDrag();
}

// ─────────────────────────────────────────────────────────────────────────────
// Speichern-Funktionen (lesen aus DOM, validieren, im Katalog speichern)
// ─────────────────────────────────────────────────────────────────────────────

function saveCableTypeFromForm(): boolean {
  const id           = getInput("kk-ct-id");
  const name         = getInput("kk-ct-name");
  const crossSection = parseFloat(getInput("kk-ct-cs"));
  const maxCurrent   = parseFloat(getInput("kk-ct-mc"));
  const voltageLevel = getInput("kk-ct-vl");
  const installationType = getInput("kk-ct-it") as CableType["installationType"];
  const conductors   = parseInt(getInput("kk-ct-cond"), 10) || 3;
  const material     = getInput("kk-ct-mat") as CableType["material"];
  const color        = getInput("kk-ct-color");
  const manufacturer = getInput("kk-ct-manuf");
  const articleNumber = getInput("kk-ct-art");
  const notes        = getTextarea("kk-ct-notes");

  if (!name)         { showKkToast("Bitte Bezeichnung angeben");       return false; }
  if (!id)           { showKkToast("Bitte ID angeben");                return false; }
  if (isNaN(crossSection) || crossSection <= 0) { showKkToast("Ungültiger Querschnitt"); return false; }
  if (isNaN(maxCurrent)   || maxCurrent   <= 0) { showKkToast("Ungültiger Maximalstrom"); return false; }
  if (!voltageLevel) { showKkToast("Bitte Spannungsebene wählen");     return false; }

  // Doppelte ID bei Neuanlage verhindern
  const cat = getCatalog();
  if (_ctEditId === null && cat.cableTypes.some((t) => t.id === id)) {
    showKkToast("Diese ID existiert bereits");
    return false;
  }

  const existing = _ctEditId ? cat.cableTypes.find((t) => t.id === _ctEditId) : null;
  const type: CableType = {
    id:              _ctEditId ?? id,
    name, crossSection, maxCurrent, installationType, voltageLevel,
    conductors, material, color, manufacturer, articleNumber, notes,
    createdAt: existing?.createdAt ?? today(),
    updatedAt: today(),
  };

  saveCableType(type);
  return true;
}

function saveVoltageLevelFromForm(): boolean {
  const id        = getInput("kk-vl-id");
  const name      = getInput("kk-vl-name");
  const voltage   = getInput("kk-vl-volt");
  const frequency = getInput("kk-vl-freq");
  const color     = (_win!.querySelector<HTMLInputElement>("#kk-vl-color")?.value ?? "#3d8bff");
  const notes     = getTextarea("kk-vl-notes");

  if (!name)    { showKkToast("Bitte Bezeichnung angeben");  return false; }
  if (!id)      { showKkToast("Bitte ID angeben");           return false; }
  if (!voltage) { showKkToast("Bitte Nennspannung angeben"); return false; }

  const cat = getCatalog();
  if (_vlEditId === null && cat.voltageLevels.some((v) => v.id === id)) {
    showKkToast("Diese ID existiert bereits");
    return false;
  }

  const level: VoltageLevel = { id: _vlEditId ?? id, name, voltage, frequency, color, notes };
  saveVoltageLevel(level);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event-Handler (Event Delegation auf _win)
// ─────────────────────────────────────────────────────────────────────────────

function onWinClick(e: Event): void {
  const btn = (e.target as Element).closest<HTMLElement>("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action!;

  switch (action) {

    case "close":
      closeCatalogWindow();
      break;

    case "tab":
      _activeTab = btn.dataset.tab as Tab;
      renderAll();
      break;

    case "export":
      exportCatalog();
      break;

    case "import":
      triggerImport();
      break;

    // ── Kabeltypen ──────────────────────────────────────────────────────────

    case "ct-new":
      _ctFormOpen = true;
      _ctEditId   = null;
      _ctIdAuto   = true;
      renderAll();
      setTimeout(() => _win?.querySelector<HTMLInputElement>("#kk-ct-name")?.focus(), 30);
      break;

    case "ct-edit":
      _ctFormOpen = true;
      _ctEditId   = btn.dataset.id!;
      _ctIdAuto   = false;
      renderAll();
      break;

    case "ct-del": {
      const id  = btn.dataset.id!;
      const cat = getCatalog();
      const t   = cat.cableTypes.find((x) => x.id === id);
      if (!t) break;
      if (!confirm(`Kabeltyp "${t.name}" wirklich löschen?`)) break;
      deleteCableType(id);
      if (_ctEditId === id) { _ctFormOpen = false; _ctEditId = null; }
      renderAll();
      break;
    }

    case "ct-save":
      if (saveCableTypeFromForm()) {
        _ctFormOpen = false;
        _ctEditId   = null;
        _ctIdAuto   = true;
        renderAll();
        showKkToast("Kabeltyp gespeichert");
      }
      break;

    case "ct-cancel":
      _ctFormOpen = false;
      _ctEditId   = null;
      _ctIdAuto   = true;
      renderAll();
      break;

    // ── Spannungsebenen ─────────────────────────────────────────────────────

    case "vl-new":
      _vlFormOpen = true;
      _vlEditId   = null;
      _vlIdAuto   = true;
      renderAll();
      setTimeout(() => _win?.querySelector<HTMLInputElement>("#kk-vl-name")?.focus(), 30);
      break;

    case "vl-edit":
      _vlFormOpen = true;
      _vlEditId   = btn.dataset.id!;
      _vlIdAuto   = false;
      renderAll();
      break;

    case "vl-del": {
      const id  = btn.dataset.id!;
      const cat = getCatalog();
      const v   = cat.voltageLevels.find((x) => x.id === id);
      if (!v) break;
      const used = cat.cableTypes.filter((t) => t.voltageLevel === id);
      if (used.length > 0) {
        alert(`"${v.name}" wird von ${used.length} Kabeltyp(en) verwendet und kann nicht gelöscht werden.`);
        break;
      }
      if (!confirm(`Spannungsebene "${v.name}" wirklich löschen?`)) break;
      deleteVoltageLevel(id);
      if (_vlEditId === id) { _vlFormOpen = false; _vlEditId = null; }
      renderAll();
      break;
    }

    case "vl-save":
      if (saveVoltageLevelFromForm()) {
        _vlFormOpen = false;
        _vlEditId   = null;
        _vlIdAuto   = true;
        renderAll();
        showKkToast("Spannungsebene gespeichert");
      }
      break;

    case "vl-cancel":
      _vlFormOpen = false;
      _vlEditId   = null;
      _vlIdAuto   = true;
      renderAll();
      break;
  }
}

function onWinInput(e: Event): void {
  const target = e.target as HTMLInputElement;

  // Kabeltyp-Name → auto ID
  if (target.id === "kk-ct-name" && _ctIdAuto && _ctEditId === null) {
    const idEl = _win!.querySelector<HTMLInputElement>("#kk-ct-id");
    if (idEl) idEl.value = generateId(target.value);
  }
  // Manuelle Bearbeitung des ID-Felds → auto-Modus aus
  if (target.id === "kk-ct-id") _ctIdAuto = false;

  // Spannungsebene-Name → auto ID
  if (target.id === "kk-vl-name" && _vlIdAuto && _vlEditId === null) {
    const idEl = _win!.querySelector<HTMLInputElement>("#kk-vl-id");
    if (idEl) idEl.value = generateId(target.value);
  }
  if (target.id === "kk-vl-id") _vlIdAuto = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Datei-Import
// ─────────────────────────────────────────────────────────────────────────────

function triggerImport(): void {
  const input    = document.createElement("input");
  input.type     = "file";
  input.accept   = ".json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (!confirm("Bestehender Katalog wird überschrieben. Fortfahren?")) return;
      if (importCatalogJson(reader.result as string)) {
        // Formular-State zurücksetzen
        _ctFormOpen = false; _ctEditId = null;
        _vlFormOpen = false; _vlEditId = null;
        renderAll();
        showKkToast("Katalog erfolgreich importiert");
      } else {
        showKkToast("Import fehlgeschlagen — ungültige Datei");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag & Drop am Header
// ─────────────────────────────────────────────────────────────────────────────

function setupHeaderDrag(): void {
  const handle = _win!.querySelector<HTMLElement>("#kk-drag-handle");
  if (!handle) return;
  handle.addEventListener("mousedown", (e: MouseEvent) => {
    if ((e.target as Element).closest("[data-action]")) return;
    _dragging  = true;
    const rect = _win!.getBoundingClientRect();
    _dragOffX  = e.clientX - rect.left;
    _dragOffY  = e.clientY - rect.top;
    e.preventDefault();
  });
}

function ensureGlobalDragListeners(): void {
  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!_dragging || !_win) return;
    _win.style.left      = `${e.clientX - _dragOffX}px`;
    _win.style.top       = `${e.clientY - _dragOffY}px`;
    _win.style.transform = "none"; // zentrierendes transform nach erstem Drag entfernen
  });
  document.addEventListener("mouseup", () => { _dragging = false; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Öffentliche API
// ─────────────────────────────────────────────────────────────────────────────

export function openCatalogWindow(): void {
  if (!_win) {
    _win = document.createElement("div");
    _win.id        = "kk-window";
    _win.className = "kk-window";
    document.body.appendChild(_win);

    _win.addEventListener("click", onWinClick);
    _win.addEventListener("input", onWinInput);
    ensureGlobalDragListeners();
  }

  renderAll();
  _win.style.display = "flex";
}

export function closeCatalogWindow(): void {
  if (_win) _win.style.display = "none";
}
