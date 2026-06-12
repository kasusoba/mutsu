// Pure SRT→VTT conversion check (no network). Run:
//   node --experimental-strip-types packages/server/test/vtt.test.mts
import { toVtt } from "../src/subtitles/vtt.ts";

let fails = 0;
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL:"} ${label}`);
  if (!cond) fails++;
};

const srt = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "Hello world",
  "",
  "2",
  "0:04,000 --> 0:05,000",
  "Second line",
  "",
].join("\n");

const vtt = toVtt(srt);
console.log(`--- converted ---\n${vtt}\n-----------------`);
ok("starts with WEBVTT", vtt.startsWith("WEBVTT"));
ok("comma → dot in timestamps", vtt.includes("00:00:01.000 --> 00:00:03.500"));
ok("drops numeric counter lines", !/^\s*1\s*$/m.test(vtt));
ok("keeps cue text", vtt.includes("Hello world") && vtt.includes("Second line"));
ok("pads short timestamps", vtt.includes("00:00:04.000 --> 00:00:05.000"));

// Pass-through: already-VTT input stays VTT (not double-wrapped).
const already = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
ok("passes through existing VTT", toVtt(already) === already);

console.log(fails === 0 ? "\n✅ vtt conversion OK\n" : `\n❌ ${fails} failed\n`);
process.exit(fails === 0 ? 0 : 1);
