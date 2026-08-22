import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSourceSnapshot, IGNORED_SOURCE_ROLE_ID, SYNC_MODE_NICKNAMES, SYNCED_SOURCE_ROLE_IDS, SyncEngine } from "../src/sync-engine.js";

const SOURCE = "1509633054451175575";
const TARGET = "2509633054451175575";
const BOT = "3509633054451175575";
const SYNC_ROLE = SYNCED_SOURCE_ROLE_IDS[0];
const OTHER_ROLE = "4509633054451175575";
const MANAGE_NICKNAMES = String(1n << 27n);
const MANAGE_ROLES_AND_NICKS = String((1n << 28n) | (1n << 27n));

test("role allowlist and ignored role match the configured Aurion IDs", () => {
  assert.deepEqual(SYNCED_SOURCE_ROLE_IDS, [
    "1509633054497308832",
    "1509633054451175584",
    "1509633054509895685",
    "1509633054509895680",
    "1509633054497308839",
    "1509633054497308837",
    "1509633054497308833",
    "1509633054497308834",
    "1509633054509895687",
  ]);
  assert.equal(IGNORED_SOURCE_ROLE_ID, "1509633054451175583");
});

function sourceData() {
  return {
    guild: { id: SOURCE, name: "Aurion", owner_id: "owner-source" },
    roles: [
      { id: SOURCE, name: "@everyone", color: 0, managed: false, position: 0, permissions: "0" },
      { id: SYNC_ROLE, name: "Моряк", color: 0x336699, managed: false, position: 2, permissions: "0" },
      { id: OTHER_ROLE, name: "Не переносить", color: 0x123456, managed: false, position: 2, permissions: "0" },
      { id: IGNORED_SOURCE_ROLE_ID, name: "Игнорировать", color: 0, managed: false, position: 4, permissions: "0" },
      { id: "managed-role", name: "Интеграция", color: 10, managed: true, position: 3, permissions: "0" },
    ],
    members: [
      { user: { id: "user-1", bot: false }, nick: "Капитан", roles: [SYNC_ROLE, OTHER_ROLE] },
      { user: { id: "user-2", bot: false }, nick: null, roles: [SYNC_ROLE] },
      { user: { id: "ignored-user", bot: false }, nick: "Не трогать", roles: [SYNC_ROLE, IGNORED_SOURCE_ROLE_ID] },
      { user: { id: BOT, bot: true }, nick: null, roles: [SYNC_ROLE, "managed-role"] },
    ],
  };
}

function targetData(extraRoles = [], extraMemberRoles = []) {
  return {
    guild: { id: TARGET, name: "Aurion Test", owner_id: "owner-target" },
    roles: [
      { id: TARGET, name: "@everyone", color: 0, managed: false, position: 0, permissions: "0" },
      { id: "bot-role", name: "Aurion Sync", color: 0, managed: true, position: 10, permissions: MANAGE_ROLES_AND_NICKS },
      ...extraRoles,
    ],
    members: [
      { user: { id: BOT, bot: true }, nick: null, roles: ["bot-role"] },
      { user: { id: "user-1", bot: false }, nick: "Старый ник", roles: [...extraMemberRoles] },
      { user: { id: "user-2", bot: false }, nick: "Оставить", roles: [] },
      { user: { id: "ignored-user", bot: false }, nick: "Целевой ник", roles: [] },
    ],
  };
}

class FakeDiscordRest {
  constructor(source = sourceData(), target = targetData()) {
    this.source = source;
    this.target = target;
    this.created = [];
    this.updated = [];
    this.assigned = [];
    this.removed = [];
    this.nickChanges = [];
  }

  async getCurrentUser() { return { id: BOT, bot: true }; }
  async getGuild(id) { return id === SOURCE ? this.source.guild : this.target.guild; }
  async getGuildRoles(id) { return id === SOURCE ? this.source.roles : this.target.roles; }
  async listGuildMembers(id) { return id === SOURCE ? this.source.members : this.target.members; }

