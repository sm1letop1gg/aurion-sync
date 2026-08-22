import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../src/api-server.js";
import { AurionDatabase } from "../src/database.js";
import { IGNORED_SOURCE_ROLE_ID, SYNCED_SOURCE_ROLE_IDS } from "../src/sync-policy.js";

const TOKEN = "test-token-with-at-least-thirty-two-characters";
const ORIGIN = "https://site.example";

test("website API requires auth and exposes only allowed roles and non-ignored people", async () => {
  const database = new AurionDatabase(":memory:");
  const allowedRole = SYNCED_SOURCE_ROLE_IDS[0];
  database.replaceSourceSnapshot({
    guildId: "1509633054451175575",
    capturedAt: "2026-08-23T12:00:00.000Z",
    roles: [
      { id: allowedRole, name: "Разрешённая", color: 123, managed: false, isEveryone: false },
      { id: IGNORED_SOURCE_ROLE_ID, name: "Игнор", color: 0, managed: false, isEveryone: false },
      { id: "2509633054451175575", name: "Другая", color: 456, managed: false, isEveryone: false },
    ],
    members: {
      "3509633054451175575": { nick: "Публичный ник", bot: false, roleIds: [allowedRole, "2509633054451175575"] },
      "3509633054451175576": { nick: "Скрытый", bot: false, roleIds: [allowedRole, IGNORED_SOURCE_ROLE_ID] },
      "3509633054451175577": { nick: "Бот", bot: true, roleIds: [allowedRole] },
    },
  });
  const server = createApiServer(database, { websiteApiToken: TOKEN, websiteOrigin: ORIGIN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const unauthorized = await fetch(`${base}/api/v1/roles`);
    assert.equal(unauthorized.status, 401);

    const rolesResponse = await fetch(`${base}/api/v1/roles`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } });
    assert.equal(rolesResponse.status, 200);
    assert.equal(rolesResponse.headers.get("access-control-allow-origin"), ORIGIN);
    const roles = await rolesResponse.json();
    assert.equal(roles.project.official, false);
    assert.equal(roles.project.leadDeveloper, "Sm1Le");
    assert.deepEqual(roles.roles.map((role) => role.id), [allowedRole]);

    const membersResponse = await fetch(`${base}/api/v1/members?limit=10`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(membersResponse.status, 200);
    const page = await membersResponse.json();
    assert.deepEqual(page.members.map((member) => member.discordId), ["3509633054451175575"]);
    assert.equal(page.members[0].nickname, "Публичный ник");
    assert.deepEqual(page.members[0].roles.map((role) => role.id), [allowedRole]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
  }
});
