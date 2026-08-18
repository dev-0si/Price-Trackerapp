// Crypto Worker — hosts the CryptoTracker Durable Object.
// Sub-step 4: adds OKX fallback (replacing Binance — Binance actively blocks
// Cloudflare Workers' network, confirmed via testing, so it can't be used).
// On MEXC disconnect/error, automatically switches to OKX.
// Visit the URL with ?forcefallback=1 to manually trigger a switch for
// testing, without waiting for a real MEXC outage.
// Sub-step 5: adds a /ping route to confirm the Service Binding from the
// Telegram Worker is working, before any real instant-notify logic is added.

const MEXC_WS_URL = "https://contract.mexc.com/edge";
const OKX_WS_URL = "https://ws.okx.com:8443/ws/v5/public";
const PING_INTERVAL_MS = 15000;

// Browser-like headers help avoid Cloudflare's bot-detection rejecting the
// connection before it even reaches OKX's servers.
const FALLBACK_HEADERS = {
  Upgrade: "websocket",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Origin: "https://www.okx.com",
};

function toMexcSymbol(symbol) {
  return symbol.replace(/USDT\.P$/, "_USDT");
}

function toOkxSymbol(symbol) {
  // e.g. "FORMUSDT.P" -> "FORM-USDT-SWAP" (OKX's perpetual swap format)
  return symbol.replace(/USDT\.P$/, "-USDT-SWAP");
}

