// Kabelkatalog — Datenmodell, localStorage-Persistenz, Standarddaten
// Zukünftig: PostgreSQL als Backend. Heute: localStorage als Zwischenlösung.

const STORAGE_KEY = "cablemgr_catalog_default";

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

export interface VoltageLevel {
  id: string;        // z.B. "0.6-1kV"
  name: string;      // z.B. "Niederspannung"
  voltage: string;   // z.B. "0,6/1 kV"
  frequency: string; // "50 Hz" | "60 Hz" | "DC"
  color: string;     // Hex-Farbe für visuelle Unterscheidung
  notes: string;
}

export interface CableType {
  id: string;               // z.B. "NYY-J-3x6"
  name: string;             // z.B. "NYY-J 3×6 mm²"
  crossSection: number;     // mm²
  maxCurrent: number;       // A
  installationType: "tray" | "conduit" | "underground";
  voltageLevel: string;     // Referenz auf VoltageLevel.id
  conductors: number;       // Anzahl Leiter
  material: "copper" | "aluminum";
  color: string;            // Mantelfarbe (z.B. "black")
  manufacturer: string;
  articleNumber: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Catalog {
  cableTypes: CableType[];
  voltageLevels: VoltageLevel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Standarddaten (beim ersten Start geladen)
// ─────────────────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().split("T")[0];
}

const DEFAULT_VOLTAGE_LEVELS: VoltageLevel[] = [
  { id: "0.6-1kV",  name: "Niederspannung", voltage: "0,6/1 kV", frequency: "50 Hz", color: "#3d8bff", notes: "" },
  { id: "230V-AC",  name: "230V AC",         voltage: "230 V",    frequency: "50 Hz", color: "#f0b429", notes: "" },
  { id: "400V-AC",  name: "400V AC",         voltage: "400 V",    frequency: "50 Hz", color: "#ff6b35", notes: "" },
  { id: "24V-DC",   name: "24V DC",          voltage: "24 V",     frequency: "DC",    color: "#00e67a", notes: "" },
];

function mkType(
  id: string, name: string, crossSection: number, maxCurrent: number, voltageLevel: string
): CableType {
  const d = today();
  return {
    id, name, crossSection, maxCurrent,
    installationType: "tray", voltageLevel, conductors: 3,
    material: "copper", color: "black",
    manufacturer: "", articleNumber: "", notes: "",
    createdAt: d, updatedAt: d,
  };
}

const DEFAULT_CABLE_TYPES: CableType[] = [
  mkType("NYY-J-3x1.5",  "NYY-J 3×1,5 mm²",   1.5,   16, "0.6-1kV"),
  mkType("NYY-J-3x2.5",  "NYY-J 3×2,5 mm²",   2.5,   23, "0.6-1kV"),
  mkType("NYY-J-3x4",    "NYY-J 3×4 mm²",      4,     30, "0.6-1kV"),
  mkType("NYY-J-3x6",    "NYY-J 3×6 mm²",      6,     38, "0.6-1kV"),
  mkType("NYY-J-3x10",   "NYY-J 3×10 mm²",    10,     52, "0.6-1kV"),
  mkType("NYY-J-3x16",   "NYY-J 3×16 mm²",    16,     69, "0.6-1kV"),
  mkType("NYY-J-3x25",   "NYY-J 3×25 mm²",    25,     90, "0.6-1kV"),
  mkType("NYY-J-3x35",   "NYY-J 3×35 mm²",    35,    111, "0.6-1kV"),
  mkType("NYCWY-3x35",   "NYCWY 3×35 mm²",    35,    135, "0.6-1kV"),
  mkType("NYCWY-3x50",   "NYCWY 3×50 mm²",    50,    160, "0.6-1kV"),
  mkType("NYCWY-3x95",   "NYCWY 3×95 mm²",    95,    250, "0.6-1kV"),
  mkType("NYCWY-3x150",  "NYCWY 3×150 mm²",  150,    320, "0.6-1kV"),
];

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + Persistenz
// ─────────────────────────────────────────────────────────────────────────────

let _catalog: Catalog | null = null;
const _listeners: Array<() => void> = [];

function loadFromStorage(): Catalog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Catalog;
      if (Array.isArray(parsed.cableTypes) && Array.isArray(parsed.voltageLevels)) {
        return parsed;
      }
    }
  } catch {
    // Ungültige Daten → Standarddaten verwenden
  }
  return {
    cableTypes: DEFAULT_CABLE_TYPES.map((t) => ({ ...t })),
    voltageLevels: DEFAULT_VOLTAGE_LEVELS.map((v) => ({ ...v })),
  };
}

export function getCatalog(): Catalog {
  if (!_catalog) _catalog = loadFromStorage();
  return _catalog;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_catalog));
  } catch {
    console.warn("[Catalog] localStorage-Schreibfehler");
  }
  for (const fn of _listeners) fn();
}

export function addCatalogChangeListener(fn: () => void): void {
  _listeners.push(fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kabeltypen CRUD
// ─────────────────────────────────────────────────────────────────────────────

export function saveCableType(type: CableType): void {
  const cat = getCatalog();
  const idx = cat.cableTypes.findIndex((t) => t.id === type.id);
  if (idx !== -1) {
    cat.cableTypes[idx] = { ...type, updatedAt: today() };
  } else {
    cat.cableTypes.push({ ...type, createdAt: today(), updatedAt: today() });
  }
  persist();
}

export function deleteCableType(id: string): void {
  const cat = getCatalog();
  const idx = cat.cableTypes.findIndex((t) => t.id === id);
  if (idx !== -1) cat.cableTypes.splice(idx, 1);
  persist();
}

// ─────────────────────────────────────────────────────────────────────────────
// Spannungsebenen CRUD
// ─────────────────────────────────────────────────────────────────────────────

export function saveVoltageLevel(level: VoltageLevel): void {
  const cat = getCatalog();
  const idx = cat.voltageLevels.findIndex((v) => v.id === level.id);
  if (idx !== -1) {
    cat.voltageLevels[idx] = { ...level };
  } else {
    cat.voltageLevels.push({ ...level });
  }
  persist();
}

export function deleteVoltageLevel(id: string): void {
  const cat = getCatalog();
  const idx = cat.voltageLevels.findIndex((v) => v.id === id);
  if (idx !== -1) cat.voltageLevels.splice(idx, 1);
  persist();
}

// ─────────────────────────────────────────────────────────────────────────────
// Export / Import
// ─────────────────────────────────────────────────────────────────────────────

export function exportCatalog(): void {
  const json = JSON.stringify(getCatalog(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "kabelkatalog.json";
  a.click();
  URL.revokeObjectURL(url);
}

export function importCatalogJson(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as Catalog;
    if (!Array.isArray(parsed.cableTypes) || !Array.isArray(parsed.voltageLevels)) {
      return false;
    }
    _catalog = parsed;
    persist();
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ID-Generierung aus Bezeichnung
// ─────────────────────────────────────────────────────────────────────────────

export function generateId(name: string): string {
  return name
    .trim()
    .replace(/[×x]/gi, "x")
    .replace(/[²]/g, "2")
    .replace(/\s+/g, "-")
    .replace(/,/g, ".")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
