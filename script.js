/**
 * APK Forge — frontend logic
 * ---------------------------------------------------------
 * 1. Submit the repo URL to POST /api/build -> get { buildId }
 * 2. Open a WebSocket to /ws?buildId=<id>
 * 3. Render incoming { type: "log" | "status" | "done" | "error" } messages
 */

// If you serve frontend and backend from the same origin (e.g. Express
// serving the /frontend folder), these can stay relative. If you split
// them across two hosts, set BACKEND_ORIGIN to the backend's URL.
const BACKEND_ORIGIN = ""; // e.g. "https://your-backend.onrender.com"
const WS_ORIGIN = BACKEND_ORIGIN
  ? BACKEND_ORIGIN.replace(/^http/, "ws")
  : (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

const form = document.getElementById("build-form");
const input = document.getElementById("repo-url");
const buildBtn = document.getElementById("build-btn");
const pipeline = document.getElementById("pipeline");
const terminalBody = document.getElementById("terminal-body");
const resultBox = document.getElementById("result");
const resultTitle = document.getElementById("result-title");
const resultSub = document.getElementById("result-sub");
const downloadLink = document.getElementById("download-link");

const STEP_ORDER = ["cloning", "compiling", "packaging", "success"];
let activeSocket = null;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const repoUrl = input.value.trim();
  if (!repoUrl) return;

  resetUI();
  setLoading(true);

  try {
    const res = await fetch(`${BACKEND_ORIGIN}/api/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start build");

    connectToLogs(data.buildId);
  } catch (err) {
    appendLog(`❌ ${err.message}`, "err");
    setLoading(false);
    showResult({ ok: false, message: err.message });
  }
});

function resetUI() {
  terminalBody.innerHTML = "";
  resultBox.hidden = true;
  pipeline.dataset.state = "idle";
  pipeline.querySelectorAll(".pipeline__step").forEach((el) => {
    el.classList.remove("is-active", "is-done");
  });
  if (activeSocket) {
    activeSocket.close();
    activeSocket = null;
  }
}

function setLoading(isLoading) {
  buildBtn.disabled = isLoading;
  buildBtn.classList.toggle("is-loading", isLoading);
}

function connectToLogs(buildId) {
  const socket = new WebSocket(`${WS_ORIGIN}/ws?buildId=${encodeURIComponent(buildId)}`);
  activeSocket = socket;

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "log":
        appendLog(msg.line, msg.line.startsWith("[stderr]") ? "err" : "");
        break;
      case "status":
        setPipelineStep(msg.status);
        break;
      case "done":
        setLoading(false);
        if (msg.error) {
          showResult({ ok: false, message: msg.error });
        } else {
          showResult({ ok: true, downloadUrl: msg.downloadUrl });
        }
        socket.close();
        break;
      case "error":
        appendLog(`❌ ${msg.message}`, "err");
        setLoading(false);
        break;
    }
  });

  socket.addEventListener("error", () => {
    appendLog("❌ Lost connection to the build server.", "err");
    setLoading(false);
  });
}

function appendLog(line, variant = "") {
  // Remove placeholder text on first real log line
  const placeholder = terminalBody.querySelector(".terminal__placeholder");
  if (placeholder) placeholder.remove();

  const el = document.createElement("div");
  if (variant) el.className = `line--${variant}`;
  el.textContent = line;
  terminalBody.appendChild(el);
  terminalBody.scrollTop = terminalBody.scrollHeight;
}

function setPipelineStep(status) {
  pipeline.dataset.state = status === "failed" ? "failed" : "running";

  const targetIndex = STEP_ORDER.indexOf(status);
  pipeline.querySelectorAll(".pipeline__step").forEach((el, i) => {
    el.classList.remove("is-active", "is-done");
    if (status === "failed") {
      // Mark the furthest reached step as the failure point
      if (i < targetIndex) el.classList.add("is-done");
      return;
    }
    if (i < targetIndex) el.classList.add("is-done");
    if (i === targetIndex) el.classList.add(status === "success" ? "is-done" : "is-active");
  });
}

function showResult({ ok, downloadUrl, message }) {
  resultBox.hidden = false;
  resultBox.dataset.variant = ok ? "success" : "error";

  if (ok) {
    resultTitle.textContent = "Build succeeded";
    resultSub.textContent = "Your APK is ready to install.";
    downloadLink.href = `${BACKEND_ORIGIN}${downloadUrl}`;
    downloadLink.hidden = false;
  } else {
    resultTitle.textContent = "Build failed";
    resultSub.textContent = message || "Check the log above for details.";
    downloadLink.hidden = true;
  }
}
