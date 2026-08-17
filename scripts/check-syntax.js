import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const file of readdirSync("src").filter((name) => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", `src/${file}`], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
console.log("Синтаксис всех файлов src/*.js корректен.");