  async createGuildRole(guildId, body) {
    assert.equal(guildId, TARGET);
    const role = { id: `created-${this.created.length + 1}`, managed: false, position: 1, permissions: "0", ...body };
    this.target.roles.push(role);
    this.created.push(role);
    return role;
  }

  async modifyGuildRole(guildId, roleId, body) {
    assert.equal(guildId, TARGET);
    const role = this.target.roles.find((item) => item.id === roleId);
    Object.assign(role, body);
    this.updated.push({ roleId, body });
    return role;
  }

  async addGuildMemberRole(guildId, userId, roleId) {
    assert.equal(guildId, TARGET);
    this.target.members.find((member) => member.user.id === userId).roles.push(roleId);
    this.assigned.push({ userId, roleId });
  }

  async removeGuildMemberRole(guildId, userId, roleId) {
    assert.equal(guildId, TARGET);
    const member = this.target.members.find((item) => item.user.id === userId);
    member.roles = member.roles.filter((item) => item !== roleId);
    this.removed.push({ userId, roleId });
  }

  async modifyGuildMember(guildId, userId, body) {
    assert.equal(guildId, TARGET);
    this.target.members.find((member) => member.user.id === userId).nick = body.nick;
    this.nickChanges.push({ userId, nick: body.nick });
  }
}

test("snapshot remembers role members and nicknames by Discord ID", () => {
  const source = sourceData();
  const snapshot = buildSourceSnapshot(SOURCE, source.roles, source.members);
  assert.deepEqual(snapshot.members["user-1"], { nick: "Капитан", bot: false, roleIds: [SYNC_ROLE, OTHER_ROLE] });
  assert.deepEqual(snapshot.members["user-2"], { nick: null, bot: false, roleIds: [SYNC_ROLE] });
  assert.deepEqual(snapshot.roles.find((role) => role.id === SYNC_ROLE).memberIds, ["user-1", "user-2", "ignored-user", BOT]);
  assert.deepEqual(snapshot.roles.find((role) => role.id === SOURCE).memberIds, ["user-1", "user-2", "ignored-user", BOT]);
});

