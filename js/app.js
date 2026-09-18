/* ============================================================
   LeakGuard — app logic
   One phone = one person: scans auto-add to the open ledger.
   "⟲" resets. Ledger persists across refresh via localStorage.
   UI: living rain background driven by leak severity, bottom
   sheets for scan/report, pointer-tracked glow, ticked numbers.
   ============================================================ */

const state = {
  subs: [],
  monthlyTotal: 0,
  duplicates: [],
  sources: [],
  scanStart: null,
  cut: [], // subscriptions you've cut — feeds the savings tracker
};

// Palette declared before any render path uses it (TDZ-safe)
const PIE_COLORS = ["#8b5cf6", "#b9a8ff", "#5b7bd8", "#2fb8a6", "#d99a2b", "#e0526e", "#6d3fd4"];
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ============================================================
   RAIN ENGINE — droplet count & speed scale with leak severity
   ============================================================ */
const rain = (() => {
  const canvas = document.getElementById("rain");
  const ctx = canvas.getContext("2d");
  let drops = [];
  let target = 0; // desired drop count (0..140)
  let w = 0, h = 0;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function spawn() {
    return {
      x: Math.random() * w,
      y: Math.random() * -h,
      len: 8 + Math.random() * 16,
      speed: 240 + Math.random() * 260,
      drift: 12 + Math.random() * 20,
      alpha: 0.12 + Math.random() * 0.25,
    };
  }

  function setIntensity(monthly) {
    // ₹0 → 0 drops; ₹3000+/mo → 140 drops
    target = Math.min(140, Math.round((monthly / 3000) * 140));
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // ease actual count toward target
    if (drops.length < target) for (let i = 0; i < 3; i++) drops.push(spawn());
    if (drops.length > target) drops.splice(0, Math.ceil((drops.length - target) * 0.04));

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(139, 92, 246, 1)";
    ctx.lineWidth = 1;
    for (const d of drops) {
      d.y += d.speed * dt;
      d.x += d.drift * dt;
      if (d.y > h + 20) Object.assign(d, spawn(), { y: -20 });
      ctx.globalAlpha = d.alpha;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.drift * 0.05, d.y - d.len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  if (!REDUCED) requestAnimationFrame(frame);
  else ctx.clearRect(0, 0, w, h);

  return { setIntensity };
})();

/* ============================================================
   SHEET NAVIGATION (scan / report slide up; ledger stays)
   ============================================================ */
const scrim = document.createElement("div");
scrim.className = "scrim";
document.body.appendChild(scrim);

function openSheet(id) {
  closeSheets();
  const sheet = document.getElementById(id);
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
  scrim.classList.add("on");
  document.getElementById("tab-scan").classList.toggle("active", id === "view-scan");
  document.getElementById("tab-report").classList.toggle("active", id === "view-report");
}
function closeSheets() {
  document.querySelectorAll(".sheet").forEach((s) => {
    s.classList.remove("open");
    s.setAttribute("aria-hidden", "true");
  });
  scrim.classList.remove("on");
  document.getElementById("tab-scan").classList.remove("active");
  document.getElementById("tab-report").classList.remove("active");
}
document.getElementById("tab-scan").addEventListener("click", () =>
  document.getElementById("view-scan").classList.contains("open") ? closeSheets() : openSheet("view-scan")
);
document.getElementById("tab-report").addEventListener("click", () =>
  document.getElementById("view-report").classList.contains("open") ? closeSheets() : openSheet("view-report")
);
scrim.addEventListener("click", closeSheets);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheets());

/* ============================================================
   POINTER FX — cards glow toward the cursor
   ============================================================ */
document.addEventListener("pointermove", (e) => {
  if (REDUCED) return;
  const card = e.target.closest?.(".sub-card, .vital");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
  card.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
});

/* ============================================================
   NUMBER TICKER — big numbers roll instead of snapping
   ============================================================ */
function tickTo(el, value, formatter) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = value;
  if (REDUCED || from === value) {
    el.textContent = formatter(value);
    return;
  }
  el.classList.remove("tick");
  void el.offsetWidth; // restart animation
  el.classList.add("tick");
  const t0 = performance.now();
  const dur = 550;
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = formatter(from + (value - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

/* ============================================================
   IMAGE INPUT (camera + gallery)
   ============================================================ */
for (const inputId of ["input-camera", "input-gallery"]) {
  document.getElementById(inputId).addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await handleImage(file);
    e.target.value = "";
  });
}

/* ---------- demo scans ---------- */
const DEMO_STATEMENT = [
  "HDFC BANK e-Statement  Sep 2026",
  "05/09/26  Netflix subscription Rs 649.00 AUTOPAY",
  "06/09/26  Spotify Premium Rs 119.00 AUTOPAY",
  "07/09/26  Gaana Plus renewal Rs 99.00 AUTOPAY",
  "08/09/26  Cult.fit Elite Rs 1250.00 e-mandate",
  "10/09/26  Google One 200GB Rs 130.00 AUTOPAY",
  "12/09/26  Amazon Prime renewal Rs 299.00",
  "15/09/26  Swiggy One membership Rs 99.00",
].join("\n");

const DEMO_SMS = [
  "SBI: Rs 199.00 debited 12/09/26 HOTSTAR AUTOPAY",
  "SBI: Rs 59.00 debited 14/09/26 YouTube Premium AUTOPAY",
  "SBI: Rs 899.00 debited 15/09/26 GOLD GYM E-MANDATE",
].join("\n");

document.getElementById("btn-demo-scan").addEventListener("click", () =>
  processScan(parseStatement(DEMO_STATEMENT), "HDFC e-Statement", DEMO_STATEMENT)
);
document.getElementById("btn-demo-scan-2").addEventListener("click", () =>
  processScan(parseStatement(DEMO_SMS), "SBI SMS", DEMO_SMS)
);

/* ---------- pipeline: image → OCR → parse ---------- */
async function handleImage(file) {
  const progress = document.getElementById("scan-progress");
  const fill = document.getElementById("progress-fill");
  const detail = document.getElementById("progress-detail");
  progress.classList.remove("hidden");
  try {
    const text = await runOCR(file, (pct, msg) => {
      fill.style.width = pct + "%";
      detail.textContent = msg;
    });
    document.getElementById("raw-text-card").classList.remove("hidden");
    document.getElementById("raw-text").textContent = text.trim() || "(no text found)";
    processScan(parseStatement(text), file.name || "Scanned image");
  } catch (err) {
    detail.textContent = "OCR failed: " + err.message;
  }
}

/* ---------- audit logic ---------- */
function processScan(parsed, sourceName) {
  state.scanStart = Date.now();
  if (!parsed.subs.length) {
    alert("No subscription charges found in that scan.");
    return;
  }
  closeSheets();
  applyMerge(parsed, sourceName);
}

function applyMerge(parsed, sourceName) {
  for (const sub of parsed.subs) {
    const existing = state.subs.find((s) => s.name.toLowerCase() === sub.name.toLowerCase());
    if (existing) {
      if ((sub.monthly || sub.amount) > (existing.monthly || existing.amount)) {
        // price went up since last scan → flag the hike
        sub.flags = sub.flags || [];
        if (existing.monthly && sub.monthly > existing.monthly * 1.05 && !sub.flags.includes("hike"))
          sub.flags.push("hike");
        Object.assign(existing, { ...sub, flags: sub.flags });
      }
    } else {
      state.subs.push({ ...sub });
    }
  }
  if (!state.sources.includes(sourceName)) state.sources.push(sourceName);
  finishAuditUpdate();
}

function finishAuditUpdate() {
  state.monthlyTotal = state.subs.reduce((sum, s) => sum + (s.monthly || s.amount), 0);
  state.duplicates = computeDuplicates(state.subs);
  saveState();
  renderDashboard();
}

function computeDuplicates(subs) {
  const byCat = {};
  for (const s of subs) (byCat[s.category] = byCat[s.category] || []).push(s);
  const dups = [];
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length > 1) {
      dups.push(cat + ": " + list.map((s) => s.name).join(" + "));
      list.forEach((s) => {
        s.flags = s.flags || [];
        if (!s.flags.includes("duplicate")) s.flags.push("duplicate");
      });
    }
  }
  return dups;
}

