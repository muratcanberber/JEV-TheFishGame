// JEV — The Fish Game · authoritative multiplayer game server + real-time WebSocket feed
// The simulation runs server-side; AI fish call the TypeSafe Jev (System One) API for
// every decision. Spectators watch a single shared world over one persistent socket.
//
// Run: node server.js  →  http://localhost:8787
// Engine: local laya-mlx bridge (laya-bridge.py) — no external API, no key.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8787;
const MAX_CONCURRENT = 3;          // parallel Jev calls
const W = 1900, H = 1150;          // world size (world units)
const AI_COUNT = 5;                // Jev-controlled fish
const MAX_PLAYERS = 5;             // human player slots
const FOOD_COUNT = 20;             // pellet cap on the map; pellets appear randomly over time
const FOOD_SPAWN_MS = 900;         // pellet spawn cadence
const METAB_DECAY = 0.012;         // energy loss per second
const MASS_DECAY = 0.008;          // base mass loss per second (+ scales with mass)
const MASS_FLOOR = 0.05;           // kg — below this (50 g) a starving fish dies
const AI_COLOR = "#7f95a8";        // players get unique colors

// ── species: every Jev fish has its own species trait ──
const TURLER = {
  piranha: { ad: "Piranha",        ozellik: "Predator — can eat prey almost its own size", renk: "#d9453c", hiz: 1.05, avOrani: 1.05, metabolizma: 1.25, diken: false, gizli: false },
  yilan:   { ad: "Eel",            ozellik: "Agile — swims 35% faster than everyone",      renk: "#3fae6a", hiz: 1.35, avOrani: 1.30, metabolizma: 1.0,  diken: false, gizli: false },
  fener:   { ad: "Anglerfish",     ozellik: "Stealth — unnoticed until someone gets close",renk: "#3c4a6b", hiz: 1.0,  avOrani: 1.30, metabolizma: 1.0,  diken: false, gizli: true },
  mersin:  { ad: "Sturgeon",       ozellik: "Armored — loses mass & energy half as fast",  renk: "#9fb2c8", hiz: 0.9,  avOrani: 1.30, metabolizma: 0.5,  diken: false, gizli: false },
  balon:   { ad: "Pufferfish",     ozellik: "Spiky — completely immune to the mines",      renk: "#e0a13c", hiz: 1.0,  avOrani: 1.30, metabolizma: 1.1,  diken: true,  gizli: false },
};
const SPECIES = [
  { tur: "piranha", mass: 2.2 },
  { tur: "yilan",   mass: 1.8 },
  { tur: "fener",   mass: 3.4 },
  { tur: "mersin",  mass: 4.2 },
  { tur: "balon",   mass: 1.6 },
];
const SPIKE_COUNT = 7;             // mines: touching one makes the fish explode into food

/* ── decision bridge (local laya-mlx) ──────────────────── */
let inFlight = 0;
const waiters = [];
function acquire() {
  return new Promise((res) => {
    if (inFlight < MAX_CONCURRENT) { inFlight++; res(); } else waiters.push(res);
  });
}
function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) { inFlight++; next(); }
}
const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:8791/predict";

// Local laya-mlx bridge: same typed-decision response shape as the old API
function callLaya(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(LAYA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 8000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; if (data.length > 262144) req.destroy(); });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else reject(new Error("HTTP " + res.statusCode));
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── world ─────────────────────────────────────────────── */
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const radiusOf = (m) => 20 * Math.sqrt(m);
const hslHex = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h * 6) % 2 - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h * 6) % 6];
  return "#" + seg.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
};



const fishes = [];
const foods = [];
let foodSeq = 0, fishSeq = 0;
const feed = [];               // recent event log
const decisions = new Map();   // fishId → latest human-readable Q&A
const tokens = new Map();      // token → fishId (players)
const viewers = new Map();     // token → nick (spectators)
let stats = { count: 0, latSum: 0, latN: 0, fallback: 0 };

function spawnFood() {
  foods.push({ id: "y" + (++foodSeq), x: rnd(-W / 2 + 150, W / 2 - 150), y: rnd(-H / 2 + 130, H / 2 - 130) });
}
for (let i = 0; i < FOOD_COUNT; i++) spawnFood();
// yemler rastgele aralıklarla yeniden belirir (yenilen yem yok olur, yenisi başka yerde çıkar)
setInterval(() => {
  if (foods.length < FOOD_COUNT && Math.random() < 0.75) spawnFood();
}, FOOD_SPAWN_MS);

// spikes: fish that touch one explodes into edible pellets
const spikes = [];
function spawnSpikes() {
  spikes.length = 0;
  for (let i = 0; i < SPIKE_COUNT; i++) {
    spikes.push({ x: rnd(-W / 2 + 230, W / 2 - 230), y: rnd(-H / 2 + 180, H / 2 - 180), r: 26 });
  }
}
spawnSpikes();

