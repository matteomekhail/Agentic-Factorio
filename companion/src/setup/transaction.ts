import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Snapshot {
  target: string;
  existed: boolean;
  backup?: string;
}

/**
 * Filesystem transaction for setup. Every declared path is snapshotted before
 * the first mutation and restored if any later step fails.
 */
export function setupTransaction<T>(targets: string[], operation: () => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factorio-setup-"));
  const snapshots: Snapshot[] = [];
  try {
    for (const [index, target] of [...new Set(targets)].entries()) {
      if (!fs.existsSync(target)) {
        snapshots.push({ target, existed: false });
        continue;
      }
      const backup = path.join(root, String(index));
      fs.cpSync(target, backup, { recursive: true, preserveTimestamps: true });
      snapshots.push({ target, existed: true, backup });
    }
    return operation();
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of snapshots.reverse()) {
      try {
        fs.rmSync(snapshot.target, { recursive: true, force: true });
        if (snapshot.existed && snapshot.backup) {
          fs.mkdirSync(path.dirname(snapshot.target), { recursive: true });
          fs.cpSync(snapshot.backup, snapshot.target, {
            recursive: true,
            preserveTimestamps: true,
          });
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `${snapshot.target}: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors.map((message) => new Error(message))],
        "setup failed and rollback was incomplete",
      );
    }
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