/* ---------- reset ---------- */
document.getElementById("btn-reset").addEventListener("click", () => {
  if (!state.subs.length && !state.cut.length) return;
  if (!confirm("Start a new audit? All entries and cut-savings history are cleared.")) return;
  state.subs = [];
  state.monthlyTotal = 0;
  state.duplicates = [];
  state.sources = [];
  state.cut = [];
  try { localStorage.removeItem("leakguard-audit"); } catch (e) {}
  renderDashboard();
});

/* ---------- persistence ---------- */
function saveState() {
  try {
    localStorage.setItem(
      "leakguard-audit",
      JSON.stringify({ subs: state.subs, sources: state.sources, monthlyTotal: state.monthlyTotal, cut: state.cut })
    );
  } catch (e) { /* storage blocked — memory-only */ }
}
function loadState() {
  try {
    const raw = localStorage.getItem("leakguard-audit");
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.subs) && saved.subs.length) {
      state.subs = saved.subs;
      state.sources = saved.sources || [];
      state.monthlyTotal = saved.monthlyTotal || 0;
      state.cut = Array.isArray(saved.cut) ? saved.cut : [];
    }
  } catch (e) { /* corrupted save — clean start */ }
}

/* ---------- export / import ledger ---------- */
document.getElementById("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ app: "LeakGuard", v: 1, ...serializeState() }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "leakguard-ledger.json";
  a.click();
});

