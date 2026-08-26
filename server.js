import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKnowledgeBrief, getKnowledgeStats } from "./data/knowledge-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PC_AUDIT_SCRIPT = path.join(__dirname, "scripts", "komarena-pc-audit.ps1");
const GUARD_TASKS_FILE = path.join(__dirname, "data", "komarena-guard-tasks.json");
const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const LEGACY_PC_AGENT_DIR = process.env.LEGACY_KOMARENA_PC_AGENT ||
  path.join(USER_HOME, "OneDrive", "Dokumenty", "Agent produkt", "pc-agent");
const VOICE_AGENT_DIR = path.join(__dirname, "pc-voice-agent");

loadEnvFile(path.join(__dirname, ".env.local"));
loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const API_KEY = process.env.OPENAI_API_KEY;
const DEV_FALLBACK = process.env.DEV_FALLBACK !== "false";
const PC_AUDIT_TIMEOUT_MS = Number(process.env.PC_AUDIT_TIMEOUT_MS || 45_000);

const AGENT_IDS = ["manager", "product", "design", "engineering", "marketing", "operations"];

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectName", "executiveSummary", "managerPlan", "agents", "risks", "nextSteps"],
  properties: {
    projectName: { type: "string" },
    executiveSummary: { type: "string" },
    managerPlan: { type: "array", items: { type: "string" } },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "role", "mission", "deliverables", "actions", "questions"],
        properties: {
          id: { type: "string", enum: AGENT_IDS },
          name: { type: "string" },
          role: { type: "string" },
          mission: { type: "string" },
          deliverables: { type: "array", items: { type: "string" } },
          actions: { type: "array", items: { type: "string" } },
          questions: { type: "array", items: { type: "string" } }
        }
      }
    },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } }
  }
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"]
]);

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        name: "Komarena.sk PC Guard",
        model: MODEL,
        keyConfigured: Boolean(API_KEY),
        devFallback: DEV_FALLBACK,
        pcAuditReady: process.platform === "win32" && existsSync(PC_AUDIT_SCRIPT),
        host: HOST,
        knowledge: getKnowledgeStats()
      });
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/knowledge") {
      return sendJson(res, 200, getKnowledgeStats());
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/pc/status") {
      return await handlePcAudit(res, "status");
    }

    if ((req.method === "GET" || req.method === "POST") && requestUrl.pathname === "/api/pc/scan") {
      const mode = req.method === "POST"
        ? String((await readJsonBody(req)).mode || "quick")
        : String(requestUrl.searchParams.get("mode") || "quick");
      return await handlePcAudit(res, mode === "deep" ? "deep" : "quick");
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/pc/tasks") {
      return sendJson(res, 200, { ok: true, tasks: await readGuardTasks() });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/pc/tasks") {
      return await handleCreateGuardTask(req, res);
    }

    if (req.method === "PATCH" && requestUrl.pathname.startsWith("/api/pc/tasks/")) {
      const taskId = decodeURIComponent(requestUrl.pathname.replace("/api/pc/tasks/", ""));
      return await handleUpdateGuardTask(req, res, taskId);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/integrations") {
      return sendJson(res, 200, { ok: true, integrations: await buildIntegrationInventory() });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/team") {
      return await handleTeamRequest(req, res);
    }

    if (req.method === "GET") {
      return await serveStatic(req, res);
    }

    return sendJson(res, 405, { error: "Metóda nie je podporovaná." });
  } catch (error) {
    if (error.expose) {
      return sendJson(res, error.status || 500, { error: error.publicMessage || error.message });
    }
    console.error(error);
    return sendJson(res, 500, { error: "Server narazil na chybu. Skús to znova." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Komarena.sk PC Guard bezi na http://${HOST}:${PORT}`);
});

async function handlePcAudit(res, mode) {
  if (process.platform !== "win32") {
    return sendJson(res, 200, {
      ok: false,
      product: "Komarena.sk PC Guard",
      mode,
      error: "PC audit je pripraveny pre Windows."
    });
  }

  if (!existsSync(PC_AUDIT_SCRIPT)) {
    return sendJson(res, 500, {
      ok: false,
      error: "Chyba scripts/komarena-pc-audit.ps1."
    });
  }

  const audit = await runPowerShellJson(PC_AUDIT_SCRIPT, ["-Mode", mode], PC_AUDIT_TIMEOUT_MS);
  return sendJson(res, 200, audit);
}

function runPowerShellJson(scriptPath, args = [], timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args
    ], {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      const error = new Error("PowerShell audit prekrocil casovy limit.");
      error.expose = true;
      error.publicMessage = error.message;
      reject(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const error = new Error(stderr.trim() || `PowerShell skoncil s kodom ${code}.`);
        error.expose = true;
        error.publicMessage = "PC audit sa nepodarilo spustit.";
        reject(error);
        return;
      }

      try {
        resolve(parseJsonOutput(stdout));
      } catch (error) {
        error.expose = true;
        error.publicMessage = "PC audit vratil necitatelny vystup.";
        reject(error);
      }
    });
  });
}

