// Telegram Worker — webhook handler + command router
// Env bindings expected: DB (D1), TELEGRAM_BOT_TOKEN (secret)

const CRYPTO_PATTERN = /^[A-Z0-9]+USDT\.P$/;
const FX_PATTERN = /^[A-Z]{6}$/;
const TRACK_PROMPT = "Reply with: SYMBOL high: PRICE low: PRICE comment\ne.g. ETHUSDT.P high: 1750 low: 1650 weekly range\n(use only high: or only low: if you just want one side)";

function detectAssetType(symbol) {
  if (CRYPTO_PATTERN.test(symbol)) return "crypto";
  if (FX_PATTERN.test(symbol)) return "fx";
  return null;
}

async function sendMessage(token, chatId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  });
  const body = await res.text();
  console.log("sendMessage status:", res.status, "body:", body);
  return res;
}

async function answerCallbackQuery(token, callbackQueryId, text = "") {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// Sub-step 5, piece 3 — tells the Crypto Worker's Durable Object to
// instantly add/remove a live subscription, via the Service Binding set up
// in piece 1 and the /notify route built in piece 2. FX symbols are
// silently skipped since the FX Worker doesn't exist yet. If this call
// fails for any reason, we don't let it break the Telegram flow — the D1
// write already succeeded, and the DO will pick up the change on its next
// natural reconnect regardless.
async function notifyCrypto(env, action, symbol) {
  try {
    const resp = await env.CRYPTO_WORKER.fetch("https://internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, symbol }),
    });
    const text = await resp.text();
    console.log(`notifyCrypto(${action}, ${symbol}):`, resp.status, text);
  } catch (err) {
    console.log(`notifyCrypto(${action}, ${symbol}) failed:`, err.message);
  }
}

async function notifyFx(env, action, symbol) {
  try {
    const resp = await env.FX_WORKER.fetch("https://internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, symbol }),
    });
    const text = await resp.text();
    console.log(`notifyFx(${action}, ${symbol}):`, resp.status, text);
  } catch (err) {
    console.log(`notifyFx(${action}, ${symbol}) failed:`, err.message);
  }
}

async function getActiveSymbols(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.symbol FROM alerts a LEFT JOIN alert_state s ON a.symbol = s.symbol
     WHERE s.status = 'active' OR s.status IS NULL`
  ).all();
  return results.map(r => r.symbol);
}

// Shared logic: given symbol/high/low/note, write to D1 and confirm
async function saveTrack(env, chatId, symbol, high, low, note) {
  symbol = symbol.toUpperCase();
  const assetType = detectAssetType(symbol);
  if (!assetType) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `Warning: "${symbol}" doesn't match expected format. Crypto: BTCUSDT.P — FX: GBPUSD`);
    return;
  }
  if (high === null && low === null) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Set at least one target (high and/or low).");
    return;
  }

  await env.DB.prepare(
    `INSERT INTO alerts (symbol, asset_type, high_target, low_target, note) VALUES (?, ?, ?, ?, ?)`
  ).bind(symbol, assetType, high, low, note).run();

  await env.DB.prepare(
    `INSERT OR REPLACE INTO alert_state (symbol, fire_count, status) VALUES (?, 0, 'active')`
  ).bind(symbol).run();

  if (assetType === "crypto") {
    await notifyCrypto(env, "add", symbol);
  }

  if (assetType === "fx") {
    await notifyFx(env, "add", symbol);
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    `Tracking ${symbol} — High: ${high ?? "—"} Low: ${low ?? "—"}${note ? ` — Note: ${note}` : ""}`);
}

// Parses one-line form: SYMBOL high:NUMBER low:NUMBER note...
// Accepts both "high:1750" and "high: 1750" (space after colon)
function parseOneLineTrack(argsText) {
  // Normalize "high: 123" -> "high:123" and "low: 123" -> "low:123" so a
  // space after the colon doesn't split the keyword from its value.
  const normalized = argsText.replace(/(high|low):\s+(?=[\d.])/gi, "$1:");

  const parts = normalized.trim().split(/\s+/).filter(Boolean);
  const symbol = (parts.shift() || "").toUpperCase();
  let high = null;
  let low = null;
  const noteWords = [];
  for (const part of parts) {
    if (/^high:/i.test(part)) high = parseFloat(part.split(":")[1]);
    else if (/^low:/i.test(part)) low = parseFloat(part.split(":")[1]);
    else noteWords.push(part);
  }
  return { symbol, high, low, note: noteWords.join(" ") || null };
}

// Guided replies use the same high:/low: keyword format as the one-line command —
// parseOneLineTrack (defined below) handles both.

// Parses high:/low:/note WITHOUT a leading symbol — used when editing a
// specific symbol chosen via button, where the symbol is already known.
function parseHighLowNote(argsText) {
  const normalized = argsText.replace(/(high|low):\s+(?=[\d.])/gi, "$1:");
  const parts = normalized.trim().split(/\s+/).filter(Boolean);
  let high = null;
  let low = null;
  const noteWords = [];
  for (const part of parts) {
    if (/^high:/i.test(part)) high = parseFloat(part.split(":")[1]);
    else if (/^low:/i.test(part)) low = parseFloat(part.split(":")[1]);
    else noteWords.push(part);
  }
  return { high, low, note: noteWords.join(" ") || null };
}

