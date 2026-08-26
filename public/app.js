const state = {
  audit: null,
  tasks: [],
  integrations: [],
  loading: false,
  pulse: 0
};

const els = {
  agentState: document.querySelector("#agentState"),
  scoreMini: document.querySelector("#scoreMini"),
  radarCanvas: document.querySelector("#radarCanvas"),
  refreshButton: document.querySelector("#refreshButton"),
  deepScanButton: document.querySelector("#deepScanButton"),
  statusLine: document.querySelector("#statusLine"),
  scoreValue: document.querySelector("#scoreValue"),
  scoreLevel: document.querySelector("#scoreLevel"),
  cpuValue: document.querySelector("#cpuValue"),
  cpuName: document.querySelector("#cpuName"),
  memoryValue: document.querySelector("#memoryValue"),
  memoryDetail: document.querySelector("#memoryDetail"),
  deviceValue: document.querySelector("#deviceValue"),
  securityBadge: document.querySelector("#securityBadge"),
  securityGrid: document.querySelector("#securityGrid"),
  findingList: document.querySelector("#findingList"),
  processList: document.querySelector("#processList"),
  thermalList: document.querySelector("#thermalList"),
  diskList: document.querySelector("#diskList"),
  deviceTable: document.querySelector("#deviceTable"),
  startupList: document.querySelector("#startupList"),
  integrationList: document.querySelector("#integrationList"),
  taskForm: document.querySelector("#taskForm"),
  taskTitle: document.querySelector("#taskTitle"),
  taskArea: document.querySelector("#taskArea"),
  taskPriority: document.querySelector("#taskPriority"),
  taskList: document.querySelector("#taskList")
};

const ctx = els.radarCanvas.getContext("2d");

init();

async function init() {
  bindEvents();
  renderEmpty();
  drawRadar();
  await Promise.all([
    loadAudit("status"),
    loadTasks(),
    loadIntegrations()
  ]);
  requestAnimationFrame(tick);
}

function bindEvents() {
  els.refreshButton.addEventListener("click", () => loadAudit("quick"));
  els.deepScanButton.addEventListener("click", () => loadAudit("deep"));
  els.taskForm.addEventListener("submit", createTask);
}

