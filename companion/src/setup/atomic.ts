import fs from "node:fs";
import path from "node:path";

/** Replace a text file without exposing readers to a partially-written file. */
export function atomicWriteFile(file: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.agentic-${process.pid}-${Date.now()}.tmp`,
  );
  const old = `${temp}.old`;
  try {
    fs.writeFileSync(temp, contents, { encoding: "utf8", mode });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    if (fs.existsSync(file)) fs.renameSync(file, old);
    try {
      fs.renameSync(temp, file);
      fs.rmSync(old, { force: true });
    } catch (error) {
      if (!fs.existsSync(file) && fs.existsSync(old)) fs.renameSync(old, file);
      throw error;
    }
  } catch (error) {
    fs.rmSync(temp, { force: true });
    fs.rmSync(old, { force: true });
    throw error;
  }
}
