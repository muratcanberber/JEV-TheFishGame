// Jev Balık Oyunu — otoriter motor + WebSocket gerçek zamanlı yayın
// Tek kalıcı sokak: sunucu 10 Hz itiyor, oyuncu girdisi olay bazlı gidiyor (polling yok).
// Çalıştırma: node server.js → http://localhost:8787
const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8787;
const API_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_CONCURRENT = 3;
const W = 1900, H = 1150;
const AI_COUNT = 5;                // Jev balığı
const MAX_PLAYERS = 5;             // kullanıcı oyuncu limiti
const FOOD_COUNT = 14;             // az sayıda rastgele yem
const AI_RENK = "#7f95a8";         // tüm Jev balıkları tek renk (oyuncular farklı renk)
const SPIKE_COUNT = 7;             // patlatıcı dikenler

/* ── Jev köprüsü ───────────────────────────────────────── */
// Anahtar YALNIZCA .env dosyasından veya ortam değişkeninden okunur; repoya girmez.
function readEnvFile() {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^([A-Z_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch { return {}; }
}
function readKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  return readEnvFile().TYPESAFE_API_KEY || null;
}
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
function callJev(payload) {
  return new Promise((resolve, reject) => {
    const key = readKey();
    if (!key) return reject(new Error("anahtar yok"));
    const body = JSON.stringify({ ...payload, model: payload.model || "jev-latest" });
    const req = https.request(API_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; if (data.length > 262144) req.destroy(); });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else reject(new Error("HTTP " + res.statusCode));
      });
    });
    req.on("timeout", () => req.destroy(new Error("zaman aşımı")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── dünya ─────────────────────────────────────────────── */
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const radiusOf = (m) => 15 * Math.pow(m, 0.62);
const hslHex = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h * 6) % 2 - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h * 6) % 6];
  return "#" + seg.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
};

const AI_NAMES = ["Lekker", "Bulut", "Şimşek", "Gölge", "Duman", "Kıvılcım", "Fırtına", "Mercan",
  "Yosun", "Kefal", "Levrek", "Palamut", "Uskumru", "Hamsi", "Sardalya", "Ton", "Barbun",
  "Dil Balığı", "Çine", "Mavi", "Derin", "Korsan", "Kaptan", "Fener", "Lodos", "Poyraz",
  "Karayel", "Meltem", "Tayfun", "Dalga", "Kıyı", "Ada", "Liman", "Sandal", "Yelken",
  "Demir", "Çapa", "Sis", "Ay Işığı", "Simit", "Çay", "Baklava", "Turşu", "Zümrüt", "İnci",
  "Su Perisi", "Dalgıç", "Çırak", "Usta", "Sülo"];

const fishes = [];
const foods = [];
let foodSeq = 0, fishSeq = 0;
const feed = [];
const kararlar = new Map();
const tokens = new Map();      // token → fishId (oyuncular)
const viewers = new Map();     // token → nick (izleyiciler)
let stats = { count: 0, latSum: 0, latN: 0, fallback: 0 };

// yemler geri geldi: az sayıda, yendiğinde rastgele yere taşınır
function spawnFood() {
  foods.push({ id: "y" + (++foodSeq), x: rnd(-W / 2 + 60, W / 2 - 60), y: rnd(-H / 2 + 60, H / 2 - 60) });
}
for (let i = 0; i < FOOD_COUNT; i++) spawnFood();

// dikenler: çarpan balık patlar, parçaları yem olur
const spikes = [];
function spawnSpikes() {
  spikes.length = 0;
  for (let i = 0; i < SPIKE_COUNT; i++) {
    spikes.push({ x: rnd(-W / 2 + 230, W / 2 - 230), y: rnd(-H / 2 + 180, H / 2 - 180), r: 26 });
  }
}
spawnSpikes();