function makeFish(name, turOrHue, mass, isPlayer) {
  const tur = isPlayer ? null : turOrHue;
  const turBilgi = tur && TURLER[tur];
  const f = {
    id: "b" + (++fishSeq), name,
    _hue: turOrHue,
    tur: tur || null,
    ozellik: turBilgi ? turBilgi.ozellik : null,
    color: isPlayer ? hslHex(Number(turOrHue) || 0.12, 0.8, 0.52) : (turBilgi ? turBilgi.renk : AI_COLOR),
    mass, isPlayer,
    x: rnd(-W / 2 + 150, W / 2 - 150), y: rnd(-H / 2 + 120, H / 2 - 120),
    vx: rnd(-30, 30), vy: rnd(-30, 30), dir: rnd(0, Math.PI * 2),
    mode: "roam", targetId: null, threatId: null, sprint: false,
    alive: true, nextThink: Date.now() + rnd(200, 4000), thinking: false,
    enerji: 0.8,                       // 0-1: düşerse açlık artar, sıfıra yakınsa ölür
    _wa: rnd(0, Math.PI * 2), _threats: [],
    label: null, labelColor: "#9fb6c9", labelAt: 0, arrow: "",
    input: { x: 0, y: 0, down: false, has: false },
  };
  fishes.push(f);
  return f;
}
SPECIES.forEach((s) => makeFish(TURLER[s.tur].ad, s.tur, s.mass, false));

function addFeed(cls, text) {
  feed.unshift({ cls, text, t: Date.now() });
  if (feed.length > 12) feed.pop();
}

/* ── decision engine ───────────────────────────────────── */
const nearOf = (list, f, pred, n) =>
  list.filter(pred).map((o) => ({ o, d: dist(o, f) })).sort((a, b) => a.d - b.d).slice(0, n);
const bearing = (f, o) => {
  const dx = o.x - f.x, dy = o.y - f.y;
  const hx = dx > 40 ? "east" : dx < -40 ? "west" : "";
  const vy = dy > 40 ? "north" : dy < -40 ? "south" : "";
  return (hx + " " + vy).trim() || "on top of it";
};

function buildPayload(f) {
  const foodsNear = nearOf(foods, f, () => true, 3)
    .map(({ o, d }) => ({ id: o.id, distance: Math.round(d), direction: bearing(f, o) }));
  const prey = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * ((f.tur === "piranha") ? 0.95 : 0.8), 2)
    .map(({ o, d }) => ({ id: o.name, size_ratio: +(o.mass / f.mass).toFixed(2), distance: Math.round(d), direction: bearing(f, o) }));
  // Anglerfish stays invisible until someone gets within 330 units
  const threats = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass > f.mass * 1.25 && !(o.tur === "fener" && dist(o, f) > 330), 2)
    .map(({ o, d }) => ({ id: o.name, size_ratio: +(o.mass / f.mass).toFixed(2), distance: Math.round(d), direction: bearing(f, o) }));
  const dangerPct = threats.length ? +clamp(1 - threats[0].distance / 620, 0, 1).toFixed(2) : 0;
  const walls = {
    west: Math.round(f.x + W / 2), east: Math.round(W / 2 - f.x),
    north: Math.round(f.y + H / 2), south: Math.round(H / 2 - f.y),
  };
  const spikesNear = nearOf(spikes, f, () => true, 2)
    .map(({ o, d }) => ({ distance: Math.round(d), direction: bearing(f, o) }));
  const targetCriteria = { none: "No obvious target — roam freely" };
  foodsNear.forEach((y) => targetCriteria[y.id] = `food pellet, ${y.distance} units to the ${y.direction}`);
  prey.forEach((b) => targetCriteria[b.id] = `prey at ${b.size_ratio}x your size, ${b.distance} units to the ${b.direction}`);
  threats.forEach((b) => targetCriteria["flee_" + b.id] = `${b.id} is a threat ${b.distance} units to the ${b.direction}; open distance instead`);
  const aclik = +(1 - f.enerji).toFixed(2);   // 0 = tok, 1 = aç
  return {
    state: {
      me: {
        name: f.name, mass_g: Math.round(f.mass * 1000), role: f.isPlayer ? "player" : "ai",
        hunger_pct: aclik,
        species: f.tur && TURLER[f.tur] ? TURLER[f.tur].ad : null,
        trait: f.ozellik,
      },
      surroundings: {
        foods: foodsNear, prey, threats,
        threat_proximity_pct: dangerPct,
        walls,
        spikes: spikesNear,
      },
    },
    questions: {
      action: {
        type: "choice",
        instructions: "What should the fish in `me` do next? Your drives: eat, survive, avoid being eaten. Use `me.hunger_pct` and the `surroundings` data.",
        criteria: {
          flee: "if `surroundings.threats` is not empty, survive first; if a `surroundings.walls` value is below 200, slide parallel to the wall instead of getting cornered; keep `surroundings.spikes` distance above 200 when picking an escape direction",
          hunt: "if `me.mass_kg` is above 2 and `me.hunger_pct` is above 0.4, you MUST hunt when `surroundings.prey` has targets — pellets cannot sustain a large fish. Otherwise hunt when hunger is above 0.4 and there is no immediate threat/spike risk",
          eat_food: "if `me.hunger_pct` is above 0.35 and `surroundings.foods` has pellets reachable without crossing a spike, eat them",
          roam: "if hunger is low (below 0.35) and there is no prey, food or threat nearby, explore",
        },
      },
      target: {
        type: "choice",
        instructions: "Which object should this move focus on? Pick one id from `surroundings`.",
        criteria: targetCriteria,
      },
      panic: { type: "noul", instructions: "Judging by `surroundings.threats` distances, is this fish threatened enough to speed up?" },
    },
    _meta: { threats },
  };
}