async function handleTrack(env, chatId, argsText) {
  if (!argsText.trim()) {
    // No args given — start guided flow via force_reply
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, TRACK_PROMPT, {
      reply_markup: { force_reply: true },
    });
    return;
  }
  const { symbol, high, low, note } = parseOneLineTrack(argsText);
  if (!symbol) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /track SYMBOL high:PRICE low:PRICE note");
    return;
  }
  await saveTrack(env, chatId, symbol, high, low, note);
}

async function handleEditMenu(env, chatId) {
  const symbols = await getActiveSymbols(env);
  if (!symbols.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No active symbols to edit.");
    return;
  }
  const inline_keyboard = symbols.map(s => [{ text: s, callback_data: `edit:${s}` }]);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Select a symbol to edit:", {
    reply_markup: { inline_keyboard },
  });
}

async function handleRemoveMenu(env, chatId) {
  const symbols = await getActiveSymbols(env);
  if (!symbols.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No active symbols to remove.");
    return;
  }
  const inline_keyboard = symbols.map(s => [{ text: s, callback_data: `remove:${s}` }]);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Select a symbol to remove:", {
    reply_markup: { inline_keyboard },
  });
}

async function handleList(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT a.symbol, a.asset_type, a.high_target, a.low_target, a.note, s.fire_count
     FROM alerts a LEFT JOIN alert_state s ON a.symbol = s.symbol
     WHERE s.status = 'active' OR s.status IS NULL`
  ).all();

  if (!results.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No active symbols tracked.");
    return;
  }
  const lines = results.map(r =>
    `${r.symbol} — High: ${r.high_target ?? "—"} Low: ${r.low_target ?? "—"}${r.note ? ` — ${r.note}` : ""}`
  );
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, lines.join("\n"));
}

async function handleRemove(env, chatId, argsText) {
  const symbol = argsText.trim().toUpperCase();
  if (!symbol) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /remove SYMBOL");
    return;
  }
  await env.DB.prepare(`DELETE FROM alerts WHERE symbol = ?`).bind(symbol).run();
  await env.DB.prepare(`DELETE FROM alert_state WHERE symbol = ?`).bind(symbol).run();
  if (detectAssetType(symbol) === "crypto") {
    await notifyCrypto(env, "remove", symbol);
  }

  if (detectAssetType(symbol) === "fx") {
    await notifyFx(env, "remove", symbol);
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Removed ${symbol}`);
}

async function handleEdit(env, chatId, argsText) {
  const { symbol, high, low, note } = parseOneLineTrack(argsText);
  if (!symbol) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Usage: /edit SYMBOL high:PRICE low:PRICE note");
    return;
  }
  const existing = await env.DB.prepare(`SELECT * FROM alerts WHERE symbol = ?`).bind(symbol).first();
  if (!existing) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `${symbol} isn't tracked yet.`);
    return;
  }
  await env.DB.prepare(
    `UPDATE alerts SET high_target = ?, low_target = ?, note = ? WHERE symbol = ?`
  ).bind(
    high !== null ? high : existing.high_target,
    low !== null ? low : existing.low_target,
    note !== null ? note : existing.note,
    symbol
  ).run();
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Updated ${symbol}`);
}

async function handleTriggered(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT a.symbol, a.asset_type, s.fire_count, s.last_fired_at
     FROM alert_state s JOIN alerts a ON a.symbol = s.symbol
     WHERE s.status = 'triggered'`
  ).all();
  if (!results.length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "No triggered alerts.");
    return;
  }
  const lines = results.map(r => `${r.symbol} — fired ${r.fire_count}x, last at ${r.last_fired_at}`);
  const inline_keyboard = results.map(r => [{ text: `Clear ${r.symbol}`, callback_data: `cleartrig:${r.symbol}` }]);
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard },
  });
}


async function routeCommand(env, chatId, text) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const argsText = rest.join(" ");
  console.log("routing command:", command, "args:", argsText);

  switch (command.toLowerCase()) {
    case "/track": return handleTrack(env, chatId, argsText);
    case "/list": return handleList(env, chatId);
    case "/remove":
      return argsText.trim() ? handleRemove(env, chatId, argsText) : handleRemoveMenu(env, chatId);
    case "/edit":
      return argsText.trim() ? handleEdit(env, chatId, argsText) : handleEditMenu(env, chatId);
    case "/triggered": return handleTriggered(env, chatId);
    default:
      return sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Commands: /track /list /remove /edit /triggered");
  }
}

