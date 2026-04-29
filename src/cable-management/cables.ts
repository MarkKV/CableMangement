export type CableStatus = "in Bearbeitung" | "geplant";

export interface Cable {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  circuit: string;
  voltage: string;
  sourceModelId: string;
  sourceExpressId: number;
  sourceLabel: string;
  targetModelId: string;
  targetExpressId: number;
  targetLabel: string;
  trassIds: { modelId: string; expressId: number }[];
  status: CableStatus;
  color: string;
  length: number;
}

export const CABLE_COLORS = [
  "#3d8bff", "#ff8c00", "#00e67a", "#ff4455",
  "#c87aff", "#00d4ff", "#ffdd00", "#ff69b4",
];

export const CABLE_TYPES = [
  { value: "NYY-J-3x1.5", label: "NYY-J 3×1,5 mm²  — max. 16A" },
  { value: "NYY-J-3x2.5", label: "NYY-J 3×2,5 mm²  — max. 23A" },
  { value: "NYY-J-3x4",   label: "NYY-J 3×4 mm²  — max. 30A" },
  { value: "NYY-J-3x6",   label: "NYY-J 3×6 mm²  — max. 38A" },
  { value: "NYY-J-3x10",  label: "NYY-J 3×10 mm²  — max. 52A" },
  { value: "NYY-J-3x16",  label: "NYY-J 3×16 mm²  — max. 69A" },
  { value: "NYCWY-3x35",  label: "NYCWY 3×35 mm²  — max. 135A" },
  { value: "NYCWY-3x95",  label: "NYCWY 3×95 mm²  — max. 250A" },
];

export const VOLTAGE_OPTIONS = ["400V AC", "230V AC", "24V DC", "690V AC"];

export const cableRegistry: Cable[] = [];

let _idCounter = 1;
export const nextCableId = () =>
  `KAB-${String(_idCounter++).padStart(3, "0")}`;

export const getNextColor = () =>
  CABLE_COLORS[cableRegistry.length % CABLE_COLORS.length];

// ── Change notification (toolbar count, window refresh) ───────────────────
const _changeListeners: Array<() => void> = [];

export function addCableChangeListener(fn: () => void): void {
  if (!_changeListeners.includes(fn)) _changeListeners.push(fn);
}

export function notifyCableChange(): void {
  for (const fn of _changeListeners) fn();
}