function makeFish(name, hue, mass, isPlayer) {
  const f = {
    id: "b" + (++fishSeq), name,
    _hue: hue,
    renk: isPlayer ? hslHex(hue, 0.8, 0.52) : AI_RENK,
    mass, isPlayer,
    x: rnd(-W / 2 + 150, W / 2 - 150), y: rnd(-H / 2 + 120, H / 2 - 120),
    vx: rnd(-30, 30), vy: rnd(-30, 30), dir: rnd(0, Math.PI * 2),
    mode: "dolan", targetId: null, threatId: null, sprint: false,
    alive: true, nextThink: Date.now() + rnd(200, 4000), thinking: false,
    _wa: rnd(0, Math.PI * 2), _buyukler: [],
    etiket: null, etiketRenk: "#9fb6c9", etiketZaman: 0, yonOk: "",
    in: { x: 0, y: 0, down: false, has: false },
  };
  fishes.push(f);
  return f;
}
AI_NAMES.slice(0, AI_COUNT).forEach((n, i) => makeFish(n, 0.02 + (i % 20) / 20 * 0.95, rnd(0.7, 3.0), false));

function addFeed(cls, text) {
  feed.unshift({ cls, text, t: Date.now() });
  if (feed.length > 12) feed.pop();
}

/* ── karar verici ──────────────────────────────────────── */
const nearOf = (list, f, pred, n) =>
  list.filter(pred).map((o) => ({ o, d: dist(o, f) })).sort((a, b) => a.d - b.d).slice(0, n);
const yon = (f, o) => {
  const dx = o.x - f.x, dy = o.y - f.y;
  const hx = dx > 40 ? "sağ" : dx < -40 ? "sol" : "";
  const vy = dy > 40 ? "yukarı" : dy < -40 ? "aşağı" : "";
  return (hx + " " + vy).trim() || "üstünde";
};

function buildPayload(f) {
  const yemler = nearOf(foods, f, () => true, 3)
    .map(({ o, d }) => ({ id: o.id, mesafe: Math.round(d), yone: yon(f, o) }));
  const dikenler = nearOf(spikes, f, () => true, 2)
    .map(({ o, d }) => ({ mesafe: Math.round(d), yone: yon(f, o) }));
  const kucukler = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * 0.8, 2)
    .map(({ o, d }) => ({ id: o.name, boyut_orani: +(o.mass / f.mass).toFixed(2), mesafe: Math.round(d), yone: yon(f, o) }));
  const buyukler = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass > f.mass * 1.25, 2)
    .map(({ o, d }) => ({ id: o.name, boyut_orani: +(o.mass / f.mass).toFixed(2), mesafe: Math.round(d), yone: yon(f, o) }));
  const tehditPct = buyukler.length ? +clamp(1 - buyukler[0].mesafe / 620, 0, 1).toFixed(2) : 0;
  const duvar = {
    sol: Math.round(f.x + W / 2), sag: Math.round(W / 2 - f.x),
    ust: Math.round(f.y + H / 2), alt: Math.round(H / 2 - f.y),
  };
  const hedefCriteria = { yok: "Belirgin bir hedef yok, serbest dolaş" };
  kucukler.forEach((b) => hedefCriteria[b.id] = `av ${b.boyut_orani}x boyutunda, ${b.mesafe} birim ${b.yone}`);
  buyukler.forEach((b) => hedefCriteria["kac_" + b.id] = `${b.id} tarafından ${b.mesafe} birim ${b.yone} taraftan tehdit var; ters yöne açıl`);
  return {
    state: {
      ben: { kimlik: f.name, boyut_kg: +f.mass.toFixed(2), rol: f.isPlayer ? "oyuncu" : "aje" },
      cevre: {
        yemler, kucuk_baliklar: kucukler, buyuk_baliklar: buyukler,
        dikenler, tehdit_yakinligi_pct: tehditPct, duvar,
      },
    },
    questions: {
      eylem: {
        type: "choice",
        instructions: "`ben` balığının bir sonraki hamlesi ne olmalı? `cevre` verisini kullan.",
        criteria: {
          kac: "tehdit varsa hayatta kal; `cevre.duvar` 200'ün altındaysa duvara paralel açıl, `cevre.dikenler` 200'ün altındaysa kaçış yönünü dikenden uzak tut",
          avla: "kucuk_baliklar'da av var ve tehdit/diken riski yoksa büyümek için avlan",
          yem_ye: "yemler'de yem varsa ve yol üzerinde diken yoksa güvenli büyüme",
          dolan: "yakında ne av ne yem ne tehdit varsa çevreyi keşfet; dikenlerden uzak dur",
        },
      },
      hedef: { type: "choice", instructions: "Bu hamle için hangi nesneye odaklanmalı? `cevre` içindeki id'lerden birini seç.", criteria: hedefCriteria },
      panik: { type: "noul", instructions: "`cevre.buyuk_baliklar` mesafesine göre bu balık hızını artıracak kadar tehdit altında mı?" },
    },
    _meta: { buyukler },
  };
}

