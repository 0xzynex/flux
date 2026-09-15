/**
 * HIVE Swarm Visualizer, server
 *
 * How it works:
 *   1. Client opens a WebSocket and sends { action: "watch", mint: "<TOKEN_ADDRESS>" }.
 *   2. Server subscribes to logsSubscribe for that mint via WebSocket RPC (near-zero latency,
 *      does not burn HTTP credits).
 *   3. Every incoming signature goes into a queue.
 *   4. A batcher drains the queue every BATCH_INTERVAL_MS and POSTs up to BATCH_SIZE
 *      signatures at once to Helius Enhanced Transactions API:
 *      https://api.helius.xyz/v0/transactions?api-key=...
 *      One HTTP request parses up to 100 transactions => ~100x fewer RPC credits and
 *      no per-tx round-trip latency.
 *   5. Parsed trades (buy / sell, sol amount, token amount, trader) are broadcast to all
 *      connected browser clients over WebSocket.
 *
 * Result: on an active pump.fun token doing 20,40 tx/s the feed stays in real time and
 * a Helius free tier lasts a lot longer than "one credit per tx".
 *
 * No secrets are baked in. The user provides RPC_URL via .env or environment.
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const fetch = require("node-fetch");
const { Connection, PublicKey } = require("@solana/web3.js");

// ---------- config ----------
const PORT = parseInt(process.env.PORT || "3000", 10);
const RPC_URL = process.env.RPC_URL;
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || "350", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "100", 10);
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || "1000", 10);
const DEDUP_TTL_MS = 5 * 60 * 1000;

if (!RPC_URL) {
  console.error("\n[HIVE] RPC_URL is not set.");
  console.error("       Create a .env file (copy .env.example) and paste your Helius URL,");
  console.error("       or run:  RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY' node server.js\n");
  process.exit(1);
}

// derive Helius API key from RPC URL if user pasted a Helius endpoint
function extractHeliusKey(url) {
  try {
    const u = new URL(url);
    if (!/helius/i.test(u.hostname)) return null;
    return u.searchParams.get("api-key");
  } catch {
    return null;
  }
}
const HELIUS_KEY = process.env.HELIUS_API_KEY || extractHeliusKey(RPC_URL);
const ENHANCED_URL = HELIUS_KEY
  ? `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`
  : null;

if (!ENHANCED_URL) {
  console.warn("[HIVE] Warning: RPC_URL is not a Helius endpoint and HELIUS_API_KEY is not set.");
  console.warn("       Falling back to per-tx getParsedTransaction, this will be slow and rate-limited.");
  console.warn("       For real-time speed use a Helius RPC URL (free tier is enough for casual use).\n");
}

// ---------- express + ws ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, watchers: watchers.size }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------- state ----------
/**
 * One "watcher" per mint. Multiple browser clients can share the same watcher.
 *   watchers: Map<mint, {
 *     subId: number,          // solana logsSubscribe id
 *     clients: Set<WebSocket>,
 *     queue: string[],         // pending signatures
 *     seen: Map<sig, ts>,      // dedup
 *   }>
 */
const watchers = new Map();

// One HTTP Connection instance for the fallback path (getParsedTransaction).
const httpConnection = new Connection(RPC_URL, {
  commitment: "confirmed",
  wsEndpoint: RPC_URL.replace(/^http/, "ws"),
});

// ---------- WS: browser <-> server ----------
wss.on("connection", (ws) => {
  ws.watchingMint = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.action === "watch" && typeof msg.mint === "string") {
      startWatching(msg.mint.trim(), ws);
    } else if (msg.action === "unwatch") {
      stopWatching(ws);
    }
  });

  ws.on("close", () => stopWatching(ws));
  ws.on("error", () => stopWatching(ws));

  send(ws, { type: "hello", ts: Date.now() });
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
function broadcast(mint, obj) {
  const w = watchers.get(mint);
  if (!w) return;
  const payload = JSON.stringify(obj);
  for (const c of w.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  }
}

// ---------- watcher lifecycle ----------
async function startWatching(mint, ws) {
  // validate mint
  let mintPk;
  try { mintPk = new PublicKey(mint); } catch {
    send(ws, { type: "error", message: `Invalid mint address: ${mint}` });
    return;
  }

  // if this client was watching something else, unhook it first
  stopWatching(ws);

  let w = watchers.get(mint);
  if (!w) {
    w = { subId: null, clients: new Set(), queue: [], seen: new Map() };
    watchers.set(mint, w);
    try {
      w.subId = await httpConnection.onLogs(
        mintPk,
        (logInfo) => onSignature(mint, logInfo.signature, logInfo.err),
        "processed"
      );
      console.log(`[HIVE] watching ${mint} (subId=${w.subId})`);
    } catch (e) {
      console.error(`[HIVE] onLogs subscribe failed for ${mint}:`, e.message);
      watchers.delete(mint);
      send(ws, { type: "error", message: `Failed to subscribe: ${e.message}` });
      return;
    }
  }

  w.clients.add(ws);
  ws.watchingMint = mint;
  send(ws, { type: "watching", mint });
}

