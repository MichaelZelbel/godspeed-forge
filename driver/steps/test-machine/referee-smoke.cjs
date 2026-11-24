// The referee repair's smoke test (2026-11-15, D-419): does the holdout verifier's browser stay alive
// through a real page of the product? It judges nothing about the product: it starts the notebook from
// a built checkout, opens its dashboard in the verifier's own browser setup (the caller sources the
// tools' _lib/browser.sh first, so NODE_PATH and the browser paths are the verifier's), waits, reads how
// much text the page shows, and says whether the browser was still there. Prints one JSON line.
//   node referee-smoke.cjs <built checkout>
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path");
(async () => {
  const target = process.argv[2];
  const out = { ok: false, text_length: 0, error: "", browser: "" };
  let srv, browser;
  const stderr = [];
  try {
    const { chromium } = require("playwright");
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "referee-smoke-"));
    const port = 39000 + Math.floor(Math.random() * 900);
    srv = spawn("node", ["notebook/server/main.mjs"], { cwd: target, env: { ...process.env, GODSPEED_WORKSPACE: ws, GODSPEED_PORT: String(port) }, stdio: "ignore", detached: true });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) throw new Error("the notebook did not start");
    browser = await chromium.launch();
    browser.on("disconnected", () => stderr.push("browser disconnected"));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000));
    out.text_length = await page.evaluate(() => (document.body.innerText || "").trim().length);
    await page.screenshot({ path: path.join(ws, "smoke.png") });
    out.browser = browser.isConnected() ? "alive" : "gone";
    out.ok = out.browser === "alive" && out.text_length > 20;
  } catch (e) { out.error = String(e && e.message || e).split("\n")[0].slice(0, 300); out.browser = browser && browser.isConnected() ? "alive" : "gone"; }
  try { if (browser) await browser.close(); } catch {}
  try { if (srv) process.kill(-srv.pid, "SIGTERM"); } catch {}
  if (stderr.length) out.note = stderr.join("; ");
  console.log(JSON.stringify(out));
  process.exit(0);
})();