document.getElementById("btn-import").addEventListener("click", () => document.getElementById("input-import").click());
document.getElementById("input-import").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.subs)) throw new Error("not a LeakGuard ledger");
    state.subs = data.subs;
    state.sources = data.sources || [];
    state.monthlyTotal = data.monthlyTotal || 0;
    state.cut = Array.isArray(data.cut) ? data.cut : [];
    finishAuditUpdate();
    alert(`Imported ${state.subs.length} entries.`);
  } catch (err) {
    alert("Import failed: " + err.message);
  }
});

function serializeState() {
  return { subs: state.subs, sources: state.sources, monthlyTotal: state.monthlyTotal, cut: state.cut };
}

/* ============================================================
   RENDER
   ============================================================ */
function renderDashboard() {
  const yearly = state.monthlyTotal * 12;
  tickTo(document.getElementById("leak-amount"), state.monthlyTotal, fmt);
  document.getElementById("leak-yearly").textContent = fmt(yearly) + " a year, quietly";
  document.getElementById("sub-count").textContent = state.subs.length;
  document.getElementById("leak-score").textContent = state.subs.length
    ? leakScore(state.subs, state.monthlyTotal)
    : "—";
  document.getElementById("source-label").textContent = state.sources.length
    ? `${state.sources.length} source${state.sources.length > 1 ? "s" : ""} · ${state.sources.join(" · ")}`
    : "No sources scanned yet";

  if (!state.subs.length) {
    document.getElementById("drip-counter").innerHTML = "&nbsp;";
    state.scanStart = null;
  }

  // rain follows the leak
  rain.setIntensity(state.monthlyTotal);
  renderTimeline();
  renderSavings();

  const list = document.getElementById("subscription-list");
  list.innerHTML = "";
  if (!state.subs.length) {
    list.innerHTML = "";
    document.getElementById("empty-note").style.display = "";
    document.getElementById("chart-card").classList.add("hidden");
    return;
  }
  document.getElementById("empty-note").style.display = "none";
  state.subs.forEach((sub, i) => {
    const card = subCard(sub);
    card.style.setProperty("--i", i);
    list.appendChild(card);
  });
  drawPieChart();
}

