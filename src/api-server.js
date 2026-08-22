import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { COMMUNITY_DISCLAIMER } from "./commands.js";
import { IGNORED_SOURCE_ROLE_ID, SYNCED_SOURCE_ROLE_IDS } from "./sync-policy.js";

const PROJECT = Object.freeze({
  name: "Aurion Sync",
  official: false,
  notice: "Не официальный проект сервера, а разработка от комьюнити.",
  leadDeveloper: "Sm1Le",
});

function authorized(request, expectedToken) {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function responseHeaders(request, allowedOrigin) {
  const origin = request.headers.origin;
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(allowedOrigin && origin === allowedOrigin ? {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    } : {}),
  };
}

function sendJson(response, status, body, headers) {
  response.writeHead(status, headers);
  response.end(JSON.stringify({ project: PROJECT, ...body }));
}

export function createApiServer(database, config) {
  const token = config.websiteApiToken?.trim();
  if (!token || token.length < 32) throw new Error("WEBSITE_API_TOKEN должен содержать не менее 32 символов");

  return createServer((request, response) => {
    const headers = responseHeaders(request, config.websiteOrigin);
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "OPTIONS") {
        if (config.websiteOrigin && request.headers.origin !== config.websiteOrigin) {
          sendJson(response, 403, { error: "Origin запрещён" }, headers);
          return;
        }
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        sendJson(response, 200, { status: "ok", capturedAt: database.getSetting("source_snapshot_captured_at") }, headers);
        return;
      }
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "Требуется Bearer-токен" }, { ...headers, "WWW-Authenticate": "Bearer" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/roles") {
        sendJson(response, 200, {
          capturedAt: database.getSetting("source_snapshot_captured_at"),
          roles: database.getApiRoles(SYNCED_SOURCE_ROLE_IDS),
        }, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/members") {
        const after = url.searchParams.get("after");
        if (after && !/^\d{15,22}$/.test(after)) {
          sendJson(response, 400, { error: "Параметр after должен быть Discord ID" }, headers);
          return;
        }
        const page = database.getApiMembers({
          allowedRoleIds: SYNCED_SOURCE_ROLE_IDS,
          ignoredRoleId: IGNORED_SOURCE_ROLE_ID,
          limit: url.searchParams.get("limit") ?? 250,
          after,
        });
        sendJson(response, 200, page, headers);
        return;
      }
      sendJson(response, 404, { error: "Маршрут не найден", documentation: "/api/v1/roles, /api/v1/members" }, headers);
    } catch (error) {
      console.error("Aurion Sync API:", error);
      if (!response.headersSent) sendJson(response, 500, { error: "Внутренняя ошибка API" }, headers);
      else response.end();
    }
  });
}

export async function startApiServer(database, config) {
  const server = createApiServer(database, config);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(config.apiPort, config.apiHost, () => {
      server.off("error", onError);
      resolve();
    });
  });
  console.log(`Aurion Sync API: http://${config.apiHost}:${config.apiPort} — ${COMMUNITY_DISCLAIMER.replaceAll("**", "")}`);
  return server;
}
