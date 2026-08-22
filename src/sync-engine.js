import { AurionDatabase } from "./database.js";
import { IGNORED_SOURCE_ROLE_ID, SYNC_MODE_FULL, SYNC_MODE_NICKNAMES, SYNCED_SOURCE_ROLE_IDS } from "./sync-policy.js";

export { IGNORED_SOURCE_ROLE_ID, SYNC_MODE_FULL, SYNC_MODE_NICKNAMES, SYNCED_SOURCE_ROLE_IDS } from "./sync-policy.js";

const ADMINISTRATOR = 1n << 3n;
const MANAGE_NICKNAMES = 1n << 27n;
const MANAGE_ROLES = 1n << 28n;

const SYNCED_SOURCE_ROLE_ID_SET = new Set(SYNCED_SOURCE_ROLE_IDS);

function roleColorPayload(role, targetGuild) {
  if (targetGuild.features?.includes("ENHANCED_ROLE_COLORS") && role.colors && typeof role.colors === "object") {
    return { colors: role.colors };
  }
  return { color: Number(role.colors?.primary_color ?? role.color) || 0 };
}

function eligibleSourceRole(role, sourceGuildId) {
  return role.id !== sourceGuildId && !role.managed && SYNCED_SOURCE_ROLE_ID_SET.has(role.id);
}

function normalizeMode(mode) {
  if (mode === SYNC_MODE_FULL || mode === SYNC_MODE_NICKNAMES) return mode;
  throw new Error("Неизвестный режим синхронизации");
}

function isIgnoredSourceMember(member) {
  return Array.isArray(member.roles) && member.roles.includes(IGNORED_SOURCE_ROLE_ID);
}

function highestRolePosition(member, rolesById) {
  return member.roles.reduce((highest, id) => Math.max(highest, rolesById.get(id)?.position ?? 0), 0);
}

function guildPermissions(member, rolesById, guildId) {
  let permissions = BigInt(rolesById.get(guildId)?.permissions ?? "0");
  for (const id of member.roles) permissions |= BigInt(rolesById.get(id)?.permissions ?? "0");
  return permissions;
}

function hasPermission(permissions, permission) {
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR || (permissions & permission) === permission;
}

export function buildSourceSnapshot(sourceGuildId, roles, members) {
  const memberIdsByRole = new Map(roles.map((role) => [role.id, []]));
  const savedMembers = {};
  for (const member of members) {
    const userId = member.user?.id;
    if (!userId) continue;
    const roleIds = Array.isArray(member.roles) ? member.roles : [];
    savedMembers[userId] = { nick: member.nick ?? null, bot: Boolean(member.user?.bot), roleIds };
    memberIdsByRole.get(sourceGuildId)?.push(userId);
    for (const roleId of roleIds) memberIdsByRole.get(roleId)?.push(userId);
  }
  return {
    guildId: sourceGuildId,
    capturedAt: new Date().toISOString(),
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      color: Number(role.color) || 0,
      ...(role.colors ? { colors: role.colors } : {}),
      managed: Boolean(role.managed),
      isEveryone: role.id === sourceGuildId,
      memberIds: memberIdsByRole.get(role.id) ?? [],
    })),
    members: savedMembers,
  };
}

function resolveTargetRole(sourceRole, targetRoles, mapping, targetGuildId) {
  const mapped = targetRoles.find((role) => role.id === mapping[sourceRole.id] && role.id !== targetGuildId && !role.managed);
  if (mapped) return mapped;
  return targetRoles
    .filter((role) => role.id !== targetGuildId && role.name === sourceRole.name && !role.managed)
    .sort((a, b) => b.position - a.position)[0] ?? null;
}