function subCard(sub) {
  const div = document.createElement("div");
  div.className = "sub-card" + (sub.kept ? " kept" : "");
  const flags = (sub.flags || [])
    .map((f) => `<span class="badge ${f}">${f}</span>`)
    .join("");
  const perDay = sub.monthly / 30;
  const details = [
    ["Billed", billLabel(sub)],
    ["Effective", `${fmt(sub.monthly)}/mo · ${fmt(sub.monthly * 12)}/yr`],
    ["Per day", `₹${perDay.toFixed(2)}`],
    ["Category", sub.category],
    ["Last charged", sub.lastCharged || "recent"],
    ["AutoPay", sub.autopay ? "on — bank pulls it automatically" : "no — manual renewal"],
    ["Cancel via", sub.cancel || "check app/bank mandate"],
  ]
    .map(([k, v]) => `<div class="fact"><span class="fact-k">${k}</span><span class="fact-v">${v}</span></div>`)
    .join("");

  div.innerHTML = `
    <div class="sub-top">
      <span class="sub-name">${sub.name}</span>
      <span class="sub-amount act-edit" title="Tap to correct if OCR misread">${fmt(sub.monthly)}/mo ✎</span>
    </div>
    <p class="sub-meta">${sub.category} · ${billLabel(sub)} · saves ${fmt(sub.monthly * 12)}/yr${sub.autopay ? " · UPI AutoPay" : ""}</p>
    ${flags}
    <div class="sub-more"><div class="sub-more-inner">${details}</div></div>
    <div class="sub-actions">
      <button class="btn btn-danger act-cancel">Cut it</button>
      <button class="btn act-keep">Keep</button>
    </div>`;

  function billLabel(s) {
    if (s.monthsPerPayment === 12) return `billed ${fmt(s.amount)}/yr`;
    if (s.monthsPerPayment === 3) return `billed ${fmt(s.amount)}/qtr`;
    if (s.monthsPerPayment && s.monthsPerPayment > 1 && s.monthsPerPayment < 12)
      return `billed ${fmt(s.amount)} every ${Math.round(s.monthsPerPayment)} mo`;
    return "billed monthly";
  }

  div.querySelector(".act-edit").addEventListener("click", () => {
    const raw = prompt(`Correct amount billed per period (currently ${sub.amount}):`, String(sub.amount));
    if (raw === null) return;
    const val = parseFloat(raw.replace(/[^0-9.]/g, ""));
    if (!val || val <= 0) return alert("Enter a valid amount.");
    sub.amount = val;
    sub.monthly = Math.round((val / (sub.monthsPerPayment || 1)) * 100) / 100;
    finishAuditUpdate();
  });

  div.querySelector(".act-cancel").addEventListener("click", () => {
    div.classList.add("dying"); // slide-out, then remove
    setTimeout(() => {
      state.subs = state.subs.filter((s) => s !== sub);
      state.cut.push(sub);
      finishAuditUpdate();
      showUndo(sub);
    }, REDUCED ? 0 : 380);
  });

  div.querySelector(".act-keep").addEventListener("click", (e) => {
    sub.kept = true;
    div.classList.add("kept");
    e.target.textContent = "Kept ✓";
    e.target.disabled = true;
  });
  return div;
}

function fmt(n) {
  return "₹" + Math.round(Number(n)).toLocaleString("en-IN");
}

/* ---------- pie chart ---------- */
/* Hover behavior: the whole chart swells slightly, and the slice under
   the cursor pops out, highlights its legend row, and shows a plain-
   language explanation of that part below the chart. */
let pieEntries = [];   // cached [cat, val] pairs, sorted desc
let pieHover = -1;     // index of hovered slice, -1 = none
let pieAnim = 0;       // 0..1 eased animation value for the pop
let pieRaf = null;

function animatePie() {
  // ease current pop amount toward target (1 when a slice is hovered)
  const target = pieHover >= 0 ? 1 : 0;
  pieAnim += (target - pieAnim) * 0.18;
  if (Math.abs(target - pieAnim) < 0.005) {
    pieAnim = target;
    pieRaf = null;
  } else {
    pieRaf = requestAnimationFrame(animatePie);
  }
  paintPie();
}

