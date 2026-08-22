// Crypto Worker — hosts the CryptoTracker Durable Object.
// Sub-step 4: adds OKX fallback (replacing Binance — Binance actively blocks
// Cloudflare Workers' network, confirmed via testing, so it can't be used).
// On MEXC disconnect/error, automatically switches to OKX.
// Visit the URL with ?forcefallback=1 to manually trigger a switch for
// testing, without waiting for a real MEXC outage.
// Sub-step 5: adds a /ping route to confirm the Service Binding from the
// Telegram Worker is working, before any real instant-notify logic is added.
//
// Watchdog: outbound WebSockets (to MEXC/OKX) cannot use the Hibernation
// API — that only applies to inbound connections accepted by the DO.
// Instead, an Alarm is scheduled every ALARM_INTERVAL_MS to check the
// connection and reconnect immediately if it's dead. This keeps worst-case
// wake latency bounded by ALARM_INTERVAL_MS instead of the DO's natural
// (much longer, unpredictable) idle-eviction window.

const MEXC_WS_URL = "https://contract.mexc.com/edge";
const OKX_WS_URL = "https://ws.okx.com:8443/ws/v5/public";
const PING_INTERVAL_MS = 15000;
const ALARM_INTERVAL_MS = 5000; // watchdog check interval — tune down for tighter latency
const FEED_RECOVERY_CHECK_EVERY_N_ALARMS = 6; // ~30s at 5s alarm interval

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

function fromMexcSymbol(mexcSymbol) {
  return mexcSymbol.replace(/_USDT$/, "USDT.P");
}

function fromOkxSymbol(okxSymbol) {
  return okxSymbol.replace(/-USDT-SWAP$/, "USDT.P");
}

