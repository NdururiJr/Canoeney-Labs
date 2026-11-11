import type { Clock } from "../clock";
import type { CompanyDb } from "../db";
import { MEMORY_VALUE_MAX_BYTES, type Memory, type MemoryEntry, type MemoryScope } from "./types";

export class SqliteMemory implements Memory {
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
  ) {}

  get(s: MemoryScope, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM memory_items WHERE scope_kind = ? AND scope_id = ? AND key = ?")
      .get<{ value: string }>(s.kind, s.id, key);
    return row ? row.value : null;
  }

  set(s: MemoryScope, key: string, value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MEMORY_VALUE_MAX_BYTES) {
      throw new RangeError(`memory value is ${bytes} bytes; the limit is ${MEMORY_VALUE_MAX_BYTES}`);
    }
    this.db
      .prepare(
        `INSERT INTO memory_items(scope_kind, scope_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_kind, scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(s.kind, s.id, key, value, this.clock.now().toISOString());
  }

  delete(s: MemoryScope, key: string): boolean {
    const r = this.db
      .prepare("DELETE FROM memory_items WHERE scope_kind = ? AND scope_id = ? AND key = ?")
      .run(s.kind, s.id, key);
    return r.changes > 0;
  }

  list(s: MemoryScope): MemoryEntry[] {
    // Rows from the driver have a null prototype; copy into plain objects.
    return this.db
      .prepare(
        "SELECT key, value, updated_at AS updatedAt FROM memory_items WHERE scope_kind = ? AND scope_id = ? ORDER BY key",
      )
      .all<MemoryEntry>(s.kind, s.id)
      .map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt }));
  }
}
