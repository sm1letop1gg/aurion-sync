import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AurionDatabase } from "../src/database.js";

test("SQLite imports version 2 JSON and registers existing guilds in full mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aurion-sync-db-"));
  const legacyFile = path.join(directory, "state.json");
  const databaseFile = path.join(directory, "state.sqlite");
  let database;
  try {
    await writeFile(legacyFile, JSON.stringify({
      version: 2,
      sourceSnapshot: {
        guildId: "source",
        capturedAt: "2026-08-23T09:00:00.000Z",
        roles: [{ id: "source-role", name: "Role", color: 1, managed: false, isEveryone: false, memberIds: ["user"] }],
        members: { user: { nick: "Nick", roleIds: ["source-role"] } },
      },
      roleMappings: { "target-1": { "source-role": "target-role" } },
      lastRuns: { "target-2": { finishedAt: "2026-08-23T10:00:00.000Z", failures: [] } },
    }), "utf8");
    database = new AurionDatabase(databaseFile, { legacyStateFile: legacyFile });
    assert.equal(database.getRoleMappings("target-1")["source-role"], "target-role");
    assert.equal(database.getSyncTarget("target-1").mode, "full");
    assert.equal(database.getSyncTarget("target-2").mode, "full");
    assert.equal(database.getLastSyncRun("target-2").finishedAt, "2026-08-23T10:00:00.000Z");
    assert.equal(database.getSourceSnapshot().members.user.nick, "Nick");
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
