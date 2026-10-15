// Sender push-varsel til dei som er på vakt. Køyrer i GitHub Actions (sjå .github/workflows/varsel.yml).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import webpush from "web-push";

const TZ = "Europe/Oslo";
const APP_URL = "https://kristoffertungesvik-stack.github.io/krambua-oppgaver/";
const DATA = "data";

// Kvart tidspunkt har to cron-linjer (sommartid/vintertid). Linja som ikkje passar dagens tidssone, gjer ingenting.
const CRON = {
  "55 7 * * *":  { slot: "10:00", off: 120 }, "55 8 * * *":  { slot: "10:00", off: 60 },
  "55 9 * * *":  { slot: "12:00", off: 120 }, "55 10 * * *": { slot: "12:00", off: 60 },
  "25 14 * * *": { slot: "16:30", off: 120 }, "25 15 * * *": { slot: "16:30", off: 60 },
  "55 15 * * *": { slot: "19:00", off: 120 }, "55 16 * * *": { slot: "19:00", off: 60 },
};

function osloParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(d).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  const utc = new Date(d.toISOString().slice(0, 16) + "Z");
  const loc = new Date(`${date}T${p.hour === "24" ? "00" : p.hour}:${p.minute}Z`);
  return { date, dow, hm: `${p.hour}:${p.minute}`, off: Math.round((loc - utc) / 60000) };
}
const mins = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

const SLOTS = {
  "10:00": { vakt: "dag",   title: "God morgon! ☀️",            body: n => n ? `Sjå gjennom dagens oppgåver – ${n} på dagvakta i dag.` : "Sjå gjennom dagens oppgåver i appen.", skipIfDone: false },
  "12:00": { vakt: "dag",   title: "Hugs å krysse av ✅",        body: n => `${n} ${n === 1 ? "oppgåve står" : "oppgåver står"} att på dagvakta. Kryss av det du har gjort.`, skipIfDone: true },
  "16:30": { vakt: "kveld", title: "Velkomen på kveldsvakt 👋",  body: n => n ? `Sjå gjennom kveldens oppgåver – ${n} i kveld.` : "Sjå gjennom kveldens oppgåver i appen.", skipIfDone: false },
  "19:00": { vakt: "kveld", title: "Hugs å krysse av ✅",        body: n => `${n} ${n === 1 ? "oppgåve står" : "oppgåver står"} att i kveld. Kryss av det du har gjort.`, skipIfDone: true },
};

function remaining(date, dow, vakt) {
  const t = readJSON(path.join(DATA, "oppgaver.json")); if (!t) return null;
  const done = (readJSON(path.join(DATA, `${date}.json`)) || {}).done || {};
  const all = [...((t.daily || {}).tasks || []), ...(((t.week || {})[dow] || {}).tasks || [])];
  const mine = all.filter(x => !x.vakt || x.vakt === vakt);
  return mine.filter(x => !done[x.id]).length;
}

async function main() {
  const now = osloParts(process.env.NOW ? new Date(process.env.NOW) : new Date());   // NOW kan setjast ved testing
  const sched = process.env.SCHEDULE || "";
  const testId = (process.env.TEST || "").trim();
  let slot = (process.env.SLOT || "").trim();
  if (sched) {
    const c = CRON[sched];
    if (!c) return console.log("Ukjend cron:", sched);
    if (c.off !== now.off) return console.log(`Hoppar over ${sched}: tidssona er no UTC+${now.off / 60}.`);
    slot = c.slot;
    // Køyringa startar nokre minutt før; vent til rett klokkeslett.
    const wait = (mins(slot) - mins(now.hm)) * 60000;
    if (wait > 0 && wait < 10 * 60000) { console.log(`Ventar ${Math.round(wait / 1000)} s til ${slot}`); await new Promise(r => setTimeout(r, wait)); }
    if (mins(now.hm) - mins(slot) > 75) return console.log("For seint (GitHub-forseinking) – sender ikkje.");
  }

  webpush.setVapidDetails("mailto:krissi0507@icloud.com", process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  const subsDir = path.join(DATA, "push");
  const subs = fs.existsSync(subsDir) ? fs.readdirSync(subsDir).filter(f => f.endsWith(".json")).map(f => ({ f: path.join(subsDir, f), ...readJSON(path.join(subsDir, f)) })).filter(s => s.sub && s.id) : [];

  let targets, payload;
  if (testId) {
    targets = subs.filter(s => testId === "alle" || s.id === testId);
    payload = { title: "Testvarsel frå Krambua", body: "Varsla verkar! 🎉", url: APP_URL };
  } else {
    const S = SLOTS[slot]; if (!S) return console.log("Ukjent tidspunkt:", slot);
    const vakter = (readJSON(path.join(DATA, "vakter.json")) || {}).vakter || {};
    const today = vakter[now.date] || [];
    const t = mins(slot);
    const onShift = new Set(today.filter(v => mins(v.fra) <= t && t < mins(v.til)).map(v => v.id));
    const n = remaining(now.date, now.dow, S.vakt);
    if (S.skipIfDone && n === 0) return console.log("Alt er gjort – ingen påminning.");
    targets = subs.filter(s => onShift.has(s.id));
    payload = { title: S.title, body: S.body(n), url: APP_URL };
    console.log(`${now.date} ${slot}: på vakt ${[...onShift].join(", ") || "ingen"} · ${n} att · ${targets.length} einingar`);
  }

  let gone = 0;
  for (const s of targets) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" }); console.log("Sendt til", s.id); }
    catch (e) {
      console.log("Feil for", s.id, e.statusCode || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) { fs.unlinkSync(s.f); gone++; }   // eininga har slått av varsel
    }
  }
  if (gone) {
    execSync('git config user.name "Krambua-varsel" && git config user.email "varsel@users.noreply.github.com"');
    try { execSync(`git add -A ${subsDir} && git commit -m "Fjerna ${gone} utgått(e) varsel-abonnement" && (git push || (git pull --rebase && git push))`, { stdio: "inherit" }); }
    catch (e) { console.log("Klarte ikkje å lagre oppryddinga – prøver igjen neste gong."); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
