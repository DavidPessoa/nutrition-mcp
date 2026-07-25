// Local MCP Apps host harness for widget development.
//
//   bun run scripts/widget-harness.ts            # then open http://localhost:8787
//
// Mimics a STRICT host: it validates the ui/initialize request shape, withholds
// the tool result until the app sends ui/notifications/initialized, starts the
// iframe deliberately SHORT so a missing size-changed report shows up as a
// clipped widget, and — unlike anything else we have — answers app-initiated
// tools/call so a widget's server round-trip can be exercised offline.
//
// Query parameters let you reproduce host behaviours that are otherwise only
// observable in production:
//
//   ?serverTools=0      withhold hostCapabilities.serverTools
//   ?tools=0            accept tools/call but never answer (tests timeouts)
//   ?delay=3000         delay every tools/call, standing in for an approval prompt
//   ?maxHeight=600      impose hostContext.containerDimensions.maxHeight
//   ?fail=1             answer tools/call with a JSON-RPC error
//
// Nothing here is served by the production app; scripts/ is dev-only.

import { getWidgetHtml, WIDGET_TEMPLATES } from "../src/widgets.js";

const PORT = Number(process.env.HARNESS_PORT ?? 8787);
const KEYS = Object.keys(WIDGET_TEMPLATES);

function indexPage(): string {
    const links = KEYS.map(
        (k) =>
            `<li><a href="/host?widget=${encodeURIComponent(k)}">${k}</a></li>`,
    ).join("");
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Widget harness</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:32px;max-width:760px}
  code{background:#eee;padding:1px 4px;border-radius:3px}
  li{margin:4px 0}
</style></head>
<body>
  <h1>MCP Apps widget harness</h1>
  <p>Pick a widget. Append query flags to simulate host behaviour:
     <code>?serverTools=0</code>, <code>?tools=0</code>, <code>?delay=3000</code>,
     <code>?maxHeight=600</code>, <code>?fail=1</code>.</p>
  <ul>${links}</ul>
</body></html>`;
}

function hostPage(widget: string, params: URLSearchParams): string {
    const serverTools = params.get("serverTools") !== "0";
    const answerTools = params.get("tools") !== "0";
    const delay = Number(params.get("delay") ?? 0);
    const maxHeight = params.get("maxHeight");
    const failCalls = params.get("fail") === "1";

    // A representative tool result, so widgets that render structuredContent
    // have something to paint.
    const toolResult = {
        date: "2026-01-15",
        totals: {
            calories: 1850,
            protein_g: 120,
            carbs_g: 190,
            fat_g: 62,
            water_ml: 1500,
        },
        has_goals: true,
        goals: {
            calories: 2200,
            protein_g: 140,
            carbs_g: 220,
            fat_g: 70,
            water_ml: 2500,
        },
        meals: [],
    };

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>host: ${widget}</title>
<style>
  body{font:13px/1.5 -apple-system,system-ui,sans-serif;margin:16px}
  #frame{width:100%;height:130px;border:2px solid #888;border-radius:8px;transition:height .15s}
  #log{margin-top:12px;padding:8px;background:#111;color:#0f0;border-radius:6px;
       font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;max-height:300px;overflow:auto}
  .cfg{color:#666}
</style></head>
<body>
  <strong>${widget}</strong>
  <span class="cfg">serverTools=${serverTools} answerTools=${answerTools} delay=${delay}ms${maxHeight ? " maxHeight=" + maxHeight : ""}${failCalls ? " fail=1" : ""}</span>
  <div style="margin-top:8px"><iframe id="frame" sandbox="allow-scripts" src="/widget/${encodeURIComponent(widget)}"></iframe></div>
  <div id="log">host ready — iframe starts at 130px and grows only on size-changed</div>
<script>
const CFG = {
  serverTools: ${serverTools},
  answerTools: ${answerTools},
  delay: ${delay},
  maxHeight: ${maxHeight ? Number(maxHeight) : "null"},
  fail: ${failCalls},
};
const TOOL_RESULT = ${JSON.stringify(toolResult)};
const frame = document.getElementById("frame");
const logEl = document.getElementById("log");
const log = (m) => { logEl.textContent += "\\n" + m; logEl.scrollTop = logEl.scrollHeight; };
let initialized = false;

function send(msg) { frame.contentWindow.postMessage(msg, "*"); }

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;   // what bridge.js should also do
  const d = e.data;
  if (!d || typeof d !== "object") return;

  // ---- ui/initialize (strict: validate the request shape) ----
  if (d.method === "ui/initialize") {
    const p = d.params || {};
    const ok = p.protocolVersion && p.appInfo && p.appCapabilities;
    log("<- ui/initialize " + JSON.stringify(p.appInfo || null));
    if (!ok) {
      log("!! REJECTED: needs protocolVersion + appInfo + appCapabilities " +
          "(clientInfo/capabilities is the MCP-core shape and is wrong here)");
      return;
    }
    const hostContext = { theme: "light" };
    if (CFG.maxHeight) hostContext.containerDimensions = { maxHeight: CFG.maxHeight };
    const hostCapabilities = {};
    if (CFG.serverTools) hostCapabilities.serverTools = {};
    send({ jsonrpc: "2.0", id: d.id, result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "local-harness", version: "1.0.0" },
      hostCapabilities, hostContext,
    }});
    return;
  }

  // ---- required before the host will deliver data ----
  if (d.method === "ui/notifications/initialized") {
    initialized = true;
    log("<- initialized; delivering tool-result");
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
           params: { structuredContent: TOOL_RESULT } });
    return;
  }

  // ---- height reporting ----
  if (d.method === "ui/notifications/size-changed") {
    const h = d.params && d.params.height;
    const capped = CFG.maxHeight ? Math.min(h, CFG.maxHeight) : h;
    frame.style.height = capped + "px";
    log("<- size-changed height=" + h + (capped !== h ? " (capped to " + capped + ")" : ""));
    return;
  }

  // ---- app-initiated tools/call ----
  if (d.method === "tools/call") {
    const name = d.params && d.params.name;
    log("<- tools/call " + name + " (id " + d.id + ")");
    if (!initialized) log("!! app called a tool before the handshake finished");
    if (!CFG.answerTools) { log("   (answerTools=0: dropping, app should time out)"); return; }
    setTimeout(() => {
      if (CFG.fail) {
        send({ jsonrpc: "2.0", id: d.id, error: { code: -32603, message: "harness: simulated failure" } });
        log("-> error for id " + d.id);
      } else {
        send({ jsonrpc: "2.0", id: d.id, result: {
          content: [{ type: "text", text: "harness canned result for " + name }],
          structuredContent: TOOL_RESULT,
        }});
        log("-> result for id " + d.id + (CFG.delay ? " after " + CFG.delay + "ms" : ""));
      }
    }, CFG.delay);
    return;
  }

  log("<- (unhandled) " + JSON.stringify(d).slice(0, 160));
});
</script>
</body></html>`;
}

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/") {
            return new Response(indexPage(), {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }
        if (url.pathname === "/host") {
            const widget = url.searchParams.get("widget") ?? KEYS[0]!;
            if (!KEYS.includes(widget)) {
                return new Response(`unknown widget: ${widget}`, {
                    status: 404,
                });
            }
            return new Response(hostPage(widget, url.searchParams), {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }
        if (url.pathname.startsWith("/widget/")) {
            const key = decodeURIComponent(
                url.pathname.slice("/widget/".length),
            );
            if (!KEYS.includes(key)) {
                return new Response(`unknown widget: ${key}`, { status: 404 });
            }
            // Same CSP the MCP Apps sandbox applies, so a widget that reaches
            // for the network here fails here too.
            return new Response(await getWidgetHtml(key), {
                headers: {
                    "content-type": "text/html; charset=utf-8",
                    "content-security-policy":
                        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
                },
            });
        }
        return new Response("not found", { status: 404 });
    },
});

console.log(`widget harness on http://localhost:${PORT}`);
console.log(`widgets: ${KEYS.join(", ")}`);
