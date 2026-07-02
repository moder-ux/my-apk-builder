# APK Forge

Clone a Git repo (e.g. a Replit project synced to GitHub), compile it with Gradle,
and hand back a downloadable `.apk` — with live build logs streamed to the browser.

```
apk-builder/
├── backend/
│   ├── server.js          # Express API + WebSocket log streaming + build pipeline
│   ├── package.json
│   ├── .env.example
│   └── public/downloads/  # finished APKs are copied here and served statically
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── Dockerfile              # JDK + Android SDK + Node, needed for real builds
└── README.md
```

---

## 1. How it works

1. Browser POSTs `{ repoUrl }` to `POST /api/build`.
2. Server validates the URL against an allow-list of git hosts, generates a
   `buildId`, and **immediately responds** with `{ buildId }` — the actual
   build runs asynchronously in the background.
3. Browser opens `new WebSocket("wss://.../ws?buildId=...")`.
4. As the server runs `git clone` and `./gradlew assembleDebug` via
   `child_process.spawn`, every stdout/stderr line is broadcast to that
   buildId's subscribed sockets as `{ type: "log", line }`.
5. Status transitions (`cloning → compiling → packaging → success/failed`)
   are broadcast as `{ type: "status", status }` and drive the pipeline
   stepper UI.
6. On success, the APK is copied to `backend/public/downloads/<buildId>.apk`
   and a `{ type: "done", downloadUrl }` message unlocks the download button.

### Why WebSockets instead of SSE here

Both work for this use case since logs only flow server → client. I used
**WebSockets** (via the `ws` package) because:
- It's trivial to multiplex many concurrent builds by keying sockets to a
  `buildId` query param, and the same connection pattern would let you add
  bidirectional features later (e.g. a "cancel build" button) without
  switching transport.
- Some free hosts / proxies buffer SSE responses, which can make "live" logs
  arrive in bursts instead of line-by-line.

**If you'd rather use SSE** (simpler, plain HTTP, auto-reconnect built into
`EventSource`), swap the WebSocket block in `server.js` for an endpoint like:

```js
app.get("/api/stream/:buildId", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const build = getOrCreateBuild(req.params.buildId);
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  build.sseClients = build.sseClients || new Set();
  build.sseClients.add(send);

  req.on("close", () => build.sseClients.delete(send));
});
```
...and call each `send()` in `sseClients` everywhere `broadcast()` currently
writes to WebSocket sockets. On the frontend, replace the `WebSocket` block
in `script.js` with:
```js
const es = new EventSource(`/api/stream/${buildId}`);
es.onmessage = (e) => handleMessage(JSON.parse(e.data));
```

---

## 2. Run it locally

### Prerequisites
- Node.js 18+
- **JDK 17** (`java -version`)
- **Android SDK** with `ANDROID_HOME` set, plus `platform-tools` and at least
  one `platforms;android-XX` + `build-tools;XX.0.0` matching what the repos
  you'll build expect. Easiest path: install **Android Studio** once, then
  point `ANDROID_HOME` at its SDK folder (Studio's SDK Manager UI can add/
  remove platform versions).
- `git` on your PATH.

### Steps
```bash
# 1. Backend
cd backend
cp .env.example .env         # edit ANDROID_HOME etc. if needed
npm install
npm start                    # -> http://localhost:5000

# 2. Frontend
# server.js already serves the /frontend folder as static files,
# so just open http://localhost:5000 in your browser — no separate step needed.
```

Paste a Git URL of an Android Gradle project (must have `gradlew` at its
root) and click **Build APK**. Watch the terminal panel for live output.

> **Test repo tip:** Google's official [`android/sunflower`](https://github.com/android/sunflower)
> or any basic `File > New Project` Android Studio scaffold pushed to GitHub
> work well as smoke tests before pointing this at a Replit project.

---

## 3. Deploying for free (Render / Railway)

Android builds need a JDK + Android SDK on the server — a bare Node
buildpack won't have these. **Deploy the included `Dockerfile`**, which
installs everything in one image.

### Option A — Railway
1. Push this project to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, select the repo.
3. Railway auto-detects the `Dockerfile` at the project root and builds it.
4. Under **Variables**, add anything from `.env.example` you want to
   override (e.g. `BUILD_TIMEOUT_MS`).
5. Railway assigns a public URL automatically — that's both your frontend
   and API (same origin, so `BACKEND_ORIGIN` in `script.js` can stay `""`).
6. **Note on disk:** Railway's filesystem is ephemeral per deploy but fine
   for this use case since each build cleans up its clone directory after
   copying out the APK.

### Option B — Render
1. Push this project to GitHub.
2. In Render: **New → Web Service**, connect the repo.
3. Set **Runtime** to **Docker** (Render detects the `Dockerfile`
   automatically if it's at the repo root).
4. Set the **Health Check Path** to `/api/health`.
5. Free tier constraints to plan around:
   - Services spin down after inactivity, so the *first* build request after
     idling will be slow (cold start) — the SDK/JDK image is large.
   - Free tier has limited build minutes/RAM; a large Android project may hit
     Gradle's memory needs. If builds fail with OOM, add a `gradle.properties`
     override in the pipeline (`org.gradle.jvmargs=-Xmx1536m`) or upgrade the
     instance.
   - Free instances have ephemeral disk — same as Railway, this is fine since
     we don't persist clones.

### Either platform — a few production hardening steps worth doing
- **Auth-gate the `/api/build` endpoint** (API key header, or put it behind
  your app's existing login) — right now anyone with the URL can trigger
  arbitrary Gradle builds on your server.
- **Rate-limit** `/api/build` per IP (e.g. `express-rate-limit`) to stop one
  user from queuing unlimited concurrent builds.
- **Isolate builds** further by running each `gradlew` invocation inside its
  own short-lived container (e.g. spin up a Docker-in-Docker sidecar, or use
  a job queue like BullMQ + a worker pool) rather than directly on the web
  server's process, especially if you'll accept truly untrusted repos.
- **Expire old APKs** — add a cron/cleanup job that deletes files in
  `public/downloads/` older than, say, 24 hours, so disk doesn't fill up.

---

## 4. Extending it
- Swap the in-memory `builds` Map for Redis if you need to scale the backend
  horizontally (multiple server instances) — WebSocket subscribers would then
  need a pub/sub bridge (Redis pub/sub or similar) to hear about builds
  started on a different instance.
- Add a `assembleRelease` option (with signing config) alongside
  `assembleDebug` if you need installable, distributable builds instead of
  debug-only APKs.
- Persist build history (repoUrl, status, timestamp, download link) in a
  small SQLite/Postgres table so users can see past builds.
