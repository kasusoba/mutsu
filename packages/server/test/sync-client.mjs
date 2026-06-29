// Throwaway Phase-1 test client (SPEC §15 P1 milestone).
//
// Proves, against a running `partykit dev`:
//   1. two clients converge on the same playback state (sync works)
//   2. the server's single clock projects `time` forward while playing
//   3. host mode drops a non-host's control and snaps them back (SPEC §8)
//   4. the host's own control is accepted
//   5. reconnect → resync snapshot (SPEC §7)
//
// Uses Node 22's native WebSocket — no dependencies. Run the server first:
//   pnpm dev:server         (in one terminal)
//   pnpm test:sync          (in another)

const HOST = process.env.MUTSU_HOST ?? "127.0.0.1:8787";
const ROOM = `test-${process.pid}`;
const SECRET = "s3cret";
const URL = `ws://${HOST}/parties/main/${ROOM}`;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL:"} ${label}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(tag) {
    this.tag = tag;
    this.self = null;
    this.sync = null; // last sync message
    this.members = null; // last members list
    this.gate = null; // last gate message
    this.errors = [];
    this.ws = new WebSocket(URL);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "welcome") this.self = m.self;
      else if (m.type === "sync") this.sync = m;
      else if (m.type === "members") this.members = m.list;
      else if (m.type === "gate") this.gate = m;
      else if (m.type === "error") this.errors.push(m);
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  async join(name) {
    await this.ready;
    this.send({ type: "join", secret: SECRET, name });
    await sleep(150);
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  console.log(`\nmutsu Phase-1 sync test → ${URL}\n`);

  // ── 1. two clients join ──────────────────────────────────────────────────
  console.log("[1] two clients join the same room");
  const a = new Client("A");
  const b = new Client("B");
  await a.join("alice");
  await b.join("bob");
  check("A got a welcome/self id", typeof a.self === "string");
  check("B got a welcome/self id", typeof b.self === "string");
  check("A sees 2 members", a.members?.length === 2);
  check("B sees 2 members", b.members?.length === 2);

  // ── 2. A sets the source + plays; B should converge ──────────────────────
  console.log("\n[2] A sets source and presses play; B converges");
  const SRC = "https://example.test/embed/abc";
  a.send({ type: "setSource", src: SRC });
  await sleep(100);
  a.send({ type: "control", intent: "playing", time: 10 });
  await sleep(150);
  check("B sees the source", b.sync?.src === SRC);
  check("B intent === playing", b.sync?.intent === "playing");
  check("B time >= 10 (projected forward)", (b.sync?.time ?? 0) >= 10);

  // ── 3. single clock advances ─────────────────────────────────────────────
  console.log("\n[3] server clock projects time forward");
  const t1 = b.sync?.time ?? 0;
  await sleep(1200);
  b.send({ type: "resync" });
  await sleep(150);
  const t2 = b.sync?.time ?? 0;
  check(`time advanced over ~1.2s (${t1.toFixed(2)} → ${t2.toFixed(2)})`, t2 > t1 + 0.8);

  // ── 4. host mode drops non-host control ──────────────────────────────────
  console.log("\n[4] host mode: A becomes host, B's control is dropped");
  a.send({ type: "setMode", mode: "host" });
  await sleep(150);
  check("B sees mode === host", b.sync?.mode === "host");
  check("B sees hostId === A", b.sync?.hostId === a.self);

  b.send({ type: "control", intent: "paused", time: 0 }); // should be rejected
  await sleep(200);
  check("room intent stayed playing (B was dropped)", a.sync?.intent === "playing");
  check("B was snapped back to playing (corrective sync)", b.sync?.intent === "playing");

  // ── 5. host's own control is accepted ────────────────────────────────────
  console.log("\n[5] host's own control is accepted");
  a.send({ type: "control", intent: "paused", time: 42 });
  await sleep(200);
  check("B sees paused", b.sync?.intent === "paused");
  check("B sees time === 42", Math.abs((b.sync?.time ?? 0) - 42) < 0.5);

  // ── 6. buffer gate: stall soft-pauses, recovery resumes (SPEC §9) ─────────
  console.log("\n[6] buffer gate soft-pauses the room while a member stalls");
  a.send({ type: "control", intent: "playing", time: 5 });
  await sleep(150);
  b.send({ type: "status", state: "stalled" });
  await sleep(150);
  check("gate engaged (paused)", b.gate?.paused === true);
  check("gate waiting on B", b.gate?.waitingFor?.includes(b.self));
  check("intent stays playing (hard state untouched)", a.sync?.intent === "playing");
  a.send({ type: "resync" });
  await sleep(100);
  const frozen = a.sync?.time ?? 0;
  await sleep(800);
  a.send({ type: "resync" });
  await sleep(100);
  check("clock frozen while gated", Math.abs((a.sync?.time ?? 0) - frozen) < 0.2);

  b.send({ type: "status", state: "ready" });
  await sleep(150);
  check("gate cleared after recovery", b.gate?.paused === false);

  // ── 7. manual skip drops a staller from the gate ─────────────────────────
  console.log("\n[7] manual skip releases the gate without moving in-sync members");
  b.send({ type: "status", state: "stalled" });
  await sleep(150);
  check("gate engaged again", a.sync && b.gate?.paused === true);
  a.send({ type: "skip", memberId: b.self }); // A is host
  await sleep(150);
  check("gate released after skip", b.gate?.paused === false);
  check("B no longer in waitingFor", !b.gate?.waitingFor?.includes(b.self));

  a.send({ type: "control", intent: "paused", time: 42 });
  await sleep(150);

  // ── 8. reconnect → resync snapshot ───────────────────────────────────────
  console.log("\n[8] reconnect gets a fresh snapshot");
  b.close();
  await sleep(150);
  const b2 = new Client("B2");
  await b2.join("bob");
  check("reconnected client sees the source", b2.sync?.src === SRC);
  check("reconnected client sees paused @42", b2.sync?.intent === "paused");

  a.close();
  b2.close();
  await sleep(100);

  console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n💥 test client crashed:", err.message);
  console.error("   (is the server running?  pnpm dev:server)");
  process.exit(1);
});