function parseJsonOutput(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("JSON vystup sa nenasiel.");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function handleCreateGuardTask(req, res) {
  const body = await readJsonBody(req);
  const title = String(body.title || "").trim();
  const detail = String(body.detail || "").trim();
  const area = normalizeTaskArea(body.area);
  const priority = normalizeTaskPriority(body.priority);

  if (title.length < 3) {
    return sendJson(res, 400, { ok: false, error: "Uloha potrebuje nazov." });
  }
  if (title.length > 160 || detail.length > 900) {
    return sendJson(res, 400, { ok: false, error: "Uloha je prilis dlha." });
  }

  const tasks = await readGuardTasks();
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title,
    detail,
    area,
    priority,
    status: "todo",
    createdAt: now,
    updatedAt: now
  };

  tasks.unshift(task);
  await writeGuardTasks(tasks);
  return sendJson(res, 200, { ok: true, task, tasks });
}

async function handleUpdateGuardTask(req, res, taskId) {
  const body = await readJsonBody(req);
  const tasks = await readGuardTasks();
  const index = tasks.findIndex((task) => task.id === taskId);

  if (index === -1) {
    return sendJson(res, 404, { ok: false, error: "Uloha sa nenasla." });
  }

  const current = tasks[index];
  const updated = {
    ...current,
    title: body.title ? String(body.title).trim().slice(0, 160) : current.title,
    detail: body.detail !== undefined ? String(body.detail).trim().slice(0, 900) : current.detail,
    area: body.area ? normalizeTaskArea(body.area) : current.area,
    priority: body.priority ? normalizeTaskPriority(body.priority) : current.priority,
    status: body.status ? normalizeTaskStatus(body.status) : current.status,
    updatedAt: new Date().toISOString()
  };

  tasks[index] = updated;
  await writeGuardTasks(tasks);
  return sendJson(res, 200, { ok: true, task: updated, tasks });
}

