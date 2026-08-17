import { randomBytes } from "node:crypto";

const EPHEMERAL = 64;
const ADMINISTRATOR = 1n << 3n;
const CONFIRM_TTL_MS = 2 * 60_000;
const RESPONSE_LIMIT = 1_950;
export const COMMUNITY_DISCLAIMER = "ℹ️ **Aurion Sync — не официальный проект сервера, а разработка от комьюнити. Главный разработчик — Sm1Le.**";

function withDisclaimer(content) {
  const suffix = `\n\n${COMMUNITY_DISCLAIMER}`;
  return `${content.slice(0, RESPONSE_LIMIT - suffix.length)}${suffix}`;
}

export const commandData = [{
  name: "sync",
  description: "Разработка от комьюнити, не официальный проект сервера. Главный разработчик — Sm1Le",
  type: 1,
  default_member_permissions: ADMINISTRATOR.toString(),
  dm_permission: false,
}];

function hasAdministrator(interaction) {
  return (BigInt(interaction.member?.permissions ?? "0") & ADMINISTRATOR) === ADMINISTRATOR;
}

function previewMessage(preview) {
  const lines = [
    "## Aurion Sync — подтверждение",
    `**Источник:** ${preview.sourceGuildName}`,
    `**Целевой сервер:** ${preview.targetGuildName}`,
    `Ролей для синхронизации: **${preview.sourceRoles}**`,
    `Новых ролей будет создано: **${preview.rolesToCreate}**`,
    `Общих участников найдено: **${preview.sharedMembers}**`,
  ];
  if (preview.warnings.length) lines.push("", ...preview.warnings.map((warning) => `⚠️ ${warning}`));
  lines.push("", "Продолжить массовую синхронизацию?");
  return withDisclaimer(lines.join("\n"));
}

export function formatSummary(summary) {
  const lines = [
    summary.failures.length ? "## ⚠️ Aurion Sync завершён с ошибками" : "## ✅ Aurion Sync завершён",
    `Общих участников: **${summary.sharedMembers}**`,
    `Ролей создано: **${summary.rolesCreated}**`,
    `Ролей обновлено: **${summary.rolesUpdated}**`,
    `Ролей выдано: **${summary.rolesAssigned}**`,
    `Ников изменено: **${summary.nicknamesChanged}**`,
  ];
  if (summary.skippedBots) lines.push(`Ботов пропущено: **${summary.skippedBots}**`);
  if (summary.failures.length) {
    lines.push("", `Не удалось выполнить действий: **${summary.failures.length}**`);
    for (const failure of summary.failures.slice(0, 12)) {
      lines.push(`- ${failure.action}: ${failure.subject} — ${failure.error}`);
    }
    if (summary.failures.length > 12) lines.push(`- …ещё ${summary.failures.length - 12}; полный список сохранён в state-файле бота.`);
  }
  return withDisclaimer(lines.join("\n"));
}

function buttons(nonce) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Запустить синхронизацию", custom_id: `aurion-sync:confirm:${nonce}` },
      { type: 2, style: 2, label: "Отмена", custom_id: `aurion-sync:cancel:${nonce}` },
    ],
  }];
}

export function attachCommandHandlers(gateway, rest, clientId, engine, sourceGuildId) {
  const pending = new Map();
  gateway.on("interaction", (interaction) => {
    void handle(interaction).catch(async (error) => {
      const content = withDisclaimer(`❌ ${error instanceof Error ? error.message : String(error)}`);
      try { await rest.editInteraction(clientId, interaction.token, { content, components: [] }); }
      catch { await rest.interactionCallback(interaction, { type: 4, data: { content, flags: EPHEMERAL } }).catch(() => undefined); }
    });
  });

  async function handle(interaction) {
    if (interaction.type === 2 && interaction.data.name === "sync") {
      if (!interaction.guild_id) throw new Error("Команда доступна только на сервере");
      if (!hasAdministrator(interaction)) {
        await rest.interactionCallback(interaction, { type: 4, data: { content: withDisclaimer("Требуются права администратора."), flags: EPHEMERAL } });
        return;
      }
      if (interaction.guild_id === sourceGuildId) {
        await rest.interactionCallback(interaction, { type: 4, data: { content: withDisclaimer("Основной сервер Aurion является источником и не синхронизируется сам с собой."), flags: EPHEMERAL } });
        return;
      }
      await rest.interactionCallback(interaction, { type: 5, data: { flags: EPHEMERAL } });
      const preview = await engine.preview(interaction.guild_id);
      const nonce = randomBytes(12).toString("hex");
      pending.set(nonce, { guildId: interaction.guild_id, userId: interaction.member.user.id, expiresAt: Date.now() + CONFIRM_TTL_MS });
      await rest.editInteraction(clientId, interaction.token, { content: previewMessage(preview), components: buttons(nonce) });
      return;
    }

    if (interaction.type !== 3 || !interaction.data.custom_id?.startsWith("aurion-sync:")) return;
    const [, action, nonce] = interaction.data.custom_id.split(":");
    const request = pending.get(nonce);
    if (!request || request.expiresAt < Date.now()) {
      pending.delete(nonce);
      await rest.interactionCallback(interaction, { type: 7, data: { content: withDisclaimer("⏳ Подтверждение устарело. Запустите `/sync` ещё раз."), components: [] } });
      return;
    }
    if (!hasAdministrator(interaction)) {
      await rest.interactionCallback(interaction, { type: 4, data: { content: withDisclaimer("Права администратора больше не действуют."), flags: EPHEMERAL } });
      return;
    }
    if (interaction.member?.user?.id !== request.userId || interaction.guild_id !== request.guildId) {
      await rest.interactionCallback(interaction, { type: 4, data: { content: withDisclaimer("Подтвердить синхронизацию может только администратор, вызвавший `/sync`."), flags: EPHEMERAL } });
      return;
    }
    pending.delete(nonce);
    if (action === "cancel") {
      await rest.interactionCallback(interaction, { type: 7, data: { content: withDisclaimer("Синхронизация отменена."), components: [] } });
      return;
    }
    if (action !== "confirm") return;
    await rest.interactionCallback(interaction, { type: 6 });
    await rest.editInteraction(clientId, interaction.token, { content: withDisclaimer("⏳ Синхронизация запущена…"), components: [] });
    const summary = await engine.synchronize(request.guildId);
    await rest.editInteraction(clientId, interaction.token, { content: formatSummary(summary), components: [] });
  }
}