test("sync creates roles once, assigns by ID and preserves target nick when source nick is null", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const rest = new FakeDiscordRest();
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    const preview = await engine.preview(TARGET);
    assert.equal(preview.rolesToCreate, 1);
    assert.equal(preview.sharedMembers, 3);
    assert.equal(preview.ignoredMembers, 1);

    const first = await engine.synchronize(TARGET);
    assert.equal(first.rolesCreated, 1);
    assert.equal(rest.created.some((role) => role.name === "Интеграция"), false);
    assert.equal(rest.created.some((role) => role.name === "Не переносить"), false);
    assert.equal(first.rolesAssigned, 2);
    assert.equal(first.nicknamesChanged, 1);
    assert.equal(first.skippedBots, 1);
    assert.equal(first.ignoredMembers, 1);
    assert.equal(rest.target.members.find((member) => member.user.id === "ignored-user").nick, "Целевой ник");
    assert.equal(rest.target.members.find((member) => member.user.id === "user-2").nick, "Оставить");

    const second = await engine.synchronize(TARGET);
    assert.equal(second.rolesCreated, 0);
    assert.equal(second.rolesAssigned, 0);
    assert.equal(second.nicknamesChanged, 0);
    assert.equal(rest.created.length, 1);

    rest.source.roles.find((role) => role.id === SYNC_ROLE).name = "Навигатор";
    rest.source.roles.find((role) => role.id === SYNC_ROLE).color = 0x112233;
    const third = await engine.synchronize(TARGET);
    assert.equal(third.rolesCreated, 0);
    assert.equal(third.rolesUpdated, 1);
    assert.equal(rest.created[0].name, "Навигатор");

    assert.equal(engine.database.getRoleMappings(TARGET)[SYNC_ROLE], rest.created[0].id);
    assert.equal(engine.database.getSyncTarget(TARGET).mode, "full");
    assert.equal(engine.database.getSourceSnapshot().members["user-1"].nick, "Капитан");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing exact-name role is reused instead of duplicated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const existing = { id: "existing-role", name: "Моряк", color: 0x336699, managed: false, position: 1, permissions: "0" };
    const rest = new FakeDiscordRest(sourceData(), targetData([existing]));
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    const result = await engine.synchronize(TARGET);
    assert.equal(result.rolesCreated, 0);
    assert.equal(rest.assigned.length, 2);
    assert.ok(rest.assigned.every((item) => item.roleId === "existing-role"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full sync removes a synchronized role that was removed on the source server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const rest = new FakeDiscordRest();
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    await engine.synchronize(TARGET);
    rest.source.members.find((member) => member.user.id === "user-1").roles = [OTHER_ROLE];
    const result = await engine.synchronize(TARGET);
    assert.equal(result.rolesRemoved, 1);
    assert.equal(rest.removed[0].userId, "user-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nickname-only mode changes nicknames without creating or assigning roles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const rest = new FakeDiscordRest();
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    const result = await engine.synchronize(TARGET, { mode: SYNC_MODE_NICKNAMES });
    assert.equal(result.rolesCreated, 0);
    assert.equal(result.rolesAssigned, 0);
    assert.equal(result.nicknamesChanged, 1);
    assert.equal(rest.created.length, 0);
    assert.equal(engine.database.getSyncTarget(TARGET).mode, SYNC_MODE_NICKNAMES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new member is synchronized using the saved target mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const rest = new FakeDiscordRest();
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    await engine.synchronize(TARGET);
    rest.source.members.push({ user: { id: "new-user", bot: false }, nick: "Новенький", roles: [SYNC_ROLE] });
    rest.target.members.push({ user: { id: "new-user", bot: false }, nick: null, roles: [] });
    const result = await engine.synchronizeNewMember(TARGET, "new-user");
    assert.equal(result.rolesAssigned, 1);
    assert.equal(result.nicknamesChanged, 1);
    assert.equal(result.trigger, "member_join");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduled synchronization updates registered target roles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const rest = new FakeDiscordRest();
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    await engine.synchronize(TARGET);
    rest.source.roles.find((role) => role.id === SYNC_ROLE).name = "Обновлённая роль";
    const results = await engine.synchronizeRegisteredTargets();
    assert.equal(results.length, 1);
    assert.equal(results[0].summary.rolesUpdated, 1);
    assert.equal(results[0].summary.trigger, "scheduled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("members at or above bot hierarchy are reported and not modified", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const highRole = { id: "high-role", name: "Администратор", color: 0, managed: false, position: 10, permissions: "0" };
    const rest = new FakeDiscordRest(sourceData(), targetData([highRole], ["high-role"]));
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    const result = await engine.synchronize(TARGET);
    const userFailures = result.failures.filter((failure) => failure.subject.includes("user-1"));
    assert.equal(userFailures.length, 2);
    assert.equal(rest.assigned.some((item) => item.userId === "user-1"), false);
    assert.equal(rest.nickChanges.some((item) => item.userId === "user-1"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync refuses to start when bot permissions are missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const target = targetData();
    target.roles.find((role) => role.id === "bot-role").permissions = "0";
    const engine = new SyncEngine(new FakeDiscordRest(sourceData(), target), { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    await assert.rejects(() => engine.preview(TARGET), /Manage Roles, Manage Nicknames/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nickname-only mode does not require Manage Roles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const target = targetData();
    target.roles.find((role) => role.id === "bot-role").permissions = MANAGE_NICKNAMES;
    const engine = new SyncEngine(new FakeDiscordRest(sourceData(), target), { sourceGuildId: SOURCE, databaseFile: ":memory:" });
    const preview = await engine.preview(TARGET, SYNC_MODE_NICKNAMES);
    assert.equal(preview.mode, SYNC_MODE_NICKNAMES);
    await assert.rejects(() => engine.preview(TARGET), /Manage Roles/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
