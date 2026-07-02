/**
 * APK Builder Backend
 * ---------------------------------------------------------
 * Flow:
 *   1. Client POSTs a git URL to /api/build
 *   2. Server validates the URL, creates a buildId, starts the build
 *      pipeline asynchronously, and immediately returns { buildId }
 *   3. Client opens a WebSocket to /ws?buildId=<id> to receive
 *      real-time log lines and status updates
 *   4. On success, server emits a "done" message with a download URL
 *      that points at a statically-served file in /public/downloads
 *
 * IMPORTANT SECURITY NOTES (read before deploying publicly):
 *   - This endpoint runs arbitrary user-supplied repositories' build
 *     scripts (gradlew) on your server. Treat this as remote code
 *     execution by design. Only expose it if you trust your users,
 *     put it behind auth, and/or run builds inside an isolated
 *     container/VM per build (see README).
 *   - We use `spawn` (never `exec`/shell string concatenation) so
 *     user input can't be used for shell injection.
 *   - We whitelist allowed git hosts and reject anything else.
 *   - We enforce a hard timeout per build and kill the process tree.
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs-extra");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const { spawn } = require("child_process");
require("dotenv").config();

// ---------- Configuration ----------
const PORT = process.env.PORT || 5000;
const WORK_DIR = process.env.WORK_DIR || "/tmp/apk-builds";
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || "./public/downloads");
const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS || "900000", 10); // 15 min default
const ALLOWED_GIT_HOSTS = (process.env.ALLOWED_GIT_HOSTS || "github.com,gitlab.com,replit.com")
  .split(",")
  .map((h) => h.trim().toLowerCase());

fs.ensureDirSync(WORK_DIR);
fs.ensureDirSync(DOWNLOAD_DIR);

// ---------- App / server / websocket setup ----------
const app = express();
app.use(cors());
app.use(express.json());

// Serve the finished APKs
app.use("/downloads", express.static(DOWNLOAD_DIR));

// Serve the frontend (see /frontend folder) if you want one process to do both
app.use(express.static(path.join(__dirname, "..", "frontend")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// In-memory registry of build state, keyed by buildId.
// For production, swap this for Redis so it survives restarts / scales horizontally.
const builds = new Map(); // buildId -> { status, sockets: Set<ws>, logBuffer: string[] }

function getOrCreateBuild(buildId) {
  if (!builds.has(buildId)) {
    builds.set(buildId, { status: "pending", sockets: new Set(), logBuffer: [] });
  }
  return builds.get(buildId);
}

/** Broadcast a structured message to every socket subscribed to a build,
 *  and also keep a rolling buffer so late-connecting clients can catch up. */
function broadcast(buildId, payload) {
  const build = getOrCreateBuild(buildId);
  const message = JSON.stringify(payload);

  if (payload.type === "log") {
    build.logBuffer.push(payload.line);
    if (build.logBuffer.length > 2000) build.logBuffer.shift(); // cap memory use
  }
  if (payload.type === "status") {
    build.status = payload.status;
  }

  for (const socket of build.sockets) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}

// ---------- WebSocket: log streaming ----------
wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const buildId = url.searchParams.get("buildId");

  if (!buildId || !builds.has(buildId)) {
    socket.send(JSON.stringify({ type: "error", message: "Unknown or missing buildId" }));
    socket.close();
    return;
  }

  const build = builds.get(buildId);
  build.sockets.add(socket);

  // Replay any logs the client missed (e.g. they connected slightly late)
  socket.send(JSON.stringify({ type: "status", status: build.status }));
  for (const line of build.logBuffer) {
    socket.send(JSON.stringify({ type: "log", line }));
  }

  socket.on("close", () => build.sockets.delete(socket));
});

// ---------- Helpers ----------

/** Basic allow-list validation to reduce abuse (SSRF to internal hosts, etc). */
function isAllowedGitUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    return ALLOWED_GIT_HOSTS.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Runs a command as a child process, streaming stdout/stderr line-by-line
 *  to the given buildId's websocket subscribers. Resolves with exit code. */
