// Shared browser module for dashboard auth and management transport.
// Auto-detects local server vs static/remote Worker mode; all auth goes through
// the Worker session endpoints (local server proxies /api/auth/*).
import { normalizeYouTubeHandle } from "./channel-input.mjs";

const DEFAULT_RELAY = "https://dry-flower-a30f.xyxcliff.workers.dev";
const DEFAULT_DATA_BASE = "https://pub-a05f40620ff24db7996b638d15240c4c.r2.dev";

function getDataBase() {
  try {
    const q = new URLSearchParams(location.search).get("data");
    const ls = (() => {
      try { return localStorage.getItem("dash-data-base") || ""; }
      catch { return ""; }
    })();
    return (q || ls || window.DATA_BASE_URL || DEFAULT_DATA_BASE).replace(/\/+$/, "");
  } catch {
    return DEFAULT_DATA_BASE;
  }
}

export function dataUrl(path) {
  const base = getDataBase();
  return base ? `${base}/${String(path).replace(/^\/+/, "")}` : String(path);
}

export function resolveUrl(u) {
  if (!u || /^https?:\/\//i.test(u) || u.startsWith("data:") || u.startsWith("blob:")) return u;
  return dataUrl(u);
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function storageGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch {}
}
function storageRemove(key) {
  try { sessionStorage.removeItem(key); } catch {}
}

class DashboardClient {
  constructor() {
    this.local = false; // true when /api/health responds
    this.token = storageGet("dash-token");
    this.user = null;
    this.relay = DEFAULT_RELAY;
    this._listeners = new Set();
    this._pollTimer = null;
    this._jobs = [];
  }

  on(event, fn) {
    this._listeners.add({ event, fn });
    return () => this._listeners.delete({ event, fn });
  }
  _emit(event, payload) {
    for (const l of this._listeners) if (l.event === event) l.fn(payload);
  }

  async init() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      this.local = r.ok && j.ok === true;
    } catch {
      this.local = false;
    }
    if (this.token) {
      const s = await this.session();
      if (!s) this.clearSession();
      else this.startPolling();
    }
    this._emit("ready", { local: this.local, user: this.user });
  }

  _authHeaders() {
    const h = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async _request(method, path, body, { noAuth = false } = {}) {
    const isLocal = this.local;
    let url;
    if (path.startsWith("/auth/")) {
      url = isLocal ? `/api${path}` : `${this.relay}${path}`;
    } else if (path === "/" || path === "/jobs") {
      url = isLocal ? `/api${path}` : `${this.relay}${path}`;
    } else if (path.startsWith("/api/")) {
      url = path;
    } else {
      url = isLocal ? `/api${path}` : `${this.relay}${path}`;
    }
    const init = { method, headers: noAuth ? { "Content-Type": "application/json" } : this._authHeaders() };
    if (body != null) init.body = JSON.stringify(body);
    const r = await fetch(url, init);
    if (r.status === 401) {
      this.clearSession();
      this._emit("unauthorized", { path });
    }
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j };
  }

  async login(username, password) {
    const { ok, status, body } = await this._request("POST", "/auth/login", { username, password }, { noAuth: true });
    if (ok && body.token) {
      this.token = body.token;
      storageSet("dash-token", body.token);
      this.user = body.user ?? null;
      this._mustChangePassword = !!body.user?.mustChangePassword;
      this._emit("login", { user: this.user });
      this._startPolling();
    }
    return { ok, status, body };
  }

  async session() {
    if (!this.token) return null;
    const { ok, body } = await this._request("GET", "/auth/session", null);
    if (ok && body.user) {
      this.user = body.user;
      this._mustChangePassword = !!body.user?.mustChangePassword;
      return body.user;
    }
    return null;
  }

  passwordChangeRequired() { return !!this._mustChangePassword; }

  async logout() {
    if (this.token) await this._request("POST", "/auth/logout", null);
    this.clearSession();
    return { ok: true };
  }

  async changePassword(currentPassword, newPassword) {
    const res = await this._request("POST", "/auth/password", { currentPassword, newPassword });
    // Server may revoke all sessions after password change
    if (res.body?.reauthenticate) this.clearSession();
    return res;
  }

  clearSession() {
    this.token = null;
    this.user = null;
    this._mustChangePassword = false;
    storageRemove("dash-token");
    this._stopPolling();
    this._emit("logout", {});
  }

  isAdmin() { return this.user?.role === "admin"; }
  channels() { return this.user?.channels ?? []; }

  _key(platform, handle) { return `${platform}:${handle}`; }
  isOwner(key) {
    if (!this.user) return false;
    if (this.isAdmin() && this._allMode()) return true;
    return this.channels().includes(key);
  }
  canManage(key, owner) {
    if (this.isAdmin() && this._allMode()) return true;
    if (owner && this.user?.user === owner) return true;
    return this.channels().includes(key);
  }
  _allMode() {
    try { return sessionStorage.getItem("dash-all") !== "0"; }
    catch { return false; }
  }
  setAllMode(on) {
    try {
      sessionStorage.setItem("dash-all", on ? "1" : "0");
    } catch {}
  }

  normalize(platform, input) {
    if (platform === "youtube") return normalizeYouTubeHandle(input);
    // TikTok minimal normalization for UI convenience
    let h = String(input ?? "").trim();
    if (!h) return null;
    try {
      if (/^https?:\/\//i.test(h)) h = new URL(h).pathname.split("/").filter(Boolean).pop();
    } catch { return null; }
    h = decodeURIComponent(h).normalize("NFC");
    if (!h.startsWith("@")) h = "@" + h;
    return /^@[\w.]{1,24}$/i.test(h) ? h.toLowerCase() : null;
  }

  _managementGuard() {
    if (this.passwordChangeRequired()) {
      return { ok: false, status: 403, body: { error: "请先更换曾公开的旧密码", passwordChangeRequired: true } };
    }
    return null;
  }

  async _management(action, payload) {
    const guard = this._managementGuard();
    if (guard) return guard;
    if (!this.local) {
      return this._request("POST", "/", { action, ...payload });
    }
    // Local server uses REST-style paths, not action-based Worker dispatch
    switch (action) {
      case "add":
        return this._request("POST", "/api/channels", payload);
      case "update":
        return this._request("POST", "/api/channel-meta", payload);
      case "delete": {
        const { platform, handle } = payload;
        return this._request("DELETE", `/api/channels/${encodeURIComponent(platform)}/${encodeURIComponent(handle)}`);
      }
      case "refresh":
        return this._request("POST", "/api/refresh", payload);
      case "members":
        return this._request("POST", "/api/", { action: "members" });
      default:
        return { ok: false, status: 400, body: { error: "unknown action" } };
    }
  }

  async addChannel({ platform = "youtube", handle, alias = "", group = "", tags = [], all = false } = {}) {
    const n = this.normalize(platform, handle);
    if (!n) return { ok: false, status: 400, body: { error: "请输入有效的账号 handle、主页链接或频道 ID" } };
    const res = await this._management("add", { platform, handle: n, alias, group, tags, all });
    if (res.ok) this._startPolling();
    return res;
  }

  async updateChannel({ platform, handle, alias, group, tags }) {
    return this._management("update", { platform, handle, alias, group, tags });
  }

  async deleteChannel(platform, handle) {
    return this._management("delete", { platform, handle });
  }

  async refreshChannel(platform, handle) {
    const res = await this._management("refresh", { platform, handle });
    if (res.ok) this._startPolling();
    return res;
  }

  async listMembers() {
    return this._management("members", {});
  }

  async listChannels() {
    const res = await this._request("GET", this.local ? "/api/channels" : "/channels", null);
    if (!res.ok) return res;
    return { ...res, body: { channels: Array.isArray(res.body) ? res.body : res.body.channels ?? [] } };
  }

  async listJobs() {
    const res = await this._request("GET", "/jobs", null);
    if (res.ok) this._jobs = res.body.jobs ?? [];
    return res;
  }

  hasPendingJobs() {
    return this._jobs.some((j) => j.status === "queued" || j.status === "running" || j.status === "collected" || j.status === "publishing");
  }

  startPolling() { this._startPolling(); }
  stopPolling() { this._stopPolling(); }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(async () => {
      try {
        await this.listJobs();
        this._emit("jobs", this._jobs);
        if (!this.hasPendingJobs()) this._stopPolling();
      } catch (error) {
        this._emit("jobsError", error);
      }
    }, 3000);
  }
  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }
}

