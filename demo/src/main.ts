import "./style.css";

// ── DOM elements ─────────────────────────────

const $msgs = document.getElementById("messages")!;
const $input = document.getElementById("input") as HTMLTextAreaElement;
const $send = document.getElementById("send") as HTMLButtonElement;
const $status = document.getElementById("status")!;
const $debug = document.getElementById("debug-messages")!;
const $debugCount = document.getElementById("debug-count")!;
const $debugFilter = document.getElementById("debug-filter") as HTMLInputElement;
const $btnAll = document.getElementById("btn-all")!;
const $btnSend = document.getElementById("btn-send")!;
const $btnRecv = document.getElementById("btn-recv")!;
const $resizeHandle = document.getElementById("resize-handle")!;
const $debugPanel = document.getElementById("debug-panel")!;
const $btnCopy = document.getElementById("btn-copy")!;
const $btnCollapse = document.getElementById("btn-collapse")!;
const $debugMini = document.getElementById("debug-mini")!;

// ── Task manager DOM ─────────────────────────

const $taskBar = document.getElementById("task-bar")!;
const $taskIcon = document.getElementById("task-icon")!;
const $taskText = document.getElementById("task-text")!;
const $taskPanel = document.getElementById("task-panel")!;
const $taskList = document.getElementById("task-list")!;

// ── State ────────────────────────────────────

let ws: WebSocket;
let busy = false;
let assistantEl: HTMLElement | null = null;
let thoughtEl: HTMLElement | null = null;
const toolEls: Record<string, HTMLElement> = {};
let protoCount = 0;
let dirFilter: "all" | "send" | "recv" = "all";
let textFilter = "";
let startTime = Date.now();
let autoScrollDebug = true;
const protoLog: { dir: string; ts: number; msg: unknown }[] = [];

// ── Task manager state ───────────────────────

interface TaskInfo {
  toolCallId: string;
  title: string;
  kind: string;
  toolKind: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  isBackground: boolean;
  startTime: number;
  endTime: number | null;
}

const taskStore: Record<string, TaskInfo> = {};
const peekStatus: Record<string, string> = {};
let turnToolCallIds: string[] = [];
let taskPanelOpen = false;
let userClosedPanel = false;

$taskBar.addEventListener("click", () => {
  taskPanelOpen = !taskPanelOpen;
  if (!taskPanelOpen) userClosedPanel = true;
  $taskBar.classList.toggle("open", taskPanelOpen);
  $taskPanel.style.display = taskPanelOpen ? "block" : "none";
});

function classifyTool(meta: any): string {
  const name = meta?.claudeCode?.toolName || "";
  if (name === "Task") return "agent";
  if (name === "Bash") return "bash";
  if (name) return "other";
  return "other";
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}