const MODE_TEXT = { flee: "FLEEING", hunt: "HUNTING", eat_food: "SEEKING FOOD", roam: "ROAMING" };
const MODE_SHORT = { flee: "FLEE", hunt: "HUNT", eat_food: "FOOD", roam: "ROAM" };
const MODE_COLOR = { flee: "#ff9c8f", hunt: "#ffc46b", eat_food: "#8fe3a2", roam: "#9fb6c9" };

function arrowFromAngle(ang) {
  const sector = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"][sector];
}

function readableQA(f, req, resp, ms, source) {
  const a = resp.answers || {};
  const qa = [];
  const e = a.action || {};
  qa.push({
    q: "What is your next move?",
    a: MODE_TEXT[e.choice] || e.choice || "–",
    color: MODE_COLOR[e.choice] || "#9fb6c9",
    confidence: e.confidence != null ? Math.round(e.confidence * 100) : null,
    options: e.probabilities ? Object.entries(e.probabilities)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => ({ name: MODE_SHORT[k] || k, pct: Math.round(v * 100) })) : [],
  });
  const h = a.target || {};
  const hint = h.choice && req.questions.target.criteria[h.choice];
  qa.push({
    q: "Which target will you focus on?",
    a: !h.choice || h.choice === "none" ? "No obvious target — roam freely" : h.choice,
    detail: hint || null,
  });
  const p = a.panic ? a.panic.noul : null;
  qa.push({
    q: "Is the threat big enough to speed up?",
    a: p == null ? "–" : p > 0.6 ? `YES (${Math.round(p * 100)}%)` : p > 0.4 ? `UNCLEAR (${Math.round(p * 100)}%)` : `NO (${Math.round((1 - p) * 100)}%)`,
    color: p == null ? "#9fb6c9" : p > 0.6 ? "#ff9c8f" : p > 0.4 ? "#ffc46b" : "#8fe3a2",
  });
  const st = req.state.surroundings;
  const sees = [
    `hunger ${Math.round((1 - f.enerji) * 100)}%`,
    `${st.foods.length} foods${st.foods[0] ? ` (nearest: ${st.foods[0].distance}u ${st.foods[0].direction})` : ""}`,
    `${st.prey.length} prey`,
    st.threats.length
      ? `threats: ${st.threats.map((b) => `${b.id} ${b.size_ratio}x ${b.distance}u`).join(", ")}`
      : "no threats",
    st.spikes[0] ? `spike: ${st.spikes[0].distance}u ${st.spikes[0].direction}` : "spike: far",
  ].join(" · ");
  return { id: f.id, name: f.name, kg: +f.mass.toFixed(2), ms, source, sees, qa };
}

function applyDecision(f, payload, out, ms, source) {
  const a = out.answers || {};
  const action = a.action?.choice || "roam";
  let target = a.target?.choice || "none";
  const panic = a.panic?.noul ?? 0;
  f.mode = action;
  f.sprint = action === "flee" && panic > 0.6;
  f.targetId = null; f.threatId = null;
  if (action === "flee") {
    f.threatId = target.startsWith("flee_") ? target.slice(5) : (f._threats?.[0]?.id ?? null);
  } else if (target !== "none") {
    f.targetId = target;
  }
  f.label = MODE_SHORT[action] + (f.sprint ? " ‼" : "");
  f.labelColor = MODE_COLOR[action];
  // direction decision: away from the threat when fleeing, toward the target otherwise
  let ang = f.dir;
  const targetEntity = f.targetId ? entityById(f.targetId) : null;
  if (action === "flee" && f.threatId) {
    const t = entityById(f.threatId);
    if (t) ang = Math.atan2(f.y - t.y, f.x - t.x);
  } else if (action === "hunt" && targetEntity) {
    ang = Math.atan2(targetEntity.y - f.y, targetEntity.x - f.x);
  }
  f.arrow = arrowFromAngle(ang);
  f.labelAt = Date.now();
  if (source === "laya") { stats.count++; stats.latSum += ms; stats.latN++; } else stats.fallback++;
  const qa = readableQA(f, payload, out, ms, source);
  decisions.set(f.id, qa);
  fanout("decision", qa);
}

