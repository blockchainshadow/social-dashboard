import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

async function loadClient() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: "http://localhost:8000/",
    pretendToBeVisual: true,
    resources: "usable",
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.sessionStorage = dom.window.sessionStorage;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  global.URL = dom.window.URL;
  global.URLSearchParams = dom.window.URLSearchParams;

  // Force module fresh load
  const modPath = new URL("../assets/dashboard-client.mjs", import.meta.url).pathname;
  const key = `${modPath}?t=${Date.now()}`;
  const mod = await import(key);
  return mod;
}

describe("dashboard-client auth transitions", () => {
  let client;
  let calls;

  beforeEach(async () => {
    calls = [];
    const mod = await loadClient();
    client = mod.client;
    global.sessionStorage = window.sessionStorage;
    sessionStorage.clear();
    client.local = true;
    client._listeners = new Set();
    client._jobs = [];
    client.token = null;
    client.user = null;
    client._mustChangePassword = false;
  });

  afterEach(() => {
    client._stopPolling();
  });

  it("login stores token and user on success", async () => {
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, token: "tok-1", user: { user: "alice", role: "member", channels: ["youtube:@test"] } }),
      };
    };
    const res = await client.login("alice", "secret");
    assert.equal(res.ok, true);
    assert.equal(client.token, "tok-1");
    assert.equal(client.user.user, "alice");
    assert.equal(sessionStorage.getItem("dash-token"), "tok-1");
    assert.equal(calls[0].url, "/api/auth/login");
    assert.deepEqual(JSON.parse(calls[0].init.body), { username: "alice", password: "secret" });
  });

  it("login failure clears state", async () => {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "bad creds" }) });
    const res = await client.login("alice", "wrong");
    assert.equal(res.ok, false);
    assert.equal(client.token, null);
    assert.equal(client.user, null);
  });

  it("session validates stored token", async () => {
    client.token = "tok-2";
    sessionStorage.setItem("dash-token", "tok-2");
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/health") return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ user: { user: "bob", role: "admin", channels: [] } }) };
    };
    await client.init();
    assert.equal(client.user.role, "admin");
    assert.equal(client.local, true);
    assert.equal(calls[0].url, "/api/health");
    assert.equal(calls[1].url, "/api/auth/session");
    assert.equal(calls[1].init.headers.Authorization, "Bearer tok-2");
  });

  it("expired token clears session and emits unauthorized", async () => {
    client.token = "expired";
    sessionStorage.setItem("dash-token", "expired");
    let unauthorized = false;
    client.on("unauthorized", () => { unauthorized = true; });
    global.fetch = async (url) => {
      if (url === "/api/health") return { ok: true, json: async () => ({ ok: true }) };
      return { ok: false, status: 401, json: async () => ({ error: "expired" }) };
    };
    await client.init();
    assert.equal(client.user, null);
    assert.equal(unauthorized, true);
    assert.equal(sessionStorage.getItem("dash-token"), null);
  });

  it("logout server-side and clears storage", async () => {
    client.token = "tok-3";
    client.user = { user: "alice" };
    sessionStorage.setItem("dash-token", "tok-3");
    global.fetch = async (url) => {
      calls.push({ url });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    await client.logout();
    assert.equal(client.token, null);
    assert.equal(client.user, null);
    assert.equal(calls[0].url, "/api/auth/logout");
    assert.equal(sessionStorage.getItem("dash-token"), null);
  });

  it("password change revokes session when reauthenticate required", async () => {
    client.token = "tok-4";
    client.user = { user: "alice" };
    sessionStorage.setItem("dash-token", "tok-4");
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, reauthenticate: true }) });
    const res = await client.changePassword("old", "newnewnewnew");
    assert.equal(res.ok, true);
    assert.equal(client.token, null);
    assert.equal(sessionStorage.getItem("dash-token"), null);
  });

  it("blocks management when mustChangePassword flag set", async () => {
    client.user = { user: "alice", role: "member", channels: ["youtube:@test"] };
    client._mustChangePassword = true;
    const res = await client.addChannel({ handle: "@foo" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.body.passwordChangeRequired, true);
  });

  it("uses Worker directly when not local", async () => {
    client.local = false;
    global.fetch = async (url, init) => {
      calls.push({ url });
      return { ok: true, status: 200, json: async () => ({ token: "tok-5", user: { user: "x" } }) };
    };
    await client.login("x", "y");
    assert.ok(calls[0].url.startsWith("https://"));
    assert.ok(calls[0].url.endsWith("/auth/login"));
  });
});