function formatPrice(symbol, price) {
  if (price === undefined || price === null || isNaN(price)) return "N/A";
  const num = Number(price);

  // FX: JPY pairs get 3 decimals, other FX pairs get 5
  if (/^[A-Z]{6}$/.test(symbol)) {
    return symbol.includes("JPY") ? num.toFixed(3) : num.toFixed(5);
  }

  // Crypto: scale decimals to price magnitude
  if (num >= 100) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      // Test route — confirms the Service Binding to the Crypto Worker
      // works, before any real instant-notify logic is added.
      if (url.searchParams.get("testbinding") === "1") {
        const resp = await env.CRYPTO_WORKER.fetch("https://internal/ping");
        const text = await resp.text();
        return new Response(`Crypto Worker responded: ${text}`, { status: 200 });
      }
      return new Response("Price Tracker — Telegram Worker: alive", { status: 200 });
    }

    if (url.pathname === "/alert-fire") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      const { symbol, price, fireCount, triggeredSide, triggeredTarget, note } = body || {};
      if (!symbol || price === undefined) {
        return new Response("Expected { symbol, price, fireCount }", { status: 400 });
      }

      console.log(`[alert-fire] ${symbol} @ ${price} (fire ${fireCount}/5)`);

      const formattedPrice = formatPrice(symbol, price);
      const formattedTarget = formatPrice(symbol, triggeredTarget);

      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        `🔔 <b>${symbol}</b> alert triggered\n${triggeredSide}: ${formattedTarget}\nCurrent Price: ${formattedPrice}\nFire count: ${fireCount}/5${note ? `\nNote: ${note}` : ""}`
      );

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.pathname === "/feed-status") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      const { source, status } = body || {};
      const emoji = status === "down" ? "🔴" : "🟢";
      const label = status === "down" ? "feed is DOWN (both providers failed)" : "feed has RECOVERED";

      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        `${emoji} <b>${source.toUpperCase()}</b> ${label}`
      );

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    try {
      const update = await request.json();
      console.log("incoming update:", JSON.stringify(update));

      // Handle button taps
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message.chat.id;
        const [action, symbol] = cq.data.split(":");

        if (action === "remove") {
          await env.DB.prepare(`DELETE FROM alerts WHERE symbol = ?`).bind(symbol).run();
          await env.DB.prepare(`DELETE FROM alert_state WHERE symbol = ?`).bind(symbol).run();
          if (detectAssetType(symbol) === "crypto") {
            await notifyCrypto(env, "remove", symbol);
          }

          if (detectAssetType(symbol) === "fx") {
            await notifyFx(env, "remove", symbol);
          }

          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, `Removed ${symbol}`);
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Removed ${symbol}`);
        } else if (action === "cleartrig") {
          await env.DB.prepare(`DELETE FROM alerts WHERE symbol = ?`).bind(symbol).run();
          await env.DB.prepare(`DELETE FROM alert_state WHERE symbol = ?`).bind(symbol).run();
          if (detectAssetType(symbol) === "crypto") {
            await notifyCrypto(env, "remove", symbol);
          }

          if (detectAssetType(symbol) === "fx") {
            await notifyFx(env, "remove", symbol);
          }

          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, `Cleared ${symbol}`);
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Cleared ${symbol} — deleted entirely`);
        } else if (action === "edit") {
          const existing = await env.DB.prepare(`SELECT * FROM alerts WHERE symbol = ?`).bind(symbol).first();
          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id);
          await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
            `Editing ${symbol} — current High: ${existing?.high_target ?? "—"} Low: ${existing?.low_target ?? "—"}\nReply with: high: PRICE low: PRICE comment`,
            { reply_markup: { force_reply: true } });
        }
        return new Response("ok");
      }

      const message = update.message;
      if (!message || !message.text) {
        return new Response("ok");
      }

      // Check if this message is a reply to an edit prompt (from button flow)
      const editMatch = message.reply_to_message?.text?.match(/^Editing (\S+) —/);
      if (editMatch) {
        const symbol = editMatch[1];
        const existing = await env.DB.prepare(`SELECT * FROM alerts WHERE symbol = ?`).bind(symbol).first();
        if (!existing) {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, message.chat.id, `${symbol} no longer exists.`);
          return new Response("ok");
        }
        const { high, low, note } = parseHighLowNote(message.text);
        await env.DB.prepare(
          `UPDATE alerts SET high_target = ?, low_target = ?, note = ? WHERE symbol = ?`
        ).bind(
          high !== null ? high : existing.high_target,
          low !== null ? low : existing.low_target,
          note !== null ? note : existing.note,
          symbol
        ).run();
        await sendMessage(env.TELEGRAM_BOT_TOKEN, message.chat.id, `Updated ${symbol}`);
        return new Response("ok");
      }

      // Check if this message is a reply to our guided /track prompt
      const isTrackReply = message.reply_to_message &&
        message.reply_to_message.text &&
        message.reply_to_message.text.startsWith("Reply with: SYMBOL high:");

      if (isTrackReply) {
        const { symbol, high, low, note } = parseOneLineTrack(message.text);
        if (!symbol) {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, message.chat.id, "Didn't catch a symbol — try /track again.");
        } else {
          await saveTrack(env, message.chat.id, symbol, high, low, note);
        }
        return new Response("ok");
      }

      await routeCommand(env, message.chat.id, message.text);
    } catch (err) {
      console.log("ERROR:", err.message, err.stack);
    }

    return new Response("ok");
  },
};
