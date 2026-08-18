// FX pairs are 6-letter symbols like GBPUSD (no ".P" suffix, unlike crypto perps).
function isFxSymbol(symbol) {
  return /^[A-Z]{6}$/.test(symbol);
}

// "GBPUSD" -> "GBP/USD" (Twelve Data's forex symbol format)
function toTwelveDataSymbol(symbol) {
  return symbol.slice(0, 3) + "/" + symbol.slice(3);
}

// "GBPUSD" -> "OANDA:GBP_USD" (Finnhub's forex symbol format)
function toFinnhubSymbol(symbol) {
  return "OANDA:" + symbol.slice(0, 3) + "_" + symbol.slice(3);
}

const REST_POLL_INTERVAL_MS = 30000; // well under Twelve Data's 8-calls/min cap
const TIINGO_RETRY_INTERVAL_MS = 90000; // how often we try to recover Tiingo while on fallback

export class FxDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.trackedPairs = [];
    this.latestTicks = {};
    this.tiingoSocket = null;
    this.feedStatus = "not connected";
    this.activeSource = null; // "tiingo" | "twelvedata" | "finnhub" | null
    this.restPollInterval = null;
    this.tiingoRetryInterval = null;

    this.state.blockConcurrencyWhile(async () => {
      await this.loadTrackedPairs();
      await this.connectTiingo();
    });
  }

  async loadTrackedPairs() {
    const { results } = await this.env.DB.prepare(
      "SELECT DISTINCT symbol FROM alerts"
    ).all();

    this.trackedPairs = results
      .map((row) => row.symbol)
      .filter(isFxSymbol);

    console.log("FX DO loaded tracked pairs:", this.trackedPairs);
  }

  async connectTiingo() {
    try {
      const resp = await fetch("https://api.tiingo.com/fx", {
        headers: { Upgrade: "websocket" }
      });

      const ws = resp.webSocket;
      if (!ws) {
      }

      ws.accept();
      this.tiingoSocket = ws;
      this.activeSource = "tiingo";
      this.feedStatus = "tiingo connecting";

      // Recovered — stop polling REST and stop trying to reconnect, the
      // live socket is doing the job again.
      this.stopRestFallback();
      this.stopTiingoRetry();

      ws.addEventListener("message", (event) => {
        this.handleTiingoMessage(event.data);
      });

      ws.addEventListener("close", () => {
        this.feedStatus = "tiingo closed";
        console.log("Tiingo socket closed — starting REST fallback");
        this.tiingoSocket = null;
        this.activeSource = null;
        this.startRestFallback();
      });

      ws.addEventListener("error", (err) => {
        this.feedStatus = "tiingo error";
        console.log("Tiingo socket error:", err.message || "unknown error", "— starting REST fallback");
        this.tiingoSocket = null;
        this.activeSource = null;
        this.startRestFallback();
      });

      // Subscribe once the socket is open. If there are no tracked pairs
      // yet, we still subscribe with an empty list so the connection is
      // proven alive — real pairs get added via the instant-notify pattern
      // in sub-step 5.
      const subscribeMsg = {
        eventName: "subscribe",
        authorization: this.env.TIINGO_API_TOKEN,
        eventData: {
          thresholdLevel: 5,
          tickers: this.trackedPairs.map((p) => p.toLowerCase())
        }
      };
      ws.send(JSON.stringify(subscribeMsg));
    } catch (err) {
      this.feedStatus = "tiingo connect exception: " + err.message;
      console.log(this.feedStatus, "— starting REST fallback");
      this.startRestFallback();
    }
  }

  updateSubscription(action, symbol) {
    const lower = symbol.toLowerCase();

    if (action === "add" && !this.trackedPairs.includes(symbol)) {
      this.trackedPairs.push(symbol);
    } else if (action === "remove") {
      this.trackedPairs = this.trackedPairs.filter((p) => p !== symbol);
      delete this.latestTicks[symbol.toLowerCase()];
    }

    if (this.activeSource === "tiingo" && this.tiingoSocket && this.tiingoSocket.readyState === 1) {
      const msg = {
        eventName: action === "add" ? "subscribe" : "unsubscribe",
        authorization: this.env.TIINGO_API_TOKEN,
        eventData: { thresholdLevel: 5, tickers: [lower] }
      };
      this.tiingoSocket.send(JSON.stringify(msg));
      console.log(`[notify][Tiingo] ${action}: ${lower}`);
      return { ok: true, note: `${action} sent to Tiingo live socket` };
    }

    console.log(`[notify] Not on live Tiingo socket (source: ${this.activeSource}) — ${action} for ${symbol} queued via trackedPairs, will apply on next Tiingo (re)connect or REST poll`);
    return { ok: true, note: "Queued via trackedPairs; will apply on next reconnect or REST poll" };
  }

  // Sub-step 4 — REST fallback. Tiingo is a WebSocket-only primary; when it's
  // down we poll Twelve Data (primary REST fallback) on an interval, and if
  // Twelve Data itself fails we drop to Finnhub (secondary REST fallback).
  // Unlike crypto's MEXC/OKX (which stays on the fallback until a manual
  // reset), FX auto-recovers: a separate interval keeps retrying the Tiingo
  // WebSocket in the background, and as soon as it reconnects the REST
  // polling stops.
  startRestFallback() {
    if (this.restPollInterval) return; // already running
    this.activeSource = "twelvedata";
    this.feedStatus = "starting REST fallback (twelvedata)";
    this.pollRestFallback();
    this.restPollInterval = setInterval(() => this.pollRestFallback(), REST_POLL_INTERVAL_MS);

    if (!this.tiingoRetryInterval) {
      this.tiingoRetryInterval = setInterval(() => {
        console.log("Retrying Tiingo connection...");
        this.connectTiingo();
      }, TIINGO_RETRY_INTERVAL_MS);
    }
  }

  stopRestFallback() {
    if (this.restPollInterval) {
      clearInterval(this.restPollInterval);
      this.restPollInterval = null;
    }
  }

  stopTiingoRetry() {
    if (this.tiingoRetryInterval) {
      clearInterval(this.tiingoRetryInterval);
      this.tiingoRetryInterval = null;
    }
  }

  async pollRestFallback() {
    if (this.trackedPairs.length === 0) {
      this.feedStatus = `${this.activeSource} fallback (no pairs tracked)`;
      return;
    }
    const twelveDataOk = await this.pollTwelveData();
    if (twelveDataOk) {
      this.activeSource = "twelvedata";
      this.feedStatus = "twelvedata live";
      return;
    }
    console.log("Twelve Data poll failed — all feeds down, will retry next interval");
    this.feedStatus = "all feeds down";
    this.activeSource = null;
  }

  // Twelve Data's /quote endpoint accepts a comma-separated symbol list and
  // returns one object per symbol in a single call, keeping us well under
  // the free tier's 8-calls/minute cap regardless of how many pairs we track.
  // NOTE: Twelve Data's free tier /quote endpoint returns a last traded
  // price, not a true bid/ask spread. We store that same price as both
  // `bid` and `ask` to keep the same shape Tiingo produces — flagging this
  // since Stage 6's alert-firing logic should be aware fallback ticks won't
  // have a real spread.
  async pollTwelveData() {
    try {
      const symbols = this.trackedPairs.map(toTwelveDataSymbol).join(",");
      const resp = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${this.env.TWELVEDATA_API_KEY}`
      );
      if (!resp.ok) {
        console.log("Twelve Data HTTP error:", resp.status, resp.statusText);
        return false;
      }
      const data = await resp.json();

      // Single-symbol requests return one object directly; multi-symbol
      // requests return an object keyed by symbol.
      const entries = this.trackedPairs.length === 1
        ? [[this.trackedPairs[0], data]]
        : this.trackedPairs.map((pair) => [pair, data[toTwelveDataSymbol(pair)]]);

      let gotAny = false;
      for (const [pair, quote] of entries) {
        if (!quote || quote.status === "error" || !quote.close) continue;
        const price = parseFloat(quote.close);
        this.latestTicks[pair.toLowerCase()] = { bid: price, ask: price, receivedAt: Date.now() };
        gotAny = true;
      }
      return gotAny;
    } catch (err) {
      console.log("Twelve Data poll exception:", err.message);
      return false;
    }
  }

  // Finnhub's /quote endpoint is called once per symbol (no documented batch
  // quote endpoint on the free tier). At ~60 calls/minute allowed and this
  // only running while both Tiingo and Twelve Data are down, ~10 pairs every
  // 30s is comfortably inside the limit.
  async pollFinnhub() {
    try {
      let gotAny = false;
      for (const pair of this.trackedPairs) {
        const resp = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(toFinnhubSymbol(pair))}&token=${this.env.FINNHUB_API_KEY}`
        );
        if (!resp.ok) {
          console.log("Finnhub HTTP error for", pair, ":", resp.status, resp.statusText);
          continue;
        }
        const data = await resp.json();
        // Finnhub returns { c: currentPrice, ... }; c === 0 usually means no data.
        if (!data || !data.c) continue;
        this.latestTicks[pair.toLowerCase()] = { bid: data.c, ask: data.c, receivedAt: Date.now() };
        gotAny = true;
      }
      return gotAny;
    } catch (err) {
      console.log("Finnhub poll exception:", err.message);
      return false;
    }
  }

  handleTiingoMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    console.log("Tiingo message:", raw);

    // Tiingo sends a "heartbeat"/"info" message on connect, then
    // "A" (data) messages per tick once subscribed.
    if (msg.messageType === "A" && Array.isArray(msg.data)) {
      const [, ticker, , , bidPrice, , , askPrice] = msg.data;
      const isTracked = this.trackedPairs.some((p) => p.toLowerCase() === ticker);
      if (isTracked) {
        this.latestTicks[ticker] = { bid: bidPrice, ask: askPrice, receivedAt: Date.now() };
        this.feedStatus = "tiingo live";
      } else {
        console.log(`[tiingo] Ignoring untracked tick for ${ticker} (possibly stale unsubscribe)`);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.searchParams.has("testpairs")) {
      return new Response(JSON.stringify(this.trackedPairs), {
        headers: { "content-type": "application/json" }
      });
    }

    if (url.searchParams.has("testticks")) {
      return new Response(
        JSON.stringify({ status: this.feedStatus, activeSource: this.activeSource, ticks: this.latestTicks }),
        { headers: { "content-type": "application/json" } }
      );
    }

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

    // Manual test route — forces a switch to REST fallback without waiting
    // for a real Tiingo outage, same pattern as the Crypto Worker's
    // ?forcefallback=1.
    if (url.searchParams.has("forcefallback")) {
      console.log("Manual test trigger: forcing Finnhub-only fallback (Twelve Data skipped)");
      if (this.tiingoSocket) {
        try { this.tiingoSocket.close(); } catch (e) { }
      }
      this.tiingoSocket = null;
      this.activeSource = null;
      this.skipTwelveDataForTest = true;
      this.startRestFallback();
      return new Response(`Forced Finnhub-only fallback triggered. Active source: ${this.activeSource}`, { status: 200 });
    }

    return new Response("FX Durable Object is alive", { status: 200 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const id = env.FX_DO.idFromName("singleton");
    const stub = env.FX_DO.get(id);
    return stub.fetch(request);
  }
};