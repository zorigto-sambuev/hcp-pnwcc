


// env
const PORT = process.env.PORT || 8080;           // fly will set this
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const RUNNER_URL = process.env.RUNNER_URL || "wss://api.browsercat.com/connect"; // e.g. your Browsercat project run URL
const RUNNER_AUTH = process.env.RUNNER_AUTH || "fL5IbzX0DX0Sy3AmC1SKohZFdLvraQxjzQxzUgklXW4k7fCCXM4ptxC0rGTe5I8l";// e.g. "Bearer <api-key>" or leave blank

const app = express();
app.use(express.json({ limit: "1mb" }));

// basic health check
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// webhook endpoint
app.post("/", async (req, res) => {
  try {
    // 1) simple auth via shared secret header
    const sig = req.header("X-Webhook-Secret");
    if (!WEBHOOK_SECRET || sig !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // 2) basic payload sanity check (accept anything JSON-y)
    const payload = req.body || {};
    console.log("[webhook] received:", JSON.stringify(payload).slice(0, 2000));

    // 3) optionally forward to your runner
    if (!RUNNER_URL) {
      // no runner set yet — just acknowledge
      return res.status(200).json({ status: "received (no RUNNER_URL set)" });
    }

    // forward with a timeout
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);

    const headers = { "content-type": "application/json" };
    if (RUNNER_AUTH) headers["authorization"] = RUNNER_AUTH;

    const r = await fetch(RUNNER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch((err) => {
      // make aborts explicit
      throw new Error(`runner fetch failed: ${err.message || String(err)}`);
    });

    clearTimeout(t);

    const text = await r.text().catch(() => "");
    const out = (text && safeJson(text)) || { status: r.status, text };

    if (!r.ok) {
      console.error("[runner] non-200:", r.status, text?.slice(0, 500));
      return res.status(502).json({ error: "runner_error", details: out });
    }

    return res.status(200).json({ ok: true, runner: out });
  } catch (err) {
    console.error("[webhook] error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`[webhook] listening on ${PORT}`);
});
