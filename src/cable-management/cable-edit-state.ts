// Global edit state — verhindert gleichzeitige Bearbeitung zweier Kabel.

export interface EditingCable {
  cableId: string;
  mode: "attributes" | "routing";
}

let _editingCable: EditingCable | null = null;

export function getEditingCable(): EditingCable | null {
  return _editingCable;
}

export function setEditingCable(state: EditingCable | null): void {
  _editingCable = state;
}

export function showConflictToast(): void {
  const existing = document.querySelector(".ce-conflict-toast");
  if (existing) return;
  const t = document.createElement("div");
  t.className = "ce-conflict-toast";
  t.textContent =
    "Bitte aktuelle Bearbeitung zuerst abschliessen oder abbrechen.";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