const MOD_TR = { kac: "KAÇIYOR", avla: "AVLANIYOR", yem_ye: "YEM ARIZ", dolan: "DOLANIYOR" };
const MOD_KISA = { kac: "KAÇ", avla: "AVLA", yem_ye: "YEM", dolan: "DOLAN" };
const MOD_RENK = { kac: "#ff9c8f", avla: "#ffc46b", yem_ye: "#8fe3a2", dolan: "#9fb6c9" };

function okFromAngle(ang) {
  const sek = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"][sek];
}

function readableQA(f, req, resp, ms, kaynak) {
  const a = resp.answers || {};
  const qa = [];
  const e = a.eylem || {};
  qa.push({
    s: "Bir sonraki hamlen ne olmalı?",
    c: MOD_TR[e.choice] || e.choice || "–",
    renk: MOD_RENK[e.choice] || "#9fb6c9",
    guven: e.confidence != null ? Math.round(e.confidence * 100) : null,
    secenekler: e.probabilities ? Object.entries(e.probabilities)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => ({ ad: MOD_KISA[k] || k, yuzde: Math.round(v * 100) })) : [],
  });
  const h = a.hedef || {};
  const hAciklama = h.choice && req.questions.hedef.criteria[h.choice];
  qa.push({
    s: "Odaklanacağın hedef hangisi?",
    c: !h.choice || h.choice === "yok" ? "Belirgin hedef yok, serbest yüz" : h.choice,
    aciklama: hAciklama || null,
  });
  const p = a.panik ? a.panik.noul : null;
  qa.push({
    s: "Hızını artıracak kadar tehdit var mı?",
    c: p == null ? "–" : p > 0.6 ? `EVET (%${Math.round(p * 100)})` : p > 0.4 ? `BELİRSİZ (%${Math.round(p * 100)})` : `HAYIR (%${Math.round((1 - p) * 100)})`,
    renk: p == null ? "#9fb6c9" : p > 0.6 ? "#ff9c8f" : p > 0.4 ? "#ffc46b" : "#8fe3a2",
  });
  const st = req.state.cevre;
  const goruyor = [
    `${st.yemler.length} yem${st.yemler[0] ? ` (yakın: ${st.yemler[0].mesafe}b ${st.yemler[0].yone})` : ""}`,
    `${st.kucuk_baliklar.length} av`,
    st.buyuk_baliklar.length
      ? `tehdit: ${st.buyuk_baliklar.map((b) => `${b.id} ${b.boyut_orani}× ${b.mesafe}b`).join(", ")}`
      : "tehdit yok",
    st.dikenler[0] ? `diken: ${st.dikenler[0].mesafe}b ${st.dikenler[0].yone}` : "diken: uzak",
  ].join(" · ");
  return { id: f.id, ad: f.name, kg: +f.mass.toFixed(2), ms, kaynak, goruyor, qa };
}

