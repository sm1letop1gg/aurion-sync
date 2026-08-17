import { commandData } from "./commands.js";
import { loadConfig } from "./config.js";
import { DiscordRest } from "./discord.js";

const config = loadConfig();
const rest = new DiscordRest(config.discordToken);
await rest.registerGlobalCommands(config.discordClientId, commandData);
console.log(`Зарегистрировано глобальных команд: ${commandData.length}`);
