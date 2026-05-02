import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);

// Binance bases
const FUT_BASE = process.env.BINANCE_BASE_FUTURES || process.env.BINANCE_FUTURES_BASE || "https://fapi.binance.com";
const SPOT_BASE = process.env.BINANCE_BASE_SPOT || process.env.BINANCE_SPOT_BASE || "https://api.binance.com";
const DATA_API_BASE = "https://data-api.binance.vision";

// Mapping: futures API paths → spot equivalents on data-api.binance.vision
const FUTURES_TO_SPOT_PATH = {
  "/fapi/v1/klines": "/api/v3/klines",
  "/fapi/v1/exchangeInfo": "/api/v3/exchangeInfo",
  "/fapi/v1/ticker/price": "/api/v3/ticker/price",
};

// Secrets
const MASTER_KEY = process.env.MASTER_KEY || "";
const TOKEN_SECRET = process.env.TOKEN_SECRET || "CHANGE_ME_TOKEN_SECRET";

// Live orders switch
const ALLOW_LIVE_ORDERS =
  String(process.env.ALLOW_LIVE_ORDERS || "false").toLowerCase() === "true";

// Hard trade limits (server enforced)
const MIN_TRADE_USD = Number(process.env.MIN_USDT_PER_TRADE || 5);
const MAX_TRADE_USD = Number(process.env.MAX_USDT_PER_TRADE || 10);
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS || 3);
const MAX_TRADES_PER_DAY = Number(process.env.MAX_TRADES_PER_DAY || 100);

// Default SL/TP/Trail
const DEFAULT_STOP_LOSS_PCT = Number(process.env.DEFAULT_STOP_LOSS_PCT || 0.35);
const DEFAULT_TAKE_PROFIT_PCT = Number(process.env.DEFAULT_TAKE_PROFIT_PCT || 0.25);
const DEFAULT_TRAIL_PCT = Number(process.env.DEFAULT_TRAIL_PCT || 0.20);

// Spot dollar quotes supported
const SPOT_DOLLAR_QUOTES = new Set(["USDT", "USDC", "FDUSD", "BUSD"]);

// Futures defaults
const DEFAULT_MARGIN_TYPE = "ISOLATED";
const DEFAULT_LEVERAGE = Number(process.env.DEFAULT_LEVERAGE || 10);

// Cooldown
const ORDER_COOLDOWN_MS = Number(process.env.ORDER_COOLDOWN_MS || 8000);

// ===== DB =====
const DB_PATH = path.join(__dirname, "data", "db.json");
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return {
      users: [],
      accounts: [],
      master: { balance: 0 },
      clients: [],
      trades: [],
      signals: [],
      settings: {},
      autoScalping: { enabled: false, symbols: [], intervalSec: 30, minConfidence: 60 },
      autoTradeOpen: { enabled: false },
      autoTradeClose: { enabled: false, trailingStopPct: 0, maxHoldMinutes: 0 },
    };
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    db.master = db.master || { balance: 0 };
    db.clients = db.clients || [];
    db.trades = db.trades || [];
    db.signals = db.signals || [];
    db.settings = db.settings || {};
    db.autoScalping = db.autoScalping || { enabled: false, symbols: [], intervalSec: 30, minConfidence: 60 };
    db.autoTradeOpen = db.autoTradeOpen || { enabled: false };
    db.autoTradeClose = db.autoTradeClose || { enabled: false, trailingStopPct: 0, maxHoldMinutes: 0 };
    return db;
  } catch {
    return {
      users: [],
      accounts: [],
      master: { balance: 0 },
      clients: [],
      trades: [],
      signals: [],
      settings: {},
      autoScalping: { enabled: false, symbols: [], intervalSec: 30, minConfidence: 60 },
      autoTradeOpen: { enabled: false },
      autoTradeClose: { enabled: false, trailingStopPct: 0, maxHoldMinutes: 0 },
    };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let DB = loadDB();

// ===== Encryption helpers =====
const ENC_ALGO = "aes-256-gcm";

function getEncKey() {
  const raw =
    process.env.APP_ENC_KEY ||
    process.env.ENC_KEY ||
    process.env.SECRET ||
    process.env.MASTER_KEY ||
    MASTER_KEY ||
    "";
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function enc(plainText) {
  const key = getEncKey();
  if (!key) return Buffer.from(String(plainText), "utf8").toString("base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function dec(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const key = getEncKey();
    if (!key) return Buffer.from(String(token), "base64").toString("utf8");

    if (token.includes(":")) {
      const [ivHex, tagHex, dataHex] = token.split(":");
      if (!ivHex || !tagHex || !dataHex) return null;
      const iv = Buffer.from(ivHex, "hex");
      const tag = Buffer.from(tagHex, "hex");
      const data = Buffer.from(dataHex, "hex");
      const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    }

    const isLikelyBase64 = /[+/=]/.test(token);
    const buf = Buffer.from(token, isLikelyBase64 ? "base64" : "base64url");
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ===== Password hashing =====
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const test = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(hash, "hex"));
}

// ===== Token (simple JWT-like HS256) =====
function b64url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signToken(payloadObj, ttlSeconds = 60 * 60 * 24) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...payloadObj, iat: now, exp: now + ttlSeconds };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${h}.${p}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const check = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (check !== sig) return null;
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now > payload.exp) return null;
  return payload;
}

// ===== Middleware =====
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: "missing_token" });
  const payload = verifyToken(m[1]);
  if (!payload?.uid) return res.status(401).json({ error: "invalid_token" });
  req.user = payload;
  next();
}

function optionalAuth(req, _res, next) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer (.+)$/);
  if (m) {
    const payload = verifyToken(m[1]);
    if (payload?.uid) req.user = payload;
  }
  next();
}

function liveOk(res) {
  if (!ALLOW_LIVE_ORDERS) {
    res.status(403).json({
      error: "live_orders_disabled",
      message: "Live orders disabled. Set ALLOW_LIVE_ORDERS=true in .env and restart server.",
    });
    return false;
  }
  return true;
}

// ===== Throttle =====
let lastCallAt = 0;
const MIN_GAP_MS = 120;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastCallAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// ===== Binance wrappers =====
function signQS(qs, apiSecret) {
  return crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");
}

