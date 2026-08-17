import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function loadState(file) {
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    if (state?.version === 1) return { version: 2, roleMappings: {}, lastRuns: {} };
    if (state?.version !== 2 || !state.roleMappings || typeof state.roleMappings !== "object") throw new Error("неподдерживаемый формат");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 2, roleMappings: {}, lastRuns: {} };
    throw new Error(`Не удалось прочитать состояние ${file}`, { cause: error });
  }
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