function kickPieAnim() {
  if (!pieRaf) pieRaf = requestAnimationFrame(animatePie);
}

function paintPie() {
  if (!pieEntries.length) return;
  const canvas = document.getElementById("pie-chart");
  const ctx = canvas.getContext("2d");
  const total = pieEntries.reduce((sum, [, v]) => sum + v, 0);
  // grow the whole pie a touch when anything is hovered
  const grow = 1 + 0.07 * pieAnim;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r = (canvas.width / 2 - 14) * grow;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let start = -Math.PI / 2;
  pieEntries.forEach(([cat, val], i) => {
    const slice = (val / total) * Math.PI * 2;
    const mid = start + slice / 2;
    // hovered slice slides outward along its own mid-angle
    const pop = i === pieHover ? 10 * pieAnim : 0;
    const px = cx + Math.cos(mid) * pop;
    const py = cy + Math.sin(mid) * pop;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, r, start, start + slice);
    ctx.closePath();
    ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
    ctx.globalAlpha = pieHover === -1 ? 0.92 : i === pieHover ? 1 : 0.45;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#e9e6f7"; // matches neumorphic surface
    ctx.lineWidth = 3;
    ctx.stroke();
    start += slice;
  });
}

function pieExplain(i) {
  if (i < 0 || !pieEntries[i]) return "";
  const [cat, val] = pieEntries[i];
  const total = pieEntries.reduce((sum, [, v]) => sum + v, 0);
  const pct = Math.round((val / total) * 100);
  const subs = state.subs.filter((s) => s.category === cat);
  const names = subs.map((s) => s.name).join(", ");
  return `${cat} — ${fmt(val)}/mo (${pct}% of your leak)\n${fmt(val * 12)} a year\n${names}`;
}

function highlightLegend(i) {
  document.querySelectorAll("#pie-legend .row").forEach((row, j) => {
    row.classList.toggle("hot", j === i);
  });
}

function drawPieChart() {
  const byCat = {};
  for (const s of state.subs) byCat[s.category] = (byCat[s.category] || 0) + (s.monthly || s.amount);
  pieEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  pieHover = -1;
  pieAnim = 0;
  const total = pieEntries.reduce((sum, [, v]) => sum + v, 0);
  if (!total) return;

  document.getElementById("chart-card").classList.remove("hidden");
  paintPie();

  document.getElementById("pie-legend").innerHTML = pieEntries
    .map(([cat, val], i) => {
      const pct = Math.round((val / total) * 100);
      return `<div class="row" data-i="${i}"><span><span class="swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>${cat}</span><span>${fmt(val)}/mo · ${pct}%</span></div>`;
    })
    .join("");
}

(function wirePieHover() {
  const canvas = document.getElementById("pie-chart");
  const wrap = document.getElementById("chart-card");
  const info = document.createElement("pre");
  info.id = "pie-info";
  info.className = "pie-info";
  wrap.appendChild(info);

  function locate(e) {
    const rect = canvas.getBoundingClientRect();
    // canvas is scaled by CSS (max-width: 62%) — map back to bitmap coords
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy);
    const r = canvas.width / 2 - 14;
    if (dist > r || !pieEntries.length) return -1;
    let ang = Math.atan2(dy, dx); // -π..π
    if (ang < -Math.PI / 2) ang += Math.PI * 2; // slices start at -π/2
    let a = -Math.PI / 2;
    const total = pieEntries.reduce((sum, [, v]) => sum + v, 0);
    for (let i = 0; i < pieEntries.length; i++) {
      a += (pieEntries[i][1] / total) * Math.PI * 2;
      if (ang <= a) return i;
    }
    return pieEntries.length - 1;
  }

  canvas.addEventListener("mousemove", (e) => {
    const i = locate(e);
    if (i !== pieHover) {
      pieHover = i;
      kickPieAnim();
      highlightLegend(i);
      info.textContent = pieExplain(i);
      info.classList.toggle("on", i >= 0);
      canvas.style.cursor = i >= 0 ? "pointer" : "default";
    }
  });
  canvas.addEventListener("mouseleave", () => {
    pieHover = -1;
    kickPieAnim();
    highlightLegend(-1);
    info.classList.remove("on");
  });
})();