async function bFetch(
  base,
  apiKey,
  apiSecret,
  pathname,
  { method = "GET", query = {}, signed = false } = {}
) {
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const headers = {};
  if (signed) {
    url.searchParams.set("timestamp", String(Date.now()));
    const qs = url.searchParams.toString();
    url.searchParams.set("signature", signQS(qs, apiSecret));
    headers["X-MBX-APIKEY"] = apiKey;
  }

  await throttle();
  const res = await fetch(url.toString(), { method, headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw Object.assign(new Error("Binance request failed"), {
      status: res.status,
      statusText: res.statusText,
      binance: json,
    });
  }
  return json;
}

async function pubFetch(base, pathname, query = {}) {
  const buildUrl = (b, p) => {
    const url = new URL(b + p);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  };

  // Try primary endpoint first
  try {
    const res = await fetch(buildUrl(base, pathname));
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
  } catch (_) { /* primary failed, try fallback */ }

  // Fallback: use data-api.binance.vision with spot-equivalent path
  const fallbackPath = FUTURES_TO_SPOT_PATH[pathname] || pathname.replace(/^\/fapi\/v1\//, "/api/v3/");
  const fallbackUrl = buildUrl(DATA_API_BASE, fallbackPath);
  const res2 = await fetch(fallbackUrl);
  const json2 = await res2.json().catch(() => ({}));
  if (!res2.ok)
    throw Object.assign(new Error("Public request failed (primary + fallback)"), { status: res2.status, binance: json2 });
  return json2;
}

// ===== Binance order execution (standalone, for copy trading) =====
async function executeFuturesOrder({ apiKey, apiSecret, symbol, side, quantity }) {
  const timestamp = Date.now();
  const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(query)
    .digest("hex");
  const url = `${FUT_BASE}/fapi/v1/order?${query}&signature=${signature}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  return await res.json();
}

// ===== Filters =====
function getFilters(exInfo, symbol) {
  const s = exInfo?.symbols?.find((x) => x.symbol === symbol);
  if (!s) return null;
  const lot = (s.filters || []).find((f) => f.filterType === "LOT_SIZE");
  const minNotional =
    (s.filters || []).find((f) => f.filterType === "MIN_NOTIONAL") ||
    (s.filters || []).find((f) => f.filterType === "NOTIONAL");
  return {
    stepSize: lot ? Number(lot.stepSize) : null,
    minQty: lot ? Number(lot.minQty) : null,
    minNotional: minNotional
      ? Number(minNotional.notional ?? minNotional.minNotional ?? 0)
      : null,
  };
}
function floorToStep(qty, stepSize) {
  if (!stepSize || stepSize <= 0) return qty;
  const inv = 1 / stepSize;
  return Math.floor(qty * inv) / inv;
}
function decimalsFromStep(stepSize) {
  const s = String(stepSize);
  if (!s.includes(".")) return 0;
  return s.split(".")[1].replace(/0+$/, "").length;
}

// ===== Activity logs (in-memory, last 200) =====
const activityLogs = [];
function addLog(level, message, data = {}) {
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    time: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  activityLogs.unshift(entry);
  if (activityLogs.length > 200) activityLogs.length = 200;
  if (process.env.LOG_LEVEL !== "silent") {
    console.log(`[${level.toUpperCase()}] ${message}`);
  }
  return entry;
}

// ===== serve UI =====
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ===========================
// STATUS / HEALTH
// ===========================
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    node: process.version,
    liveOrders: ALLOW_LIVE_ORDERS,
    tradeLimits: { min: MIN_TRADE_USD, max: MAX_TRADE_USD },
    spotDollarQuotes: Array.from(SPOT_DOLLAR_QUOTES),
  });
});

app.get("/api/status", (_req, res) => {
  const running = DB.trades.filter((t) => t.status === "running").length;
  const closed = DB.trades.filter((t) => t.status === "closed").length;
  const pending = DB.signals.filter((s) => s.status === "pending").length;
  const approved = DB.signals.filter((s) => s.status === "approved").length;

  res.json({
    status: "online",
    ok: true,
    ts: Date.now(),
    node: process.version,
    liveOrders: ALLOW_LIVE_ORDERS,
    tradeLimits: { min: MIN_TRADE_USD, max: MAX_TRADE_USD },
    maxOpenPositions: MAX_OPEN_POSITIONS,
    maxTradesPerDay: MAX_TRADES_PER_DAY,
    stats: { running, closed, pending, approved },
  });
});

// ===========================
// AUTH
// ===========================
app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username_password_required" });

  const exists = DB.users.find(
    (u) => u.username.toLowerCase() === String(username).toLowerCase()
  );
  if (exists) return res.status(409).json({ error: "user_exists" });

  const { salt, hash } = hashPassword(password);
  const uid = crypto.randomUUID();

  DB.users.push({ uid, username, salt, hash });
  saveDB(DB);

  res.json({ ok: true, token: signToken({ uid, username }), username });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username_password_required" });

  const user = DB.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return res.status(401).json({ error: "bad_credentials" });

  if (!verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: "bad_credentials" });
  }

  res.json({
    ok: true,
    token: signToken({ uid: user.uid, username: user.username }),
    username: user.username,
  });
});

// ===========================
// ACCOUNTS (Binance API key management)
// ===========================
app.get("/api/accounts", auth, (req, res) => {
  const items = DB.accounts
    .filter((a) => a.uid === req.user.uid)
    .map((a) => ({ id: a.id, label: a.label, enabled: a.enabled, createdAt: a.createdAt }));
  res.json(items);
});

app.post("/api/accounts", auth, (req, res) => {
  const { label, apiKey, apiSecret, enabled } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: "apiKey_apiSecret_required" });

  const id = crypto.randomUUID();
  DB.accounts.push({
    id,
    uid: req.user.uid,
    label: label || `Account ${id.slice(0, 6)}`,
    apiKeyEnc: enc(apiKey),
    apiSecretEnc: enc(apiSecret),
    enabled: enabled !== false,
    createdAt: Date.now(),
  });
  saveDB(DB);
  res.json({ ok: true, id });
});

app.post("/api/accounts/:id/toggle", auth, (req, res) => {
  const id = String(req.params.id);
  const a = DB.accounts.find((x) => x.id === id && x.uid === req.user.uid);
  if (!a) return res.status(404).json({ error: "not_found" });
  a.enabled = !a.enabled;
  saveDB(DB);
  res.json({ ok: true, enabled: a.enabled });
});

app.delete("/api/accounts/:id", auth, (req, res) => {
  const id = String(req.params.id);
  DB.accounts = DB.accounts.filter((x) => !(x.id === id && x.uid === req.user.uid));
  saveDB(DB);
  res.json({ ok: true });
});

// ===========================
// CLIENT MANAGEMENT (copy trading clients)
// ===========================
app.get("/api/clients", optionalAuth, (_req, res) => {
  const clients = DB.clients.map((c) => ({
    id: c.id,
    label: c.label,
    balance: c.balance,
    profit: c.profit,
    loss: c.loss,
    masterShare: c.masterShare,
    enabled: c.enabled,
  }));
  res.json({ ok: true, clients });
});

app.post("/api/clients/add", optionalAuth, (req, res) => {
  const { label, apiKey, apiSecret, balance } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: "apiKey_apiSecret_required" });

  const client = {
    id: crypto.randomUUID(),
    label: label || "Client",
    apiKey: enc(apiKey),
    apiSecret: enc(apiSecret),
    balance: Number(balance || 0),
    profit: 0,
    loss: 0,
    masterShare: 0,
    enabled: true,
  };

  DB.clients.push(client);
  saveDB(DB);
  addLog("info", `Client added: ${client.label}`, { clientId: client.id });
  res.json({ ok: true, id: client.id });
});

app.post("/api/clients/:id/toggle", optionalAuth, (req, res) => {
  const client = DB.clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: "client_not_found" });
  client.enabled = !client.enabled;
  saveDB(DB);
  res.json({ ok: true, enabled: client.enabled });
});

app.delete("/api/clients/:id", optionalAuth, (req, res) => {
  DB.clients = DB.clients.filter((c) => c.id !== req.params.id);
  saveDB(DB);
  res.json({ ok: true });
});

// ===========================
// SYMBOL LIST (public)
// ===========================
app.get("/api/spot/symbols", async (_req, res) => {
  try {
    const info = await pubFetch(SPOT_BASE, "/api/v3/exchangeInfo", {});
    const symbols = (info.symbols || [])
      .filter(
        (s) =>
          s.status === "TRADING" &&
          s.isSpotTradingAllowed === true &&
          SPOT_DOLLAR_QUOTES.has(s.quoteAsset)
      )
      .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
    res.json({ ok: true, symbols });
  } catch (e) {
    res.status(500).json({ error: "spot_symbols_failed", details: e?.binance || e?.message || String(e) });
  }
});

app.get("/api/futures/symbols", async (_req, res) => {
  try {
    const info = await pubFetch(FUT_BASE, "/fapi/v1/exchangeInfo", {});
    const symbols = (info.symbols || [])
      .filter((s) => s.status === "TRADING" && s.contractType === "PERPETUAL")
      .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
    res.json({ ok: true, symbols });
  } catch (e) {
    res.status(500).json({ error: "futures_symbols_failed", details: e?.binance || e?.message || String(e) });
  }
});

// ===========================
// PUBLIC KLINES
// ===========================
app.get("/api/futures/klines", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const interval = String(req.query.interval || "1m");
    const limit = Number(req.query.limit || 200);
    if (!symbol) return res.status(400).json({ error: "symbol_required" });
    res.json(await pubFetch(FUT_BASE, "/fapi/v1/klines", { symbol, interval, limit }));
  } catch (e) {
    res.status(500).json({ error: "fut_klines_failed", details: e?.binance || e?.message || String(e) });
  }
});

app.get("/api/spot/klines", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const interval = String(req.query.interval || "1m");
    const limit = Number(req.query.limit || 200);
    if (!symbol) return res.status(400).json({ error: "symbol_required" });
    res.json(await pubFetch(SPOT_BASE, "/api/v3/klines", { symbol, interval, limit }));
  } catch (e) {
    res.status(500).json({ error: "spot_klines_failed", details: e?.binance || e?.message || String(e) });
  }
});

// ===========================
// USER SUMMARY
// ===========================
app.get("/api/user/summary", auth, async (req, res) => {
  const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
  const out = [];

  for (const a of accounts) {
    const apiKey = dec(a.apiKeyEnc);
    const apiSecret = dec(a.apiSecretEnc);
    if (!apiKey || !apiSecret) {
      const msg =
        "Stored API credentials are invalid (encryption key changed or data corrupted). Re-add the account.";
      out.push({
        id: a.id,
        label: a.label,
        enabled: a.enabled,
        futures: null,
        spot: null,
        errFut: msg,
        errSpot: msg,
      });
      continue;
    }

    let fut = null;
    let spot = null;
    let errFut = null;
    let errSpot = null;

    try {
      const acct = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/account", { signed: true });
      const wallet = Number(acct?.totalWalletBalance ?? 0);
      const avail = Number(acct?.availableBalance ?? 0);
      const upnl = Number(acct?.totalUnrealizedProfit ?? 0);
      fut = { walletBalance: wallet, availableBalance: avail, unrealizedProfit: upnl };
    } catch (e) {
      errFut = e?.binance || e?.message || String(e);
    }

    try {
      const acct = await bFetch(SPOT_BASE, apiKey, apiSecret, "/api/v3/account", { signed: true });
      const balances = acct?.balances || [];
      const by = {};
      let total = 0;
      for (const q of SPOT_DOLLAR_QUOTES) {
        const b = balances.find((x) => x.asset === q);
        const free = b ? Number(b.free ?? 0) : 0;
        by[q] = free;
        total += free;
      }
      spot = { dollarTotal: total, dollarByAsset: by };
    } catch (e) {
      errSpot = e?.binance || e?.message || String(e);
    }

    out.push({
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      futures: fut,
      spot,
      errFut,
      errSpot,
    });
  }

  res.json({
    ok: true,
    user: { username: req.user.username },
    accounts: out,
    liveOrders: ALLOW_LIVE_ORDERS,
    tradeLimits: { min: MIN_TRADE_USD, max: MAX_TRADE_USD },
    spotDollarQuotes: Array.from(SPOT_DOLLAR_QUOTES),
  });
});

// ===========================
// RUNNING POSITIONS + OPEN ORDERS
// ===========================
app.get("/api/futures/positions", auth, async (req, res) => {
  const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
  const result = [];
  for (const a of accounts) {
    const apiKey = dec(a.apiKeyEnc);
    const apiSecret = dec(a.apiSecretEnc);
    if (!apiKey || !apiSecret) {
      result.push({
        accountId: a.id,
        label: a.label,
        ok: false,
        error: "Invalid stored API credentials. Re-add the account.",
      });
      continue;
    }
    try {
      const pos = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/positionRisk", { signed: true });
      const open = (pos || []).filter((p) => Math.abs(Number(p.positionAmt || 0)) > 0);
      result.push({ accountId: a.id, label: a.label, ok: true, positions: open });
    } catch (e) {
      result.push({ accountId: a.id, label: a.label, ok: false, error: e?.binance || e?.message || String(e) });
    }
  }
  res.json({ ok: true, accounts: result });
});

app.get("/api/futures/openOrders", auth, async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase() || undefined;
  const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
  const result = [];
  for (const a of accounts) {
    const apiKey = dec(a.apiKeyEnc);
    const apiSecret = dec(a.apiSecretEnc);
    if (!apiKey || !apiSecret) {
      result.push({
        accountId: a.id,
        label: a.label,
        ok: false,
        error: "Invalid stored API credentials. Re-add the account.",
      });
      continue;
    }
    try {
      const orders = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/openOrders", {
        signed: true,
        query: symbol ? { symbol } : {},
      });
      result.push({ accountId: a.id, label: a.label, ok: true, orders });
    } catch (e) {
      result.push({ accountId: a.id, label: a.label, ok: false, error: e?.binance || e?.message || String(e) });
    }
  }
  res.json({ ok: true, accounts: result });
});

app.get("/api/spot/openOrders", auth, async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol_required" });

  const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
  const result = [];
  for (const a of accounts) {
    const apiKey = dec(a.apiKeyEnc);
    const apiSecret = dec(a.apiSecretEnc);
    if (!apiKey || !apiSecret) {
      result.push({
        accountId: a.id,
        label: a.label,
        ok: false,
        error: "Invalid stored API credentials. Re-add the account.",
      });
      continue;
    }
    try {
      const orders = await bFetch(SPOT_BASE, apiKey, apiSecret, "/api/v3/openOrders", {
        signed: true,
        query: { symbol },
      });
      result.push({ accountId: a.id, label: a.label, ok: true, orders });
    } catch (e) {
      result.push({ accountId: a.id, label: a.label, ok: false, error: e?.binance || e?.message || String(e) });
    }
  }
  res.json({ ok: true, accounts: result });
});

// ===========================
// SIGNAL GENERATION (NEW — frontend expects these)
// ===========================

// Fetch current price for a symbol (real Binance data only)
async function getCurrentPrice(symbol) {
  const kl = await pubFetch(FUT_BASE, "/fapi/v1/klines", { symbol, interval: "1m", limit: 2 });
  const price = Number(kl?.[kl.length - 1]?.[4]);
  if (!price || !Number.isFinite(price)) throw new Error(`Cannot fetch price for ${symbol}`);
  return price;
}

// Technical signal generator using real Binance klines
async function generateMarketSignal(opts = {}) {
  const symbol = opts.symbol || process.env.DEFAULT_SYMBOL || "BTCUSDT";
  const leverage = opts.leverage || DEFAULT_LEVERAGE;
  const tpPct = opts.takeProfitPercent || DEFAULT_TAKE_PROFIT_PCT * 100;
  const slPct = opts.stopLossPercent || DEFAULT_STOP_LOSS_PCT * 100;

  const klines = await pubFetch(FUT_BASE, "/fapi/v1/klines", {
    symbol,
    interval: "5m",
    limit: 50,
  });

  if (!klines || klines.length < 20) {
    throw new Error(`Insufficient kline data for ${symbol} — got ${klines?.length || 0} candles`);
  }

  const closes = klines.map((k) => Number(k[4]));
  const volumes = klines.map((k) => Number(k[5]));
  const highs = klines.map((k) => Number(k[2]));
  const lows = klines.map((k) => Number(k[3]));

  const currentPrice = closes[closes.length - 1];

  // Simple moving averages
  const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  // RSI (14 period)
  const rsiPeriod = 14;
  const rsiCloses = closes.slice(-(rsiPeriod + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < rsiCloses.length; i++) {
    const diff = rsiCloses[i] - rsiCloses[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / rsiPeriod;
  const avgLoss = losses / rsiPeriod;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  // Volume trend
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const olderVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
  const volMultiplier = olderVol > 0 ? recentVol / olderVol : 1;

  // Bollinger Bands (20 period, 2 std dev)
  const bbCloses = closes.slice(-20);
  const bbMean = bbCloses.reduce((a, b) => a + b, 0) / 20;
  const bbStdDev = Math.sqrt(
    bbCloses.reduce((sum, c) => sum + Math.pow(c - bbMean, 2), 0) / 20
  );
  const bbUpper = bbMean + 2 * bbStdDev;
  const bbLower = bbMean - 2 * bbStdDev;

  // ATR (14 period) for volatility
  const atrPeriod = Math.min(14, highs.length - 1);
  let atrSum = 0;
  for (let i = closes.length - atrPeriod; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    atrSum += tr;
  }
  const atr = atrSum / atrPeriod;

  // Determine side based on signals
  let bullScore = 0;
  let bearScore = 0;

  // SMA crossover
  if (sma10 > sma20) bullScore += 25;
  else bearScore += 25;

  // RSI
  if (rsi < 30) bullScore += 30; // oversold = buy
  else if (rsi > 70) bearScore += 30; // overbought = sell
  else if (rsi < 45) bullScore += 10;
  else if (rsi > 55) bearScore += 10;

  // Bollinger Band position
  if (currentPrice <= bbLower) bullScore += 20; // price at lower band
  else if (currentPrice >= bbUpper) bearScore += 20; // price at upper band
  else if (currentPrice < bbMean) bullScore += 5;
  else bearScore += 5;

  // Volume confirmation
  if (volMultiplier > 1.2) {
    if (closes[closes.length - 1] > closes[closes.length - 2]) bullScore += 15;
    else bearScore += 15;
  }

  // Price momentum (last 3 candles)
  const momentum = closes[closes.length - 1] - closes[closes.length - 4];
  if (momentum > 0) bullScore += 10;
  else bearScore += 10;

  const side = bullScore >= bearScore ? "BUY" : "SELL";
  const confidence = Math.min(95, Math.max(30, Math.round(
    side === "BUY" ? bullScore : bearScore
  )));

  // Calculate TP/SL from percentage or ATR
  const tpDist = Math.max(currentPrice * (tpPct / 100), atr * 1.5);
  const slDist = Math.max(currentPrice * (slPct / 100), atr * 1.0);

  const entry = currentPrice;
  const takeProfit = side === "BUY"
    ? +(entry + tpDist).toFixed(2)
    : +(entry - tpDist).toFixed(2);
  const stopLoss = side === "BUY"
    ? +(entry - slDist).toFixed(2)
    : +(entry + slDist).toFixed(2);

  return {
    id: crypto.randomUUID(),
    pair: symbol,
    side,
    entry: +entry.toFixed(2),
    takeProfit,
    stopLoss,
    leverage,
    confidence,
    status: "pending",
    createdAt: new Date().toISOString(),
    indicators: {
      sma10: +sma10.toFixed(2),
      sma20: +sma20.toFixed(2),
      rsi: +rsi.toFixed(2),
      atr: +atr.toFixed(4),
      bbUpper: +bbUpper.toFixed(2),
      bbLower: +bbLower.toFixed(2),
      volMultiplier: +volMultiplier.toFixed(2),
    },
  };
}

// GET all signals
app.get("/api/signals", optionalAuth, (_req, res) => {
  res.json({ ok: true, signals: DB.signals });
});

// GET approved signals only
app.get("/api/approved-signals", optionalAuth, (_req, res) => {
  const approved = DB.signals.filter((s) => s.status === "approved");
  res.json({ ok: true, signals: approved });
});

// POST generate a new signal
app.post("/api/signals/generate", optionalAuth, async (req, res) => {
  try {
    const { leverage, takeProfitPercent, stopLossPercent, symbol } = req.body || {};
    const signal = await generateMarketSignal({
      leverage,
      takeProfitPercent,
      stopLossPercent,
      symbol,
    });
    DB.signals.push(signal);
    saveDB(DB);
    addLog("info", `Signal generated: ${signal.pair} ${signal.side} @ ${signal.entry}`, {
      signalId: signal.id,
    });
    res.json({ ok: true, signal });
  } catch (e) {
    addLog("error", `Signal generation failed: ${e.message}`);
    res.status(500).json({ error: "signal_generation_failed", details: e.message });
  }
});

// POST approve signal
app.post("/api/signals/:id/approve", optionalAuth, (req, res) => {
  const signal = DB.signals.find((s) => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: "signal_not_found" });
  if (signal.status !== "pending") return res.status(400).json({ error: "signal_not_pending" });

  signal.status = "approved";
  signal.approvedAt = new Date().toISOString();
  saveDB(DB);
  addLog("info", `Signal approved: ${signal.pair} ${signal.side}`, { signalId: signal.id });
  res.json({ ok: true, signal });
});

// POST reject signal
app.post("/api/signals/:id/reject", optionalAuth, (req, res) => {
  const signal = DB.signals.find((s) => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: "signal_not_found" });
  if (signal.status !== "pending") return res.status(400).json({ error: "signal_not_pending" });

  signal.status = "rejected";
  signal.rejectedAt = new Date().toISOString();
  saveDB(DB);
  addLog("info", `Signal rejected: ${signal.pair} ${signal.side}`, { signalId: signal.id });
  res.json({ ok: true, signal });
});

// ===========================
// TRADES (signal -> trade execution, monitoring, closing)
// ===========================

// GET all trades
app.get("/api/trades", optionalAuth, (_req, res) => {
  const trades = DB.trades.map((t) => ({
    id: t.id,
    pair: t.pair || t.symbol,
    side: t.side,
    entry: t.entry,
    sizeUsd: t.sizeUsd || t.notional || 0,
    pnl: t.pnl || 0,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    leverage: t.leverage,
    status: t.status || "running",
    monitorScore: t.monitorScore || 50,
    openedAt: t.openedAt || t.createdAt,
    closedAt: t.closedAt,
  }));
  res.json({ ok: true, trades });
});

// POST execute an approved signal as a trade
app.post("/api/trades/execute", optionalAuth, async (req, res) => {
  try {
    const { signalId, allocationPercent } = req.body || {};
    if (!signalId) return res.status(400).json({ error: "signalId_required" });

    const signal = DB.signals.find((s) => s.id === signalId);
    if (!signal) return res.status(404).json({ error: "signal_not_found" });
    if (signal.status !== "approved") return res.status(400).json({ error: "signal_not_approved" });

    // Check max open positions
    const openTrades = DB.trades.filter((t) => t.status === "running");
    if (openTrades.length >= MAX_OPEN_POSITIONS) {
      return res.status(400).json({
        error: "max_positions_reached",
        message: `Maximum ${MAX_OPEN_POSITIONS} open positions allowed`,
      });
    }

    // Check daily trade limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = DB.trades.filter(
      (t) => new Date(t.openedAt || t.createdAt) >= todayStart
    );
    if (todayTrades.length >= MAX_TRADES_PER_DAY) {
      return res.status(400).json({
        error: "daily_limit_reached",
        message: `Maximum ${MAX_TRADES_PER_DAY} trades per day`,
      });
    }

    // Get fresh price
    const currentPrice = await getCurrentPrice(signal.pair);
    if (!currentPrice) {
      return res.status(500).json({ error: "cannot_fetch_price" });
    }

    const allocation = Number(allocationPercent || 25);
    const notional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, MAX_TRADE_USD * (allocation / 100)));

    // Create the trade record
    const trade = {
      id: crypto.randomUUID(),
      signalId: signal.id,
      pair: signal.pair,
      symbol: signal.pair,
      side: signal.side,
      entry: currentPrice,
      sizeUsd: +notional.toFixed(2),
      notional: +notional.toFixed(2),
      qty: +(notional / currentPrice).toFixed(6),
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      leverage: signal.leverage,
      status: "running",
      pnl: 0,
      monitorScore: 50,
      openedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      closedAt: null,
      liveExecution: false,
      executionResults: [],
    };

    // If live orders are enabled and user has accounts, execute on Binance
    if (ALLOW_LIVE_ORDERS && req.user) {
      const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
      for (const a of accounts) {
        const apiKey = dec(a.apiKeyEnc);
        const apiSecret = dec(a.apiSecretEnc);
        if (!apiKey || !apiSecret) continue;

        try {
          const exInfo = await pubFetch(FUT_BASE, "/fapi/v1/exchangeInfo", { symbol: signal.pair });
          const f = getFilters(exInfo, signal.pair);
          if (!f?.stepSize) continue;

          const acct = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/account", { signed: true });
          const avail = Number(acct?.availableBalance ?? 0);
          if (avail < MIN_TRADE_USD) continue;

          const liveNotional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, avail * (allocation / 100)));
          let qty = liveNotional / currentPrice;
          qty = floorToStep(qty, f.stepSize);
          qty = Number(qty.toFixed(decimalsFromStep(f.stepSize)));

          if (f.minQty && qty < f.minQty) continue;

          const mType = DEFAULT_MARGIN_TYPE;
          const lev = signal.leverage || DEFAULT_LEVERAGE;
          const entrySide = signal.side;
          const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
          const positionSide = entrySide === "BUY" ? "LONG" : "SHORT";

          try { await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/marginType", { method: "POST", signed: true, query: { symbol: signal.pair, marginType: mType } }); } catch {}
          try { await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/leverage", { method: "POST", signed: true, query: { symbol: signal.pair, leverage: lev } }); } catch {}

          // Market entry
          await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
            method: "POST",
            signed: true,
            query: {
              symbol: signal.pair,
              side: entrySide,
              type: "MARKET",
              quantity: qty,
              positionSide,
            },
          });

          // TP
          if (signal.takeProfit) {
            await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
              method: "POST",
              signed: true,
              query: {
                symbol: signal.pair,
                side: exitSide,
                type: "TAKE_PROFIT_MARKET",
                stopPrice: Number(signal.takeProfit),
                closePosition: true,
                workingType: "CONTRACT_PRICE",
                positionSide,
              },
            });
          }

          // SL
          if (signal.stopLoss) {
            await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
              method: "POST",
              signed: true,
              query: {
                symbol: signal.pair,
                side: exitSide,
                type: "STOP_MARKET",
                stopPrice: Number(signal.stopLoss),
                closePosition: true,
                workingType: "CONTRACT_PRICE",
                positionSide,
              },
            });
          }

          trade.liveExecution = true;
          trade.executionResults.push({ accountId: a.id, ok: true, qty, notional: liveNotional });
        } catch (e) {
          trade.executionResults.push({
            accountId: a.id,
            ok: false,
            error: e?.binance || e?.message || String(e),
          });
        }
      }
    }

    // Copy trade to clients
    const enabledClients = DB.clients.filter((c) => c.enabled);
    for (const client of enabledClients) {
      try {
        const clientApiKey = dec(client.apiKey);
        const clientApiSecret = dec(client.apiSecret);
        if (!clientApiKey || !clientApiSecret) continue;

        const ratio = client.balance > 0 && trade.sizeUsd > 0
          ? client.balance / (trade.sizeUsd * 10)
          : 1;
        const clientQty = trade.qty * ratio;

        const order = await executeFuturesOrder({
          apiKey: clientApiKey,
          apiSecret: clientApiSecret,
          symbol: trade.symbol,
          side: trade.side,
          quantity: clientQty,
        });

        trade.executionResults.push({
          clientId: client.id,
          ok: true,
          qty: clientQty,
          order,
        });
      } catch (err) {
        addLog("warn", `Client copy trade failed: ${err.message}`, { clientId: client.id });
      }
    }

    // Mark signal as executed
    signal.status = "executed";
    signal.executedAt = new Date().toISOString();

    DB.trades.push(trade);
    saveDB(DB);

    addLog("info", `Trade executed: ${trade.pair} ${trade.side} @ ${trade.entry}`, {
      tradeId: trade.id,
    });

    res.json({ ok: true, trade });
  } catch (e) {
    addLog("error", `Trade execution failed: ${e.message}`);
    res.status(500).json({ error: "trade_execution_failed", details: e.message });
  }
});

// POST monitor a trade (refresh PnL and monitor score)
app.post("/api/trades/:id/monitor", optionalAuth, async (req, res) => {
  const trade = DB.trades.find((t) => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: "trade_not_found" });
  if (trade.status === "closed") return res.status(400).json({ error: "trade_already_closed" });

  try {
    const currentPrice = await getCurrentPrice(trade.pair || trade.symbol);
    if (!currentPrice) {
      return res.status(500).json({ error: "cannot_fetch_price" });
    }

    // Calculate PnL
    const direction = trade.side === "BUY" ? 1 : -1;
    const priceDiff = (currentPrice - trade.entry) * direction;
    const pnl = priceDiff * (trade.qty || trade.sizeUsd / trade.entry);
    const pnlPct = (priceDiff / trade.entry) * 100;

    trade.pnl = +pnl.toFixed(4);
    trade.currentPrice = currentPrice;
    trade.lastMonitored = new Date().toISOString();

    // Calculate monitor score (0-100, higher = more risk/pressure)
    const tp = trade.takeProfit;
    const sl = trade.stopLoss;
    let score = 50;

    if (tp && sl) {
      const tpDist = Math.abs(tp - currentPrice);
      const slDist = Math.abs(sl - currentPrice);
      const totalRange = tpDist + slDist;
      if (totalRange > 0) {
        // Score: closer to SL = higher score (more danger)
        score = Math.round((1 - slDist / totalRange) * 100);
      }
    }

    // Adjust score based on PnL
    if (pnlPct > 0) score = Math.max(5, score - Math.round(pnlPct * 5));
    if (pnlPct < 0) score = Math.min(100, score + Math.round(Math.abs(pnlPct) * 5));

    trade.monitorScore = Math.max(5, Math.min(100, score));

    // Auto-close if SL/TP hit
    if (sl && ((trade.side === "BUY" && currentPrice <= sl) || (trade.side === "SELL" && currentPrice >= sl))) {
      trade.status = "closed";
      trade.closeReason = "stop_loss_hit";
      trade.closedAt = new Date().toISOString();
      trade.exitPrice = currentPrice;
      addLog("warn", `Trade auto-closed (SL hit): ${trade.pair}`, { tradeId: trade.id });
    }
    if (tp && ((trade.side === "BUY" && currentPrice >= tp) || (trade.side === "SELL" && currentPrice <= tp))) {
      trade.status = "closed";
      trade.closeReason = "take_profit_hit";
      trade.closedAt = new Date().toISOString();
      trade.exitPrice = currentPrice;
      addLog("info", `Trade auto-closed (TP hit): ${trade.pair}`, { tradeId: trade.id });
    }

    // PnL distribution for copy trading clients
    if (trade.status === "closed" && trade.pnl !== 0) {
      distributePnL(trade);
    }

    saveDB(DB);
    addLog("info", `Trade monitored: ${trade.pair} PnL: ${trade.pnl.toFixed(4)}`, {
      tradeId: trade.id,
    });

    res.json({ ok: true, trade });
  } catch (e) {
    addLog("error", `Monitor failed: ${e.message}`);
    res.status(500).json({ error: "monitor_failed", details: e.message });
  }
});

// POST close a trade manually
app.post("/api/trades/:id/close", optionalAuth, async (req, res) => {
  const trade = DB.trades.find((t) => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: "trade_not_found" });
  if (trade.status === "closed") return res.status(400).json({ error: "trade_already_closed" });

  try {
    const currentPrice = await getCurrentPrice(trade.pair || trade.symbol);

    const direction = trade.side === "BUY" ? 1 : -1;
    const priceDiff = currentPrice ? (currentPrice - trade.entry) * direction : 0;
    const pnl = priceDiff * (trade.qty || trade.sizeUsd / trade.entry);

    trade.status = "closed";
    trade.pnl = +pnl.toFixed(4);
    trade.exitPrice = currentPrice || trade.entry;
    trade.closedAt = new Date().toISOString();
    trade.closeReason = "manual";
    trade.monitorScore = 0;

    // PnL distribution for copy trading clients
    if (trade.pnl !== 0) {
      distributePnL(trade);
    }

    // If live orders and user authenticated, close position on exchange
    if (ALLOW_LIVE_ORDERS && req.user) {
      const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
      for (const a of accounts) {
        const apiKey = dec(a.apiKeyEnc);
        const apiSecret = dec(a.apiSecretEnc);
        if (!apiKey || !apiSecret) continue;

        try {
          // Cancel all open orders for this symbol
          await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/allOpenOrders", {
            method: "DELETE",
            signed: true,
            query: { symbol: trade.pair || trade.symbol },
          });

          // Close position with market order
          const exitSide = trade.side === "BUY" ? "SELL" : "BUY";
          const positionSide = trade.side === "BUY" ? "LONG" : "SHORT";

          // Get current position
          const positions = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/positionRisk", { signed: true });
          const pos = (positions || []).find(
            (p) => p.symbol === (trade.pair || trade.symbol) && Math.abs(Number(p.positionAmt)) > 0
          );
          if (pos) {
            const closeQty = Math.abs(Number(pos.positionAmt));
            await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
              method: "POST",
              signed: true,
              query: {
                symbol: trade.pair || trade.symbol,
                side: exitSide,
                type: "MARKET",
                quantity: closeQty,
                positionSide,
              },
            });
          }
        } catch (e) {
          addLog("warn", `Live close failed for account ${a.label}: ${e.message}`);
        }
      }
    }

    saveDB(DB);
    addLog("info", `Trade closed: ${trade.pair} PnL: ${trade.pnl.toFixed(4)}`, {
      tradeId: trade.id,
    });

    res.json({ ok: true, trade });
  } catch (e) {
    addLog("error", `Close trade failed: ${e.message}`);
    res.status(500).json({ error: "close_failed", details: e.message });
  }
});

// ===========================
// PnL DISTRIBUTION (copy trading profit sharing)
// ===========================
function distributePnL(trade) {
  // Find client trades associated with this trade
  const clientTrades = DB.trades.filter(
    (t) => t.parentTradeId === trade.id && !t.pnlDistributed
  );

  // Also distribute based on signal
  const pnl = trade.pnl || 0;
  if (pnl === 0) return;

  for (const client of DB.clients) {
    if (!client.enabled) continue;

    // Proportional PnL based on client balance
    const totalClientBalance = DB.clients.reduce((sum, c) => sum + (c.balance || 0), 0);
    if (totalClientBalance === 0) continue;

    const clientPnl = pnl * (client.balance / totalClientBalance);

    if (clientPnl > 0) {
      const masterCut = clientPnl * 0.3; // 30% profit share to master
      client.profit = (client.profit || 0) + clientPnl;
      client.masterShare = (client.masterShare || 0) + masterCut;
      DB.master.balance = (DB.master.balance || 0) + masterCut;
    } else {
      client.loss = (client.loss || 0) + Math.abs(clientPnl);
    }
  }

  trade.pnlDistributed = true;
  saveDB(DB);
}

// ===========================
// COPY TRADING — Master Trade endpoint
// ===========================
app.post("/api/trade/masterTrade", optionalAuth, async (req, res) => {
  try {
    const { symbol, side, qty, price, masterBalance } = req.body || {};
    if (!symbol || !side) return res.status(400).json({ error: "symbol_side_required" });

    const masterTrade = { symbol, side, qty, price, masterBalance };

    // Copy to all enabled clients
    const results = [];
    const enabledClients = DB.clients.filter((c) => c.enabled);

    for (const client of enabledClients) {
      try {
        const clientApiKey = dec(client.apiKey);
        const clientApiSecret = dec(client.apiSecret);
        if (!clientApiKey || !clientApiSecret) {
          results.push({ clientId: client.id, ok: false, error: "invalid_credentials" });
          continue;
        }

        const ratio = masterBalance > 0 ? client.balance / masterBalance : 1;
        const clientQty = (qty || 0) * ratio;

        const order = await executeFuturesOrder({
          apiKey: clientApiKey,
          apiSecret: clientApiSecret,
          symbol,
          side,
          quantity: clientQty,
        });

        const tradeRecord = {
          id: crypto.randomUUID(),
          clientId: client.id,
          symbol,
          side,
          entry: price,
          qty: clientQty,
          status: "running",
          openedAt: new Date().toISOString(),
        };

        DB.trades.push(tradeRecord);
        results.push({ clientId: client.id, ok: true, qty: clientQty, order });
      } catch (err) {
        results.push({ clientId: client.id, ok: false, error: err.message });
        addLog("warn", `Copy trade failed for client ${client.label}: ${err.message}`);
      }
    }

    saveDB(DB);
    addLog("info", `Master trade executed: ${symbol} ${side}`, { results });
    res.json({ ok: true, message: "Trade copied to clients", results });
  } catch (e) {
    res.status(500).json({ error: "master_trade_failed", details: e.message });
  }
});

// ===========================
// SETTINGS
// ===========================
app.get("/api/settings", optionalAuth, (_req, res) => {
  res.json({ ok: true, settings: DB.settings });
});

app.post("/api/settings/save", optionalAuth, (req, res) => {
  const {
    apiBase,
    allocationPercent,
    leverage,
    takeProfitPercent,
    stopLossPercent,
    refreshIntervalSec,
    apiKey,
    secretKey,
  } = req.body || {};

  DB.settings = {
    ...DB.settings,
    apiBase: apiBase || DB.settings.apiBase,
    allocationPercent: allocationPercent ?? DB.settings.allocationPercent ?? 25,
    leverage: leverage ?? DB.settings.leverage ?? DEFAULT_LEVERAGE,
    takeProfitPercent: takeProfitPercent ?? DB.settings.takeProfitPercent ?? DEFAULT_TAKE_PROFIT_PCT * 100,
    stopLossPercent: stopLossPercent ?? DB.settings.stopLossPercent ?? DEFAULT_STOP_LOSS_PCT * 100,
    refreshIntervalSec: refreshIntervalSec ?? DB.settings.refreshIntervalSec ?? 10,
    updatedAt: new Date().toISOString(),
  };

  // If API key provided, store it as an account
  if (apiKey && secretKey && req.user) {
    const existing = DB.accounts.find(
      (a) => a.uid === req.user.uid && a.label === "Dashboard Default"
    );
    if (existing) {
      existing.apiKeyEnc = enc(apiKey);
      existing.apiSecretEnc = enc(secretKey);
    } else {
      DB.accounts.push({
        id: crypto.randomUUID(),
        uid: req.user.uid,
        label: "Dashboard Default",
        apiKeyEnc: enc(apiKey),
        apiSecretEnc: enc(secretKey),
        enabled: true,
        createdAt: Date.now(),
      });
    }
  }

  saveDB(DB);
  addLog("info", "Settings saved");
  res.json({ ok: true, settings: DB.settings });
});

// ===========================
// FUTURES EXECUTE (direct, no signal)
// ===========================
app.post("/api/trade/executeFutures", auth, async (req, res) => {
  try {
    if (!liveOk(res)) return;

    const { symbol, side, tpPx, slPx, marginType, leverage, hedgeMode } = req.body || {};
    if (!symbol || !side || !tpPx || !slPx)
      return res.status(400).json({ error: "symbol_side_tp_sl_required" });

    const sym = String(symbol).toUpperCase();
    const entrySide = String(side).toUpperCase();
    if (!["BUY", "SELL"].includes(entrySide))
      return res.status(400).json({ error: "side_must_be_BUY_or_SELL" });

    const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
    const positionSide = entrySide === "BUY" ? "LONG" : "SHORT";

    const mType = (marginType || DEFAULT_MARGIN_TYPE).toUpperCase();
    const lev = Number(leverage || DEFAULT_LEVERAGE);
    const useHedge = hedgeMode !== false;

    const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
    if (!accounts.length) return res.status(400).json({ error: "no_enabled_accounts" });

    const kl = await pubFetch(FUT_BASE, "/fapi/v1/klines", { symbol: sym, interval: "1m", limit: 2 });
    const price = Number(kl?.[kl.length - 1]?.[4]);
    if (!Number.isFinite(price) || price <= 0) return res.status(500).json({ error: "bad_price" });

    const exInfo = await pubFetch(FUT_BASE, "/fapi/v1/exchangeInfo", { symbol: sym });
    const f = getFilters(exInfo, sym);
    if (!f?.stepSize) return res.status(500).json({ error: "missing_stepSize" });

    const results = [];

    for (const a of accounts) {
      const apiKey = dec(a.apiKeyEnc);
      const apiSecret = dec(a.apiSecretEnc);
      if (!apiKey || !apiSecret) {
        results.push({
          accountId: a.id,
          label: a.label,
          ok: false,
          market: "FUTURES",
          error: "Invalid stored API credentials. Re-add the account.",
        });
        continue;
      }

      try {
        const acct = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/account", { signed: true });
        const avail = Number(acct?.availableBalance ?? 0);

        if (avail < MIN_TRADE_USD) {
          results.push({
            accountId: a.id,
            label: a.label,
            ok: false,
            skipped: true,
            reason: `Low futures USDT: ${avail.toFixed(2)} < ${MIN_TRADE_USD}`,
          });
          continue;
        }

        const notional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, avail));
        let qty = notional / price;
        qty = floorToStep(qty, f.stepSize);
        qty = Number(qty.toFixed(decimalsFromStep(f.stepSize)));

        if (f.minQty && qty < f.minQty) {
          results.push({ accountId: a.id, label: a.label, ok: false, skipped: true, reason: `Qty < minQty (${qty} < ${f.minQty})` });
          continue;
        }
        if (f.minNotional && qty * price < f.minNotional) {
          results.push({ accountId: a.id, label: a.label, ok: false, skipped: true, reason: `Notional < minNotional (${(qty * price).toFixed(4)} < ${f.minNotional})` });
          continue;
        }

        try { await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/marginType", { method: "POST", signed: true, query: { symbol: sym, marginType: mType } }); } catch {}
        try { await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/leverage", { method: "POST", signed: true, query: { symbol: sym, leverage: lev } }); } catch {}

        await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
          method: "POST",
          signed: true,
          query: {
            symbol: sym, side: entrySide, type: "MARKET", quantity: qty,
            ...(useHedge ? { positionSide } : {}),
          },
        });

        await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
          method: "POST",
          signed: true,
          query: {
            symbol: sym, side: exitSide, type: "TAKE_PROFIT_MARKET",
            stopPrice: Number(tpPx), closePosition: true, workingType: "CONTRACT_PRICE",
            ...(useHedge ? { positionSide } : {}),
          },
        });

        await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
          method: "POST",
          signed: true,
          query: {
            symbol: sym, side: exitSide, type: "STOP_MARKET",
            stopPrice: Number(slPx), closePosition: true, workingType: "CONTRACT_PRICE",
            ...(useHedge ? { positionSide } : {}),
          },
        });

        results.push({ accountId: a.id, label: a.label, ok: true, market: "FUTURES", qty, notional, price });
      } catch (e) {
        results.push({ accountId: a.id, label: a.label, ok: false, market: "FUTURES", error: e?.binance || e?.message || String(e) });
      }
    }

    res.json({ ok: true, market: "FUTURES", symbol: sym, side: entrySide, results });
  } catch (e) {
    res.status(500).json({ error: "executeFutures_failed", details: e?.message || String(e) });
  }
});

// ===========================
// SPOT EXECUTE
// ===========================
app.post("/api/trade/executeSpot", auth, async (req, res) => {
  try {
    if (!liveOk(res)) return;

    const { symbol, side } = req.body || {};
    if (!symbol || !side) return res.status(400).json({ error: "symbol_side_required" });

    const sym = String(symbol).toUpperCase();
    const entrySide = String(side).toUpperCase();
    if (!["BUY", "SELL"].includes(entrySide)) return res.status(400).json({ error: "side_must_be_BUY_or_SELL" });

    const accounts = DB.accounts.filter((a) => a.uid === req.user.uid && a.enabled);
    if (!accounts.length) return res.status(400).json({ error: "no_enabled_accounts" });

    const exInfo = await pubFetch(SPOT_BASE, "/api/v3/exchangeInfo", { symbol: sym });
    const s = exInfo?.symbols?.find((x) => x.symbol === sym);
    if (!s) return res.status(400).json({ error: "unknown_symbol" });

    const baseAsset = s.baseAsset;
    const quoteAsset = s.quoteAsset;

    if (!SPOT_DOLLAR_QUOTES.has(quoteAsset)) {
      return res.status(400).json({
        error: "unsupported_quote_asset",
        message: `Only dollar-quote pairs supported: ${Array.from(SPOT_DOLLAR_QUOTES).join(", ")}. Got ${quoteAsset}`,
        baseAsset, quoteAsset,
      });
    }

    const f = getFilters(exInfo, sym);
    if (!f?.stepSize) return res.status(500).json({ error: "missing_stepSize" });

    const kl = await pubFetch(SPOT_BASE, "/api/v3/klines", { symbol: sym, interval: "1m", limit: 2 });
    const price = Number(kl?.[kl.length - 1]?.[4]);
    if (!Number.isFinite(price) || price <= 0) return res.status(500).json({ error: "bad_price" });

    const results = [];

    for (const a of accounts) {
      const apiKey = dec(a.apiKeyEnc);
      const apiSecret = dec(a.apiSecretEnc);
      if (!apiKey || !apiSecret) {
        results.push({ accountId: a.id, label: a.label, ok: false, market: "SPOT", error: "Invalid stored API credentials. Re-add the account." });
        continue;
      }

      try {
        const acct = await bFetch(SPOT_BASE, apiKey, apiSecret, "/api/v3/account", { signed: true });
        const balances = acct?.balances || [];

        const quoteBal = balances.find((b) => b.asset === quoteAsset);
        const baseBal = balances.find((b) => b.asset === baseAsset);
        const quoteFree = quoteBal ? Number(quoteBal.free ?? 0) : 0;
        const baseFree = baseBal ? Number(baseBal.free ?? 0) : 0;

        if (entrySide === "BUY") {
          if (quoteFree < MIN_TRADE_USD) {
            results.push({ accountId: a.id, label: a.label, ok: false, skipped: true, reason: `Low spot ${quoteAsset}: ${quoteFree.toFixed(2)} < ${MIN_TRADE_USD}` });
            continue;
          }
          const notional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, quoteFree));
          await bFetch(SPOT_BASE, apiKey, apiSecret, "/api/v3/order", { method: "POST", signed: true, query: { symbol: sym, side: "BUY", type: "MARKET", quoteOrderQty: notional } });
          results.push({ accountId: a.id, label: a.label, ok: true, market: "SPOT", action: "BUY", quoteAsset, baseAsset, notional, price });
        } else {
          const maxNotionalPossible = baseFree * price;
          const desiredNotional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, maxNotionalPossible));
          if (desiredNotional < MIN_TRADE_USD) {
            results.push({ accountId: a.id, label: a.label, ok: false, skipped: true, reason: `Not enough ${baseAsset} to sell ${MIN_TRADE_USD} ${quoteAsset} worth` });
            continue;
          }
          let qty = desiredNotional / price;
          qty = floorToStep(qty, f.stepSize);
          qty = Number(qty.toFixed(decimalsFromStep(f.stepSize)));
          qty = Math.min(qty, baseFree);
          qty = floorToStep(qty, f.stepSize);
          qty = Number(qty.toFixed(decimalsFromStep(f.stepSize)));
          if (f.minQty && qty < f.minQty) {
            results.push({ accountId: a.id, label: a.label, ok: false, skipped: true, reason: `Qty < minQty (${qty} < ${f.minQty})` });
            continue;
          }
          if (f.minNotional && qty * price < f.minNotional) {
            results.push({ accountId: a.id, label: a.label, ok: false, skipped: true, reason: `Notional < minNotional` });
            continue;
          }
          await bFetch(SPOT_BASE, apiKey, apiSecret, "/api/v3/order", { method: "POST", signed: true, query: { symbol: sym, side: "SELL", type: "MARKET", quantity: qty } });
          results.push({ accountId: a.id, label: a.label, ok: true, market: "SPOT", action: "SELL", quoteAsset, baseAsset, qty, notional: qty * price, price });
        }
      } catch (e) {
        results.push({ accountId: a.id, label: a.label, ok: false, market: "SPOT", error: e?.binance || e?.message || String(e) });
      }
    }

    res.json({ ok: true, market: "SPOT", symbol: sym, side: entrySide, baseAsset, quoteAsset, results });
  } catch (e) {
    res.status(500).json({ error: "executeSpot_failed", details: e?.message || String(e) });
  }
});

// ===========================
// ACTIVITY LOGS
// ===========================
app.get("/api/logs", optionalAuth, (req, res) => {
  const limit = Math.min(200, Number(req.query.limit || 50));
  res.json({ ok: true, logs: activityLogs.slice(0, limit) });
});

// ===========================
// MASTER ACCOUNT SUMMARY
// ===========================
app.get("/api/master/summary", optionalAuth, (_req, res) => {
  const totalProfit = DB.clients.reduce((sum, c) => sum + (c.profit || 0), 0);
  const totalLoss = DB.clients.reduce((sum, c) => sum + (c.loss || 0), 0);
  const totalMasterShare = DB.clients.reduce((sum, c) => sum + (c.masterShare || 0), 0);

  res.json({
    ok: true,
    master: {
      balance: DB.master.balance,
      totalClientProfit: totalProfit,
      totalClientLoss: totalLoss,
      totalMasterShare,
      clientCount: DB.clients.length,
      enabledClients: DB.clients.filter((c) => c.enabled).length,
    },
  });
});

// ===========================
// WEBHOOK (for TradingView or external signal sources)
// ===========================
app.post("/api/webhook", (req, res) => {
  const webhookEnabled = String(process.env.WEBHOOK_ENABLED || "false").toLowerCase() === "true";
  if (!webhookEnabled) return res.status(403).json({ error: "webhook_disabled" });

  const webhookSecret = process.env.WEBHOOK_SECRET || "";
  const providedSecret = req.headers["x-webhook-secret"] || req.body?.secret || "";

  if (webhookSecret && providedSecret !== webhookSecret) {
    return res.status(401).json({ error: "invalid_webhook_secret" });
  }

  const { symbol, side, action, price, stopLoss, takeProfit, leverage } = req.body || {};

  if (action === "close" && symbol) {
    // Close all running trades for this symbol
    const openTrades = DB.trades.filter(
      (t) => (t.pair === symbol || t.symbol === symbol) && t.status === "running"
    );
    for (const trade of openTrades) {
      trade.status = "closed";
      trade.closedAt = new Date().toISOString();
      trade.closeReason = "webhook";
      trade.exitPrice = price || trade.entry;
      trade.pnl = trade.exitPrice
        ? +((trade.exitPrice - trade.entry) * (trade.side === "BUY" ? 1 : -1) * (trade.qty || 0)).toFixed(4)
        : 0;
      if (trade.pnl !== 0) distributePnL(trade);
    }
    saveDB(DB);
    addLog("info", `Webhook close: ${symbol}, ${openTrades.length} trades closed`);
    return res.json({ ok: true, closedCount: openTrades.length });
  }

  if (!symbol || !side) return res.status(400).json({ error: "symbol_side_required" });

  // Create signal from webhook
  const signal = {
    id: crypto.randomUUID(),
    pair: symbol.toUpperCase(),
    side: side.toUpperCase(),
    entry: price || 0,
    takeProfit: takeProfit || 0,
    stopLoss: stopLoss || 0,
    leverage: leverage || DEFAULT_LEVERAGE,
    confidence: 80,
    status: "approved",
    source: "webhook",
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  };

  DB.signals.push(signal);
  saveDB(DB);
  addLog("info", `Webhook signal: ${signal.pair} ${signal.side}`, { signalId: signal.id });

  res.json({ ok: true, signal });
});

// ===========================
// CLOSE PnL endpoint (from pnl.js)
// ===========================
app.post("/api/pnl/close", optionalAuth, (req, res) => {
  const { symbol, exitPrice } = req.body || {};
  if (!symbol || !exitPrice) return res.status(400).json({ error: "symbol_exitPrice_required" });

  const trades = DB.trades.filter(
    (t) => (t.symbol === symbol || t.pair === symbol) && t.status !== "closed"
  );

  for (const t of trades) {
    const direction = t.side === "BUY" ? 1 : -1;
    const pnl = (exitPrice - t.entry) * (t.qty || 0) * direction;

    t.status = "closed";
    t.exitPrice = exitPrice;
    t.pnl = +pnl.toFixed(4);
    t.closedAt = new Date().toISOString();
    t.closeReason = "pnl_close";

    // Distribute to copy trading clients
    if (pnl !== 0) {
      for (const client of DB.clients) {
        if (!client.enabled) continue;
        const clientPnl = pnl * ((client.balance || 0) / Math.max(1, DB.clients.reduce((s, c) => s + (c.balance || 0), 0)));
        if (clientPnl > 0) {
          const masterCut = clientPnl * 0.3;
          client.profit = (client.profit || 0) + clientPnl;
          client.masterShare = (client.masterShare || 0) + masterCut;
          DB.master.balance = (DB.master.balance || 0) + masterCut;
        } else {
          client.loss = (client.loss || 0) + Math.abs(clientPnl);
        }
      }
    }
  }

  saveDB(DB);
  addLog("info", `PnL close: ${symbol} @ ${exitPrice}, ${trades.length} trades`);
  res.json({ ok: true, closedCount: trades.length });
});

// ===========================
// AUTO SCALPING ENGINE
// ===========================
let scalpingTimer = null;
let scalpingRunning = false;

async function runScalpingCycle() {
  if (scalpingRunning) return;
  scalpingRunning = true;

  try {
    const cfg = DB.autoScalping;
    if (!cfg.enabled) return;

    const symbols = cfg.symbols?.length ? cfg.symbols : [process.env.DEFAULT_SYMBOL || "BTCUSDT"];
    const minConf = cfg.minConfidence || 60;

    for (const symbol of symbols) {
      try {
        // Check max open positions
        const openTrades = DB.trades.filter((t) => t.status === "running");
        if (openTrades.length >= MAX_OPEN_POSITIONS) {
          addLog("info", `Scalping skip: max ${MAX_OPEN_POSITIONS} positions open`);
          break;
        }

        // Check daily trade limit
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTrades = DB.trades.filter((t) => new Date(t.openedAt || t.createdAt) >= todayStart);
        if (todayTrades.length >= MAX_TRADES_PER_DAY) {
          addLog("info", `Scalping skip: daily limit ${MAX_TRADES_PER_DAY} reached`);
          break;
        }

        // Skip if already have open trade for this symbol
        const existingTrade = openTrades.find((t) => (t.pair === symbol || t.symbol === symbol));
        if (existingTrade) continue;

        // Generate signal from real data
        const signal = await generateMarketSignal({
          symbol,
          leverage: DB.settings.leverage || DEFAULT_LEVERAGE,
          takeProfitPercent: DB.settings.takeProfitPercent || DEFAULT_TAKE_PROFIT_PCT * 100,
          stopLossPercent: DB.settings.stopLossPercent || DEFAULT_STOP_LOSS_PCT * 100,
        });

        signal.source = "auto_scalping";

        // Only trade if confidence meets threshold
        if (signal.confidence < minConf) {
          addLog("info", `Scalping skip ${symbol}: confidence ${signal.confidence}% < ${minConf}%`);
          continue;
        }

        // Auto-approve high-confidence signals
        signal.status = "approved";
        signal.approvedAt = new Date().toISOString();
        DB.signals.push(signal);
        saveDB(DB);

        addLog("info", `Scalping signal: ${symbol} ${signal.side} @ ${signal.entry} (${signal.confidence}%)`, { signalId: signal.id });

        // Auto execute if autoTradeOpen is enabled
        if (DB.autoTradeOpen.enabled) {
          await autoExecuteTrade(signal);
        }
      } catch (err) {
        addLog("error", `Scalping error for ${symbol}: ${err.message}`);
      }
    }
  } catch (err) {
    addLog("error", `Scalping cycle error: ${err.message}`);
  } finally {
    scalpingRunning = false;
  }
}

function startScalping() {
  stopScalping();
  const intervalSec = Math.max(10, DB.autoScalping.intervalSec || 30);
  scalpingTimer = setInterval(() => runScalpingCycle(), intervalSec * 1000);
  addLog("info", `Auto scalping started: ${intervalSec}s interval, symbols: ${(DB.autoScalping.symbols || []).join(", ") || "default"}`);
  // Run first cycle immediately
  runScalpingCycle();
}

function stopScalping() {
  if (scalpingTimer) {
    clearInterval(scalpingTimer);
    scalpingTimer = null;
  }
}

// API: scalping config
app.get("/api/auto/scalping", optionalAuth, (_req, res) => {
  res.json({ ok: true, autoScalping: DB.autoScalping, running: !!scalpingTimer });
});

app.post("/api/auto/scalping", optionalAuth, (req, res) => {
  const { enabled, symbols, intervalSec, minConfidence } = req.body || {};

  if (enabled !== undefined) DB.autoScalping.enabled = !!enabled;
  if (symbols !== undefined) DB.autoScalping.symbols = Array.isArray(symbols) ? symbols.map((s) => String(s).toUpperCase()) : DB.autoScalping.symbols;
  if (intervalSec !== undefined) DB.autoScalping.intervalSec = Math.max(10, Number(intervalSec) || 30);
  if (minConfidence !== undefined) DB.autoScalping.minConfidence = Math.max(0, Math.min(100, Number(minConfidence) || 60));

  saveDB(DB);

  if (DB.autoScalping.enabled) {
    startScalping();
  } else {
    stopScalping();
    addLog("info", "Auto scalping stopped");
  }

  res.json({ ok: true, autoScalping: DB.autoScalping, running: !!scalpingTimer });
});

// ===========================
// AUTO TRADE OPEN ENGINE
// ===========================
let autoOpenTimer = null;

async function autoExecuteTrade(signal) {
  try {
    const openTrades = DB.trades.filter((t) => t.status === "running");
    if (openTrades.length >= MAX_OPEN_POSITIONS) return;

    const currentPrice = await getCurrentPrice(signal.pair);

    const allocation = DB.settings.allocationPercent || 25;
    const notional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, MAX_TRADE_USD * (allocation / 100)));

    const trade = {
      id: crypto.randomUUID(),
      signalId: signal.id,
      pair: signal.pair,
      symbol: signal.pair,
      side: signal.side,
      entry: currentPrice,
      sizeUsd: +notional.toFixed(2),
      notional: +notional.toFixed(2),
      qty: +(notional / currentPrice).toFixed(8),
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      leverage: signal.leverage,
      status: "running",
      pnl: 0,
      monitorScore: 50,
      openedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      closedAt: null,
      trailingStop: null,
      highWaterMark: currentPrice,
      lowWaterMark: currentPrice,
      source: signal.source || "auto",
      liveExecution: false,
      executionResults: [],
    };

    // Live Binance execution for all enabled accounts
    if (ALLOW_LIVE_ORDERS) {
      const accounts = DB.accounts.filter((a) => a.enabled);
      for (const a of accounts) {
        const apiKey = dec(a.apiKeyEnc);
        const apiSecret = dec(a.apiSecretEnc);
        if (!apiKey || !apiSecret) continue;

        try {
          const exInfo = await pubFetch(FUT_BASE, "/fapi/v1/exchangeInfo", { symbol: signal.pair });
          const f = getFilters(exInfo, signal.pair);
          if (!f?.stepSize) continue;

          const acct = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/account", { signed: true });
          const avail = Number(acct?.availableBalance ?? 0);
          if (avail < MIN_TRADE_USD) continue;

          const liveNotional = Math.max(MIN_TRADE_USD, Math.min(MAX_TRADE_USD, avail * (allocation / 100)));
          let qty = liveNotional / currentPrice;
          qty = floorToStep(qty, f.stepSize);
          qty = Number(qty.toFixed(decimalsFromStep(f.stepSize)));
          if (f.minQty && qty < f.minQty) continue;

          const entrySide = signal.side;
          const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
          const positionSide = entrySide === "BUY" ? "LONG" : "SHORT";

          try { await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/marginType", { method: "POST", signed: true, query: { symbol: signal.pair, marginType: DEFAULT_MARGIN_TYPE } }); } catch {}
          try { await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/leverage", { method: "POST", signed: true, query: { symbol: signal.pair, leverage: signal.leverage || DEFAULT_LEVERAGE } }); } catch {}

          await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
            method: "POST", signed: true,
            query: { symbol: signal.pair, side: entrySide, type: "MARKET", quantity: qty, positionSide },
          });

          if (signal.takeProfit) {
            try {
              await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
                method: "POST", signed: true,
                query: { symbol: signal.pair, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: Number(signal.takeProfit), closePosition: true, workingType: "CONTRACT_PRICE", positionSide },
              });
            } catch {}
          }
          if (signal.stopLoss) {
            try {
              await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
                method: "POST", signed: true,
                query: { symbol: signal.pair, side: exitSide, type: "STOP_MARKET", stopPrice: Number(signal.stopLoss), closePosition: true, workingType: "CONTRACT_PRICE", positionSide },
              });
            } catch {}
          }

          trade.liveExecution = true;
          trade.executionResults.push({ accountId: a.id, ok: true, qty, notional: liveNotional });
          addLog("info", `Live order placed: ${signal.pair} ${entrySide} qty=${qty}`, { accountId: a.id });
        } catch (e) {
          trade.executionResults.push({ accountId: a.id, ok: false, error: e?.binance || e?.message || String(e) });
        }
      }
    }

    // Copy to clients
    for (const client of DB.clients.filter((c) => c.enabled)) {
      try {
        const ck = dec(client.apiKey);
        const cs = dec(client.apiSecret);
        if (!ck || !cs) continue;
        const ratio = client.balance > 0 ? client.balance / (trade.sizeUsd * 10) : 1;
        const cQty = trade.qty * ratio;
        await executeFuturesOrder({ apiKey: ck, apiSecret: cs, symbol: trade.symbol, side: trade.side, quantity: cQty });
      } catch (err) {
        addLog("warn", `Copy trade failed for client: ${err.message}`);
      }
    }

    signal.status = "executed";
    signal.executedAt = new Date().toISOString();
    DB.trades.push(trade);
    saveDB(DB);

    addLog("info", `Auto trade opened: ${trade.pair} ${trade.side} @ ${trade.entry} $${trade.sizeUsd}`, { tradeId: trade.id });
    return trade;
  } catch (err) {
    addLog("error", `Auto trade open failed: ${err.message}`);
    return null;
  }
}

async function runAutoOpenCycle() {
  if (!DB.autoTradeOpen.enabled) return;

  const approved = DB.signals.filter((s) => s.status === "approved");
  for (const signal of approved) {
    const openTrades = DB.trades.filter((t) => t.status === "running");
    if (openTrades.length >= MAX_OPEN_POSITIONS) break;

    // Skip if already have a trade for this symbol
    if (openTrades.find((t) => (t.pair === signal.pair || t.symbol === signal.pair))) continue;

    await autoExecuteTrade(signal);
  }
}

function startAutoOpen() {
  stopAutoOpen();
  autoOpenTimer = setInterval(() => runAutoOpenCycle(), 5000);
  addLog("info", "Auto trade open started");
  runAutoOpenCycle();
}

function stopAutoOpen() {
  if (autoOpenTimer) {
    clearInterval(autoOpenTimer);
    autoOpenTimer = null;
  }
}

// API: auto trade open config
app.get("/api/auto/trade-open", optionalAuth, (_req, res) => {
  res.json({ ok: true, autoTradeOpen: DB.autoTradeOpen, running: !!autoOpenTimer });
});

app.post("/api/auto/trade-open", optionalAuth, (req, res) => {
  const { enabled } = req.body || {};
  if (enabled !== undefined) DB.autoTradeOpen.enabled = !!enabled;
  saveDB(DB);

  if (DB.autoTradeOpen.enabled) {
    startAutoOpen();
  } else {
    stopAutoOpen();
    addLog("info", "Auto trade open stopped");
  }

  res.json({ ok: true, autoTradeOpen: DB.autoTradeOpen, running: !!autoOpenTimer });
});

// ===========================
// AUTO TRADE CLOSE ENGINE (trailing stop + SL/TP + time-based)
// ===========================
let autoCloseTimer = null;

async function runAutoCloseCycle() {
  const cfg = DB.autoTradeClose;
  if (!cfg.enabled) return;

  const runningTrades = DB.trades.filter((t) => t.status === "running");
  if (!runningTrades.length) return;

  for (const trade of runningTrades) {
    try {
      const currentPrice = await getCurrentPrice(trade.pair || trade.symbol);
      const direction = trade.side === "BUY" ? 1 : -1;
      const priceDiff = (currentPrice - trade.entry) * direction;
      const pnl = priceDiff * (trade.qty || trade.sizeUsd / trade.entry);
      const pnlPct = (priceDiff / trade.entry) * 100;

      trade.pnl = +pnl.toFixed(4);
      trade.currentPrice = currentPrice;
      trade.lastMonitored = new Date().toISOString();

      // Update high/low water marks for trailing stop
      if (!trade.highWaterMark || currentPrice > trade.highWaterMark) trade.highWaterMark = currentPrice;
      if (!trade.lowWaterMark || currentPrice < trade.lowWaterMark) trade.lowWaterMark = currentPrice;

      // Calculate monitor score
      const tp = trade.takeProfit;
      const sl = trade.stopLoss;
      let score = 50;
      if (tp && sl) {
        const tpDist = Math.abs(tp - currentPrice);
        const slDist = Math.abs(sl - currentPrice);
        const totalRange = tpDist + slDist;
        if (totalRange > 0) score = Math.round((1 - slDist / totalRange) * 100);
      }
      if (pnlPct > 0) score = Math.max(5, score - Math.round(pnlPct * 5));
      if (pnlPct < 0) score = Math.min(100, score + Math.round(Math.abs(pnlPct) * 5));
      trade.monitorScore = Math.max(5, Math.min(100, score));

      let shouldClose = false;
      let closeReason = "";

      // 1) Stop Loss hit
      if (sl) {
        if ((trade.side === "BUY" && currentPrice <= sl) || (trade.side === "SELL" && currentPrice >= sl)) {
          shouldClose = true;
          closeReason = "stop_loss_hit";
        }
      }

      // 2) Take Profit hit
      if (tp && !shouldClose) {
        if ((trade.side === "BUY" && currentPrice >= tp) || (trade.side === "SELL" && currentPrice <= tp)) {
          shouldClose = true;
          closeReason = "take_profit_hit";
        }
      }

      // 3) Trailing stop
      const trailPct = cfg.trailingStopPct || 0;
      if (trailPct > 0 && !shouldClose) {
        if (trade.side === "BUY") {
          const trailPrice = trade.highWaterMark * (1 - trailPct / 100);
          trade.trailingStop = +trailPrice.toFixed(2);
          if (currentPrice <= trailPrice) {
            shouldClose = true;
            closeReason = `trailing_stop (${trailPct}% from high ${trade.highWaterMark})`;
          }
        } else {
          const trailPrice = trade.lowWaterMark * (1 + trailPct / 100);
          trade.trailingStop = +trailPrice.toFixed(2);
          if (currentPrice >= trailPrice) {
            shouldClose = true;
            closeReason = `trailing_stop (${trailPct}% from low ${trade.lowWaterMark})`;
          }
        }
      }

      // 4) Time-based auto-close
      const maxHold = cfg.maxHoldMinutes || 0;
      if (maxHold > 0 && !shouldClose) {
        const openedAt = new Date(trade.openedAt || trade.createdAt).getTime();
        const elapsed = (Date.now() - openedAt) / 60000;
        if (elapsed >= maxHold) {
          shouldClose = true;
          closeReason = `max_hold_time (${maxHold}min)`;
        }
      }

      // Execute close
      if (shouldClose) {
        trade.status = "closed";
        trade.closedAt = new Date().toISOString();
        trade.closeReason = closeReason;
        trade.exitPrice = currentPrice;
        trade.monitorScore = 0;

        // Close on Binance
        if (ALLOW_LIVE_ORDERS) {
          const accounts = DB.accounts.filter((a) => a.enabled);
          for (const a of accounts) {
            const apiKey = dec(a.apiKeyEnc);
            const apiSecret = dec(a.apiSecretEnc);
            if (!apiKey || !apiSecret) continue;
            try {
              await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/allOpenOrders", { method: "DELETE", signed: true, query: { symbol: trade.pair || trade.symbol } });
              const positions = await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v2/positionRisk", { signed: true });
              const pos = (positions || []).find((p) => p.symbol === (trade.pair || trade.symbol) && Math.abs(Number(p.positionAmt)) > 0);
              if (pos) {
                const exitSide = trade.side === "BUY" ? "SELL" : "BUY";
                const positionSide = trade.side === "BUY" ? "LONG" : "SHORT";
                await bFetch(FUT_BASE, apiKey, apiSecret, "/fapi/v1/order", {
                  method: "POST", signed: true,
                  query: { symbol: trade.pair || trade.symbol, side: exitSide, type: "MARKET", quantity: Math.abs(Number(pos.positionAmt)), positionSide },
                });
              }
            } catch (e) {
              addLog("warn", `Auto close live order failed: ${e.message}`);
            }
          }
        }

        // PnL distribution
        if (trade.pnl !== 0) distributePnL(trade);

        addLog("info", `Auto closed: ${trade.pair} ${trade.side} reason=${closeReason} PnL=${trade.pnl}`, { tradeId: trade.id });
      }
    } catch (err) {
      addLog("error", `Auto close error for ${trade.pair}: ${err.message}`);
    }
  }

  saveDB(DB);
}

function startAutoClose() {
  stopAutoClose();
  autoCloseTimer = setInterval(() => runAutoCloseCycle(), 5000);
  addLog("info", "Auto trade close started");
  runAutoCloseCycle();
}

function stopAutoClose() {
  if (autoCloseTimer) {
    clearInterval(autoCloseTimer);
    autoCloseTimer = null;
  }
}

// API: auto trade close config
app.get("/api/auto/trade-close", optionalAuth, (_req, res) => {
  res.json({ ok: true, autoTradeClose: DB.autoTradeClose, running: !!autoCloseTimer });
});

app.post("/api/auto/trade-close", optionalAuth, (req, res) => {
  const { enabled, trailingStopPct, maxHoldMinutes } = req.body || {};
  if (enabled !== undefined) DB.autoTradeClose.enabled = !!enabled;
  if (trailingStopPct !== undefined) DB.autoTradeClose.trailingStopPct = Math.max(0, Number(trailingStopPct) || 0);
  if (maxHoldMinutes !== undefined) DB.autoTradeClose.maxHoldMinutes = Math.max(0, Number(maxHoldMinutes) || 0);
  saveDB(DB);

  if (DB.autoTradeClose.enabled) {
    startAutoClose();
  } else {
    stopAutoClose();
    addLog("info", "Auto trade close stopped");
  }

  res.json({ ok: true, autoTradeClose: DB.autoTradeClose, running: !!autoCloseTimer });
});

// ===========================
// AUTO STATUS (combined view of all auto engines)
// ===========================
app.get("/api/auto/status", optionalAuth, (_req, res) => {
  res.json({
    ok: true,
    scalping: { ...DB.autoScalping, running: !!scalpingTimer },
    autoOpen: { ...DB.autoTradeOpen, running: !!autoOpenTimer },
    autoClose: { ...DB.autoTradeClose, running: !!autoCloseTimer },
  });
});

// Master toggle: start/stop all auto engines at once
app.post("/api/auto/toggle-all", optionalAuth, (req, res) => {
  const { enabled } = req.body || {};
  const on = !!enabled;

  DB.autoScalping.enabled = on;
  DB.autoTradeOpen.enabled = on;
  DB.autoTradeClose.enabled = on;
  saveDB(DB);

  if (on) {
    startScalping();
    startAutoOpen();
    startAutoClose();
  } else {
    stopScalping();
    stopAutoOpen();
    stopAutoClose();
    addLog("info", "All auto engines stopped");
  }

  res.json({
    ok: true,
    enabled: on,
    scalping: { ...DB.autoScalping, running: !!scalpingTimer },
    autoOpen: { ...DB.autoTradeOpen, running: !!autoOpenTimer },
    autoClose: { ...DB.autoTradeClose, running: !!autoCloseTimer },
  });
});

// ===========================
// START SERVER + RESTORE AUTO ENGINES
// ===========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  FuturesOps TradeBot running!`);
  console.log(`  Dashboard: http://127.0.0.1:${PORT}/`);
  console.log(`  Health:    http://127.0.0.1:${PORT}/api/health`);
  console.log(`  Status:    http://127.0.0.1:${PORT}/api/status`);
  console.log(`  Live:      ${ALLOW_LIVE_ORDERS ? "ENABLED" : "DISABLED"}`);
  console.log(`  Limits:    $${MIN_TRADE_USD}-$${MAX_TRADE_USD}/trade`);

  // Restore auto engines from saved state
  if (DB.autoScalping.enabled) {
    startScalping();
    console.log(`  Scalping:  ACTIVE (${DB.autoScalping.intervalSec}s)`);
  }
  if (DB.autoTradeOpen.enabled) {
    startAutoOpen();
    console.log(`  AutoOpen:  ACTIVE`);
  }
  if (DB.autoTradeClose.enabled) {
    startAutoClose();
    console.log(`  AutoClose: ACTIVE`);
  }
  console.log("");
});
