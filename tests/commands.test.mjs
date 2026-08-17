import assert from "node:assert/strict";
import test from "node:test";
import { commandData, COMMUNITY_DISCLAIMER, formatSummary } from "../src/commands.js";

test("only /sync is registered and it is administrator-only", () => {
  assert.equal(commandData.length, 1);
  assert.equal(commandData[0].name, "sync");
  assert.equal(commandData[0].default_member_permissions, String(1n << 3n));
  assert.equal(commandData[0].dm_permission, false);
  assert.match(commandData[0].description, /не официальный проект сервера/i);
  assert.match(commandData[0].description, /Sm1Le/);
});

test("final report contains requested counters and failures", () => {
  const report = formatSummary({
    sharedMembers: 4,
    rolesCreated: 2,
    rolesUpdated: 1,
    rolesAssigned: 7,
    nicknamesChanged: 3,
    skippedBots: 1,
    failures: [{ action: "ник", subject: "123", error: "иерархия ролей" }],
  });
  assert.match(report, /Ролей создано: \*\*2\*\*/);
  assert.match(report, /Ролей выдано: \*\*7\*\*/);
  assert.match(report, /Ников изменено: \*\*3\*\*/);
  assert.match(report, /иерархия ролей/);
  assert.match(report, /не официальный проект сервера/);
  assert.match(report, /разработка от комьюнити/);
  assert.match(report, /Sm1Le/);
  assert.ok(COMMUNITY_DISCLAIMER.length > 0);
  assert.ok(report.length <= 1_950);
});