function preflight(targetGuild, targetRoles, targetMembers, botUserId, mode) {
  const rolesById = new Map(targetRoles.map((role) => [role.id, role]));
  const botMember = targetMembers.find((member) => member.user?.id === botUserId);
  if (!botMember) throw new Error("Бот не найден среди участников целевого сервера");
  const permissions = guildPermissions(botMember, rolesById, targetGuild.id);
  const missing = [];
  if (mode === SYNC_MODE_FULL && !hasPermission(permissions, MANAGE_ROLES)) missing.push("Manage Roles");
  if (!hasPermission(permissions, MANAGE_NICKNAMES)) missing.push("Manage Nicknames");
  if (missing.length) throw new Error(`Боту не хватает прав: ${missing.join(", ")}`);
  const botHighestPosition = highestRolePosition(botMember, rolesById);
  if (botHighestPosition === 0) throw new Error("Роль бота должна находиться выше переносимых ролей и участников");
  return { rolesById, botHighestPosition };
}

async function loadGuildData(rest, guildId) {
  const [guild, roles, members] = await Promise.all([
    rest.getGuild(guildId),
    rest.getGuildRoles(guildId),
    rest.listGuildMembers(guildId),
  ]);
  return { guild, roles, members };
}

export class SyncEngine {
  constructor(rest, config) {
    this.rest = rest;
    this.config = config;
    this.database = new AurionDatabase(config.databaseFile ?? config.stateFile, {
      legacyStateFile: config.legacyStateFile,
      settings: {
        source_guild_id: config.sourceGuildId,
        synced_source_role_ids: SYNCED_SOURCE_ROLE_IDS,
        ignored_source_role_id: IGNORED_SOURCE_ROLE_ID,
        sync_interval_minutes: 15,
      },
    });
    this.queue = Promise.resolve();
    this.automationRunning = false;
  }

  enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async preview(targetGuildId, requestedMode = SYNC_MODE_FULL) {
    const mode = normalizeMode(requestedMode);
    if (targetGuildId === this.config.sourceGuildId) throw new Error("Основной сервер Aurion нельзя синхронизировать сам с собой");
    const [botUser, source, target] = await Promise.all([
      this.rest.getCurrentUser(),
      loadGuildData(this.rest, this.config.sourceGuildId),
      loadGuildData(this.rest, targetGuildId),
    ]);
    const { botHighestPosition } = preflight(target.guild, target.roles, target.members, botUser.id, mode);
    const mapping = this.database.getRoleMappings(targetGuildId);
    const eligibleRoles = mode === SYNC_MODE_FULL
      ? source.roles.filter((role) => eligibleSourceRole(role, this.config.sourceGuildId))
      : [];
    const missingRoles = eligibleRoles.filter((role) => !resolveTargetRole(role, target.roles, mapping, targetGuildId));
    const targetMemberIds = new Set(target.members.map((member) => member.user?.id).filter(Boolean));
    const sharedMembers = source.members.filter((member) => member.user?.id && targetMemberIds.has(member.user.id) && !isIgnoredSourceMember(member));
    const ignoredMembers = source.members.filter((member) => member.user?.id && targetMemberIds.has(member.user.id) && isIgnoredSourceMember(member));
    const blockedExistingRoles = eligibleRoles.filter((role) => {
      const found = resolveTargetRole(role, target.roles, mapping, targetGuildId);
      return found && found.position >= botHighestPosition;
    });
    const gradientDowngrades = target.guild.features?.includes("ENHANCED_ROLE_COLORS") ? 0 : eligibleRoles.filter((role) => role.colors?.secondary_color || role.colors?.tertiary_color).length;
    const warnings = [];
    if (blockedExistingRoles.length) warnings.push(`${blockedExistingRoles.length} существующих ролей находятся не ниже роли бота`);
    if (gradientDowngrades) warnings.push(`${gradientDowngrades} градиентных ролей будут перенесены с основным цветом: целевой сервер не поддерживает Enhanced Role Colors`);
    return {
      mode,
      sourceGuildName: source.guild.name,
      targetGuildName: target.guild.name,
      sourceRoles: eligibleRoles.length,
      rolesToCreate: missingRoles.length,
      sharedMembers: sharedMembers.length,
      ignoredMembers: ignoredMembers.length,
      warnings,
    };
  }

