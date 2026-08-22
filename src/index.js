import { attachCommandHandlers } from "./commands.js";
import { startApiServer } from "./api-server.js";
import { loadConfig } from "./config.js";
import { DiscordGateway, DiscordRest } from "./discord.js";
import { SyncEngine } from "./sync-engine.js";
import { AUTO_SYNC_INTERVAL_MS } from "./sync-policy.js";

const config = loadConfig();
const rest = new DiscordRest(config.discordToken);
const gateway = new DiscordGateway(config.discordToken);
const engine = new SyncEngine(rest, config);
let automationTimer = null;
let shuttingDown = false;
const apiServer = await startApiServer(engine.database, config);

attachCommandHandlers(gateway, rest, config.discordClientId, engine, config.sourceGuildId);

gateway.on("ready", (user) => {
  console.log(`Aurion Sync подключён как ${user.username}#${user.discriminator}`);
  console.log("Aurion Sync — не официальный проект сервера, а разработка от комьюнити. Главный разработчик — Sm1Le.");
  console.log(`Основной сервер: ${config.sourceGuildId}. Ожидаю команду /sync на целевом сервере.`);
  if (!automationTimer) {
    automationTimer = setInterval(() => {
      void runAutomaticSync().catch((error) => console.error("Автосинхронизация:", error));
    }, AUTO_SYNC_INTERVAL_MS);
    automationTimer.unref();
    console.log("Автоматическая проверка основного сервера включена: каждые 15 минут.");
    void runAutomaticSync().catch((error) => console.error("Первичное обновление базы:", error));
  }
});
gateway.on("resumed", () => console.log("Соединение с Discord восстановлено."));
gateway.on("error", (error) => console.error("Discord Gateway:", error));
gateway.on("member_join", (member) => {
  void engine.synchronizeNewMember(member.guild_id, member.user?.id).catch((error) => {
    console.error(`Не удалось синхронизировать нового участника ${member.user?.id ?? "unknown"} на сервере ${member.guild_id}:`, error);
  });
});

async function runAutomaticSync() {
  const results = await engine.synchronizeRegisteredTargets();
  for (const result of results) {
    if (result.error) console.error(`Автосинхронизация ${result.guildId}: ${result.error}`);
    else console.log(`Автосинхронизация ${result.guildId}: ролей +${result.summary.rolesAssigned}/-${result.summary.rolesRemoved}, ников ${result.summary.nicknamesChanged}`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}, отключаюсь...`);
  if (automationTimer) clearInterval(automationTimer);
  gateway.close();
  await new Promise((resolve) => apiServer.close(resolve));
  await engine.close();
  process.exit(0);
}

gateway.connect();