function applyDecision(f, payload, out, ms, kaynak) {
  const a = out.answers || {};
  const eylem = a.eylem?.choice || "dolan";
  let hedef = a.hedef?.choice || "yok";
  const panik = a.panik?.noul ?? 0;
  f.mode = eylem;
  f.sprint = eylem === "kac" && panik > 0.6;
  f.targetId = null; f.threatId = null;
  if (eylem === "kac") {
    f.threatId = hedef.startsWith("kac_") ? hedef.slice(4) : (f._buyukler?.[0]?.id ?? null);
  } else if (hedef !== "yok") {
    f.targetId = hedef;
  }
  f.etiket = MOD_KISA[eylem] + (f.sprint ? " ‼" : "");
  f.etiketRenk = MOD_RENK[eylem];
  let yonAng = f.dir;
  const hedefNesne = f.targetId ? entityById(f.targetId) : null;
  if (eylem === "kac" && f.threatId) {
    const t = entityById(f.threatId);
    if (t) yonAng = Math.atan2(f.y - t.y, f.x - t.x);
  } else if (eylem === "avla" && hedefNesne) {
    yonAng = Math.atan2(hedefNesne.y - f.y, hedefNesne.x - f.x);
  }
  f.yonOk = okFromAngle(yonAng);
  f.etiketZaman = Date.now();
  if (kaynak === "jev") { stats.count++; stats.latSum += ms; stats.latN++; } else stats.fallback++;
  const qa = readableQA(f, payload, out, ms, kaynak);
  kararlar.set(f.id, qa);
  fanout("karar", qa);
}

function fallbackDecision(f) {
  const buyukler = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass > f.mass * 1.25, 1);
  if (buyukler.length && buyukler[0].d < 320) {
    f.mode = "kac"; f.threatId = buyukler[0].o.name; f.targetId = null; f.sprint = buyukler[0].d < 200;
  } else {
    const kucuk = nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * 0.8, 1);
    if (kucuk.length && kucuk[0].d < 380) { f.mode = "avla"; f.targetId = kucuk[0].o.name; f.threatId = null; }
    else { f.mode = "dolan"; f.targetId = null; f.threatId = null; f.sprint = false; }
  }
  f.etiket = MOD_KISA[f.mode]; f.etiketRenk = MOD_RENK[f.mode];
}

async function decide(f) {
  f.thinking = true;
  const payload = buildPayload(f);
  const meta = payload._meta; delete payload._meta;
  f._buyukler = meta.buyukler;
  try {
    const t0 = Date.now();
    const out = await callJev(payload);
    applyDecision(f, payload, out, Date.now() - t0, "jev");
  } catch {
    fallbackDecision(f);
    applyDecision(f, payload, {
      answers: {
        eylem: { choice: f.mode, probabilities: null, confidence: null },
        hedef: { choice: f.targetId || "yok" },
        panik: { noul: f.sprint ? 0.9 : 0.1 },
      },
    }, 0, "yerel");
  } finally {
    f.thinking = false;
    f.nextThink = Date.now() + rnd(3500, 8000);
  }
}

