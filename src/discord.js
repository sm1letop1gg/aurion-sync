import { EventEmitter } from "node:events";

const API = "https://discord.com/api/v10";

export class DiscordRest {
  constructor(token) {
    this.token = token;
  }

  async request(method, path, body, authenticated = true, reason) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          ...(authenticated ? { Authorization: `Bot ${this.token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : {}),
          "User-Agent": "DiscordBot (Aurion-Sync, 1.0)",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429) {
        const rate = await response.json();
        await new Promise((resolve) => setTimeout(resolve, Math.ceil((rate.retry_after ?? 1) * 1_000)));
        continue;
      }
      if (response.status === 204) return null;
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(`Discord API ${method} ${path}: ${response.status} ${data?.message ?? response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return data;
    }
    throw new Error(`Discord API ${method} ${path}: превышен лимит повторов`);
  }

  getCurrentUser() { return this.request("GET", "/users/@me"); }
  getGuild(id) { return this.request("GET", `/guilds/${id}`); }
  getGuildRoles(id) { return this.request("GET", `/guilds/${id}/roles`); }
  async listGuildMembers(guildId) {
    const members = [];
    let after = "0";
    while (true) {
      const page = await this.request("GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
      members.push(...page);
      if (page.length < 1000) return members;
      after = page.at(-1).user.id;
    }
  }
  createGuildRole(guildId, role) { return this.request("POST", `/guilds/${guildId}/roles`, role, true, "Aurion Sync: создание роли"); }
  modifyGuildRole(guildId, roleId, role) { return this.request("PATCH", `/guilds/${guildId}/roles/${roleId}`, role, true, "Aurion Sync: обновление роли"); }
  addGuildMemberRole(guildId, userId, roleId) { return this.request("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, true, "Aurion Sync: выдача роли"); }
  modifyGuildMember(guildId, userId, body) { return this.request("PATCH", `/guilds/${guildId}/members/${userId}`, body, true, "Aurion Sync: перенос серверного ника"); }
  registerGuildCommands(clientId, guildId, commands) { return this.request("PUT", `/applications/${clientId}/guilds/${guildId}/commands`, commands); }
  registerGlobalCommands(clientId, commands) { return this.request("PUT", `/applications/${clientId}/commands`, commands); }
  interactionCallback(interaction, data) { return this.request("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, data, false); }
  editInteraction(clientId, token, data) { return this.request("PATCH", `/webhooks/${clientId}/${token}/messages/@original`, { ...data, allowed_mentions: { parse: [] } }, false); }
}

export class DiscordGateway extends EventEmitter {
  constructor(token) {
    super();
    this.token = token;
    this.socket = null;
    this.heartbeat = null;
    this.sequence = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
  }

  connect() {
    this.stopped = false;
    const base = this.resumeUrl ?? "wss://gateway.discord.gg";
    const socket = new WebSocket(`${base.replace(/\/$/, "")}/?v=10&encoding=json`);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.scheduleReconnect());
    socket.addEventListener("error", (event) => this.emit("error", event.error ?? new Error("Ошибка Discord Gateway")));
  }

  close() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(1000, "Shutdown");
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  onMessage(raw) {
    const payload = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;
    if (payload.op === 10) {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), payload.d.heartbeat_interval);
      this.send(this.sessionId
        ? { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } }
        : { op: 2, d: {
          token: this.token,
          intents: 3,
          properties: { os: process.platform, browser: "aurion-sync", device: "aurion-sync" },
          presence: {
            status: "online",
            afk: false,
            activities: [{ name: "не официальный проект сервера • комьюнити-разработка • главный разработчик Sm1Le", type: 0 }],
          },
        } });
      return;
    }
    if (payload.op === 7) {
      this.socket?.close(4000, "Reconnect requested");
      return;
    }
    if (payload.op === 9) {
      if (!payload.d) {
        this.sessionId = null;
        this.resumeUrl = null;
        this.sequence = null;
      }
      this.socket?.close(4000, "Invalid session");
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === "READY") {
      this.sessionId = payload.d.session_id;
      this.resumeUrl = payload.d.resume_gateway_url;
      this.reconnectAttempt = 0;
      this.emit("ready", payload.d.user);
    } else if (payload.t === "RESUMED") {
      this.reconnectAttempt = 0;
      this.emit("resumed");
    } else if (payload.t === "INTERACTION_CREATE") {
      this.emit("interaction", payload.d);
    }
  }

  scheduleReconnect() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    setTimeout(() => this.connect(), delay).unref();
  }
}