function renderTasks() {
  const bgTasks = Object.values(taskStore).filter((t) => t.isBackground);
  const activeCount = bgTasks.filter((t) => t.status === "running").length;
  const allDone = bgTasks.length > 0 && activeCount === 0;
  console.log(
    "[task-mgr] renderTasks: bgTasks=" + bgTasks.length,
    "active=" + activeCount,
    bgTasks.map((t) => t.toolCallId + ":" + t.status),
  );

  if (bgTasks.length === 0) {
    $taskBar.style.display = "none";
    $taskPanel.style.display = "none";
    userClosedPanel = false;
    return;
  }

  $taskBar.style.display = "flex";

  if (activeCount > 0 && !taskPanelOpen && !userClosedPanel) {
    taskPanelOpen = true;
    $taskBar.classList.add("open");
    $taskPanel.style.display = "block";
  }
  $taskIcon.className = allDone ? "all-done" : "";
  $taskText.textContent = allDone
    ? bgTasks.length +
      " background task" +
      (bgTasks.length === 1 ? "" : "s") +
      " \u2014 all done"
    : activeCount +
      " active background task" +
      (activeCount === 1 ? "" : "s");

  $taskList.innerHTML = "";
  for (const task of bgTasks) {
    const now = Date.now();
    const elapsed = (task.endTime || now) - task.startTime;
    const badgeClass = task.toolKind || "other";
    const badgeLabel =
      badgeClass === "agent"
        ? "AGENT"
        : badgeClass === "bash"
          ? "BASH"
          : "TOOL";
    const statusClass =
      task.status === "running"
        ? "running"
        : task.status === "completed"
          ? "completed"
          : "failed";
    const statusLabel =
      task.status === "running"
        ? "running"
        : task.status === "completed"
          ? "done"
          : "failed";
    const isDone = task.status !== "running";

    const row = document.createElement("div");
    row.className = "task-item";
    row.innerHTML =
      '<span class="task-badge ' +
      badgeClass +
      '">' +
      badgeLabel +
      "</span>" +
      '<span class="task-title">' +
      escapeHtml(task.title) +
      "</span>" +
      '<span class="task-elapsed">' +
      formatElapsed(elapsed) +
      "</span>" +
      '<span class="task-status ' +
      statusClass +
      '">' +
      statusLabel +
      "</span>" +
      '<button class="task-kill"' +
      (isDone ? " disabled" : "") +
      ">Kill</button>";

    if (!isDone) {
      row.querySelector<HTMLButtonElement>(".task-kill")!.onclick = () =>
        killTask(task);
    }
    $taskList.appendChild(row);

    const peek = peekStatus[task.toolCallId];
    if (peek && !isDone) {
      row.classList.add("has-peek");
      const peekEl = document.createElement("div");
      peekEl.className = "task-peek";
      peekEl.innerHTML =
        '<span class="peek-dot"></span>' + escapeHtml(peek);
      $taskList.appendChild(peekEl);
    }
  }
}

function killTask(task: TaskInfo) {
  if (!ws || task.status !== "running") return;
  const desc =
    task.toolKind === "bash"
      ? "Kill the background bash process: " + task.title
      : task.toolKind === "agent"
        ? "Kill the background agent task: " + task.title
        : "Kill the background task: " + task.title;
  addMsg("user", desc);
  assistantEl = null;
  thoughtEl = null;
  setReady(false);
  ws.send(JSON.stringify({ type: "prompt", text: desc }));
}

// Update elapsed times every second
setInterval(() => {
  const hasRunning = Object.values(taskStore).some(
    (t) => t.isBackground && t.status === "running",
  );
  if (hasRunning) renderTasks();
}, 1000);

// ── Collapse debug panel ─────────────────────

let debugCollapsed = false;
let savedDebugWidth = "";

$btnCollapse.onclick = () => {
  debugCollapsed = !debugCollapsed;
  if (debugCollapsed) {
    savedDebugWidth = $debugPanel.style.width || "";
    $debugPanel.style.width = "160px";
    $debug.style.display = "none";
    $debugMini.style.display = "flex";
    $debugMini.style.flexDirection = "column";
    $debugMini.scrollTop = $debugMini.scrollHeight;
    $debugFilter.style.display = "none";
    $resizeHandle.style.display = "none";
    for (const el of $debugPanel.querySelectorAll<HTMLElement>("#debug-controls, #btn-copy, #debug-count")) {
      el.style.display = "none";
    }
    $btnCollapse.innerHTML = "&#9664;";
  } else {
    $debugPanel.style.width = savedDebugWidth || "480px";
    $debug.style.display = "";
    $debugMini.style.display = "none";
    $debugFilter.style.display = "";
    $resizeHandle.style.display = "";
    for (const el of $debugPanel.querySelectorAll<HTMLElement>("#debug-controls, #btn-copy, #debug-count")) {
      el.style.display = "";
    }
    $btnCollapse.innerHTML = "&#9654;";
  }
};

// ── Resize ───────────────────────────────────