function runStreamed(command, args, options, buildId) {
  return new Promise((resolve, reject) => {
    broadcast(buildId, { type: "log", line: `$ ${command} ${args.join(" ")}` });

    const child = spawn(command, args, { ...options, shell: false });

    const timeout = setTimeout(() => {
      broadcast(buildId, { type: "log", line: "⏱️  Build timed out — killing process." });
      child.kill("SIGKILL");
      reject(new Error("Build timed out"));
    }, BUILD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => broadcast(buildId, { type: "log", line }));
    });

    child.stderr.on("data", (chunk) => {
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => broadcast(buildId, { type: "log", line: `[stderr] ${line}` }));
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

/** Recursively search a directory for the first *.apk file matching a pattern. */
async function findApk(rootDir) {
  const candidates = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip heavy irrelevant dirs to keep this fast
        if (["node_modules", ".git", ".gradle"].includes(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".apk")) {
        candidates.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  // Prefer debug APKs if multiple are found
  candidates.sort((a, b) => (a.includes("debug") ? -1 : 1));
  return candidates[0] || null;
}

// ---------- Core build pipeline ----------
async function runBuildPipeline(buildId, repoUrl) {
  const buildDir = path.join(WORK_DIR, buildId);

  try {
    broadcast(buildId, { type: "status", status: "cloning" });
    await fs.ensureDir(buildDir);

    // 1. Clone the repository (shallow clone = faster, less disk usage)
    await runStreamed(
      "git",
      ["clone", "--depth", "1", repoUrl, buildDir],
      {},
      buildId
    );

    // 2. Make sure gradlew is executable (git sometimes drops the +x bit)
    const gradlewPath = path.join(buildDir, "gradlew");
    if (!(await fs.pathExists(gradlewPath))) {
      throw new Error("No gradlew found in repository root — is this an Android Gradle project?");
    }
    await fs.chmod(gradlewPath, 0o755);

    // 3. Compile the debug APK
    broadcast(buildId, { type: "status", status: "compiling" });
    const exitCode = await runStreamed(
      "./gradlew",
      ["assembleDebug", "--no-daemon", "--stacktrace"],
      { cwd: buildDir, env: { ...process.env } },
      buildId
    );

    if (exitCode !== 0) {
      throw new Error(`Gradle exited with code ${exitCode}`);
    }

    // 4. Locate and move the APK into the public downloads folder
    broadcast(buildId, { type: "status", status: "packaging" });
    const apkPath = await findApk(path.join(buildDir, "app", "build", "outputs", "apk"));
    if (!apkPath) throw new Error("Build succeeded but no .apk file was found.");

    const finalName = `${buildId}.apk`;
    const finalPath = path.join(DOWNLOAD_DIR, finalName);
    await fs.copy(apkPath, finalPath);

    broadcast(buildId, { type: "log", line: `✅ APK ready: /downloads/${finalName}` });
    broadcast(buildId, { type: "status", status: "success" });
    broadcast(buildId, { type: "done", downloadUrl: `/downloads/${finalName}` });
  } catch (err) {
    broadcast(buildId, { type: "log", line: `❌ Build failed: ${err.message}` });
    broadcast(buildId, { type: "status", status: "failed" });
    broadcast(buildId, { type: "done", error: err.message });
  } finally {
    // Clean up the cloned source to save disk space (keep only the APK output).
    // Comment this out during development if you want to inspect failed builds.
    fs.remove(buildDir).catch(() => {});
  }
}

// ---------- API routes ----------

// Kick off a new build. Returns immediately with a buildId to subscribe to.
app.post("/api/build", (req, res) => {
  const { repoUrl } = req.body || {};

  if (!repoUrl || typeof repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl is required" });
  }
  if (!isAllowedGitUrl(repoUrl)) {
    return res.status(400).json({
      error: `URL must be a valid https:// link from an allowed host (${ALLOWED_GIT_HOSTS.join(", ")})`,
    });
  }

  const buildId = uuidv4();
  getOrCreateBuild(buildId); // initialize state before returning so the WS connect never races

  // Fire-and-forget: the pipeline reports progress via WebSocket, not via HTTP.
  runBuildPipeline(buildId, repoUrl);

  res.json({ buildId });
});

// Optional: poll-based status check as a fallback if WebSockets are blocked by a proxy.
app.get("/api/status/:buildId", (req, res) => {
  const build = builds.get(req.params.buildId);
  if (!build) return res.status(404).json({ error: "Unknown buildId" });
  res.json({ status: build.status, logs: build.logBuffer });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`🚀 APK Builder server listening on http://localhost:${PORT}`);
});
