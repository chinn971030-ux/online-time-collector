const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "sessions.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ sessions: {} }, null, 2));
}

function readStore() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeStore(store) {
  ensureDataFile();
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("请求内容太大"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON 格式不正确"));
      }
    });
  });
}

function token(length = 12) {
  return crypto.randomBytes(length).toString("base64url");
}

function publicOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function mondayOf(date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return formatDate(copy);
}

function formatDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 40);
}

function cleanFree(value) {
  const free = {};
  if (!value || typeof value !== "object") return free;
  for (const key of Object.keys(value)) {
    if (/^[0-6]-([0-9]|1[0-9]|2[0-7])$/.test(key) && value[key]) free[key] = true;
  }
  return free;
}

function getSession(store, id) {
  return store.sessions[String(id || "")] || null;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readBody(req);
      const id = token(6);
      const adminToken = token(18);
      const weekStart = body.weekStart ? mondayOf(new Date(`${body.weekStart}T00:00:00`)) : mondayOf(new Date());
      const store = readStore();
      store.sessions[id] = {
        id,
        adminToken,
        title: String(body.title || "本周上课时间收集").trim().slice(0, 80),
        weekStart,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        participants: {},
      };
      writeStore(store);
      const origin = publicOrigin(req);
      sendJson(res, 201, {
        id,
        adminToken,
        shareUrl: `${origin}/s/${id}`,
        adminUrl: `${origin}/admin/${id}?token=${adminToken}`,
      });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const store = readStore();
      const session = getSession(store, sessionMatch[1]);
      if (!session) return sendJson(res, 404, { error: "没有找到这个收集链接" });
      const isAdmin = url.searchParams.get("token") === session.adminToken;
      sendJson(res, 200, {
        id: session.id,
        title: session.title,
        weekStart: session.weekStart,
        updatedAt: session.updatedAt,
        participantCount: Object.keys(session.participants).length,
        participants: isAdmin ? Object.values(session.participants) : undefined,
        isAdmin,
      });
      return;
    }

    const submitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/submit$/);
    if (req.method === "POST" && submitMatch) {
      const body = await readBody(req);
      const name = cleanName(body.name);
      if (!name) return sendJson(res, 400, { error: "请填写姓名" });
      const store = readStore();
      const session = getSession(store, submitMatch[1]);
      if (!session) return sendJson(res, 404, { error: "没有找到这个收集链接" });
      const participantId = crypto.createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 16);
      session.participants[participantId] = {
        id: participantId,
        name,
        free: cleanFree(body.free),
        submittedAt: new Date().toISOString(),
      };
      session.updatedAt = new Date().toISOString();
      writeStore(store);
      sendJson(res, 200, { ok: true, participantCount: Object.keys(session.participants).length });
      return;
    }

    const updateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/settings$/);
    if (req.method === "POST" && updateMatch) {
      const body = await readBody(req);
      const store = readStore();
      const session = getSession(store, updateMatch[1]);
      if (!session) return sendJson(res, 404, { error: "没有找到这个收集链接" });
      if (body.token !== session.adminToken) return sendJson(res, 403, { error: "管理链接不正确" });
      if (body.title) session.title = String(body.title).trim().slice(0, 80);
      if (body.weekStart) session.weekStart = mondayOf(new Date(`${body.weekStart}T00:00:00`));
      session.updatedAt = new Date().toISOString();
      writeStore(store);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "接口不存在" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器错误" });
  }
}

function serveStatic(req, res, url) {
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || url.pathname.startsWith("/s/") || url.pathname.startsWith("/admin/")) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`在线上课时间收集已启动：http://127.0.0.1:${PORT}`);
});