/* ── fizik ─────────────────────────────────────────────── */
function entityById(id) {
  return fishes.find((o) => o.alive && o.name === id);
}
function steer(f, dt) {
  // kütleyle azalan hız: küçük çevik, büyük hantaldır
  let speed = clamp(115 / Math.pow(f.mass, 0.45), 42, 130);
  let tx = null, ty = null;
  if (f.isPlayer) {
    if (!f.in.has) return;
    tx = f.in.x; ty = f.in.y;
    if (f.in.down) speed *= 1.5;
  } else {
    if (f.mode === "kac") {
      const t = f.threatId ? entityById(f.threatId) : null;
      const threat = t && t.mass ? t : nearOf(fishes, f, (o) => o !== f && o.alive && o.mass > f.mass * 1.25, 1)[0]?.o;
      if (threat) {
        const d = Math.max(1, dist(f, threat));
        tx = f.x + (f.x - threat.x) / d * 300;
        ty = f.y + (f.y - threat.y) / d * 300;
        if (f.sprint) speed *= 1.35;
      } else f.mode = "dolan";
    }
    if (f.mode === "avla") {
      const p = f.targetId ? entityById(f.targetId) : null;
      const prey = p && p.mass && p.mass < f.mass * 0.8 ? p : nearOf(fishes, f, (o) => o !== f && o.alive && o.mass < f.mass * 0.8, 1)[0]?.o;
      if (prey) { tx = prey.x; ty = prey.y; speed *= 1.15; } else f.mode = "dolan";
    }
    if (f.mode === "dolan") {
      f._wa += rnd(-0.5, 0.5) * dt * 3;
      tx = clamp(f.x + Math.cos(f._wa) * 260, -W / 2 + 60, W / 2 - 60);
      ty = clamp(f.y + Math.sin(f._wa) * 260, -H / 2 + 60, H / 2 - 60);
      speed *= 0.65;
    }
  }
  let ax = 0, ay = 0;
  const d = Math.hypot(tx - f.x, ty - f.y);
  if (d > 4) { ax = (tx - f.x) / d * speed; ay = (ty - f.y) / d * speed; }
  const M = 170, PUSH = 320, TANJANT = 0.55;
  const mL = f.x + W / 2, mR = W / 2 - f.x, mU = f.y + H / 2, mD = H / 2 - f.y;
  if (mL < M) { ax += (1 - mL / M) * PUSH; ay += (f.y > 0 ? -1 : 1) * (1 - mL / M) * PUSH * TANJANT; }
  if (mR < M) { ax -= (1 - mR / M) * PUSH; ay += (f.y > 0 ? -1 : 1) * (1 - mR / M) * PUSH * TANJANT; }
  if (mU < M) { ay += (1 - mU / M) * PUSH; ax += (f.x > 0 ? -1 : 1) * (1 - mU / M) * PUSH * TANJANT; }
  if (mD < M) { ay -= (1 - mD / M) * PUSH; ax += (f.x > 0 ? -1 : 1) * (1 - mD / M) * PUSH * TANJANT; }
  tx = clamp(tx, -W / 2 + 50, W / 2 - 50);
  ty = clamp(ty, -H / 2 + 50, H / 2 - 50);
  // diken itmesi: yaklaşılan diken balığı kendi yolundan geri iter
  for (const s of spikes) {
    const dx = f.x - s.x, dy = f.y - s.y;
    const dd = Math.hypot(dx, dy);
    const guvenli = s.r + 80;
    if (dd < guvenli && dd > 0.5) {
      const it = (1 - dd / guvenli) * 430;
      ax += dx / dd * it; ay += dy / dd * it;
    }
  }
  const k = 1 - Math.pow(0.001, dt);
  f.vx += (ax - f.vx) * k * 3; f.vy += (ay - f.vy) * k * 3;
}

function tryEat(f) {
  // yem: patlama parçaları (tek) yenince silinir, normal yem ışınlanır
  for (let i = foods.length - 1; i >= 0; i--) {
    const o = foods[i];
    if (Math.hypot(o.x - f.x, o.y - f.y) < radiusOf(f.mass) + 9) {
      f.mass = Math.min(f.mass + (o.tek ? 0.3 : 0.15) / Math.pow(f.mass, 0.5), 35);
      if (o.tek) foods.splice(i, 1);
      else { o.x = rnd(-W / 2 + 60, W / 2 - 60); o.y = rnd(-H / 2 + 60, H / 2 - 60); o.id = "y" + (++foodSeq); }
    }
  }
  for (const other of fishes) {
    if (other === f || !other.alive) continue;
    if (f.mass > other.mass * 1.3 && dist(f, other) < radiusOf(f.mass) * 0.85) {
      f.mass = Math.min(f.mass + other.mass * 0.6 / Math.pow(f.mass, 0.6), 35);
      other.alive = false;
      addFeed("kac", `${other.name} yendi! (${f.name} +${(other.mass * .6).toFixed(1)} kg)`);
      const victim = other;
      setTimeout(() => {
        const canliAI = fishes.filter((x) => x.alive && !x.isPlayer).length;
        if (canliAI >= AI_COUNT) return;
        dogur(victim);
      }, 2500);
    }
  }
}

function dogur(victim) {
  victim.mass = rnd(0.7, 3.0);
  victim.x = rnd(-W / 2 + 120, W / 2 - 120); victim.y = rnd(-H / 2 + 100, H / 2 - 100);
  victim.vx = victim.vy = 0; victim.mode = "dolan"; victim.alive = true;
  victim.nextThink = Date.now() + 500;
}

