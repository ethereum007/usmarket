/** Account-scoped browser convenience only; never hosted persistence. */
export type BrowserNotes = Record<string, { note: string; saved: boolean }>;
type NoteStorage = Pick<Storage, "getItem" | "setItem">;
export function notesKey(owner: string | undefined): string | null {
  if (!owner || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner)) return null;
  return `usmarket-browser-notes-v2:${owner}`;
}
export function readNotes(storage: NoteStorage, owner: string | undefined): BrowserNotes {
  const key = notesKey(owner);
  if (!key) return {};
  const saved: unknown = JSON.parse(storage.getItem(key) || "{}");
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter(([symbol, value]) =>
    /^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol) && value && typeof value === "object" &&
    typeof value.note === "string" && typeof value.saved === "boolean"));
}
export function writeNotes(storage: NoteStorage, owner: string | undefined, notes: BrowserNotes): void {
  const key = notesKey(owner);
  if (key) storage.setItem(key, JSON.stringify(notes));
}
