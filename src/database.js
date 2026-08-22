import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

export class AurionDatabase {
  constructor(file, { legacyStateFile, settings = {} } = {}) {
    this.file = file === ":memory:" ? file : path.resolve(file);
    if (this.file !== ":memory:") mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.createSchema();
    this.setSettings(settings);
    if (legacyStateFile) this.migrateLegacyJson(path.resolve(legacyStateFile));
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color INTEGER NOT NULL DEFAULT 0,
        colors_json TEXT,
        managed INTEGER NOT NULL DEFAULT 0,
        is_everyone INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS source_members (
        user_id TEXT PRIMARY KEY,
        nickname TEXT,
        bot INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS source_member_roles (
        user_id TEXT NOT NULL REFERENCES source_members(user_id) ON DELETE CASCADE,
        role_id TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS source_member_roles_role_idx ON source_member_roles(role_id);
      CREATE TABLE IF NOT EXISTS role_mappings (
        target_guild_id TEXT NOT NULL,
        source_role_id TEXT NOT NULL,
        target_role_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (target_guild_id, source_role_id)
      );
      CREATE TABLE IF NOT EXISTS sync_targets (
        guild_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('full', 'nicknames')),
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        guild_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );
    `);
    this.setSetting("schema_version", "1");
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setSetting(key, value) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  getSetting(key) {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  }

  setSettings(settings) {
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) this.setSetting(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }

  replaceSourceSnapshot(snapshot) {
    const insertRole = this.db.prepare("INSERT INTO source_roles(id, name, color, colors_json, managed, is_everyone) VALUES (?, ?, ?, ?, ?, ?)");
    const insertMember = this.db.prepare("INSERT INTO source_members(user_id, nickname, bot) VALUES (?, ?, ?)");
    const insertMemberRole = this.db.prepare("INSERT OR IGNORE INTO source_member_roles(user_id, role_id) VALUES (?, ?)");
    this.transaction(() => {
      this.db.exec("DELETE FROM source_member_roles; DELETE FROM source_members; DELETE FROM source_roles;");
      for (const role of snapshot.roles ?? []) {
        insertRole.run(role.id, role.name, Number(role.color) || 0, role.colors ? JSON.stringify(role.colors) : null, role.managed ? 1 : 0, role.isEveryone ? 1 : 0);
      }
      for (const [userId, member] of Object.entries(snapshot.members ?? {})) {
        insertMember.run(userId, member.nick ?? null, member.bot ? 1 : 0);
        for (const roleId of member.roleIds ?? []) insertMemberRole.run(userId, roleId);
      }
      this.setSetting("source_guild_id", snapshot.guildId);
      this.setSetting("source_snapshot_captured_at", snapshot.capturedAt);
    });
  }

  getSourceSnapshot() {
    const roles = this.db.prepare("SELECT id, name, color, colors_json, managed, is_everyone FROM source_roles ORDER BY id").all().map((role) => ({
      id: role.id,
      name: role.name,
      color: Number(role.color),
      ...(role.colors_json ? { colors: parseJson(role.colors_json, {}) } : {}),
      managed: Boolean(role.managed),
      isEveryone: Boolean(role.is_everyone),
      memberIds: this.db.prepare("SELECT user_id FROM source_member_roles WHERE role_id = ? ORDER BY user_id").all(role.id).map((row) => row.user_id),
    }));
    const members = {};
    for (const member of this.db.prepare("SELECT user_id, nickname, bot FROM source_members ORDER BY user_id").all()) {
      members[member.user_id] = {
        nick: member.nickname,
        bot: Boolean(member.bot),
        roleIds: this.db.prepare("SELECT role_id FROM source_member_roles WHERE user_id = ? ORDER BY role_id").all(member.user_id).map((row) => row.role_id),
      };
    }
    return {
      guildId: this.getSetting("source_guild_id"),
      capturedAt: this.getSetting("source_snapshot_captured_at"),
      roles,
      members,
    };
  }

  getRoleMappings(targetGuildId) {
    return Object.fromEntries(this.db.prepare("SELECT source_role_id, target_role_id FROM role_mappings WHERE target_guild_id = ?").all(targetGuildId).map((row) => [row.source_role_id, row.target_role_id]));
  }

  saveRoleMapping(targetGuildId, sourceRoleId, targetRoleId) {
    this.db.prepare(`
      INSERT INTO role_mappings(target_guild_id, source_role_id, target_role_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(target_guild_id, source_role_id) DO UPDATE SET target_role_id = excluded.target_role_id, updated_at = excluded.updated_at
    `).run(targetGuildId, sourceRoleId, targetRoleId, new Date().toISOString());
  }

  registerSyncTarget(guildId, mode, updatedAt = new Date().toISOString()) {
    this.db.prepare(`
      INSERT INTO sync_targets(guild_id, mode, enabled, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(guild_id) DO UPDATE SET mode = excluded.mode, enabled = 1, updated_at = excluded.updated_at
    `).run(guildId, mode, updatedAt);
  }

  getSyncTarget(guildId) {
    const row = this.db.prepare("SELECT guild_id, mode, enabled, updated_at FROM sync_targets WHERE guild_id = ?").get(guildId);
    return row ? { guildId: row.guild_id, mode: row.mode, enabled: Boolean(row.enabled), updatedAt: row.updated_at } : null;
  }

  listSyncTargets() {
    return this.db.prepare("SELECT guild_id, mode, enabled, updated_at FROM sync_targets WHERE enabled = 1 ORDER BY guild_id").all().map((row) => ({
      guildId: row.guild_id,
      mode: row.mode,
      enabled: Boolean(row.enabled),
      updatedAt: row.updated_at,
    }));
  }

  saveSyncRun(guildId, summary) {
    this.db.prepare(`
      INSERT INTO sync_runs(guild_id, summary_json, finished_at) VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET summary_json = excluded.summary_json, finished_at = excluded.finished_at
    `).run(guildId, JSON.stringify(summary), summary.finishedAt ?? new Date().toISOString());
  }

  getLastSyncRun(guildId) {
    const row = this.db.prepare("SELECT summary_json FROM sync_runs WHERE guild_id = ?").get(guildId);
    return row ? parseJson(row.summary_json, null) : null;
  }

  getApiRoles(allowedRoleIds) {
    if (!allowedRoleIds.length) return [];
    return this.db.prepare(`SELECT id, name, color, colors_json FROM source_roles WHERE managed = 0 AND id IN (${placeholders(allowedRoleIds)}) ORDER BY name, id`).all(...allowedRoleIds).map((role) => ({
      id: role.id,
      name: role.name,
      color: Number(role.color),
      ...(role.colors_json ? { colors: parseJson(role.colors_json, {}) } : {}),
    }));
  }

  getApiMembers({ allowedRoleIds, ignoredRoleId, limit = 250, after = null }) {
    const requestedLimit = Number(limit);
    const safeLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 1_000)) : 250;
    const afterClause = after ? "AND CAST(m.user_id AS INTEGER) > CAST(? AS INTEGER)" : "";
    const params = [ignoredRoleId, ...(after ? [after] : []), safeLimit + 1];
    const rows = this.db.prepare(`
      SELECT m.user_id, m.nickname
      FROM source_members m
      WHERE m.bot = 0
        AND NOT EXISTS (SELECT 1 FROM source_member_roles ignored WHERE ignored.user_id = m.user_id AND ignored.role_id = ?)
        ${afterClause}
      ORDER BY CAST(m.user_id AS INTEGER)
      LIMIT ?
    `).all(...params);
    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit);
    const members = page.map((row) => ({ discordId: row.user_id, nickname: row.nickname, roles: [] }));
    if (members.length && allowedRoleIds.length) {
      const byId = new Map(members.map((member) => [member.discordId, member]));
      const userIds = members.map((member) => member.discordId);
      const roleRows = this.db.prepare(`
        SELECT mr.user_id, r.id, r.name, r.color, r.colors_json
        FROM source_member_roles mr
        JOIN source_roles r ON r.id = mr.role_id
        WHERE mr.user_id IN (${placeholders(userIds)}) AND r.id IN (${placeholders(allowedRoleIds)}) AND r.managed = 0
        ORDER BY r.name, r.id
      `).all(...userIds, ...allowedRoleIds);
      for (const role of roleRows) {
        byId.get(role.user_id)?.roles.push({
          id: role.id,
          name: role.name,
          color: Number(role.color),
          ...(role.colors_json ? { colors: parseJson(role.colors_json, {}) } : {}),
        });
      }
    }
    return {
      capturedAt: this.getSetting("source_snapshot_captured_at"),
      members,
      nextAfter: hasMore ? members.at(-1)?.discordId ?? null : null,
    };
  }

  migrateLegacyJson(file) {
    if (this.getSetting("legacy_json_migrated") || !existsSync(file)) return false;
    const state = parseJson(readFileSync(file, "utf8"));
    if (!state || ![1, 2, 3].includes(state.version)) throw new Error(`Не удалось мигрировать старое состояние ${file}`);
    if (state.sourceSnapshot) this.replaceSourceSnapshot(state.sourceSnapshot);
    for (const [guildId, mapping] of Object.entries(state.roleMappings ?? {})) {
      for (const [sourceRoleId, targetRoleId] of Object.entries(mapping ?? {})) this.saveRoleMapping(guildId, sourceRoleId, targetRoleId);
    }
    const lastRuns = state.lastRuns ?? {};
    const legacyTargetIds = [...new Set([...Object.keys(state.roleMappings ?? {}), ...Object.keys(lastRuns)])];
    const targets = state.syncTargets ?? Object.fromEntries(legacyTargetIds.map((guildId) => [guildId, { mode: "full", enabled: true }]));
    for (const [guildId, settings] of Object.entries(targets)) {
      if (settings?.enabled !== false) this.registerSyncTarget(guildId, settings?.mode ?? "full", settings?.updatedAt);
    }
    for (const [guildId, summary] of Object.entries(lastRuns)) this.saveSyncRun(guildId, summary);
    this.setSetting("legacy_json_migrated", new Date().toISOString());
    return true;
  }

  close() {
    this.db.close();
  }
}