export class CryptoTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.pingInterval = null;
    this.activeSource = null; // "mexc" | "okx" | null
    this.lastTicks = {};
  }

  async getCryptoSymbols() {
    const { results } = await this.env.DB.prepare(
      `SELECT symbol FROM alerts WHERE asset_type = 'crypto'`
    ).all();
    return results.map(r => r.symbol);
  }

  clearConnection() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.ws = null;
    this.activeSource = null;
  }

  async connectMexc() {
    console.log("Connecting to MEXC (primary)...");
    const resp = await fetch(MEXC_WS_URL, { headers: { Upgrade: "websocket" } });
    const ws = resp.webSocket;
    if (!ws) {
      console.log("MEXC connect failed — falling back to OKX");
      await this.connectOkx();
      return;
    }
    ws.accept();
    this.ws = ws;
    this.activeSource = "mexc";

    ws.addEventListener("message", (event) => this.handleMexcMessage(event));
    ws.addEventListener("close", (event) => {
      console.log("MEXC connection closed:", event.code, event.reason, "— falling back to OKX");
      this.clearConnection();
      this.connectOkx();
    });
    ws.addEventListener("error", (event) => {
      console.log("MEXC websocket error:", event.message || "unknown error", "— falling back to OKX");
      this.clearConnection();
      this.connectOkx();
    });

    const symbols = await this.getCryptoSymbols();
    console.log("[MEXC] Subscribing to:", symbols.join(", ") || "(none tracked)");
    for (const symbol of symbols) {
      ws.send(JSON.stringify({ method: "sub.ticker", param: { symbol: toMexcSymbol(symbol) } }));
    }

    this.startPing();
  }

  async connectOkx() {
    console.log("Connecting to OKX (fallback)...");
    const resp = await fetch(OKX_WS_URL, { headers: FALLBACK_HEADERS });
    const ws = resp.webSocket;
    if (!ws) {
      console.log(`OKX connect also failed — status: ${resp.status} ${resp.statusText}`);
      return;
    }
    ws.accept();
    this.ws = ws;
    this.activeSource = "okx";

    ws.addEventListener("message", (event) => this.handleOkxMessage(event));
    ws.addEventListener("close", (event) => {
      console.log("OKX connection closed:", event.code, event.reason);
      this.clearConnection();
    });
    ws.addEventListener("error", (event) => {
      console.log("OKX websocket error:", event.message || "unknown error");
    });

    const symbols = await this.getCryptoSymbols();
    console.log("[OKX] Subscribing to:", symbols.map(toOkxSymbol).join(", ") || "(none tracked)");
    for (const symbol of symbols) {
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{ channel: "tickers", instId: toOkxSymbol(symbol) }],
      }));
    }

    this.startPing();
  }

  startPing() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (this.activeSource === "mexc") {
        this.ws.send(JSON.stringify({ method: "ping" }));
      } else if (this.activeSource === "okx") {
        // OKX expects a plain text "ping" (not JSON) roughly every 30s of
        // idle time, and replies with a plain text "pong".
        this.ws.send("ping");
      }
    }, PING_INTERVAL_MS);
  }

  handleMexcMessage(event) {
    try {
      const msg = JSON.parse(event.data);
      if (msg.channel === "push.ticker" && msg.data) {
        const { symbol, lastPrice } = msg.data;
        this.lastTicks[symbol] = lastPrice;
        console.log(`[MEXC tick] ${symbol}: ${lastPrice}`);
      }
    } catch (err) {
      // subscribe confirmations / pongs — ignore
    }
  }

  handleOkxMessage(event) {
    try {
      if (event.data === "pong") return;
      const msg = JSON.parse(event.data);
      if (msg.arg && msg.arg.channel === "tickers" && msg.data && msg.data[0]) {
        const { instId, last } = msg.data[0];
        this.lastTicks[instId] = last;
        console.log(`[OKX tick] ${instId}: ${last}`);
      }
    } catch (err) {
      // subscribe confirmations — ignore
    }
  }

  // Adds or removes a single symbol's live subscription on whichever feed
  // is currently active, without dropping/rebuilding the whole connection.
  // Sub-step 5, piece 2 — called via the /notify route (and the
  // ?testnotify= manual test route) below.
  updateSubscription(action, symbol) {
    if (!this.ws || this.ws.readyState !== 1 || !this.activeSource) {
      console.log(`[notify] No active connection — ${action} for ${symbol} will apply on next reconnect`);
      return { ok: true, note: "No active connection right now; will apply on next reconnect." };
    }

    if (this.activeSource === "mexc") {
      const mexcSymbol = toMexcSymbol(symbol);
      const method = action === "add" ? "sub.ticker" : "unsub.ticker";
      this.ws.send(JSON.stringify({ method, param: { symbol: mexcSymbol } }));
      console.log(`[notify][MEXC] ${action}: ${mexcSymbol}`);
    } else if (this.activeSource === "okx") {
      const okxSymbol = toOkxSymbol(symbol);
      const op = action === "add" ? "subscribe" : "unsubscribe";
      this.ws.send(JSON.stringify({ op, args: [{ channel: "tickers", instId: okxSymbol }] }));
      console.log(`[notify][OKX] ${action}: ${okxSymbol}`);
    }

    if (action === "remove") {
      // Clean up any stored tick under either exchange's naming scheme.
      delete this.lastTicks[toMexcSymbol(symbol)];
      delete this.lastTicks[toOkxSymbol(symbol)];
    }

    return { ok: true, activeSource: this.activeSource };
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Real route — the Telegram Worker will call this via the Service
    // Binding once piece 3 is wired up. Expects JSON body:
    // { "action": "add" | "remove", "symbol": "ETHUSDT.P" }
    if (request.method === "POST" && url.pathname === "/notify") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      const { action, symbol } = body || {};
      if (!symbol || (action !== "add" && action !== "remove")) {
        return new Response("Expected { action: 'add'|'remove', symbol: 'SYMBOL' }", { status: 400 });
      }
      const result = this.updateSubscription(action, symbol);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Manual test route — try e.g. ?testnotify=add:ETHUSDT.P or
    // ?testnotify=remove:ETHUSDT.P directly in the browser, no Telegram or
    // Service Binding needed. Useful for testing this piece on its own.
    if (url.searchParams.get("testnotify")) {
      const [action, symbol] = url.searchParams.get("testnotify").split(":");
      const result = this.updateSubscription(action, symbol);
      return new Response(`Test notify result: ${JSON.stringify(result)}`, { status: 200 });
    }

    if (url.searchParams.get("forcefallback") === "1") {
      console.log("Manual test trigger: forcing fallback to OKX");
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
      }
      this.clearConnection();
      await this.connectOkx();
      return new Response(`Forced fallback triggered. Active source: ${this.activeSource}`, { status: 200 });
    }

    if (!this.ws || this.ws.readyState !== 1) {
      await this.connectMexc();
    }

    const ticks = Object.entries(this.lastTicks)
      .map(([symbol, price]) => `${symbol}: ${price}`)
      .join("\n") || "No ticks received yet.";

    return new Response(
      `CryptoTracker Durable Object: alive\nActive source: ${this.activeSource}\n\nLatest ticks:\n${ticks}`,
      { status: 200 }
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simple test route — used to confirm the Service Binding from the
    // Telegram Worker can reach this Worker, before any real logic is added.
    if (url.pathname === "/ping") {
      return new Response("pong from Crypto Worker", { status: 200 });
    }

    const id = env.CRYPTO_DO.idFromName("main");
    const stub = env.CRYPTO_DO.get(id);
    return stub.fetch(request);
  },
};