/* ── dikenler: çarpan patlar, parçaları yem olur ───────── */
function patlatKontrol(f) {
  for (const s of spikes) {
    if (dist(f, s) < s.r + radiusOf(f.mass) * 0.7) {
      f.alive = false;
      const adet = Math.round(5 + Math.min(7, f.mass));
      for (let i = 0; i < adet; i++) {
        foods.push({
          id: "y" + (++foodSeq), tek: true,
          x: clamp(f.x + rnd(-100, 100), -W / 2 + 40, W / 2 - 40),
          y: clamp(f.y + rnd(-100, 100), -H / 2 + 40, H / 2 - 40),
        });
      }
      addFeed("kac", `PAT! ${f.name} dikene çarptı — ${adet} parça yem saçıldı`);
      return;
    }
  }
}

/* ── ana döngü ─────────────────────────────────────────── */
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const f of fishes) {
    if (f.isPlayer || !f.alive || f.thinking) continue;
    if (now >= f.nextThink) { f.thinking = true; decide(f); }
  }
  for (const f of fishes) {
    if (!f.alive) continue;
    steer(f, dt);
    f.x = clamp(f.x + f.vx * dt, -W / 2 + 30, W / 2 - 30);
    f.y = clamp(f.y + f.vy * dt, -H / 2 + 30, H / 2 - 30);
    if (Math.hypot(f.vx, f.vy) > 8) f.dir = Math.atan2(f.vy, f.vx);
    tryEat(f);
    patlatKontrol(f);
  }
}, 33);

setInterval(() => {
  const canliAI = fishes.filter((f) => f.alive && !f.isPlayer).length;
  if (canliAI >= AI_COUNT) return;
  const olu = fishes.find((f) => !f.alive);
  if (olu) dogur(olu);
}, 3000);

/* ── WebSocket gerçek zamanlı katman ───────────────────── */
const sessions = new Map();   // connId → sess
let connSeq = 0;
const izleyiciSayisi = () => [...sessions.values()].filter((s) => !s.oyuncu).length;

function fanout(event, data) {
  const msg = JSON.stringify({ t: event, ...data });
  for (const s of sessions.values()) {
    if (s.ws.readyState === 1) { try { s.ws.send(msg); } catch { sessions.delete(s.connId); } }
  }
}

// istemci otomatik güncelleme: index.html değişince mtime versiyonu değişir,
// clientlar uyuşmazlık görürse kendini yeniler
function guncelVersiyon() {
  try { return fs.statSync(path.join(__dirname, "index.html")).mtimeMs.toString(36); }
  catch { return "0"; }
}

setInterval(() => {
  fanout("durum", {
    sunucuSaati: Date.now(),
    v: guncelVersiyon(),
    oyuncu: tokens.size, oyuncuLimit: MAX_PLAYERS,
    izleyici: izleyiciSayisi(), izleyiciAdlari: [...sessions.values()]
      .filter((s) => !s.oyuncu && s.nick).map((s) => s.nick).slice(0, 30),
    baliklar: fishes.map((f) => {
      const taze = f.etiket && Date.now() - f.etiketZaman < 3200;
      return {
        id: f.id, ad: f.name, kg: +f.mass.toFixed(1), x: Math.round(f.x), y: Math.round(f.y),
        dir: +f.dir.toFixed(2), canli: f.alive, oyuncu: f.isPlayer,
        renk: f.renk, mod: f.mode,
        etiket: taze ? `${f.etiket} ${f.yonOk || ""}`.trim() : null,
        etiketRenk: f.etiketRenk, sprint: f.sprint,
      };
    }),
    yemler: foods.map((o) => ({ id: o.id, x: Math.round(o.x), y: Math.round(o.y) })),
    dikenler: spikes.map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), r: s.r })),
  });
}, 100);

function cleanNick(s) {
  return String(s || "").replace(/[<>&]/g, "").trim().slice(0, 16);
}
function yeniToken() {
  return crypto.randomBytes(9).toString("hex");
}

const wss = new WebSocketServer({ noServer: true });