  synchronize(targetGuildId, options = {}) {
    return this.enqueue(() => this.perform(targetGuildId, options));
  }

  async perform(targetGuildId, { mode: requestedMode = SYNC_MODE_FULL, userIds = null, registerTarget = true, trigger = "manual" } = {}) {
    const mode = normalizeMode(requestedMode);
    if (targetGuildId === this.config.sourceGuildId) throw new Error("Основной сервер Aurion нельзя синхронизировать сам с собой");
    const startedAt = new Date().toISOString();
    const summary = { mode, trigger, rolesCreated: 0, rolesUpdated: 0, rolesAssigned: 0, rolesRemoved: 0, nicknamesChanged: 0, sharedMembers: 0, ignoredMembers: 0, skippedBots: 0, failures: [], startedAt, finishedAt: startedAt };
    const [botUser, source, target] = await Promise.all([
      this.rest.getCurrentUser(),
      loadGuildData(this.rest, this.config.sourceGuildId),
      loadGuildData(this.rest, targetGuildId),
    ]);
    this.database.replaceSourceSnapshot(buildSourceSnapshot(this.config.sourceGuildId, source.roles, source.members));

    const { rolesById, botHighestPosition } = preflight(target.guild, target.roles, target.members, botUser.id, mode);
    if (registerTarget) this.database.registerSyncTarget(targetGuildId, mode, startedAt);

    const mapping = this.database.getRoleMappings(targetGuildId);
    const targetRoles = [...target.roles];
    const usableRoles = new Map();

    const rolesToSynchronize = mode === SYNC_MODE_FULL
      ? source.roles.filter((role) => eligibleSourceRole(role, this.config.sourceGuildId))
      : [];
    for (const sourceRole of rolesToSynchronize) {
      try {
        let targetRole = resolveTargetRole(sourceRole, targetRoles, mapping, targetGuildId);
        if (!targetRole) {
          targetRole = await this.rest.createGuildRole(targetGuildId, { name: sourceRole.name, ...roleColorPayload(sourceRole, target.guild), hoist: false, mentionable: false });
          targetRoles.push(targetRole);
          rolesById.set(targetRole.id, targetRole);
          summary.rolesCreated += 1;
        } else if (targetRole.position >= botHighestPosition) {
          throw new Error("существующая роль находится не ниже роли бота");
        } else {
          const sourceColor = Number(sourceRole.colors?.primary_color ?? sourceRole.color ?? 0);
          const targetColor = Number(targetRole.colors?.primary_color ?? targetRole.color ?? 0);
          if (targetRole.name !== sourceRole.name || sourceColor !== targetColor) {
            targetRole = await this.rest.modifyGuildRole(targetGuildId, targetRole.id, { name: sourceRole.name, ...roleColorPayload(sourceRole, target.guild) });
            const index = targetRoles.findIndex((role) => role.id === targetRole.id);
            if (index >= 0) targetRoles[index] = targetRole;
            rolesById.set(targetRole.id, targetRole);
            summary.rolesUpdated += 1;
          }
        }
        mapping[sourceRole.id] = targetRole.id;
        usableRoles.set(sourceRole.id, targetRole);
        this.database.saveRoleMapping(targetGuildId, sourceRole.id, targetRole.id);
      } catch (error) {
        summary.failures.push({ action: "роль", subject: sourceRole.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const targetMembersById = new Map(target.members.filter((member) => member.user?.id).map((member) => [member.user.id, member]));
    const selectedUserIds = userIds ? new Set(userIds) : null;
    for (const sourceMember of source.members) {
      const userId = sourceMember.user?.id;
      if (!userId) continue;
      if (selectedUserIds && !selectedUserIds.has(userId)) continue;
      const targetMember = targetMembersById.get(userId);
      if (!targetMember) continue;
      if (isIgnoredSourceMember(sourceMember)) { summary.ignoredMembers += 1; continue; }
      if (sourceMember.user?.bot || userId === botUser.id) { summary.skippedBots += 1; continue; }
      summary.sharedMembers += 1;
      const targetHighest = highestRolePosition(targetMember, rolesById);
      const manageableMember = userId !== target.guild.owner_id && userId !== botUser.id && targetHighest < botHighestPosition;

      if (mode === SYNC_MODE_FULL) {
        const desiredSourceRoleIds = new Set(sourceMember.roles.filter((roleId) => SYNCED_SOURCE_ROLE_ID_SET.has(roleId)));
        for (const [sourceRoleId, targetRole] of usableRoles) {
          const shouldHaveRole = desiredSourceRoleIds.has(sourceRoleId);
          const hasRole = targetMember.roles.includes(targetRole.id);
          if (shouldHaveRole === hasRole) continue;
          const action = shouldHaveRole ? "выдача роли" : "снятие роли";
          if (!manageableMember) {
            summary.failures.push({ action, subject: `${userId} → ${targetRole.name}`, error: "участник имеет равную/более высокую роль либо является владельцем" });
            continue;
          }
          try {
            if (shouldHaveRole) {
              await this.rest.addGuildMemberRole(targetGuildId, userId, targetRole.id);
              targetMember.roles.push(targetRole.id);
              summary.rolesAssigned += 1;
            } else {
              await this.rest.removeGuildMemberRole(targetGuildId, userId, targetRole.id);
              targetMember.roles = targetMember.roles.filter((roleId) => roleId !== targetRole.id);
              summary.rolesRemoved += 1;
            }
          } catch (error) {
            summary.failures.push({ action, subject: `${userId} → ${targetRole.name}`, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }

      if (sourceMember.nick !== null && sourceMember.nick !== undefined && sourceMember.nick !== targetMember.nick) {
        if (!manageableMember) {
          summary.failures.push({ action: "ник", subject: userId, error: "нельзя изменить ник владельца или участника с равной/более высокой ролью" });
        } else {
          try {
            await this.rest.modifyGuildMember(targetGuildId, userId, { nick: sourceMember.nick });
            summary.nicknamesChanged += 1;
          } catch (error) {
            summary.failures.push({ action: "ник", subject: userId, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }

    summary.finishedAt = new Date().toISOString();
    this.database.saveSyncRun(targetGuildId, summary);
    return summary;
  }

  async refreshSourceSnapshot() {
    return this.enqueue(async () => {
      const [roles, members] = await Promise.all([
        this.rest.getGuildRoles(this.config.sourceGuildId),
        this.rest.listGuildMembers(this.config.sourceGuildId),
      ]);
      const snapshot = buildSourceSnapshot(this.config.sourceGuildId, roles, members);
      this.database.replaceSourceSnapshot(snapshot);
      return snapshot;
    });
  }

  async synchronizeRegisteredTargets() {
    if (this.automationRunning) return [];
    this.automationRunning = true;
    try {
      const targets = this.database.listSyncTargets();
      if (!targets.length) {
        await this.refreshSourceSnapshot();
        return [];
      }
      const results = [];
      for (const settings of targets) {
        const guildId = settings.guildId;
        try {
          const summary = await this.synchronize(guildId, { mode: settings.mode, registerTarget: false, trigger: "scheduled" });
          results.push({ guildId, summary });
        } catch (error) {
          results.push({ guildId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return results;
    } finally {
      this.automationRunning = false;
    }
  }

  async synchronizeNewMember(targetGuildId, userId) {
    if (targetGuildId === this.config.sourceGuildId) return null;
    const settings = this.database.getSyncTarget(targetGuildId);
    if (!settings || settings.enabled === false) return null;
    return this.synchronize(targetGuildId, { mode: settings.mode, userIds: [userId], registerTarget: false, trigger: "member_join" });
  }

  async close() {
    await this.queue.catch(() => undefined);
    this.database.close();
  }
}
