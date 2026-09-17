/* ============================================================
   LeakGuard — app logic
   Audit sessions: first scan starts a ledger; later scans ask
   MERGE (same person) or REPLACE (different person). Memory
   only — refresh wipes everything (demo-safe).
   ============================================================ */

const state = {
  subs: [],          // merged subscription entries
  monthlyTotal: 0,
  duplicates: [],
  sources: [],       // e.g. ["HDFC e-Statement", "Bank SMS"]
  scanStart: null,
};

/* ---------- screen navigation ---------- */
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.target));
});
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.target === id)
  );
}

/* ---------- image input (camera + gallery) ---------- */
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

// More evidence for the same ledger — auto-adds on scan
const DEMO_SMS = [
  "SBI: Rs 199.00 debited 12/09/26 HOTSTAR AUTOPAY",
  "SBI: Rs 59.00 debited 14/09/26 YouTube Premium AUTOPAY",
  "SBI: Rs 899.00 debited 15/09/26 GOLD GYM E-MANDATE",
].join("\n");

document.getElementById("btn-demo-scan").addEventListener("click", () =>
  processScan(parseStatement(DEMO_STATEMENT), "HDFC e-Statement", DEMO_STATEMENT)
);
document.getElementById("btn-demo-scan-2").addEventListener("click", () =>
  processScan(parseStatement(DEMO_SMS), "SBI SMS (2nd person)", DEMO_SMS)
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

/* ---------- audit session logic ---------- */
// One phone = one person: every scan auto-adds to the open ledger.
// "Start new audit" is the explicit reset between people/sessions.
function processScan(parsed, sourceName, rawText) {
  state.scanStart = Date.now();
  if (!parsed.subs.length) {
    alert("No subscription charges found in that scan.");
    return;
  }
  applyMerge(parsed, sourceName);
}

function applyMerge(parsed, sourceName) {
  for (const sub of parsed.subs) {
    const existing = state.subs.find((s) => s.name.toLowerCase() === sub.name.toLowerCase());
    if (existing) {
      // duplicate protection: same service counts once, keep higher amount
      if (sub.amount > existing.amount) {
        existing.amount = sub.amount;
        existing.autopay = sub.autopay || existing.autopay;
        existing.lastCharged = sub.lastCharged;
      }
    } else {
      state.subs.push({ ...sub });
    }
  }
  if (!state.sources.includes(sourceName)) state.sources.push(sourceName);
  finishAuditUpdate();
}

function finishAuditUpdate() {
  state.monthlyTotal = state.subs.reduce((sum, s) => sum + s.amount, 0);
  state.duplicates = computeDuplicates(state.subs);
  renderDashboard();
  showScreen("screen-dashboard");
}

function computeDuplicates(subs) {
  const byCat = {};
  for (const s of subs) (byCat[s.category] = byCat[s.category] || []).push(s);
  const dups = [];
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length > 1) {
      dups.push(cat + ": " + list.map((s) => s.name).join(" + "));
      list.forEach((s) => { s.flags = s.flags || []; if (!s.flags.includes("duplicate")) s.flags.push("duplicate"); });
    }
  }
  return dups;
}



/* ---------- new audit (full reset) ---------- */
document.getElementById("btn-new-audit").addEventListener("click", () => {
  state.subs = [];
  state.monthlyTotal = 0;
  state.duplicates = [];
  state.sources = [];
  renderDashboard();
});

/* ---------- dashboard render ---------- */
function renderDashboard() {
  const yearly = state.monthlyTotal * 12;
  document.getElementById("leak-amount").textContent = fmt(state.monthlyTotal);
  document.getElementById("leak-yearly").textContent = fmt(yearly);
  document.getElementById("sub-count").textContent = state.subs.length;
  // "—" until something is scanned: an empty ledger has no score yet
  document.getElementById("leak-score").textContent = state.subs.length
    ? leakScore(state.subs, state.monthlyTotal)
    : "—";
  // clear stale drip text when the ledger is empty
  if (!state.subs.length) {
    document.getElementById("drip-counter").textContent = "";
    state.scanStart = null;
  }
  document.getElementById("source-label").textContent = state.sources.length
    ? `Sources (${state.sources.length}): ${state.sources.join(" · ")}`
    : "No sources scanned yet";

  const list = document.getElementById("subscription-list");
  list.innerHTML = "";
  if (!state.subs.length) {
    list.innerHTML = '<p class="muted empty-msg">Ledger is empty — enter a bill to begin.</p>';
    return;
  }
  for (const sub of state.subs) list.appendChild(subCard(sub));
}

function subCard(sub) {
  const div = document.createElement("div");
  div.className = "sub-card";
  const flags = (sub.flags || [])
    .map((f) => `<span class="badge ${f}">${f}</span>`)
    .join("");
  div.innerHTML = `
    <div class="sub-top">
      <span class="sub-name">${sub.name}</span>
      <span class="sub-amount">${fmt(sub.amount)}/mo</span>
    </div>
    <p class="sub-meta">${sub.category} · last charged ${sub.lastCharged} · saves ${fmt(sub.amount * 12)}/yr if cancelled${sub.autopay ? " · UPI AutoPay" : ""}</p>
    ${flags}
    <div class="sub-actions">
      <button class="btn btn-danger act-cancel">Cancel</button>
      <button class="btn btn-secondary act-keep">Keep</button>
    </div>`;

  div.querySelector(".act-cancel").addEventListener("click", () => {
    state.subs = state.subs.filter((s) => s !== sub);
    finishAuditUpdate();
  });
  div.querySelector(".act-keep").addEventListener("click", (e) => {
    div.classList.add("kept");
    e.target.textContent = "Kept ✓";
    e.target.disabled = true;
  });
  return div;
}

function fmt(n) {
  return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/* ---------- drip counter (₹ leaking while you watch) ---------- */
setInterval(() => {
  if (!state.monthlyTotal || !state.scanStart) return;
  const seconds = (Date.now() - state.scanStart) / 1000;
  const perSec = state.monthlyTotal / (30 * 24 * 3600); // month → sec
  document.getElementById("drip-counter").textContent =
    `💧 ₹${(perSec * seconds).toFixed(4)} leaked while watching`;
}, 250);

/* ---------- leak report + Office Kit push ---------- */
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
  // Office Kit bridge hook: replace with real SDK call when docs are available.
  // Fallback: download as a file shareable to the PC.
  const blob = new Blob([document.getElementById("report-text").textContent], {
    type: "text/plain",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "leakguard-report.txt";
  a.click();
  document.getElementById("push-status").classList.remove("hidden");
});