function onMesaj(sess, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === "katil") {
    const nick = cleanNick(m.nick) || "Misafir";
    const eskiToken = sess.token;
    // ── izleyici olmak (oyuncuyken bile) ──
    if (m.izleyici) {
      if (eskiToken && tokens.has(eskiToken)) {
        // oyunculuktan ayrılıyor: balığı Jev'e devret
        const fish = fishes.find((f) => f.id === tokens.get(eskiToken));
        if (fish) { fish.isPlayer = false; fish.in.has = false; fish.nextThink = Date.now(); fish.etiket = null; }
        tokens.delete(eskiToken);
        addFeed("dolan", `${nick} izleyici koltuğuna geçti`);
      } else if (!sess.katildi) {
        addFeed("dolan", `${nick} izleyici olarak katıldı`);
      }
      sess.katildi = true; sess.oyuncu = false; sess.nick = nick;
      if (!sess.token || !viewers.has(sess.token)) sess.token = "v" + yeniToken();
      viewers.set(sess.token, nick);
      return sess.ws.send(JSON.stringify({ t: "rol", rol: "izleyici", token: sess.token, nick }));
    }
    // ── oyuncu olmak ──
    let fish = null, token = (m.token && tokens.has(m.token)) ? m.token : null;
    if (token) fish = fishes.find((f) => f.id === tokens.get(token));
    if (!fish && eskiToken && tokens.has(eskiToken)) {
      token = eskiToken; fish = fishes.find((f) => f.id === tokens.get(token));   // aynı balıkta nick değişimi
    }
    if (!fish && tokens.size >= MAX_PLAYERS) {
      sess.oyuncu = false; sess.nick = nick;
      if (!sess.token || !viewers.has(sess.token)) sess.token = "v" + yeniToken();
      viewers.set(sess.token, nick);
      return sess.ws.send(JSON.stringify({ t: "rol", rol: "izleyici", token: sess.token, nick, not: "Kadro dolu (10/10) — izleyici oldun" }));
    }
    if (!fish) {
      fish = makeFish(nick, PLAYER_HUES[tokens.size % PLAYER_HUES.length], 1.0, true);
      token = yeniToken();
      tokens.set(token, fish.id);
      addFeed("yem", `${nick} oyuna katıldı (oyuncu ${tokens.size}/${MAX_PLAYERS})`);
    } else {
      if (fish.name !== nick) addFeed("yem", `${fish.name} artık ${nick}`);
      fish.name = nick;                                  // nick değişimi
    }
    if (eskiToken && eskiToken !== token && viewers.has(eskiToken)) viewers.delete(eskiToken);
    sess.katildi = true; sess.oyuncu = true; sess.token = token; sess.fishId = fish.id; sess.nick = nick;
    sess.ws.send(JSON.stringify({ t: "rol", rol: "oyuncu", token, fishId: fish.id, nick }));
    return;
  }
  if (m.t === "girdi") {
    const fid = sess.oyuncu && sess.token && tokens.get(sess.token);
    const fish = fid && fishes.find((f) => f.id === fid);
    if (!fish || !fish.alive) return;
    fish.in.x = +m.x || 0; fish.in.y = +m.y || 0;
    fish.in.down = !!m.down; fish.in.has = true;
  }
}

/* ── dünya sıfırlama ───────────────────────────────────── */
function resetWorld() {
  const oyuncuKopyalari = [...tokens.entries()]
    .map(([tok, fid]) => ({ tok, fid, eski: fishes.find((f) => f.id === fid) }))
    .filter((x) => x.eski);
  fishes.length = 0;
  for (let i = 0; i < AI_COUNT; i++) {
    makeFish(AI_NAMES[i], 0.02 + (i % 20) / 20 * 0.95, rnd(0.7, 3.0), false);
  }
  foods.length = 0;
  for (let i = 0; i < FOOD_COUNT; i++) spawnFood();
  spawnSpikes();
  for (const o of oyuncuKopyalari) {
    const nf = makeFish(o.eski.name, o.eski._hue ?? 0.12, 1.0, true);
    nf.id = o.fid;
  }
  feed.length = 0;
  kararlar.clear();
  stats = { count: 0, latSum: 0, latN: 0, fallback: 0 };
  addFeed("dolan", "⟳ Oyun sıfırlandı — herkes 1 kg'dan başladı");
  fanout("reset", { ok: true });
}

