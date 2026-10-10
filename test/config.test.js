import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createEnvironment, prepareDataDir, root } from "../src/environment.js";
import { Config } from "../src/config.js";

test("system > .env > settings > defaults, empty secrets fall through without leaking", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-config-"));
  try {
    fs.writeFileSync(path.join(dir, ".env"), 'OPENAI_API_KEY="dotenv-secret"\nGITHUB_TOKEN=dotenv-token\nPORT=4321\nDEVPULSE_DATA_DIR=./local-data\n');
    const env = { OPENAI_API_KEY: "system-secret", GITHUB_TOKEN: "system-token", PORT: "5432" };
    const environment = createEnvironment({ projectRoot: dir, env });
    const config = new Config(dir, { environment });
    config.update({ openaiKey: "saved-secret", githubToken: "saved-token" });
    assert.equal(config.get().openaiKey, "system-secret");
    assert.equal(config.get().githubToken, "system-token");
    assert.equal(config.public().openaiKeySource, "system");
    assert.equal(environment.runtime().port, 5432);
    env.OPENAI_API_KEY = "";
    env.GITHUB_TOKEN = "  ";
    delete env.PORT;
    assert.equal(config.get().openaiKey, "dotenv-secret");
    assert.equal(config.get().githubToken, "dotenv-token");
    assert.equal(config.public().openaiKeySource, "dotenv");
    assert.equal(environment.runtime().port, 4321);
    assert.equal(environment.runtime().dataDir, path.join(dir, "local-data"));
    env.DEVPULSE_DATA_DIR = "./system-data";
    assert.equal(environment.runtime().dataDir, path.join(dir, "system-data"));
    env.DEVPULSE_DATA_DIR = path.join(dir, "absolute-data");
    assert.equal(environment.runtime().dataDir, env.DEVPULSE_DATA_DIR);
    delete env.DEVPULSE_DATA_DIR;
    assert.equal(env.OPENAI_API_KEY, "");
    const publicJson = JSON.stringify(config.public());
    const savedJson = fs.readFileSync(config.file, "utf8");
    for (const secret of ["system-secret", "system-token", "dotenv-secret", "dotenv-token", "saved-secret", "saved-token"])
      assert.ok(!publicJson.includes(secret));
    for (const secret of ["system-secret", "system-token", "dotenv-secret", "dotenv-token"])
      assert.ok(!savedJson.includes(secret));
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=\nGITHUB_TOKEN=\n");
    const fallback = new Config(dir, { environment: createEnvironment({ projectRoot: dir, env }) });
    assert.equal(fallback.get().openaiKey, "saved-secret");
    assert.equal(fallback.get().githubToken, "saved-token");
    assert.equal(fallback.public().openaiKeySource, "settings");
    fallback.update({ openaiKey: "", githubToken: "" });
    assert.equal(fallback.public().openaiKeySource, "none");
    fs.unlinkSync(path.join(dir, ".env"));
    const missing = createEnvironment({ projectRoot: dir, env: {} });
    assert.deepEqual(missing.runtime(), { port: 3000, dataDir: path.join(dir, "data") });
    assert.equal(missing.secret("OPENAI_API_KEY", "fallback").value, "fallback");
    const demo = new Config(dir, { environment, secretsEnabled: false });
    assert.equal(demo.get().openaiKey, "");
    assert.equal(demo.get().githubToken, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime rejects invalid ports and unwritable data directories without echoing input", () => {
  for (const PORT of ["", "0", "65536", "3.14", "-1", "secret-port", "3000x"]) {
    const environment = createEnvironment({ env: { PORT }, envFile: false });
    assert.throws(() => environment.runtime(), { message: "PORT phải là số nguyên từ 1 đến 65535" });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-dir-"));
  try {
    const file = path.join(dir, "private-value");
    fs.writeFileSync(file, "");
    assert.throws(() => prepareDataDir(file), { message: "Không thể ghi thư mục dữ liệu (DEVPULSE_DATA_DIR); kiểm tra đường dẫn và quyền truy cập" });
    prepareDataDir(path.join(dir, "writable"));
    assert.deepEqual(fs.readdirSync(path.join(dir, "writable")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function projectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-startup-"));
  fs.cpSync(path.join(root, "src"), path.join(dir, "src"), { recursive: true });
  fs.cpSync(path.join(root, "scripts"), path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "PORT", "DEVPULSE_DATA_DIR"])
    delete env[key];
  return { dir, env, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("startup from another cwd loads project .env before database; HTTP never exposes secrets", () => {
  const fixture = projectFixture();
  try {
    fs.writeFileSync(path.join(fixture.dir, ".env"), "OPENAI_API_KEY=dotenv-private\nGITHUB_TOKEN=dotenv-token\nPORT=4321\nDEVPULSE_DATA_DIR=./isolated\n");
    const url = pathToFileURL(path.join(fixture.dir, "src", "server.js")).href;
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      const { createApp } = await import(${JSON.stringify(url)});
      const app = createApp({ disableSchedule: true, fetcher: () => { throw new Error("Unexpected network call"); } });
      assert.equal(app.port, 4321);
      assert.equal(app.config.get().openaiKey, "dotenv-private");
      assert.ok(fs.existsSync(${JSON.stringify(path.join(fixture.dir, "isolated", "devpulse.db"))}));
      assert.ok(!fs.existsSync(${JSON.stringify(path.join(fixture.dir, "data", "devpulse.db"))}));
      await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + app.server.address().port;
      try {
        const state = await (await fetch(base + "/api/state")).text();
        assert.ok(!state.includes("dotenv-private"));
        assert.ok(!state.includes("dotenv-token"));
        assert.equal(JSON.parse(state).settings.openaiKeySource, "dotenv");
        const response = await fetch(base + "/api/settings", {
          method: "PUT", headers: { "Content-Type": "application/json", "X-DevPulse": "1" },
          body: JSON.stringify({ openaiKey: "ui-private", githubToken: "ui-token" })
        });
        const saved = await response.text();
        assert.equal(response.status, 200);
        for (const secret of ["dotenv-private", "dotenv-token", "ui-private", "ui-token"])
          assert.ok(!saved.includes(secret));
        assert.equal(JSON.parse(saved).envOpenaiKey, true);
        assert.equal(app.config.get().openaiKey, "dotenv-private");
        const file = fs.readFileSync(app.config.file, "utf8");
        assert.ok(!file.includes("dotenv-private"));
        assert.ok(!file.includes("dotenv-token"));
        assert.equal(JSON.parse(file).openaiKey, "ui-private");
      } finally { await app.close(); }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: os.tmpdir(), env: fixture.env, encoding: "utf8", timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!child.stdout.includes("dotenv-private"));
    assert.ok(!child.stderr.includes("dotenv-private"));
  } finally {
    fixture.done();
  }
});

test("CLI reports invalid port or data directory without printing secrets or creating a database", () => {
  const fixture = projectFixture();
  try {
    const file = path.join(fixture.dir, "private-directory-value");
    fs.writeFileSync(file, "");
    for (const [settings, message] of [
      ["PORT=secret-port\nDEVPULSE_DATA_DIR=./unused", "PORT phải là số nguyên"],
      ["PORT=3000\nDEVPULSE_DATA_DIR=./private-directory-value", "Không thể ghi thư mục dữ liệu"],
    ]) {
      fs.writeFileSync(path.join(fixture.dir, ".env"), "OPENAI_API_KEY=private-api-key\n" + settings);
      const child = spawnSync(process.execPath, [path.join(fixture.dir, "src", "server.js")], {
        cwd: os.tmpdir(), env: fixture.env, encoding: "utf8", timeout: 15000,
      });
      assert.equal(child.status, 1);
      assert.ok(child.stderr.includes(message));
      for (const secret of ["private-api-key", "secret-port", "private-directory-value"])
        assert.ok(!(child.stdout + child.stderr).includes(secret));
    }
    assert.ok(!fs.existsSync(path.join(fixture.dir, "unused")));
  } finally {
    fixture.done();
  }
});

test("demo ignores configured keys and real database; manual summary makes no GPT request", { timeout: 15000 }, async () => {
  const fixture = projectFixture();
  let child;
  try {
    const http = await import("node:http");
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    fs.writeFileSync(path.join(fixture.dir, ".env"), `OPENAI_API_KEY=real-private\nGITHUB_TOKEN=real-token\nPORT=${port}\nDEVPULSE_DATA_DIR=./real-data\n`);
    child = spawn(process.execPath, [path.join(fixture.dir, "scripts", "demo.js")], {
      cwd: os.tmpdir(), env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
    });
    const started = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => chunk.toString()),
      once(child, "exit").then(() => { throw new Error("Demo exited before listening"); }),
    ]);
    assert.ok(started.includes("DEMO"));
    assert.ok(!started.includes("real-private"));
    const base = "http://127.0.0.1:" + port;
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.settings.hasOpenaiKey, false);
    assert.equal(state.settings.hasGithubToken, false);
    assert.equal(state.settings.openaiKeySource, "none");
    assert.equal(state.settings.scheduleEnabled, false);
    const articles = await (await fetch(base + "/api/articles?summary=missing")).json();
    const article = articles.items.find(item => !item.summary);
    const response = await fetch(base + "/api/articles/" + article.id + "/summary", {
      method: "POST", headers: { "Content-Type": "application/json", "X-DevPulse": "1" }, body: "{}",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Chưa cấu hình OpenAI/);
    const usage = await (await fetch(base + "/api/usage")).json();
    assert.equal(usage.totals.requests, 0);
    assert.ok(fs.existsSync(path.join(fixture.dir, "data", "demo", "devpulse.db")));
    assert.ok(!fs.existsSync(path.join(fixture.dir, "real-data")));
    assert.ok(!fs.existsSync(path.join(fixture.dir, "data", "devpulse.db")));
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    fixture.done();
  }
});