let resizing = false;
$resizeHandle.addEventListener("mousedown", (e) => {
  resizing = true;
  $resizeHandle.classList.add("active");
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const newWidth = window.innerWidth - e.clientX;
  $debugPanel.style.width =
    Math.max(200, Math.min(newWidth, window.innerWidth - 300)) + "px";
});
window.addEventListener("mouseup", () => {
  resizing = false;
  $resizeHandle.classList.remove("active");
});

// ── Debug panel scroll tracking ──────────────

$debug.addEventListener("scroll", () => {
  const gap = $debug.scrollHeight - $debug.scrollTop - $debug.clientHeight;
  autoScrollDebug = gap < 40;
});

// ── Filter controls ──────────────────────────

function setDirFilter(f: "all" | "send" | "recv") {
  dirFilter = f;
  [$btnAll, $btnSend, $btnRecv].forEach((b) =>
    b.classList.remove("active"),
  );
  if (f === "all") $btnAll.classList.add("active");
  else if (f === "send") $btnSend.classList.add("active");
  else $btnRecv.classList.add("active");
  applyFilters();
}

$btnAll.onclick = () => setDirFilter("all");
$btnSend.onclick = () => setDirFilter("send");
$btnRecv.onclick = () => setDirFilter("recv");

$debugFilter.addEventListener("input", () => {
  textFilter = $debugFilter.value.toLowerCase();
  applyFilters();
});

function applyFilters() {
  for (const el of $debug.children) {
    const htmlEl = el as HTMLElement;
    const dir = htmlEl.dataset.dir;
    const method = (htmlEl.dataset.method || "").toLowerCase();
    const dirOk = dirFilter === "all" || dirFilter === dir;
    const textOk = !textFilter || method.includes(textFilter);
    htmlEl.classList.toggle("filtered", !(dirOk && textOk));
  }
}

// ── JSON syntax highlighting ─────────────────

function syntaxHighlight(json: string): string {
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    function (match) {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + match + "</span>";
    },
  );
}

// ── Copy button ──────────────────────────────

$btnCopy.onclick = () => {
  const text = protoLog.map((e) => JSON.stringify(e)).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    $btnCopy.textContent = "Copied!";
    $btnCopy.classList.add("copied");
    setTimeout(() => {
      $btnCopy.textContent = "Copy All";
      $btnCopy.classList.remove("copied");
    }, 1500);
  });
};

// ── Protocol entry ───────────────────────────

function addProtoEntry(dir: string, ts: number, msg: any) {
  protoLog.push({ dir, ts, msg });
  protoCount++;
  $debugCount.textContent = String(protoCount);

  const method =
    msg.method ||
    (msg.result !== undefined ? "result" : msg.error ? "error" : "?");
  const id = msg.id !== undefined ? "#" + msg.id : "";
  const elapsed = ((ts - startTime) / 1000).toFixed(2) + "s";

  const json = JSON.stringify(msg, null, 2);
  const highlighted = syntaxHighlight(escapeHtml(json));

  const el = document.createElement("div");
  el.className = "proto-entry";
  el.dataset.dir = dir;
  el.dataset.method = method;

  el.innerHTML =
    '<div class="proto-summary">' +
    '<span class="proto-arrow">\u25B6</span>' +
    '<span class="proto-dir ' +
    dir +
    '">' +
    (dir === "send" ? "SND \u2192" : "RCV \u2190") +
    "</span>" +
    '<span class="proto-method">' +
    escapeHtml(method) +
    "</span>" +
    '<span class="proto-id">' +
    id +
    "</span>" +
    '<span class="proto-time">' +
    elapsed +
    "</span>" +
    "</div>" +
    '<div class="proto-body"><pre>' +
    highlighted +
    "</pre></div>";

  el.querySelector(".proto-summary")!.addEventListener("click", () => {
    el.classList.toggle("open");
  });

  // Apply current filters
  const dirOk = dirFilter === "all" || dirFilter === dir;
  const textOk = !textFilter || method.toLowerCase().includes(textFilter);
  if (!(dirOk && textOk)) el.classList.add("filtered");

  $debug.appendChild(el);
  if (autoScrollDebug) $debug.scrollTop = $debug.scrollHeight;

  // Mini feed entry
  const mini = document.createElement("div");
  mini.className = "mini-entry";
  mini.innerHTML =
    '<span class="proto-dir ' + dir + '">' +
    (dir === "send" ? "SND" : "RCV") +
    "</span>" +
    '<span class="mini-method">' + escapeHtml(method) + "</span>";
  $debugMini.appendChild(mini);
  $debugMini.scrollTop = $debugMini.scrollHeight;
}