async function loadAudit(mode) {
  setLoading(true, mode === "deep" ? "Bezi deep scan." : "Nacitavam stav PC.");
  try {
    const url = mode === "status" ? "/api/pc/status" : `/api/pc/scan?mode=${encodeURIComponent(mode)}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Audit sa nepodarilo nacitat.");
    }
    state.audit = data;
    renderAudit(data);
    setStatus(`Posledny ${data.mode || mode} scan: ${formatDate(data.generatedAt)}.`, "ready");
  } catch (error) {
    setStatus(error.message || "Audit je nedostupny.", "error");
  } finally {
    setLoading(false);
  }
}

async function loadTasks() {
  try {
    const response = await fetch("/api/pc/tasks");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Ulohy sa nenacitali.");
    state.tasks = data.tasks || [];
    renderTasks();
  } catch (error) {
    els.taskList.innerHTML = `<div class="empty-mini">${escapeHtml(error.message)}</div>`;
  }
}

async function loadIntegrations() {
  try {
    const response = await fetch("/api/integrations");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Integracie sa nenacitali.");
    state.integrations = data.integrations || [];
    renderIntegrations();
  } catch (error) {
    els.integrationList.innerHTML = `<div class="empty-mini">${escapeHtml(error.message)}</div>`;
  }
}

async function createTask(event) {
  event.preventDefault();
  const title = els.taskTitle.value.trim();
  if (!title) {
    els.taskTitle.focus();
    return;
  }

  try {
    const response = await fetch("/api/pc/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        area: els.taskArea.value,
        priority: els.taskPriority.value
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Uloha sa neulozila.");
    state.tasks = data.tasks || [];
    els.taskTitle.value = "";
    renderTasks();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function updateTask(taskId, patch) {
  try {
    const response = await fetch(`/api/pc/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Uloha sa neaktualizovala.");
    state.tasks = data.tasks || [];
    renderTasks();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderEmpty() {
  els.securityGrid.innerHTML = `<div class="empty-mini">Cakam na audit.</div>`;
  els.findingList.innerHTML = "";
  els.processList.innerHTML = `<div class="empty-mini">Bez dat.</div>`;
  els.thermalList.innerHTML = `<div class="empty-mini">Bez dat.</div>`;
  els.diskList.innerHTML = "";
  els.deviceTable.innerHTML = `<div class="empty-mini">Bez dat.</div>`;
  els.startupList.innerHTML = `<div class="empty-mini">Bez dat.</div>`;
}

function renderAudit(audit) {
  const modules = audit.modules || {};
  const score = audit.score || {};
  const performance = modules.performance || {};
  const devices = modules.devices || {};

  els.scoreValue.textContent = valueOrDash(score.value);
  els.scoreMini.textContent = score.value === undefined ? "--" : `${score.value}/100`;
  els.scoreLevel.textContent = labelLevel(score.level);
  els.agentState.textContent = audit.computer?.name || "Local PC";
  document.body.dataset.level = score.level || "offline";

  els.cpuValue.textContent = percentage(performance.cpuLoadPercent);
  els.cpuName.textContent = performance.cpuName || "--";
  els.memoryValue.textContent = percentage(performance.memoryUsedPercent);
  els.memoryDetail.textContent = `${valueOrDash(performance.memoryUsedGb)} / ${valueOrDash(performance.memoryTotalGb)} GB`;
  els.deviceValue.textContent = valueOrDash(devices.count);

  renderSecurity(modules.security || {}, score);
  renderPerformance(performance);
  renderHardware(modules.thermals || {}, modules.storage || {});
  renderDevices(devices.items || []);
  renderSoftware(modules.software || {});
  drawRadar();
}

function renderSecurity(security, score) {
  const defender = security.defender || {};
  const firewall = security.firewall || [];
  const suspicious = security.suspiciousProcesses || [];
  const disabledFirewall = firewall.filter((item) => item.Enabled === false || item.enabled === false);

  els.securityBadge.textContent = labelLevel(score.level);
  els.securityBadge.dataset.level = score.level || "offline";

  const defenderState = defender.available
    ? (defender.antivirusEnabled && defender.realTimeProtectionEnabled ? "OK" : "Problem")
    : "Nedostupne";

  els.securityGrid.innerHTML = [
    renderStatusTile("Defender", defenderState, defender.available ? `Podpisy: ${valueOrDash(defender.signaturesAgeDays)} dni` : defender.message || "--"),
    renderStatusTile("Real-time", defender.realTimeProtectionEnabled ? "Zapnute" : "Vypnute", "Monitorovanie suborov a procesov"),
    renderStatusTile("Firewall", disabledFirewall.length ? `${disabledFirewall.length} vyp.` : "OK", `${firewall.length || 0} profilov`),
    renderStatusTile("Rizikove procesy", suspicious.length ? String(suspicious.length) : "0", "Heuristicke signaly")
  ].join("");

  const recommendations = score.recommendations || [];
  const rows = [
    ...recommendations.map((item) => ({
      severity: item.severity,
      title: item.title,
      detail: item.detail
    })),
    ...suspicious.map((item) => ({
      severity: "high",
      title: `${item.name} (${item.pid})`,
      detail: (item.signals || []).join(", ") || item.path || "Proces potrebuje kontrolu."
    }))
  ];

  if (!rows.length) {
    els.findingList.innerHTML = `<div class="finding ok"><strong>Bez kritickych nalezov</strong><span>Aktualny scan nenasiel okamzity problem.</span></div>`;
    return;
  }

  els.findingList.innerHTML = rows.slice(0, 10).map((item) => `
    <div class="finding ${escapeHtml(item.severity || "medium")}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail || "")}</span>
    </div>
  `).join("");
}

function renderPerformance(performance) {
  const processes = performance.topProcesses || [];
  if (!processes.length) {
    els.processList.innerHTML = `<div class="empty-mini">Procesy sa nenacitali.</div>`;
    return;
  }

  els.processList.innerHTML = processes.slice(0, 10).map((item) => `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <span>PID ${escapeHtml(item.pid)}</span>
      </div>
      <b>${valueOrDash(item.memoryMb)} MB</b>
    </div>
  `).join("");
}

function renderHardware(thermals, storage) {
  const sensors = thermals.sensors || [];
  if (sensors.length) {
    els.thermalList.innerHTML = sensors.map((sensor) => `
      <div class="list-row">
        <div>
          <strong>${escapeHtml(sensor.name)}</strong>
          <span>${escapeHtml(sensor.source || "sensor")}</span>
        </div>
        <b>${escapeHtml(sensor.celsius)} C</b>
      </div>
    `).join("");
  } else {
    els.thermalList.innerHTML = `<div class="empty-mini">${escapeHtml(thermals.note || "Teplotne senzory nie su dostupne.")}</div>`;
  }

  const disks = storage.logical || [];
  if (!disks.length) {
    els.diskList.innerHTML = `<div class="empty-mini">Disky sa nenacitali.</div>`;
    return;
  }

  els.diskList.innerHTML = disks.map((disk) => `
    <div class="disk-row">
      <div class="disk-head">
        <strong>${escapeHtml(disk.name)} ${escapeHtml(disk.label || "")}</strong>
        <span>${percentage(disk.usedPercent)}</span>
      </div>
      <div class="bar"><span style="width:${clamp(disk.usedPercent || 0, 0, 100)}%"></span></div>
      <small>${valueOrDash(disk.freeGb)} GB volne z ${valueOrDash(disk.sizeGb)} GB</small>
    </div>
  `).join("");
}

function renderDevices(devices) {
  if (!devices.length) {
    els.deviceTable.innerHTML = `<div class="empty-mini">Ziadne zariadenia v audite.</div>`;
    return;
  }

  els.deviceTable.innerHTML = devices.slice(0, 48).map((item) => `
    <div class="device-row">
      <strong>${escapeHtml(item.name || "Bez nazvu")}</strong>
      <span>${escapeHtml(item.class || "--")}</span>
      <b>${escapeHtml(item.status || "--")}</b>
    </div>
  `).join("");
}

function renderSoftware(software) {
  const startup = software.startupItems || [];
  const apps = software.installedApps || {};
  const appText = apps.mode === "deep"
    ? `${valueOrDash(apps.count)} aplikacii`
    : "Deep scan doplni aplikacie";

  const rows = [
    {
      name: "Installed apps",
      detail: appText,
      value: apps.mode === "deep" ? "deep" : "quick"
    },
    ...startup.slice(0, 9).map((item) => ({
      name: item.name,
      detail: item.source,
      value: "startup"
    }))
  ];

  els.startupList.innerHTML = rows.map((item) => `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <span title="${escapeHtml(item.detail || "")}">${escapeHtml(shorten(item.detail || "", 76))}</span>
      </div>
      <b>${escapeHtml(item.value)}</b>
    </div>
  `).join("");
}

function renderIntegrations() {
  if (!state.integrations.length) {
    els.integrationList.innerHTML = `<div class="empty-mini">Bez integracii.</div>`;
    return;
  }

  els.integrationList.innerHTML = state.integrations.map((item) => `
    <div class="integration-row">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <span title="${escapeHtml(item.path || item.details || "")}">${escapeHtml(shorten(item.details || item.path || "", 92))}</span>
      </div>
      <b data-status="${escapeHtml(item.status)}">${escapeHtml(item.status)}</b>
    </div>
  `).join("");
}

function renderTasks() {
  if (!state.tasks.length) {
    els.taskList.innerHTML = `<div class="empty-mini">Backlog je prazdny.</div>`;
    return;
  }

  const sorted = [...state.tasks].sort((a, b) => {
    const statusOrder = { doing: 0, todo: 1, blocked: 2, done: 3 };
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) ||
      (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
  });

  els.taskList.innerHTML = sorted.map((task) => `
    <div class="task-row" data-task="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}">
      <div class="task-main">
        <strong>${escapeHtml(task.title)}</strong>
        ${task.detail ? `<p>${escapeHtml(task.detail)}</p>` : ""}
        <span>${escapeHtml(task.area)} / ${escapeHtml(task.priority)}</span>
      </div>
      <select data-field="status" aria-label="Stav ulohy">
        ${renderOption("todo", task.status, "Todo")}
        ${renderOption("doing", task.status, "Doing")}
        ${renderOption("done", task.status, "Done")}
        ${renderOption("blocked", task.status, "Blocked")}
      </select>
    </div>
  `).join("");

  els.taskList.querySelectorAll("select[data-field='status']").forEach((select) => {
    select.addEventListener("change", () => {
      const row = select.closest(".task-row");
      updateTask(row.dataset.task, { status: select.value });
    });
  });
}

function renderOption(value, current, label) {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;
}

function renderStatusTile(label, value, detail) {
  return `
    <div class="status-tile">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail || "")}</small>
    </div>
  `;
}

function setLoading(isLoading, message = "") {
  state.loading = isLoading;
  els.refreshButton.disabled = isLoading;
  els.deepScanButton.disabled = isLoading;
  if (message) setStatus(message, isLoading ? "loading" : "ready");
}

function setStatus(message, status) {
  els.statusLine.textContent = message;
  els.statusLine.dataset.status = status;
}

function tick() {
  state.pulse += state.loading ? 0.08 : 0.018;
  drawRadar();
  requestAnimationFrame(tick);
}

function drawRadar() {
  const width = els.radarCanvas.width;
  const height = els.radarCanvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f6f7fb";
  ctx.fillRect(0, 0, width, height);

  const center = { x: width / 2, y: height / 2 + 8 };
  const radius = Math.min(width, height) * 0.34;
  const values = getRadarValues();
  const labels = ["Sec", "CPU", "RAM", "Disk", "Temp", "Dev"];
  const points = values.map((value, index) => {
    const angle = -Math.PI / 2 + (index / values.length) * Math.PI * 2;
    const distance = radius * (clamp(value, 0, 100) / 100);
    return {
      x: center.x + Math.cos(angle) * distance,
      y: center.y + Math.sin(angle) * distance,
      lx: center.x + Math.cos(angle) * (radius + 24),
      ly: center.y + Math.sin(angle) * (radius + 24)
    };
  });

  ctx.strokeStyle = "rgba(31, 41, 55, 0.16)";
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * (ring / 4), 0, Math.PI * 2);
    ctx.stroke();
  }

  for (let index = 0; index < labels.length; index++) {
    const angle = -Math.PI / 2 + (index / labels.length) * Math.PI * 2;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fillStyle = state.loading ? "rgba(37, 99, 235, 0.22)" : "rgba(13, 148, 136, 0.24)";
  ctx.strokeStyle = state.loading ? "#2563eb" : "#0d9488";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#111827";
  ctx.font = "700 12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  points.forEach((point, index) => {
    ctx.fillText(labels[index], point.lx, point.ly);
  });

  if (state.loading) {
    const glow = (Math.sin(state.pulse) + 1) / 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, 8 + glow * 9, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(37, 99, 235, ${0.16 + glow * 0.14})`;
    ctx.fill();
  }
}

function getRadarValues() {
  const audit = state.audit || {};
  const modules = audit.modules || {};
  const score = audit.score?.value ?? 0;
  const performance = modules.performance || {};
  const storage = modules.storage || {};
  const thermals = modules.thermals || {};
  const disks = storage.logical || [];
  const temps = thermals.sensors || [];

  const cpu = 100 - clamp(performance.cpuLoadPercent || 0, 0, 100);
  const ram = 100 - clamp(performance.memoryUsedPercent || 0, 0, 100);
  const disk = disks.length
    ? Math.min(...disks.map((item) => 100 - clamp(item.usedPercent || 0, 0, 100)))
    : 50;
  const temp = temps.length
    ? Math.max(0, 100 - Math.max(...temps.map((item) => Number(item.celsius) || 0)))
    : 70;
  const devices = modules.devices?.count ? 82 : 50;

  return [score, cpu, ram, disk, temp, devices];
}

function percentage(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Math.round(Number(value))}%`;
}

function valueOrDash(value) {
  if (value === null || value === undefined || value === "") return "--";
  return String(value);
}

function labelLevel(level) {
  const labels = {
    good: "dobry",
    watch: "sledovat",
    risk: "riziko",
    critical: "kriticke",
    offline: "offline"
  };
  return labels[level] || level || "offline";
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("sk-SK", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function shorten(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