/* ---------- drip counter ---------- */
setInterval(() => {
  if (!state.monthlyTotal || !state.scanStart) return;
  const seconds = (Date.now() - state.scanStart) / 1000;
  const perSec = state.monthlyTotal / (30 * 24 * 3600);
  document.getElementById("drip-counter").textContent =
    `that's ₹${(perSec * seconds).toFixed(4)} since you opened this`;
}, 250);

/* ---------- undo snackbar + cut-savings ---------- */
let undoTimer = null;
function showUndo(sub) {
  const bar = document.getElementById("undo-bar");
  document.getElementById("undo-text").textContent = `Cut ${sub.name} — saving ${fmt(sub.monthly)}/mo`;
  bar.classList.add("on");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => bar.classList.remove("on"), 6000);
}
document.getElementById("undo-btn").addEventListener("click", () => {
  const sub = state.cut.pop();
  if (sub) {
    state.subs.push(sub);
    finishAuditUpdate();
  }
  document.getElementById("undo-bar").classList.remove("on");
});

/* ---------- renewal timeline ---------- */
function renewalDate(sub) {
  // lastCharged formats: d/m/yy, d/m/yyyy, d-Mon-yy — else unknown
  const m = String(sub.lastCharged || "").match(/^(\d{1,2})[-\/](\d{1,2}|[A-Za-z]{3})[-\/](\d{2,4})$/);
  if (!m) return null;
  let mon;
  if (/\d/.test(m[2])) mon = parseInt(m[2], 10) - 1;
  else mon = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  let yr = parseInt(m[3], 10);
  if (yr < 100) yr += 2000;
  const d = new Date(yr, mon, parseInt(m[1], 10));
  if (isNaN(d)) return null;
  const step = Math.max(1, Math.round(sub.monthsPerPayment || 1));
  const now = new Date();
  while (d < now) d.setMonth(d.getMonth() + step);
  return d;
}

const MONTH_NAMES = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function renderTimeline() {
  const wrap = document.getElementById("timeline-card");
  const list = document.getElementById("timeline");
  const items = state.subs
    .map((s) => ({ s, d: renewalDate(s) }))
    .filter((x) => x.d)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  if (!items.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const now = new Date();
  list.innerHTML = items
    .map(({ s, d }) => {
      const days = Math.ceil((d - now) / 86400000);
      const when = days <= 1 ? "renews today/soon" : `in ${days} days`;
      const urgency = days <= 3 ? "soon" : days <= 7 ? "week" : "";
      return `<div class="t-row ${urgency}"><span class="t-name">${s.name}</span><span class="t-when">${when} · ${fmt(s.monthly)}</span></div>`;
    })
    .join("");
}

/* ---------- cut-savings tracker ---------- */
function renderSavings() {
  const el = document.getElementById("savings-card");
  if (!state.cut.length) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const perMo = state.cut.reduce((sum, s) => sum + (s.monthly || 0), 0);
  document.getElementById("savings-num").textContent = fmt(perMo);
  document.getElementById("savings-yr").textContent = `${state.cut.length} cut · ${fmt(perMo * 12)}/yr reclaimed`;
}

/* ---------- report ---------- */
document.getElementById("btn-generate-report").addEventListener("click", () => {
  const report = buildReport({
    subs: state.subs,
    monthlyTotal: state.monthlyTotal,
    duplicates: state.duplicates,
  });
  document.getElementById("report-preview").classList.remove("hidden");
  document.getElementById("report-text").textContent = report;
});

document.getElementById("btn-push-report").addEventListener("click", () => {
  // Office Kit bridge hook — replace with the real SDK call when available.
  const blob = new Blob([document.getElementById("report-text").textContent], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "leakguard-report.txt";
  a.click();
  document.getElementById("push-status").classList.remove("hidden");
});

/* ---------- boot ---------- */
loadState();
renderDashboard();