function fallbackDecision(f) {
  const threats = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass > f.mass * 1.25, 1);
  if (threats.length && threats[0].d < 320) {
    f.mode = "flee"; f.threatId = threats[0].o.name; f.targetId = null; f.sprint = threats[0].d < 200;
  } else {
    const prey = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * 0.8, 1);
    if (prey.length && prey[0].d < 380) { f.mode = "hunt"; f.targetId = prey[0].o.name; f.threatId = null; }
    else { f.mode = "roam"; f.targetId = null; f.threatId = null; f.sprint = false; }
  }
  f.label = MODE_SHORT[f.mode]; f.labelColor = MODE_COLOR[f.mode];
}

async function decide(f) {
  f.thinking = true;
  try {
    const payload = buildPayload(f);
    const meta = payload._meta; delete payload._meta;
    f._threats = meta.threats;
    const t0 = Date.now();
    const out = await callLaya(payload);
    applyDecision(f, payload, out, Date.now() - t0, "laya");
  } catch {
    fallbackDecision(f);
    applyDecision(f, payload, {
      answers: {
        action: { choice: f.mode, probabilities: null, confidence: null },
        target: { choice: f.targetId || "none" },
        panic: { noul: f.sprint ? 0.9 : 0.1 },
      },
    }, 0, "local");
  } finally {
    f.thinking = false;
    f.nextThink = Date.now() + rnd(3500, 8000);
  }
}

/* ── physics ───────────────────────────────────────────── */
function entityById(id) {
  return fishes.find((o) => o.alive && o.name === id);
}
function steer(f, dt) {
  // mass-dependent speed: small fish are nimble, big fish are sluggish
  let speed = clamp(115 / Math.pow(f.mass, 0.45), 42, 130);
  let tx = null, ty = null;
  if (f.isPlayer) {
    if (!f.input.has) return;
    tx = f.input.x; ty = f.input.y;
    if (f.input.down) speed *= 1.5;
  } else {
    if (f.mode === "flee") {
      const t = f.threatId ? entityById(f.threatId) : null;
      const threat = t && t.mass ? t : nearOf(fishes, f, (o) => o !== f && o.alive && o.mass > f.mass * 1.25, 1)[0]?.o;
      if (threat) {
        const d = Math.max(1, dist(f, threat));
        tx = f.x + (f.x - threat.x) / d * 300;
        ty = f.y + (f.y - threat.y) / d * 300;
        if (f.sprint) speed *= 1.35;
      } else f.mode = "roam";
    }
    if (f.mode === "hunt") {
      const p = f.targetId ? entityById(f.targetId) : null;
      const prey = p && p.mass && p.mass < f.mass * 0.8 ? p : nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * 0.8, 1)[0]?.o;
      if (prey) {
        // avın üstünde oturuyorsan yiyemezsin: bırakıp yem ara (kilitlenme kırıcı)
        if (dist(f, prey) < radiusOf(f.mass) * 0.6 && (f._oturma || 0) > 1500) f.mode = "eat_food";
        f._oturma = dist(f, prey) < radiusOf(f.mass) * 0.6 ? (f._oturma || 0) + dt * 1000 : 0;
        tx = prey.x; ty = prey.y; speed *= 1.15;
      } else f.mode = "roam";
    }
    if (f.mode === "eat_food") {
      const y = f.targetId ? entityById(f.targetId) : null;
      const food = (y && !y.mass) ? y : nearOf(foods, f, () => true, 1)[0]?.o;
      // aç ve büyüksek yem yetmez — en yakın avı hedefle (amaçlı büyüme)
      const acPrey = f.enerji < 0.5
        ? nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * 0.8, 1)[0]
        : null;
      if (acPrey && acPrey.d < 600) {
        f.mode = "hunt"; f.targetId = acPrey.o.name;
        tx = acPrey.o.x; ty = acPrey.o.y; speed *= 1.15;
      } else if (food) { tx = food.x; ty = food.y; } else f.mode = "roam";
    }
    if (f.mode === "roam") {
      f._wa += rnd(-0.5, 0.5) * dt * 3;
      tx = clamp(f.x + Math.cos(f._wa) * 260, -W / 2 + 60, W / 2 - 60);
      ty = clamp(f.y + Math.sin(f._wa) * 260, -H / 2 + 60, H / 2 - 60);
      speed *= 0.65;
    }
  }
  let ax = 0, ay = 0;
  const d = Math.hypot(tx - f.x, ty - f.y);
  if (d > 4) { ax = (tx - f.x) / d * speed; ay = (ty - f.y) / d * speed; }
  // wall push + slide: turn inward near edges, glide along them out of corners
  const M = 170, PUSH = 140, TANGENT = 0.55;   // PUSH > yüzme hızı olursa balık duvara asla ulaşamaz
  const mL = f.x + W / 2, mR = W / 2 - f.x, mU = f.y + H / 2, mD = H / 2 - f.y;
  if (mL < M) { ax += (1 - mL / M) * PUSH; ay += (f.y > 0 ? -1 : 1) * (1 - mL / M) * PUSH * TANGENT; }
  if (mR < M) { ax -= (1 - mR / M) * PUSH; ay += (f.y > 0 ? -1 : 1) * (1 - mR / M) * PUSH * TANGENT; }
  if (mU < M) { ay += (1 - mU / M) * PUSH; ax += (f.x > 0 ? -1 : 1) * (1 - mU / M) * PUSH * TANGENT; }
  if (mD < M) { ay -= (1 - mD / M) * PUSH; ax += (f.x > 0 ? -1 : 1) * (1 - mD / M) * PUSH * TANGENT; }
  tx = clamp(tx, -W / 2 + 50, W / 2 - 50);
  ty = clamp(ty, -H / 2 + 50, H / 2 - 50);
  // spike push: spikes deflect fish approaching them
  for (const s of spikes) {
    const dx = f.x - s.x, dy = f.y - s.y;
    const dd = Math.hypot(dx, dy);
    const safe = s.r + 80;
    if (dd < safe && dd > 0.5) {
      const push = (1 - dd / safe) * 430;
      ax += dx / dd * push; ay += dy / dd * push;
    }
  }
  const k = 1 - Math.pow(0.001, dt);
  f.vx += (ax - f.vx) * k * 3; f.vy += (ay - f.vy) * k * 3;
}