async function readGuardTasks() {
  try {
    const raw = await readFile(GUARD_TASKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultGuardTasks();
    return parsed.map(normalizeTask).filter(Boolean).slice(0, 300);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const tasks = defaultGuardTasks();
    await writeGuardTasks(tasks);
    return tasks;
  }
}

async function writeGuardTasks(tasks) {
  await mkdir(path.dirname(GUARD_TASKS_FILE), { recursive: true });
  await writeFile(GUARD_TASKS_FILE, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
}

function defaultGuardTasks() {
  const now = new Date().toISOString();
  return [
    {
      id: "core-readonly-pc-audit",
      title: "Read-only PC audit: vykon, RAM, disky, teploty, Defender, firewall, zariadenia",
      detail: "Zakladny bezpecny modul bezi cez PowerShell a nevykonava mazanie ani opravy bez explicitneho dalsieho modulu.",
      area: "core",
      priority: "high",
      status: "done",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "voice-agent-integration",
      title: "Napojit existujuci PC Voice Agent ako modul ovladania",
      detail: "Hlasovy agent ostava samostatny na porte 3177; hlavny dashboard ho deteguje v integraciach.",
      area: "automation",
      priority: "medium",
      status: "doing",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "malware-engine-roadmap",
      title: "Doplnit aktivny antivirus engine a karantenu",
      detail: "Najprv pouzit Defender telemetry a heuristiky, potom pridat podpisovy scan, hash reputaciu, karantenu a schvalovanie oprav.",
      area: "security",
      priority: "high",
      status: "todo",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "hardware-stress-tests",
      title: "Pridat kontrolovane hardware testy",
      detail: "Disk benchmark, RAM smoke test, CPU/GPU zataz iba po potvrdeni a s limitmi teploty.",
      area: "hardware",
      priority: "medium",
      status: "todo",
      createdAt: now,
      updatedAt: now
    }
  ];
}

function normalizeTask(task) {
  if (!task || typeof task !== "object") return null;
  const now = new Date().toISOString();
  const title = String(task.title || "").trim();
  if (!title) return null;
  return {
    id: String(task.id || randomUUID()),
    title: title.slice(0, 160),
    detail: String(task.detail || "").trim().slice(0, 900),
    area: normalizeTaskArea(task.area),
    priority: normalizeTaskPriority(task.priority),
    status: normalizeTaskStatus(task.status),
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || task.createdAt || now
  };
}

function normalizeTaskArea(value) {
  const allowed = new Set(["core", "security", "hardware", "software", "automation", "brand"]);
  const area = String(value || "core").toLowerCase();
  return allowed.has(area) ? area : "core";
}

function normalizeTaskPriority(value) {
  const allowed = new Set(["low", "medium", "high", "critical"]);
  const priority = String(value || "medium").toLowerCase();
  return allowed.has(priority) ? priority : "medium";
}

function normalizeTaskStatus(value) {
  const allowed = new Set(["todo", "doing", "done", "blocked"]);
  const status = String(value || "todo").toLowerCase();
  return allowed.has(status) ? status : "todo";
}

async function buildIntegrationInventory() {
  const voiceHealth = await probeJson("http://127.0.0.1:3177/api/health");
  const legacyCounts = existsSync(LEGACY_PC_AGENT_DIR)
    ? await readLegacyControlCounts(path.join(LEGACY_PC_AGENT_DIR, "control"))
    : null;

  const guardianPlaceholders = [
    path.join(USER_HOME, "OneDrive", "Dokumenty", "pc_guardian_sk_v3.py"),
    path.join(USER_HOME, "OneDrive", "Dokumenty", "Spustit_KomArena_PC_Guardian.bat")
  ].filter(Boolean).map((candidate) => ({
    path: candidate,
    exists: existsSync(candidate)
  }));

  return [
    {
      id: "komarena-pc-guard-core",
      name: "Komarena.sk PC Guard Core",
      kind: "security-hardware-dashboard",
      status: existsSync(PC_AUDIT_SCRIPT) ? "active" : "missing",
      path: __dirname,
      details: "Novy zluceny lokalny dashboard, auditovaci PowerShell modul a backlog."
    },
    {
      id: "pc-voice-agent",
      name: "PC Voice Agent",
      kind: "voice-control",
      status: voiceHealth.ok ? "online" : (existsSync(VOICE_AGENT_DIR) ? "available-offline" : "missing"),
      path: VOICE_AGENT_DIR,
      url: "http://127.0.0.1:3177",
      details: voiceHealth.ok ? "Hlasovy agent odpoveda." : "Agent existuje, ale samostatny server teraz neodpoveda."
    },
    {
      id: "legacy-komarena-pc-agent",
      name: "Legacy KomArena PC Agent",
      kind: "wordpress-deployment-control",
      status: existsSync(LEGACY_PC_AGENT_DIR) ? "available" : "missing",
      path: LEGACY_PC_AGENT_DIR,
      details: "Starsia fronta uloh pre WordPress/KomArena workflow. Pouzitelny vzor pre control queue.",
      control: legacyCounts
    },
    {
      id: "pc-guardian-placeholders",
      name: "PC Guardian placeholders",
      kind: "empty-or-cloud-placeholder",
      status: guardianPlaceholders.some((item) => item.exists) ? "placeholder" : "missing",
      details: "Najdene nazvy pc_guardian_sk_v3.py a Spustit_KomArena_PC_Guardian.bat su priecinky alebo prazdne placeholdery, nie citatelny produktovy kod.",
      items: guardianPlaceholders
    }
  ];
}

async function readLegacyControlCounts(controlDir) {
  async function countFiles(folder) {
    try {
      return (await readdir(path.join(controlDir, folder))).filter((name) => name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  return {
    queue: await countFiles("queue"),
    done: await countFiles("done"),
    failed: await countFiles("failed"),
    pcResults: await countFiles("pc-results")
  };
}

async function probeJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => null);
    return { ok: response.ok && Boolean(data?.ok), data };
  } catch {
    return { ok: false, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleTeamRequest(req, res) {
  if (!API_KEY) {
    if (DEV_FALLBACK) {
      const body = await readJsonBody(req);
      const goal = String(body.goal || "").trim();
      const context = String(body.context || "").trim();
      const mode = body.mode === "deep" ? "deep" : "fast";

      if (goal.length < 8) {
        return sendJson(res, 400, {
          error: "Napíš konkrétnejší cieľ projektu."
        });
      }

      return sendJson(res, 200, buildKnowledgeBrief({
        goal,
        context,
        mode,
        reason: "Chýba OPENAI_API_KEY, preto beží vývojový fallback."
      }));
    }

    return sendJson(res, 500, {
      error: "Chýba OPENAI_API_KEY v .env.local."
    });
  }

  const body = await readJsonBody(req);
  const goal = String(body.goal || "").trim();
  const context = String(body.context || "").trim();
  const mode = body.mode === "deep" ? "deep" : "fast";

  if (goal.length < 8) {
    return sendJson(res, 400, {
      error: "Napíš konkrétnejší cieľ projektu."
    });
  }

  const input = [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: [
            "Si manažér autonómneho tímu AI agentov pre webový produkt.",
            "Rozmýšľaš prakticky ako silný technologický tím: zákazník, produkt, dizajn, technológia, marketing a operácie.",
            "Odpovedáš po slovensky, konkrétne, vecne a bez výplne.",
            "Tvoj výstup musí presne obsahovať týchto agentov: manager, product, design, engineering, marketing, operations.",
            "Každý agent má mať vlastnú misiu, deliverables, akčné kroky a otázky.",
            "Manažér má rozdeliť prácu tak, aby sa dalo začať hneď po prečítaní."
          ].join(" ")
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            `Režim práce: ${mode === "deep" ? "detailný strategický rozklad" : "rýchly exekučný brief"}.`,
            `Cieľ: ${goal}`,
            context ? `Kontext: ${context}` : "Kontext: používateľ zatiaľ nedodal ďalšie obmedzenia.",
            "Vytvor názov projektu, krátke zhrnutie, manažérsky plán, výstup každého agenta, hlavné riziká a najbližšie kroky."
          ].join("\n")
        }
      ]
    }
  ];

  const result = await callOpenAI(input, mode).catch((error) => {
    if (DEV_FALLBACK && error.status === 429) {
      return buildKnowledgeBrief({
        goal,
        context,
        mode,
        reason: "OpenAI projekt nemá dostupnú kvótu, preto beží vývojový fallback."
      });
    }
    throw error;
  });
  return sendJson(res, 200, result);
}

async function callOpenAI(input, mode) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      max_output_tokens: mode === "deep" ? 5200 : 3600,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "agent_team_brief",
          strict: true,
          schema: responseSchema
        }
      }
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.error?.message || "OpenAI API vrátilo chybu.";
    const error = new Error(`OpenAI API ${response.status}: ${message}`);
    error.status = response.status;
    error.expose = true;
    error.publicMessage = buildPublicApiError(response.status, message);
    throw error;
  }

  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error("OpenAI API nevrátilo textový výstup.");
  }

  return normalizeTeamResult(JSON.parse(outputText));
}

