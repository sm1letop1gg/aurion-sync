import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSourceSnapshot, SyncEngine } from "../src/sync-engine.js";

const SOURCE = "1509633054451175575";
const TARGET = "2509633054451175575";
const BOT = "3509633054451175575";
const MANAGE_ROLES_AND_NICKS = String((1n << 28n) | (1n << 27n));

function sourceData() {
  return {
    guild: { id: SOURCE, name: "Aurion", owner_id: "owner-source" },
    roles: [
      { id: SOURCE, name: "@everyone", color: 0, managed: false, position: 0, permissions: "0" },
      { id: "source-role", name: "Моряк", color: 0x336699, managed: false, position: 2, permissions: "0" },
      { id: "managed-role", name: "Интеграция", color: 10, managed: true, position: 3, permissions: "0" },
    ],
    members: [
      { user: { id: "user-1", bot: false }, nick: "Капитан", roles: ["source-role"] },
      { user: { id: "user-2", bot: false }, nick: null, roles: ["source-role"] },
      { user: { id: BOT, bot: true }, nick: null, roles: ["source-role", "managed-role"] },
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

  async modifyGuildMember(guildId, userId, body) {
    assert.equal(guildId, TARGET);
    this.target.members.find((member) => member.user.id === userId).nick = body.nick;
    this.nickChanges.push({ userId, nick: body.nick });
  }
}

test("snapshot remembers role members and nicknames by Discord ID", () => {
  const source = sourceData();
  const snapshot = buildSourceSnapshot(SOURCE, source.roles, source.members);
  assert.deepEqual(snapshot.members["user-1"], { nick: "Капитан", roleIds: ["source-role"] });
  assert.deepEqual(snapshot.members["user-2"], { nick: null, roleIds: ["source-role"] });
  assert.deepEqual(snapshot.roles.find((role) => role.id === "source-role").memberIds, ["user-1", "user-2", BOT]);
  assert.deepEqual(snapshot.roles.find((role) => role.id === SOURCE).memberIds, ["user-1", "user-2", BOT]);
});

test("sync creates roles once, assigns by ID and preserves target nick when source nick is null", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const rest = new FakeDiscordRest();
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, stateFile: path.join(directory, "state.json") });
    const preview = await engine.preview(TARGET);
    assert.equal(preview.rolesToCreate, 1);
    assert.equal(preview.sharedMembers, 3);

    const first = await engine.synchronize(TARGET);
    assert.equal(first.rolesCreated, 1);
    assert.equal(rest.created.some((role) => role.name === "Интеграция"), false);
    assert.equal(first.rolesAssigned, 2);
    assert.equal(first.nicknamesChanged, 1);
    assert.equal(first.skippedBots, 1);
    assert.equal(rest.target.members.find((member) => member.user.id === "user-2").nick, "Оставить");

    const second = await engine.synchronize(TARGET);
    assert.equal(second.rolesCreated, 0);
    assert.equal(second.rolesAssigned, 0);
    assert.equal(second.nicknamesChanged, 0);
    assert.equal(rest.created.length, 1);

    rest.source.roles.find((role) => role.id === "source-role").name = "Навигатор";
    rest.source.roles.find((role) => role.id === "source-role").color = 0x112233;
    const third = await engine.synchronize(TARGET);
    assert.equal(third.rolesCreated, 0);
    assert.equal(third.rolesUpdated, 1);
    assert.equal(rest.created[0].name, "Навигатор");

    const state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.equal(state.roleMappings[TARGET]["source-role"], rest.created[0].id);
    assert.equal(state.sourceSnapshot.members["user-1"].nick, "Капитан");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing exact-name role is reused instead of duplicated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const existing = { id: "existing-role", name: "Моряк", color: 0x336699, managed: false, position: 1, permissions: "0" };
    const rest = new FakeDiscordRest(sourceData(), targetData([existing]));
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, stateFile: path.join(directory, "state.json") });
    const result = await engine.synchronize(TARGET);
    assert.equal(result.rolesCreated, 0);
    assert.equal(rest.assigned.length, 2);
    assert.ok(rest.assigned.every((item) => item.roleId === "existing-role"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("members at or above bot hierarchy are reported and not modified", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-"));
  try {
    const highRole = { id: "high-role", name: "Администратор", color: 0, managed: false, position: 10, permissions: "0" };
    const rest = new FakeDiscordRest(sourceData(), targetData([highRole], ["high-role"]));
    const engine = new SyncEngine(rest, { sourceGuildId: SOURCE, stateFile: path.join(directory, "state.json") });
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
    const engine = new SyncEngine(new FakeDiscordRest(sourceData(), target), { sourceGuildId: SOURCE, stateFile: path.join(directory, "state.json") });
    await assert.rejects(() => engine.preview(TARGET), /Manage Roles, Manage Nicknames/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