function tryEat(f) {
  // explosion bits ("single") are consumed once; normal pellets teleport elsewhere
  for (let i = foods.length - 1; i >= 0; i--) {
    const o = foods[i];
    if (Math.hypot(o.x - f.x, o.y - f.y) < radiusOf(f.mass) + 9) {
      f.mass = Math.min(f.mass + (o.single ? 0.3 : 0.15) / Math.pow(f.mass, 0.5), 35);
      if (o.single) foods.splice(i, 1);
      else { o.x = rnd(-W / 2 + 60, W / 2 - 60); o.y = rnd(-H / 2 + 60, H / 2 - 60); o.id = "y" + (++foodSeq); }
    }
  }
  for (const other of fishes) {
    if (other === f || !other.alive) continue;
    if (f.mass > other.mass * 1.3 && dist(f, other) < radiusOf(f.mass) * 0.85) {
      f.mass = Math.min(f.mass + other.mass * 0.6 / Math.pow(f.mass, 0.6), 35);
      f.enerji = Math.min(1, f.enerji + 0.3);
      other.alive = false;
      addFeed("flee", `${other.name} was eaten! (${f.name} +${(other.mass * .6).toFixed(1)} kg)`);
      const victim = other;
      setTimeout(() => {
        const aliveAI = fishes.filter((x) => x.alive && !x.isPlayer).length;
        if (aliveAI >= AI_COUNT) return;
        respawn(victim);
      }, 2500);
    }
  }
}

function respawn(victim) {
  victim.mass = rnd(0.7, 3.0);
  victim.x = rnd(-W / 2 + 120, W / 2 - 120); victim.y = rnd(-H / 2 + 100, H / 2 - 100);
  victim.vx = victim.vy = 0; victim.mode = "roam"; victim.alive = true;
  victim.nextThink = Date.now() + 500;
}

/* ── spikes: touch one and you explode into pellets ────── */
function spikeCheck(f) {
  if (f.tur === "balon") return;       // Pufferfish: spike-immune
  for (const s of spikes) {
    if (dist(f, s) < s.r + radiusOf(f.mass) * 0.7) {
      f.alive = false;
      const bits = Math.round(5 + Math.min(7, f.mass));
      for (let i = 0; i < bits; i++) {
        foods.push({
          id: "y" + (++foodSeq), single: true,
          x: clamp(f.x + rnd(-100, 100), -W / 2 + 40, W / 2 - 40),
          y: clamp(f.y + rnd(-100, 100), -H / 2 + 40, H / 2 - 40),
        });
      }
      addFeed("flee", `BOOM! ${f.name} hit a spike — ${bits} pellets scattered`);
      return;
    }
  }
}