function buildPublicApiError(status, message) {
  if (status === 401) {
    return "OpenAI API kľúč nie je platný. Skontroluj .env.local alebo vytvor nový kľúč.";
  }
  if (status === 429) {
    return "OpenAI účet alebo projekt nemá dostupnú kvótu. Skontroluj billing a limity na OpenAI Platform.";
  }
  if (status === 400 && message.toLowerCase().includes("model")) {
    return "Zvolený model nie je dostupný pre tento projekt. Skús zmeniť OPENAI_MODEL v .env.local.";
  }
  return `OpenAI API vrátilo chybu ${status}. Skús to znova alebo skontroluj nastavenia projektu.`;
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("").trim();
}

function normalizeTeamResult(result) {
  const agentsById = new Map((result.agents || []).map((agent) => [agent.id, agent]));
  result.agents = AGENT_IDS.map((id) => agentsById.get(id)).filter(Boolean);
  return result;
}

function createFallbackBrief({ goal, context, mode, reason }) {
  const isDeep = mode === "deep";
  const contextText = context || "bez ďalšieho kontextu";
  const goalText = trimSentenceEnd(goal);

  return normalizeTeamResult({
    source: "dev-fallback",
    notice: reason,
    projectName: "Vývojový agent tím",
    executiveSummary: `Vývojový režim pripravil pracovný brief pre cieľ: ${goalText}. Kontext: ${contextText}. Tento výstup slúži na ladenie produktu, UI a procesu, kým OpenAI API nemá dostupnú kvótu.`,
    managerPlan: [
      "Manažér rozdelí zadanie na produkt, dizajn, technickú realizáciu, marketing a operácie.",
      "Každý agent pripraví konkrétny výstup, ktorý sa dá skontrolovať v samostatnom bloku.",
      "Tím najprv vytvorí MVP rozsah, potom doplní backlog a až potom pôjde do automatizácie.",
      ...(isDeep ? [
        "V detailnom režime treba pridať testovací scenár pre každý agent výstup.",
        "Pred ostrým API režimom treba porovnať fallback štruktúru s reálnou AI odpoveďou."
      ] : [])
    ],
    agents: [
      {
        id: "manager",
        name: "Manažér",
        role: "Riadenie tímu a priorít",
        mission: "Premení nejasné zadanie na poradie práce, rozhodnutia a jasné vlastníctvo výstupov.",
        deliverables: ["Prioritný plán", "Rozdelenie úloh", "Kontrolný checklist"],
        actions: ["Zadefinovať prvý cieľ sprintu", "Priradiť každému agentovi jeden merateľný výstup", "Vybrať, čo ide do MVP a čo počká"],
        questions: ["Aký výsledok musí byť hotový ako prvý?", "Kto bude schvaľovať výstupy?", "Aký je deadline?"]
      },
      {
        id: "product",
        name: "Produktový",
        role: "Hodnota, zákazník a MVP",
        mission: "Vyjasní komu produkt pomáha, aký problém rieši a čo musí obsahovať prvá verzia.",
        deliverables: ["MVP rozsah", "Používateľské scenáre", "Hodnotová ponuka"],
        actions: ["Napísať 3 hlavné prípady použitia", "Zoradiť funkcie podľa hodnoty", "Odstrániť veci, ktoré nepatria do prvej verzie"],
        questions: ["Kto je prvý ideálny používateľ?", "Akú bolesť riešime?", "Čo by používateľ zaplatil alebo používal opakovane?"]
      },
      {
        id: "design",
        name: "Grafik",
        role: "Vizuál a používateľský zážitok",
        mission: "Navrhne prehľadné rozhranie, ktoré vyzerá dôveryhodne a dá sa používať bez vysvetľovania.",
        deliverables: ["UI smer", "Komponenty obrazovky", "Vizuálny tón značky"],
        actions: ["Upraviť rozloženie podľa hlavného workflow", "Pripraviť stav prázdny, loading, chyba a hotový výstup", "Zjednotiť farby a typografiu"],
        questions: ["Má to pôsobiť viac firemne alebo kreatívne?", "Ktoré výstupy musí používateľ vidieť najskôr?", "Čo má byť dominantné na prvej obrazovke?"]
      },
      {
        id: "engineering",
        name: "ITčkar",
        role: "Technická architektúra",
        mission: "Postaví bezpečný a jednoduchý technický základ, kde API kľúč ostáva na serveri.",
        deliverables: ["API endpoint", "Dátová schéma", "Vývojový fallback"],
        actions: ["Oddeliť serverové a klientské časti", "Zachovať rovnaký JSON tvar pre API aj fallback", "Pridať testy pre chyby a prázdne vstupy"],
        questions: ["Budeme ukladať históriu briefov?", "Treba používateľské účty?", "Aký hosting použijeme po MVP?"]
      },
      {
        id: "marketing",
        name: "Marketer",
        role: "Pozicioning a rast",
        mission: "Premení produkt na jasnú ponuku, ktorú cieľová skupina pochopí za pár sekúnd.",
        deliverables: ["Hlavná správa", "Kanály získavania používateľov", "Test kampane"],
        actions: ["Napísať 3 varianty ponuky", "Vybrať prvý akvizičný kanál", "Pripraviť krátky launch post"],
        questions: ["Prečo by si to niekto vybral dnes?", "Kde sa cieľová skupina už nachádza?", "Aký dôkaz dôvery vieme ukázať?"]
      },
      {
        id: "operations",
        name: "Operácie",
        role: "Realizácia a kontrola",
        mission: "Stráži, aby práca neskončila pri nápade, ale prešla do konkrétnych krokov a termínov.",
        deliverables: ["Týždenný plán", "Riziká", "Definícia hotového"],
        actions: ["Založiť backlog", "Priradiť termíny", "Každý deň skontrolovať blokery"],
        questions: ["Čo môže zastaviť vývoj?", "Ktoré rozhodnutia čakajú na používateľa?", "Ako spoznáme, že MVP je hotové?"]
      }
    ],
    risks: [
      "Fallback negeneruje skutočne nové strategické nápady, iba simuluje štruktúru tímu.",
      "Po zapnutí API treba otestovať kvalitu reálnych odpovedí a prípadne doladiť prompt.",
      "Bez ukladania histórie sa brief po obnovení stránky stratí.",
      ...(isDeep ? ["Príliš veľa agentov môže zahltiť používateľa, preto bude treba pridať zhrnutie a filtre."] : [])
    ],
    nextSteps: [
      "Doladiť vývojový workflow bez závislosti od API kvóty.",
      "Pridať históriu posledných briefov do lokálneho úložiska.",
      "Pripraviť prepínač medzi API režimom a vývojovým režimom.",
      "Po aktivácii OpenAI billing zapnúť ostrý API test."
    ]
  });
}

function trimSentenceEnd(value) {
  return String(value || "").trim().replace(/[.!?]+$/, "");
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  const target = existsSync(filePath) ? filePath : path.join(PUBLIC_DIR, "index.html");
  const fileStat = await stat(target).catch(() => null);

  if (!fileStat || !fileStat.isFile()) {
    return sendText(res, 404, "Not found");
  }

  const extension = path.extname(target).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  res.end(await readFile(target));
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 128_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const contents = readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
