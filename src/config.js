import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

function optional(name) {
  return process.env[name]?.trim() || undefined;
}

export function loadConfig() {
  loadDotEnv();
  const sourceGuildId = optional("SOURCE_GUILD_ID") ?? "1509633054451175575";
  if (!/^\d{15,22}$/.test(sourceGuildId)) throw new Error("SOURCE_GUILD_ID должен быть Discord ID сервера");
  return {
    discordToken: required("DISCORD_TOKEN"),
    discordClientId: required("DISCORD_CLIENT_ID"),
    sourceGuildId,
    stateFile: path.resolve(optional("STATE_FILE") ?? "./data/sync-state.json"),
  };
}