/* ── main loop ─────────────────────────────────────────── */
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const f of fishes) {
    if (f.isPlayer || !f.alive || f.thinking) continue;
    // Jev çağrısı yalnızca en az bir kişi katıldıysa başlar (token tasarrufu)
    if (!aktifKatilimVar()) continue;
    if (now >= f.nextThink) { f.thinking = true; decide(f); }
  }
  for (const f of fishes) {
    if (!f.alive) continue;
    steer(f, dt);
    // gövdenin TAMAMI duvar içinde: kelepçe yarıçapa duyarlı
    const r = radiusOf(f.mass);
    f.x = clamp(f.x + f.vx * dt, -W / 2 + r * 0.95, W / 2 - r * 0.95);
    f.y = clamp(f.y + f.vy * dt, -H / 2 + r * 0.95, H / 2 - r * 0.95);
    if (Math.hypot(f.vx, f.vy) > 8) f.dir = Math.atan2(f.vy, f.vx);
    // metabolizma: enerji ve kütle zamanla azalır — yemek zorunluluktur
    f.enerji = Math.max(0, f.enerji - dt * METAB_DECAY);
    f.mass = Math.max(MASS_FLOOR, f.mass - dt * (MASS_DECAY + f.mass * 0.005));
    if (f.mass <= MASS_FLOOR + 0.01 && f.enerji <= 0.02) {
      // açlıktan ölüm: birkaç parça yem bırakır ve yeniden doğar
      f.alive = false;
      const adet = 4;
      for (let i = 0; i < adet; i++) {
        foods.push({
          id: "y" + (++foodSeq), single: true,
          x: clamp(f.x + rnd(-70, 70), -W / 2 + 40, W / 2 - 40),
          y: clamp(f.y + rnd(-70, 70), -H / 2 + 40, H / 2 - 40),
        });
      }
      addFeed("flee", `${f.name} starved to death — ${adet} pellets scattered`);
      setTimeout(() => {
        const canliAI = fishes.filter((x) => x.alive && !x.isPlayer).length;
        if (canliAI >= AI_COUNT && !f.isPlayer) return;
        f.mass = rnd(0.7, 3.0); f.enerji = 0.8;
        f.x = rnd(-W / 2 + 120, W / 2 - 120); f.y = rnd(-H / 2 + 100, H / 2 - 100);
        f.vx = f.vy = 0; f.mode = "roam"; f.alive = true; f.nextThink = Date.now() + 400;
      }, 2500);
    }
    tryEat(f);
    spikeCheck(f);
  }
}, 33);

// population watchdog: keep the AI count at AI_COUNT
setInterval(() => {
  const aliveAI = fishes.filter((f) => f.alive && !f.isPlayer).length;
  if (aliveAI >= AI_COUNT) return;
  const dead = fishes.find((f) => !f.alive);
  if (dead) respawn(dead);
}, 3000);

// anti-idle watchdog: "balıklar yüzmelidir" — 3 sn'de 12 birimden az
// kımıldayan AI balığı roam moduna alınır ve itilir
setInterval(() => {
  const now = Date.now();
  for (const f of fishes) {
    if (!f.alive || f.isPlayer || f.thinking) continue;
    if (!f._olcum || now - f._olcum.t >= 3000) {
      const moved = f._olcum ? Math.hypot(f.x - f._olcum.x, f.y - f._olcum.y) : 999;
      if (moved < 12) {
        f.mode = "roam"; f.targetId = null; f.threatId = null; f.sprint = false;
        f._wa = rnd(0, Math.PI * 2);
        f.vx += Math.cos(f._wa) * 70; f.vy += Math.sin(f._wa) * 70;
      }
      f._olcum = { t: now, x: f.x, y: f.y };
    }
  }
}, 1500);

/* ── WebSocket real-time layer ─────────────────────────── */
const sessions = new Map();   // connId → sess
let connSeq = 0;
const spectatorCount = () => [...sessions.values()].filter((s) => !s.player).length;
// en az biri "Play"/"Watch" ile katıldıysa true — anonim açık sekmeler sayılmaz
function aktifKatilimVar() {
  for (const s of sessions.values()) if (s.joined) return true;
  return false;
}

function fanout(event, data) {
  const msg = JSON.stringify({ t: event, ...data });
  for (const s of sessions.values()) {
    if (s.ws.readyState === 1) { try { s.ws.send(msg); } catch { sessions.delete(s.connId); } }
  }
}

