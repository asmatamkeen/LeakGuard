/* ============================================================
   LeakGuard — app logic
   Screens, OCR wiring, dashboard render, drip counter, report.
   ============================================================ */

const state = {
  subs: [],
  monthlyTotal: 0,
  duplicates: [],
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

/* ---------- demo scan (no image needed — judges love this) ---------- */
document.getElementById("btn-demo-scan").addEventListener("click", async () => {
  const demoText = [
    "HDFC BANK e-Statement  Sep 2026",
    "05/09/26  Netflix subscription Rs 649.00 AUTOPAY",
    "06/09/26  Spotify Premium Rs 119.00 AUTOPAY",
    "07/09/26  Gaana Plus renewal Rs 99.00 AUTOPAY",
    "08/09/26  Cult.fit Elite Rs 1250.00 e-mandate",
    "10/09/26  Google One 200GB Rs 130.00 AUTOPAY",
    "12/09/26  Amazon Prime renewal Rs 299.00",
    "15/09/26  Swiggy One membership Rs 99.00",
  ].join("\n");
  await processText(demoText, "Demo statement");
});

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
    await processText(text, file.name || "Scanned image");
  } catch (err) {
    detail.textContent = "OCR failed: " + err.message;
  }
}

async function processText(text, sourceName) {
  state.scanStart = Date.now();
  document.getElementById("raw-text-card").classList.remove("hidden");
  document.getElementById("raw-text").textContent = text.trim() || "(no text found)";

  const parsed = parseStatement(text);
  state.subs = parsed.subs;
  state.monthlyTotal = parsed.monthlyTotal;
  state.duplicates = parsed.duplicates;
  renderDashboard();
  showScreen("screen-dashboard");
}

/* ---------- dashboard render ---------- */
function renderDashboard() {
  const yearly = state.monthlyTotal * 12;
  document.getElementById("leak-amount").textContent = fmt(state.monthlyTotal);
  document.getElementById("leak-yearly").textContent = fmt(yearly);
  document.getElementById("sub-count").textContent = state.subs.length;
  document.getElementById("leak-score").textContent = leakScore(state.subs, state.monthlyTotal);

  const list = document.getElementById("subscription-list");
  list.innerHTML = "";
  if (!state.subs.length) {
    list.innerHTML = '<p class="muted empty-msg">No subscriptions detected.</p>';
    return;
  }
  for (const sub of state.subs) list.appendChild(subCard(sub));
}

function subCard(sub) {
  const div = document.createElement("div");
  div.className = "sub-card";
  const flags = (sub.flags || [])
    .map((f) => `<span class="badge ${f}">${f.toUpperCase()}</span>`)
    .join("");
  div.innerHTML = `
    <div class="sub-top">
      <span class="sub-name">${sub.name}</span>
      <span class="sub-amount">${fmt(sub.amount)}/mo</span>
    </div>
    <p class="sub-meta">${sub.category} · last charged ${sub.lastCharged} · saves ${fmt(sub.amount * 12)}/yr if cancelled${sub.autopay ? " · UPI AutoPay" : ""}</p>
    ${flags}
    <div class="sub-actions">
      <button class="btn btn-cancel">Cancel</button>
      <button class="btn btn-keep">Keep</button>
    </div>`;

  div.querySelector(".btn-cancel").addEventListener("click", () => {
    state.monthlyTotal -= sub.amount;
    state.subs = state.subs.filter((s) => s !== sub);
    renderDashboard();
  });
  div.querySelector(".btn-keep").addEventListener("click", () => {
    div.querySelector(".btn-keep").textContent = "Kept ✓";
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
  const el = document.getElementById("drip-counter");
  if (el) el.textContent = `💧 ₹${(perSec * seconds).toFixed(4)} leaked while watching`;
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
  // Fallback: download as a file that can be shared to the PC.
  const blob = new Blob([document.getElementById("report-text").textContent], {
    type: "text/plain",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "leakguard-report.txt";
  a.click();
  document.getElementById("push-status").classList.remove("hidden");
});
