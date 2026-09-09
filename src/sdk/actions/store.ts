import { ActionError } from "./types.ts";

/** Process-local intentions, never reservations or transaction nonces. */
export class PreviewStore<T> {
  private records = new Map<string, { value: T; expires: number }>();
  constructor(private readonly capacity = 1000, private readonly now = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error("preview capacity must be 1–1000");
  }
  put(id: string, value: T, expires: number): void {
    if (!Number.isFinite(expires) || expires <= this.now() || expires > this.now() + 60_000) throw new Error("preview expiry must be within 60 seconds");
    for (const [key, record] of this.records) if (record.expires <= this.now()) this.records.delete(key);
    if (this.records.size >= this.capacity) this.records.delete(this.records.keys().next().value!);
    this.records.set(id, { value: structuredClone(value), expires });
  }
  get(id: string): T {
    const record = this.records.get(id);
    if (!record || record.expires <= this.now()) {
      this.records.delete(id);
      throw new ActionError("STALE_PREVIEW", "Preview missing or expired; create a new preview", false, "previewId", "action_preview");
    }
    return structuredClone(record.value);
  }
}