setInterval(() => {
  fanout("state", {
    serverTime: Date.now(),
    v: currentVersion(),
    jev: aktifKatilimVar(),
    players: tokens.size, playerLimit: MAX_PLAYERS,
    spectators: spectatorCount(),
    spectatorNames: [...sessions.values()].filter((s) => !s.player && s.nick).map((s) => s.nick).slice(0, 30),
    fish: fishes.map((f) => {
      const fresh = f.label && Date.now() - f.labelAt < 3200;
      return {
        id: f.id, name: f.name, kg: +f.mass.toFixed(1), x: Math.round(f.x), y: Math.round(f.y),
        dir: +f.dir.toFixed(2), alive: f.alive, player: f.isPlayer,
        color: f.color, mode: f.mode, tur: f.tur, ozellik: f.ozellik,
        label: fresh ? `${f.label} ${f.arrow || ""}`.trim() : null,
        labelColor: f.labelColor, sprint: f.sprint,
      };
    }),
    foods: foods.map((o) => ({ id: o.id, x: Math.round(o.x), y: Math.round(o.y) })),
    spikes: spikes.map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), r: s.r })),
  });
}, 100);

function cleanNick(s) {
  return String(s || "").replace(/[<>&]/g, "").trim().slice(0, 16);
}
function newToken() {
  return crypto.randomBytes(9).toString("hex");
}

const wss = new WebSocketServer({ noServer: true });

function onMessage(sess, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === "join") {
    const nick = cleanNick(m.nick) || "Guest";
    const oldToken = sess.token;
    // ── become a spectator (also from player) ──
    if (m.spectator) {
      if (oldToken && tokens.has(oldToken)) {
        const fish = fishes.find((f) => f.id === tokens.get(oldToken));
        if (fish) { fish.isPlayer = false; fish.input.has = false; fish.nextThink = Date.now(); fish.label = null; }
        tokens.delete(oldToken);
        addFeed("roam", `${nick} moved to the spectator seats`);
      } else if (!sess.joined) {
        addFeed("roam", `${nick} joined as a spectator`);
      }
      sess.joined = true; sess.player = false; sess.nick = nick;
      if (!sess.token || !viewers.has(sess.token)) sess.token = "v" + newToken();
      viewers.set(sess.token, nick);
      return sess.ws.send(JSON.stringify({ t: "role", role: "spectator", token: sess.token, nick }));
    }
    // ── become a player ──
    let fish = null, token = (m.token && tokens.has(m.token)) ? m.token : null;
    if (token) fish = fishes.find((f) => f.id === tokens.get(token));
    if (!fish && oldToken && tokens.has(oldToken)) {
      token = oldToken; fish = fishes.find((f) => f.id === tokens.get(token));   // rename same fish
    }
    if (!fish && tokens.size >= MAX_PLAYERS) {
      sess.player = false; sess.nick = nick;
      if (!sess.token || !viewers.has(sess.token)) sess.token = "v" + newToken();
      viewers.set(sess.token, nick);
      return sess.ws.send(JSON.stringify({ t: "role", role: "spectator", token: sess.token, nick, note: "Player roster is full (5/5) — you are a spectator" }));
    }
    if (!fish) {
      fish = makeFish(nick, PLAYER_HUES[tokens.size % PLAYER_HUES.length], 1.0, true);
      token = newToken();
      tokens.set(token, fish.id);
      addFeed("eat_food", `${nick} joined the game (player ${tokens.size}/${MAX_PLAYERS})`);
    } else {
      if (fish.name !== nick) addFeed("eat_food", `${fish.name} is now known as ${nick}`);
      fish.name = nick;                                   // nickname change
    }
    if (oldToken && oldToken !== token && viewers.has(oldToken)) viewers.delete(oldToken);
    sess.joined = true; sess.player = true; sess.token = token; sess.fishId = fish.id; sess.nick = nick;
    sess.ws.send(JSON.stringify({ t: "role", role: "player", token, fishId: fish.id, nick }));
    return;
  }
  if (m.t === "input") {
    const fid = sess.player && sess.token && tokens.get(sess.token);
    const fish = fid && fishes.find((f) => f.id === fid);
    if (!fish || !fish.alive) return;
    fish.input.x = +m.x || 0; fish.input.y = +m.y || 0;
    fish.input.down = !!m.down; fish.input.has = true;
  }
}

/* ── world reset ───────────────────────────────────────── */
function resetWorld() {
  const playerCopies = [...tokens.entries()]
    .map(([tok, fid]) => ({ tok, fid, old: fishes.find((f) => f.id === fid) }))
    .filter((x) => x.old);
  fishes.length = 0;
  SPECIES.forEach((s) => makeFish(TURLER[s.tur].ad, s.tur, s.mass, false));
  for (const o of playerCopies) {
    const nf = makeFish(o.old.name, o.old.isPlayer ? (o.old._hue ?? 0.12) : o.old.tur, 1.0, true);
    nf.id = o.fid;                       // keep the token mapping intact
  }
  foods.length = 0;
  for (let i = 0; i < FOOD_COUNT; i++) spawnFood();
  spawnSpikes();
  feed.length = 0;
  decisions.clear();
  stats = { count: 0, latSum: 0, latN: 0, fallback: 0 };
  addFeed("roam", "⟳ World reset — everyone starts from 1 kg");
  fanout("reset", { ok: true });
}