/* ── HTTP: statik + host yönetimi ──────────────────────── */
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
      ok: true, hasKey: !!readKey(), ws: sessions.size,
      karar: stats.count, oyuncu: tokens.size,
    });
  }
  if (isLocal(req) && req.method === "GET" && url === "/yonetim") {
    return send(res, 200, {
      oyuncular: [...tokens.entries()].map(([tok, fid]) => {
        const f = fishes.find((x) => x.id === fid);
        return f ? { token: tok, ad: f.name, kg: +f.mass.toFixed(1) } : null;
      }).filter(Boolean),
      izleyiciler: [...sessions.values()]
        .filter((s) => !s.oyuncu)
        .map((s) => ({
          connId: s.connId, nick: s.nick || "anonim",
          dk: Math.max(1, Math.round((Date.now() - s.since) / 60000)),
        })),
    });
  }
  if (isLocal(req) && req.method === "POST" && url === "/yonetim/cikar") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        if (p.connId != null) {
          const s = sessions.get(p.connId);
          if (s) {
            addFeed("kac", `${s.nick || "anonim izleyici"} yayından çıkarıldı`);
            try { s.ws.close(4001, "cikarildin"); } catch {}
            sessions.delete(p.connId);
          }
          return send(res, 200, { ok: true });
        }
        if (p.token) {
          const fid = tokens.get(p.token);
          const f = fid && fishes.find((x) => x.id === fid);
          if (f) { f.isPlayer = false; f.in.has = false; f.nextThink = Date.now(); addFeed("kac", `${f.name} oyunculuktan çıkarıldı (Jev devraldı)`); }
          tokens.delete(p.token);
          // o tokenla bağlı oturumu da kapat
          for (const s of [...sessions.values()]) {
            if (s.token === p.token) { try { s.ws.close(4001, "cikarildin"); } catch {} sessions.delete(s.connId); }
          }
          return send(res, 200, { ok: true });
        }
        send(res, 400, { error: "connId veya token gerekli" });
      } catch { send(res, 400, { error: "geçersiz" }); }
    });
    return;
  }
  if (isLocal(req) && req.method === "POST" && url === "/reset") {
    resetWorld();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "bulunamadı" });
});

const PLAYER_HUES = [0.12, 0.07, 0.32, 0.46, 0.62, 0.72, 0.85, 0.93, 0.55, 0.27];

server.on("upgrade", (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, "http://x");
  if (pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    socket.setNoDelay(true);
    const token = searchParams.get("token");
    const fishId = token && tokens.get(token);
    const sess = {
      connId: ++connSeq, ws, token: token || null, fishId: fishId || null,
      oyuncu: !!fishId, nick: token ? viewers.get(token) || null : null,
      since: Date.now(), ip: req.socket.remoteAddress,
    };
    sessions.set(sess.connId, sess);
    ws.send(JSON.stringify({
      t: "acilis", oyuncu: tokens.size, oyuncuLimit: MAX_PLAYERS, izleyici: izleyiciSayisi(),
      feed: feed.slice(0, 8),
    }));
    ws.on("message", (raw) => onMesaj(sess, raw));
    ws.on("close", () => {
      sessions.delete(sess.connId);
      // hayalet oyuncu yok: bağlantısı kopan oyuncunun balığı anında Jev'e geçer
      if (sess.oyuncu && sess.token && tokens.get(sess.token) === sess.fishId) {
        const fish = fishes.find((f) => f.id === sess.fishId);
        if (fish) { fish.isPlayer = false; fish.in.has = false; fish.nextThink = Date.now(); }
        tokens.delete(sess.token);
      }
    });
    ws.on("error", () => sessions.delete(sess.connId));
  });
});

server.listen(PORT, () => {
  console.log("Jev Balık Oyunu (WS): http://localhost:%d  (anahtar %s, %d AI balık)",
    PORT, readKey() ? "yüklü" : "YOK", AI_COUNT);
});
