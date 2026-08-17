import { attachCommandHandlers } from "./commands.js";
import { loadConfig } from "./config.js";
import { DiscordGateway, DiscordRest } from "./discord.js";
import { SyncEngine } from "./sync-engine.js";

const config = loadConfig();
const rest = new DiscordRest(config.discordToken);
const gateway = new DiscordGateway(config.discordToken);
const engine = new SyncEngine(rest, config);

attachCommandHandlers(gateway, rest, config.discordClientId, engine, config.sourceGuildId);

gateway.on("ready", (user) => {
  console.log(`Aurion Sync подключён как ${user.username}#${user.discriminator}`);
  console.log("Aurion Sync — неофициальный проект комьюнити, созданный игроком Смайл.");
  console.log(`Основной сервер: ${config.sourceGuildId}. Ожидаю команду /sync на целевом сервере.`);
});
gateway.on("resumed", () => console.log("Соединение с Discord восстановлено."));
gateway.on("error", (error) => console.error("Discord Gateway:", error));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`Получен ${signal}, отключаюсь...`);
    gateway.close();
    process.exit(0);
  });
}

gateway.connect();
