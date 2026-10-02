import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

function waitForServer(port, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) return resolve();
        reject(new Error(`health ${res.statusCode}`));
      });
      req.on("error", () => {
        if (Date.now() - start > timeout) return reject(new Error("server start timeout"));
        setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("server auth and ownership", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dash-server-"));
  mkdirSync(path.join(tmp, "data"), { recursive: true });
  let workerChannels = [
    { platform: "youtube", handle: "@owner1", owner: "alice" },
    { platform: "youtube", handle: "@owner2", owner: "bob" },
    { platform: "youtube", handle: "@public" },
  ];
  writeFileSync(path.join(tmp, "channels.json"), JSON.stringify(workerChannels));
  writeFileSync(path.join(tmp, "index.html"), "<html></html>");
  writeFileSync(path.join(tmp, "users.json"), JSON.stringify([{ username: "alice", passwordHash: "not-public" }]));

  // Mock Worker
  let workerPort;
  const worker = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      let status = 200;
      let payload = {};
      if (req.url === "/auth/login") {
        if (json.username === "alice" && json.password === "secret") {
          payload = { ok: true, token: "alice-token", user: { user: "alice", role: "member", channels: ["youtube:@owner1"] } };
        } else if (json.username === "admin" && json.password === "admin") {
          payload = { ok: true, token: "admin-token", user: { user: "admin", role: "admin", channels: [] } };
        } else {
          status = 401;
          payload = { error: "bad creds" };
        }
      } else if (req.url === "/auth/session") {
        const token = (req.headers.authorization ?? "").slice(7);
        if (token === "alice-token") payload = { user: { user: "alice", role: "member", channels: ["youtube:@owner1"] } };
        else if (token === "admin-token") payload = { user: { user: "admin", role: "admin", channels: [] } };
        else { status = 401; payload = { error: "unauthorized" }; }
      } else if (req.url === "/auth/logout") {
        payload = { ok: true };
      } else if (req.url === "/auth/password") {
        payload = { ok: true, reauthenticate: true };
      } else if (req.url === "/channels") {
        payload = { ok: true, channels: workerChannels };
      } else if (req.url === "/" && json.action === "members") {
        payload = { ok: true, users: [{ user: "alice", role: "member" }], channels: workerChannels };
      } else if (req.url === "/" && ["add", "update", "delete", "refresh"].includes(json.action)) {
        const token = (req.headers.authorization ?? "").slice(7);
        const existing = workerChannels.find((c) => (c.platform ?? "youtube") === json.platform && c.handle === json.handle);
        if (!["alice-token", "admin-token"].includes(token) || (token !== "admin-token" && existing && existing.owner !== "alice")) {
          status = 403;
          payload = { error: "forbidden" };
        } else {
          if (json.action === "add" && !existing) {
            workerChannels = [...workerChannels, { platform: json.platform, handle: json.handle, owner: "alice", all: json.all }];
          }
          if (json.action === "delete") workerChannels = workerChannels.filter((c) => c !== existing);
          if (json.action === "update") workerChannels = workerChannels.map((c) =>
            c === existing ? { ...c, alias: json.alias, group: json.group, tags: json.tags } : c);
          payload = { ok: true, channels: workerChannels, job: { handle: json.handle } };
        }
      } else {
        status = 404;
        payload = { error: "not found" };
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  let serverProc;
  let serverPort;

  before(async () => {
    await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
    workerPort = worker.address().port;

    serverPort = 18000 + Math.floor(Math.random() * 1000);
    serverProc = spawn(process.execPath, [path.resolve("server.mjs"), String(serverPort)], {
      env: { ...process.env, DASH_ROOT: tmp, DASH_RELAY: `http://127.0.0.1:${workerPort}` },
      stdio: "ignore",
    });
    await waitForServer(serverPort);
  });

  after(() => {
    if (serverProc) serverProc.kill();
    worker.close();
  });

  it("proxies /api/auth/login to Worker", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.token, "alice-token");
  });

  it("rejects bad login", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong" }),
    });
    assert.equal(res.status, 401);
  });

  it("protects management APIs without session", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", platform: "youtube", handle: "@new" }),
    });
    assert.equal(res.status, 401);
  });

  it("member cannot manage another owner's channel", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/channels/youtube/%40owner2`, {
      method: "DELETE",
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(res.status, 403);
  });

  it("admin can manage any channel", async () => {
    // admin deletes owner2, config atomically updated
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/channels/youtube/%40owner2`, {
      method: "DELETE",
      headers: { Authorization: "Bearer admin-token" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(workerChannels.some((c) => c.handle === "@owner2"), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(tmp, "channels.json"), "utf8")), workerChannels);
  });

  it("returns 202 for YouTube add and enqueues job", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/channels`, {
      method: "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "youtube", handle: "@newchannel" }),
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.job.id);
    assert.equal(res.body.job.handle, "@newchannel");
    assert.equal(workerChannels.some((c) => c.handle === "@newchannel" && c.owner === "alice"), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(tmp, "channels.json"), "utf8")), workerChannels);
  });

  it("jobs endpoint filters by owner", async () => {
    // alice only sees her own queued job
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/jobs`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.jobs));
    assert.ok(res.body.jobs.every((j) => j.handle === "@owner1" || j.handle === "@newchannel"));
  });

  it("does not serve users.json", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/users.json`);
    assert.equal(res.status, 404);
  });

  it("does not serve sqlite files", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/data/dashboard.sqlite`);
    assert.equal(res.status, 404);
  });

  it("proxies password change", async () => {
    const res = await httpRequest(`http://127.0.0.1:${serverPort}/api/auth/password`, {
      method: "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "old", newPassword: "newnewnewnew" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.reauthenticate, true);
  });
});
