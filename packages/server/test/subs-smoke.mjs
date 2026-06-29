// Live subtitle-proxy smoke test. Needs `pnpm dev:server` running (which loads
// .env keys). Joins a room over WS to establish auth, then exercises the
// member-gated /subs proxy against the real providers.
//
//   node packages/server/test/subs-smoke.mjs "Inception"

const HOST = process.env.MUTSU_HOST ?? "127.0.0.1:8787";
const ROOM = `subs-${process.pid}`;
const SECRET = "s3cret";
const QUERY = process.argv[2] ?? "Inception";

function joinWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}/parties/main/${ROOM}`);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "join", secret: SECRET, name: "tester" })),
    );
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "welcome") resolve(ws);
    });
    ws.addEventListener("error", reject);
    setTimeout(() => reject(new Error("ws join timeout")), 5000);
  });
}

async function proxy(op, payload) {
  const res = await fetch(`http://${HOST}/parties/main/${ROOM}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mutsu-secret": SECRET },
    body: JSON.stringify({ op, ...payload }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  console.log(`\nsubtitle proxy smoke → room ${ROOM}, query "${QUERY}"\n`);
  const ws = await joinWs();
  console.log("[1] joined room over WS (auth established)");

  // Gate check: a request without the secret must be rejected.
  const unauth = await fetch(`http://${HOST}/parties/main/${ROOM}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "subs.search", query: QUERY }),
  });
  console.log(`[2] unauthenticated request → ${unauth.status} (expect 401)`);

  const search = await proxy("subs.search", { query: QUERY, languages: "en" });
  console.log(`[3] search → HTTP ${search.status}`);
  const results = search.json?.results ?? [];
  console.log(`    ${results.length} results`);
  for (const r of results.slice(0, 5)) {
    console.log(`      - [${r.provider}] ${r.title} (${r.language}) ${r.release ?? ""}`);
  }

  if (results[0]) {
    const dl = await proxy("subs.download", { id: results[0].id });
    console.log(`[4] download first result → HTTP ${dl.status}`);
    if (dl.json?.vtt) {
      const head = dl.json.vtt.split("\n").slice(0, 6).join("\n");
      console.log(`    VTT head:\n${head.replace(/^/gm, "      ")}`);
    } else {
      console.log(`    ${JSON.stringify(dl.json)}`);
    }
  }

  ws.close();
  console.log("\n(done)\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n💥", e.message, "\n   (is the dev server running with .env keys?)");
  process.exit(1);
});