// ── Chat helpers ─────────────────────────────

function scrollBottom() {
  $msgs.scrollTop = $msgs.scrollHeight;
}

function setReady(ready: boolean) {
  busy = !ready;
  $input.disabled = !ready;
  $send.disabled = !ready || !$input.value.trim();
  if (ready) $input.focus();
}

function addMsg(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.textContent = text;
  $msgs.appendChild(el);
  scrollBottom();
  return el;
}

function addHtml(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  $msgs.appendChild(el.firstElementChild || el);
  scrollBottom();
  return $msgs.lastElementChild as HTMLElement;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── WebSocket ────────────────────────────────

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws");

  ws.onopen = () => {
    $status.textContent = "connected";
    $status.className = "connected";
    startTime = Date.now();
    setReady(true);
  };

  ws.onclose = () => {
    $status.textContent = "disconnected";
    $status.className = "error";
    setReady(false);
    setTimeout(connect, 2000);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMsg(msg);
  };
}

function handleMsg(msg: any) {
  switch (msg.type) {
    // ── Protocol debug messages ───
    case "protocol":
      addProtoEntry(msg.dir, msg.ts, msg.msg);
      break;

    // ── Chat messages ─────────────
    case "text":
      if (!assistantEl) {
        assistantEl = addMsg("assistant", "");
      }
      assistantEl.textContent += msg.text;
      scrollBottom();
      break;

    case "thought":
      if (!thoughtEl) {
        thoughtEl = addMsg("thought", "");
      }
      thoughtEl.textContent += msg.text;
      scrollBottom();
      break;

    case "tool_call": {
      thoughtEl = null;
      const content = (msg.content || [])
        .filter((c: any) => c.content?.text)
        .map((c: any) => c.content.text)
        .join("\n");
      const contentHtml = content
        ? '<div class="tool-content">' + escapeHtml(content) + "</div>"
        : "";
      const el = addHtml(
        '<div class="tool-call" id="tool-' +
          msg.toolCallId +
          '">' +
          '<div class="tool-header">' +
          '<span class="tool-kind">' +
          escapeHtml(msg.kind || "tool") +
          "</span>" +
          '<span class="tool-title">' +
          escapeHtml(msg.title || msg.toolCallId) +
          "</span>" +
          '<span class="tool-status pending">running</span>' +
          "</div>" +
          contentHtml +
          "</div>",
      );
      toolEls[msg.toolCallId] = el;
      // Track for background task detection
      const isBg = msg._meta?.claudeCode?.isBackground === true;
      console.log(
        "[task-mgr] tool_call",
        msg.toolCallId,
        "tool=" + (msg._meta?.claudeCode?.toolName || "?"),
        "isBackground=" + isBg,
        "_meta=",
        msg._meta,
      );
      taskStore[msg.toolCallId] = {
        toolCallId: msg.toolCallId,
        title: msg.title || msg.toolCallId,
        kind: msg.kind || "tool",
        toolKind: classifyTool(msg._meta),
        toolName: msg._meta?.claudeCode?.toolName || "",
        status: "running",
        isBackground: isBg,
        startTime: Date.now(),
        endTime: null,
      };
      turnToolCallIds.push(msg.toolCallId);
      if (isBg) renderTasks();
      // Track peek for parent background task
      const parentId = msg._meta?.claudeCode?.parentToolUseId;
      if (parentId && taskStore[parentId]?.isBackground) {
        peekStatus[parentId] =
          msg.title || msg._meta?.claudeCode?.toolName || "Working...";
        renderTasks();
      }
      break;
    }

    case "tool_call_update": {
      const el = toolEls[msg.toolCallId];
      if (el) {
        const statusEl = el.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = msg.status;
          statusEl.className = "tool-status " + msg.status;
        }
        if (msg.content && msg.content.length) {
          let contentEl = el.querySelector(".tool-content");
          if (!contentEl) {
            contentEl = document.createElement("div");
            contentEl.className = "tool-content";
            el.appendChild(contentEl);
          }
          const text = msg.content
            .filter((c: any) => c.content?.text)
            .map((c: any) => c.content.text)
            .join("\n");
          if (text) contentEl.textContent = text;
        }
      }
      // Update task store
      const task = taskStore[msg.toolCallId];
      if (task) {
        if (msg.status === "completed" || msg.status === "failed") {
          const isBgComplete = msg._meta?.claudeCode?.backgroundComplete;
          if (!task.isBackground || msg.status === "failed" || isBgComplete) {
            task.status = msg.status === "failed" ? "failed" : "completed";
            task.endTime = Date.now();
          }
        }
        if (msg.title) task.title = msg.title;
        if (task.isBackground && task.status !== "running") {
          delete peekStatus[msg.toolCallId];
        }
        if (task.isBackground) renderTasks();
      }
      // Track peek for parent background task
      const updateParentId = msg._meta?.claudeCode?.parentToolUseId;
      if (
        updateParentId &&
        taskStore[updateParentId]?.isBackground &&
        taskStore[updateParentId].status === "running"
      ) {
        if (msg.status === "completed") {
          peekStatus[updateParentId] = "Processing results...";
        }
        renderTasks();
      }
      break;
    }

    case "plan": {
      thoughtEl = null;
      const entries = msg.entries
        .map((e: any) => {
          const icon =
            e.status === "completed"
              ? "\u2713"
              : e.status === "in_progress"
                ? "\u25B6"
                : " ";
          return (
            '<div class="plan-entry">' +
            '<span class="marker ' +
            e.status +
            '">' +
            icon +
            "</span>" +
            "<span>" +
            escapeHtml(e.content) +
            "</span></div>"
          );
        })
        .join("");
      addHtml(
        '<div class="plan"><div class="plan-title">Plan</div>' +
          entries +
          "</div>",
      );
      break;
    }

    case "permission":
      addHtml(
        '<div class="permission">Allowed: ' +
          escapeHtml(msg.title) +
          "</div>",
      );
      break;

    case "system":
      addMsg("system", msg.text);
      break;

    case "session_info":
      addMsg(
        "system",
        "Session " +
          msg.sessionId.slice(0, 8) +
          "... | Models: " +
          msg.models.join(", ") +
          " | Modes: " +
          msg.modes.map((m: any) => m.id).join(", "),
      );
      break;

    case "turn_end":
      assistantEl = null;
      thoughtEl = null;
      console.log(
        "[task-mgr] turn_end, turnToolCallIds=",
        turnToolCallIds.slice(),
        "taskStore=",
        JSON.parse(JSON.stringify(taskStore)),
      );
      for (const id of turnToolCallIds) {
        const task = taskStore[id];
        if (task && task.status === "running") {
          task.isBackground = true;
          console.log("[task-mgr] marking as background:", id, task.title);
        }
      }
      turnToolCallIds = [];
      renderTasks();
      setReady(true);
      break;

    case "error":
      addMsg("system", "Error: " + msg.text);
      setReady(true);
      break;
  }
}

function send() {
  const text = $input.value.trim();
  if (!text || busy) return;
  addMsg("user", text);
  assistantEl = null;
  thoughtEl = null;
  setReady(false);
  ws.send(JSON.stringify({ type: "prompt", text }));
  $input.value = "";
  $input.style.height = "auto";
}

$send.onclick = send;
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$input.addEventListener("input", () => {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 120) + "px";
  $send.disabled = busy || !$input.value.trim();
});

connect();