async function stopWatching(ws) {
  const mint = ws.watchingMint;
  if (!mint) return;
  ws.watchingMint = null;
  const w = watchers.get(mint);
  if (!w) return;
  w.clients.delete(ws);
  if (w.clients.size === 0) {
    try { await httpConnection.removeOnLogsListener(w.subId); } catch {}
    watchers.delete(mint);
    console.log(`[HIVE] stopped watching ${mint}`);
  }
}

// ---------- signature intake ----------
function onSignature(mint, signature, err) {
  if (err) return; // failed tx, skip
  const w = watchers.get(mint);
  if (!w) return;
  if (w.seen.has(signature)) return;
  w.seen.set(signature, Date.now());

  if (w.queue.length >= MAX_QUEUE) {
    // drop oldest, protects memory on runaway tokens
    w.queue.shift();
  }
  w.queue.push(signature);
}

// periodic dedup cleanup
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const w of watchers.values()) {
    for (const [sig, ts] of w.seen) {
      if (ts < cutoff) w.seen.delete(sig);
    }
  }
}, 60_000).unref();

// ---------- batcher ----------
setInterval(() => {
  for (const [mint, w] of watchers) {
    if (w.queue.length === 0) continue;
    const batch = w.queue.splice(0, BATCH_SIZE);
    parseBatch(mint, batch).catch((e) => {
      console.error(`[HIVE] parseBatch error for ${mint}:`, e.message);
    });
  }
}, BATCH_INTERVAL_MS).unref();

// ---------- parsing ----------
async function parseBatch(mint, signatures) {
  if (ENHANCED_URL) {
    // Helius Enhanced, up to 100 txs per HTTP call
    let parsed;
    try {
      const r = await fetch(ENHANCED_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: signatures }),
      });
      if (!r.ok) {
        // rate-limited or transient, requeue and back off
        if (r.status === 429 || r.status >= 500) {
          const w = watchers.get(mint);
          if (w) w.queue.unshift(...signatures);
          await sleep(500);
          return;
        }
        throw new Error(`Helius ${r.status}`);
      }
      parsed = await r.json();
    } catch (e) {
      // network hiccup, requeue once and move on
      const w = watchers.get(mint);
      if (w) w.queue.unshift(...signatures);
      throw e;
    }
    for (const tx of parsed || []) {
      const trade = extractTradeFromEnhanced(tx, mint);
      if (trade) broadcast(mint, { type: "trade", ...trade });
    }
  } else {
    // Fallback: getParsedTransaction, sequentially, small pool
    await parseWithRpc(mint, signatures);
  }
}

/**
 * Extract a normalized trade from a Helius Enhanced transaction.
 * We identify direction by looking at the token transfers of `mint`:
 *   - if a user account RECEIVES the token and pays SOL -> BUY
 *   - if a user account SENDS the token and receives SOL -> SELL
 * Works for pump.fun bonding curve, Raydium, Jupiter routes, Meteora, etc.
 */