export const client = new DashboardClient();

// Small DOM helpers for pending-task UI
export function renderPendingCard(job) {
  const statusText = {
    queued: "排队中",
    running: "采集中",
    collected: "处理中",
    publishing: "发布中",
    complete: "完成",
    failed: "失败",
  }[job.status] ?? job.status;
  const statusClass = job.status === "failed" ? "down" : (job.status === "complete" ? "green" : "amber");
  const errorHtml = job.error ? `<div style="color:var(--down);font-size:12px;margin-top:4px">${escHtml(String(job.error).slice(0, 200))}</div>` : "";
  const kindText = job.kind === "initial" ? "首次采集" : job.kind === "full" ? "全量采集" : "更新现有频道";
  return `
    <div class="pending-card" data-job-id="${escHtml(job.id)}" style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;min-width:180px;flex:1 1 180px;max-width:260px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b style="font-size:13px">${escHtml(job.handle)}</b>
        <span style="font-size:11px;color:var(--${statusClass === 'green' ? 'green' : statusClass === 'down' ? 'down' : 'amber'})">${statusText}</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${kindText} · ${escHtml(job.platform || "youtube")}</div>
      ${errorHtml}
      ${job.status === "failed" ? `<button class="btn ghost retry-job" data-handle="${escHtml(job.handle)}" data-platform="${escHtml(job.platform || "youtube")}" style="margin-top:6px;padding:4px 10px;font-size:12px">重试</button>` : ""}
    </div>
  `;
}

export { escHtml };
