export default {
  async fetch(request) {
    return new Response("Price Tracker — Telegram Worker: alive", {
      headers: { "content-type": "text/plain" },
    });
  },
};