/* ── HTTP: static files + host management API ──────────── */
function send(res, code, obj) {
  const isHtml = typeof obj === "string" || Buffer.isBuffer(obj);
  const body = typeof obj === "string" ? obj : isHtml ? obj.toString("utf8") : JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
const isLocal = (req) => /(^127\.0\.0\.1$|^\[::1\]$|^::1$)/.test(req.socket.remoteAddress || "");

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")));
  }
  if (req.method === "GET" && url === "/healthz") {
    return send(res, 200, {
      ok: true, engine: "laya-local", ws: sessions.size,
      decisions: stats.count, players: tokens.size, jev: aktifKatilimVar(),
    });
  }
  if (isLocal(req) && req.method === "GET" && url === "/manage") {
    return send(res, 200, {
      players: [...tokens.entries()].map(([tok, fid]) => {
        const f = fishes.find((x) => x.id === fid);
        return f ? { token: tok, name: f.name, kg: +f.mass.toFixed(1) } : null;
      }).filter(Boolean),
      spectators: [...sessions.values()]
        .filter((s) => !s.player)
        .map((s) => ({
          connId: s.connId, nick: s.nick || "anonymous",
          min: Math.max(1, Math.round((Date.now() - s.since) / 60000)),
        })),
    });
  }
  if (isLocal(req) && req.method === "POST" && url === "/manage/remove") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        if (p.connId != null) {
          const s = sessions.get(p.connId);
          if (s) {
            addFeed("flee", `${s.nick || "anonymous spectator"} was removed from the stream`);
            try { s.ws.close(4001, "removed"); } catch {}
            sessions.delete(p.connId);
          }
          return send(res, 200, { ok: true });
        }
        if (p.token) {
          const fid = tokens.get(p.token);
          const f = fid && fishes.find((x) => x.id === fid);
          if (f) { f.isPlayer = false; f.input.has = false; f.nextThink = Date.now(); addFeed("flee", `${f.name} was kicked — Jev took over`); }
          tokens.delete(p.token);
          for (const s of [...sessions.values()]) {
            if (s.token === p.token) { try { s.ws.close(4001, "removed"); } catch {} sessions.delete(s.connId); }
          }
          return send(res, 200, { ok: true });
        }
        send(res, 400, { error: "connId or token required" });
      } catch { send(res, 400, { error: "invalid" }); }
    });
    return;
  }
  if (isLocal(req) && req.method === "POST" && url === "/reset") {
    resetWorld();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "not found" });
});

const PLAYER_HUES = [0.12, 0.07, 0.32, 0.46, 0.62, 0.72, 0.85, 0.93, 0.55, 0.27];

// clients auto-update: index.html mtime acts as the server version stamp
function currentVersion() {
  try { return fs.statSync(path.join(__dirname, "index.html")).mtimeMs.toString(36); }
  catch { return "0"; }
}

server.on("upgrade", (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, "http://x");
  if (pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    socket.setNoDelay(true);
    const token = searchParams.get("token");
    const fishId = token && tokens.get(token);
    const sess = {
      connId: ++connSeq, ws, token: token || null, fishId: fishId || null,
      player: !!fishId, nick: token ? viewers.get(token) || null : null,
      since: Date.now(), ip: req.socket.remoteAddress,
    };
    sessions.set(sess.connId, sess);
    ws.send(JSON.stringify({
      t: "welcome", players: tokens.size, playerLimit: MAX_PLAYERS, spectators: spectatorCount(),
      feed: feed.slice(0, 8),
    }));
    ws.on("message", (raw) => onMessage(sess, raw));
    ws.on("close", () => {
      sessions.delete(sess.connId);
      // no ghost players: a disconnected player's fish is handed to Jev immediately
      if (sess.player && sess.token && tokens.get(sess.token) === sess.fishId) {
        const fish = fishes.find((f) => f.id === sess.fishId);
        if (fish) { fish.isPlayer = false; fish.input.has = false; fish.nextThink = Date.now(); }
        tokens.delete(sess.token);
      }
    });
    ws.on("error", () => sessions.delete(sess.connId));
  });
});

process.on("unhandledRejection", (e) => console.log("[unhandled]", (e && e.message) || e));

server.listen(PORT, () => {
  console.log("JEV — The Fish Game: http://localhost:%d  (key %s, %d AI fish)",
    PORT, readKey() ? "loaded" : "MISSING", AI_COUNT);
});