export class CryptoTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.pingInterval = null;
    this.activeSource = null;
    this.lastTicks = {};
    this.alarmTickCount = 0;
    this.feedDown = false;
    this.state.blockConcurrencyWhile(async () => {
      await this.loadAlertTargets();
      // Make sure the watchdog alarm is running. If one is already
      // scheduled this is a cheap no-op-ish overwrite; if the DO was just
      // created or the alarm was somehow cleared, this (re)starts it.
      const currentAlarm = await this.state.storage.getAlarm();
      if (!currentAlarm) {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
    });
  }

  async getCryptoSymbols() {
    const { results } = await this.env.DB.prepare(
      `SELECT symbol FROM alerts WHERE asset_type = 'crypto'`
    ).all();
    return results.map(r => r.symbol);
  }

  async loadAlertTargets() {
    const { results } = await this.env.DB.prepare(
      `SELECT a.symbol, a.high_target, a.low_target, a.note, s.fire_count, s.status
     FROM alerts a LEFT JOIN alert_state s ON a.symbol = s.symbol
     WHERE a.asset_type = 'crypto'`
    ).all();

    this.alertTargets = {};
    for (const row of results) {
      this.alertTargets[row.symbol] = {
        high: row.high_target,
        low: row.low_target,
        note: row.note,
        fireCount: row.fire_count ?? 0,
        status: row.status ?? "active"
      };
    }
    console.log("Crypto DO loaded alert targets:", this.alertTargets);
  }

  async notifyFeedStatus(source, status) {
    this.state.waitUntil(
      this.env.TELEGRAM_WORKER.fetch("https://internal/feed-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, status })
      }).catch((err) => console.log("feed-status push failed:", err.message))
    );
  }

  async checkAlert(symbolUpper, price) {
    console.log("[checkAlert]", symbolUpper, "price:", price, "target:", JSON.stringify(this.alertTargets?.[symbolUpper])); // TEMP DEBUG
    const t = this.alertTargets?.[symbolUpper];
    if (!t || t.status === "triggered") return;

    const highBreached = t.high !== null && price >= t.high;
    const lowBreached = t.low !== null && price <= t.low;
    if (!highBreached && !lowBreached) return;

    const triggeredSide = highBreached ? "High" : "Low";
    const triggeredTarget = highBreached ? t.high : t.low;

    t.fireCount += 1;
    const newStatus = t.fireCount >= 5 ? "triggered" : "active";
    t.status = newStatus;

    await this.env.DB.prepare(
      `INSERT INTO alert_state (symbol, fire_count, status, last_fired_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET fire_count = ?, status = ?, last_fired_at = ?`
    ).bind(symbolUpper, t.fireCount, newStatus, new Date().toISOString(),
      t.fireCount, newStatus, new Date().toISOString()).run();

    this.state.waitUntil(
      this.env.TELEGRAM_WORKER.fetch("https://internal/alert-fire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: symbolUpper, price, fireCount: t.fireCount, triggeredSide, triggeredTarget, note: t.note })
      }).catch((err) => console.log("alert-fire push failed:", err.message))
    );

    console.log(`[ALERT FIRED] ${symbolUpper} @ ${price} (fire ${t.fireCount}/5)`);
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
    if (this.feedDown) {
      this.feedDown = false;
      await this.notifyFeedStatus("crypto", "recovered");
    }

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
    if (!ws) {
      console.log(`OKX connect also failed — status: ${resp.status} ${resp.statusText}`);
      if (!this.feedDown) {
        this.feedDown = true;
        await this.notifyFeedStatus("crypto", "down");
      }
      return;
    }

    ws.addEventListener("message", (event) => this.handleOkxMessage(event));
    ws.addEventListener("close", (event) => {
      console.log("OKX connection closed:", event.code, event.reason);
      this.clearConnection();
    });
    ws.addEventListener("error", (event) => {
      console.log("OKX websocket error:", event.message || "unknown error");
    });

    const symbols = await this.getCryptoSymbols();
    console.log("[OKX] Subscribing to:", symbols.join(", ") || "(none tracked)");
    ws.send(JSON.stringify({
      op: "subscribe",
      args: symbols.map((symbol) => ({ channel: "tickers", instId: toOkxSymbol(symbol) }))
    }));

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

  // Watchdog — Cloudflare wakes the DO for this on schedule even if it was
  // evicted from memory in between. This is what bounds worst-case
  // reconnect latency to ALARM_INTERVAL_MS instead of an unpredictable
  // idle-eviction window.
  async alarm() {
    console.log("[alarm] Watchdog check — ws state:", this.ws ? this.ws.readyState : "null");
    this.alarmTickCount++;

    if (!this.ws || this.ws.readyState !== 1) {
      console.log("[alarm] Connection dead or missing — reconnecting now");
      this.clearConnection();
      await this.connectMexc();
    } else if (this.activeSource === "okx" && this.alarmTickCount % FEED_RECOVERY_CHECK_EVERY_N_ALARMS === 0) {
      console.log("[alarm] On OKX fallback — probing whether MEXC has recovered");
      await this.connectMexc(); // if MEXC fails again, it falls back to OKX on its own
    }

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  handleMexcMessage(event) {
    try {
      const msg = JSON.parse(event.data);
      if (msg.channel === "push.ticker" && msg.data) {
        const { symbol, lastPrice } = msg.data;
        this.lastTicks[symbol] = lastPrice;
        console.log(`[MEXC tick] ${symbol}: ${lastPrice}`);
        this.checkAlert(fromMexcSymbol(symbol), parseFloat(lastPrice));
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
        this.checkAlert(fromOkxSymbol(instId), parseFloat(last));
      }
    } catch (err) {
      // subscribe confirmations — ignore
    }
  }

  // Adds or removes a single symbol's live subscription on whichever feed
  // is currently active, without dropping/rebuilding the whole connection.
  // Sub-step 5, piece 2 — called via the /notify route (and the
  // ?testnotify= manual test route) below.
  async updateSubscription(action, symbol) {
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

    await this.loadAlertTargets(); // NEW

    if (action === "remove") {
      // Clean up any stored tick under either exchange's naming scheme.
      delete this.lastTicks[toMexcSymbol(symbol)];
      delete this.lastTicks[toOkxSymbol(symbol)];
    }

    return { ok: true, activeSource: this.activeSource };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (!this.ws || this.ws.readyState !== 1) {
      await this.connectMexc();
    }

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
      const result = await this.updateSubscription(action, symbol);
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
      const result = await this.updateSubscription(action, symbol);
      return new Response(`Test notify result: ${JSON.stringify(result)}`, { status: 200 });
    }

    if (url.searchParams.get("forcefallback") === "1") {
      console.log("Manual test trigger: forcing fallback to OKX");
      if (this.ws) {
        try { this.ws.close(); } catch (e) { }
      }
      this.clearConnection();
      await this.connectOkx();
      return new Response(`Forced fallback triggered. Active source: ${this.activeSource}`, { status: 200 });
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