function extractTradeFromEnhanced(tx, mint) {
  if (!tx || tx.transactionError) return null;

  const tokenTransfers = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];

  const mintTransfers = tokenTransfers.filter((t) => t.mint === mint);
  if (mintTransfers.length === 0) return null;

  // Aggregate SOL flow per account (lamports -> SOL)
  const solFlow = new Map(); // account -> net sol (in)
  for (const n of nativeTransfers) {
    const amt = Number(n.amount) / 1e9;
    solFlow.set(n.fromUserAccount, (solFlow.get(n.fromUserAccount) || 0) - amt);
    solFlow.set(n.toUserAccount, (solFlow.get(n.toUserAccount) || 0) + amt);
  }

  // Aggregate token flow per account
  const tokFlow = new Map();
  for (const t of mintTransfers) {
    const amt = Number(t.tokenAmount);
    if (!Number.isFinite(amt)) continue;
    tokFlow.set(t.fromUserAccount, (tokFlow.get(t.fromUserAccount) || 0) - amt);
    tokFlow.set(t.toUserAccount, (tokFlow.get(t.toUserAccount) || 0) + amt);
  }

  // Trader = the account whose token balance changed AND whose sol balance moved
  // in the opposite direction. Pool/bonding-curve accounts will have opposite pattern.
  let trader = null;
  let side = null;
  let tokenAmount = 0;
  let solAmount = 0;

  for (const [acc, dTok] of tokFlow) {
    if (!acc || Math.abs(dTok) < 1e-9) continue;
    const dSol = solFlow.get(acc) || 0;
    if (dTok > 0 && dSol < 0) {
      // received tokens, sent sol -> BUY
      trader = acc; side = "buy";
      tokenAmount = dTok; solAmount = -dSol;
      break;
    }
    if (dTok < 0 && dSol > 0) {
      // sent tokens, received sol -> SELL
      trader = acc; side = "sell";
      tokenAmount = -dTok; solAmount = dSol;
      break;
    }
  }

  // Fallback: use fee payer + Helius description if we could not match SOL flow
  // (some routes settle SOL via wSOL tokenTransfers, not nativeTransfers).
  if (!trader) {
    trader = tx.feePayer || (tx.accountData && tx.accountData[0] && tx.accountData[0].account);
    // Try to infer via description text
    const desc = (tx.description || "").toLowerCase();
    if (/swapped\s+[\d.]+\s+sol/i.test(tx.description || "")) side = "buy";
    else if (/swapped\s+[\d.]+\s+[a-z0-9]+\s+for\s+[\d.]+\s+sol/i.test(tx.description || "")) side = "sell";

    // last resort: try wSOL transfers
    const WSOL = "So11111111111111111111111111111111111111112";
    const wsolTransfers = tokenTransfers.filter((t) => t.mint === WSOL);
    if (wsolTransfers.length) {
      const inWsol = wsolTransfers.filter((t) => t.toUserAccount === trader).reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
      const outWsol = wsolTransfers.filter((t) => t.fromUserAccount === trader).reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
      if (outWsol > inWsol) { side = side || "buy"; solAmount = outWsol - inWsol; }
      else if (inWsol > outWsol) { side = side || "sell"; solAmount = inWsol - outWsol; }
    }

    // token amount for fee payer
    const inTok = mintTransfers.filter((t) => t.toUserAccount === trader).reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
    const outTok = mintTransfers.filter((t) => t.fromUserAccount === trader).reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
    tokenAmount = Math.abs(inTok - outTok);
    if (!side) side = inTok > outTok ? "buy" : "sell";
    if (!solAmount) return null;
  }

  if (!side || !solAmount || !trader) return null;

  return {
    signature: tx.signature,
    timestamp: (tx.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    side,
    solAmount,
    tokenAmount,
    trader,
    source: tx.source || null,
  };
}

// ---------- fallback: raw RPC ----------
async function parseWithRpc(mint, signatures) {
  const CONCURRENCY = 3;
  let i = 0;
  async function worker() {
    while (i < signatures.length) {
      const sig = signatures[i++];
      try {
        const tx = await httpConnection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        const trade = extractTradeFromRpc(tx, mint, sig);
        if (trade) broadcast(mint, { type: "trade", ...trade });
      } catch (e) {
        if (e.message && e.message.includes("429")) {
          await sleep(1000);
          const w = watchers.get(mint);
          if (w) w.queue.unshift(sig);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function extractTradeFromRpc(tx, mint, signature) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const owners = new Map();
  const applyBalances = (arr, sign) => {
    for (const b of arr) {
      if (b.mint !== mint) continue;
      const owner = b.owner;
      if (!owner) continue;
      const amt = Number(b.uiTokenAmount.uiAmount || 0);
      owners.set(owner, (owners.get(owner) || 0) + sign * amt);
    }
  };
  applyBalances(pre, -1);
  applyBalances(post, +1);

  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey.toString()
  );
  const preSol = tx.meta.preBalances;
  const postSol = tx.meta.postBalances;

  let trader = null, side = null, tokenAmount = 0, solAmount = 0;
  for (const [owner, dTok] of owners) {
    if (Math.abs(dTok) < 1e-9) continue;
    const idx = accountKeys.indexOf(owner);
    if (idx < 0) continue;
    const dSol = (postSol[idx] - preSol[idx]) / 1e9;
    if (dTok > 0 && dSol < 0) { trader = owner; side = "buy"; tokenAmount = dTok; solAmount = -dSol; break; }
    if (dTok < 0 && dSol > 0) { trader = owner; side = "sell"; tokenAmount = -dTok; solAmount = dSol; break; }
  }
  if (!trader) return null;
  return {
    signature,
    timestamp: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
    side, solAmount, tokenAmount, trader, source: null,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- boot ----------
server.listen(PORT, () => {
  console.log(`\n[HIVE] http://localhost:${PORT}`);
  console.log(`[HIVE] RPC: ${maskUrl(RPC_URL)}`);
  console.log(`[HIVE] Enhanced parsing: ${ENHANCED_URL ? "ON (Helius)" : "OFF (fallback)"}\n`);
});

function maskUrl(u) {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch { return "***"; }
}

process.on("SIGINT", () => { console.log("\n[HIVE] shutting down"); process.exit(0); });
