/* ============================================================
   LeakGuard — subscription parser
   PHASE 1 (now): rule-based extraction from raw OCR text —
   regex patterns match Indian bank/SMS/UPI statement formats.
   PHASE 2 (upgrade): swap parseStatement() internals for a
   local LLM (WebLLM via WebGPU) — same input/output contract,
   so app.js doesn't change. Keeps us on "on-device" rules.
   ============================================================ */

// Known subscription merchants → category + cancel hint
const KNOWN_SERVICES = [
  { match: /netflix/i, name: "Netflix", category: "OTT", cancel: "Account → Cancel Membership" },
  { match: /prime video|amazon prime/i, name: "Prime Video", category: "OTT", cancel: "Amazon → Memberships" },
  { match: /hotstar|jiocinema/i, name: "Hotstar/JioCinema", category: "OTT", cancel: "In-app → Plans" },
  { match: /spotify/i, name: "Spotify", category: "Music", cancel: "Account → Subscription" },
  { match: /gaana|wynk|jiosaavn/i, name: "Gaana/Wynk/Saavn", category: "Music", cancel: "In-app → Subscription" },
  { match: /youtube premium|yt premium/i, name: "YouTube Premium", category: "Streaming", cancel: "Google → Subscriptions" },
  { match: /cult\.?fit|gold.?s gym|anytime fitness/i, name: "Gym/Fitness", category: "Fitness", cancel: "Visit/TAPP to cancel" },
  { match: /swiggy(?! one)|zomato(?! pro)/i, name: "Swiggy/Zomato", category: "Food", cancel: "In-app → One/Pro" },
  { match: /google one|icloud|dropbox/i, name: "Cloud Storage", category: "Storage", cancel: "Account → Storage plan" },
];

// Subscriptions often appear as these recurring patterns in SMS/OCR text
const CHARGE_RE =
  /(?:Rs\.?|INR|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
const AUTOPAY_RE = /(autopay|e-?mandate|e-?nach|recurring)/i;

/**
 * Parse raw OCR text into subscription objects.
 * @param {string} text
 * @returns {{subs: Array<{name:string,amount:number,category:string,cancel:string,autopay:boolean,lastCharged:string}>, monthlyTotal:number, duplicates:string[]}}
 */
function parseStatement(text) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const found = new Map(); // name -> sub

  for (const line of lines) {
    // must contain a ₹ amount to be interesting
    const amtMatch = [...line.matchAll(CHARGE_RE)];
    if (!amtMatch.length) continue;
    const amount = parseFloat(amtMatch[0][1].replace(/,/g, ""));
    if (!amount || amount < 10) continue;

    const svc = KNOWN_SERVICES.find(s => s.match.test(line));
    const name = svc ? svc.name : guessName(line);
    if (!name) continue;

    const autopay = AUTOPAY_RE.test(line);
    const dateMatch = line.match(/(\d{1,2}[-\/][A-Za-z]{3}[-\/]\d{2,4})|(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/);
    const sub = {
      name,
      amount,
      category: svc ? svc.category : "Other",
      cancel: svc ? svc.cancel : "Check app/bank mandate",
      autopay,
      lastCharged: dateMatch ? dateMatch[0] : "recent",
    };
    // keep the largest amount seen per service
    if (!found.has(name) || found.get(name).amount < amount) found.set(name, sub);
  }

  const subs = [...found.values()];

  // naive duplicate detection: same category, 2+ services
  const byCat = {};
  for (const s of subs) (byCat[s.category] = byCat[s.category] || []).push(s);
  const duplicates = [];
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length > 1) {
      duplicates.push(cat + ": " + list.map(s => s.name).join(" + "));
      list.forEach(s => { s.flags = s.flags || []; s.flags.push("duplicate"); });
    }
  }

  const monthlyTotal = subs.reduce((sum, s) => sum + s.amount, 0);
  return { subs, monthlyTotal, duplicates };
}

/** Fallback name guess: longest capitalized token cluster in the line */
function guessName(line) {
  const words = line.match(/[A-Za-z][A-Za-z&. ]{2,}/g);
  if (!words) return null;
  const best = words.sort((a, b) => b.length - a.length)[0].trim();
  return best.length > 2 ? best : null;
}

/** Leak Score 0–100: 100 = no leaks. */
function leakScore(subs, monthlyTotal) {
  if (!subs.length) return 100;
  // Rough model: each ₹500/month of leakage and each sub costs points
  const raw = 100 - Math.min(70, Math.round(monthlyTotal / 20)) - Math.min(30, subs.length * 5);
  return Math.max(0, Math.min(100, raw));
}

/** Generate the phone→laptop report text. */
function buildReport(parsed) {
  const yearly = parsed.monthlyTotal * 12;
  let out = "LEAKGUARD LEAK REPORT\n";
  out += "=====================\n";
  out += `Monthly leak : Rs ${parsed.monthlyTotal.toFixed(0)}\n`;
  out += `Yearly leak  : Rs ${yearly.toFixed(0)}\n`;
  out += `Leak Score   : ${leakScore(parsed.subs, parsed.monthlyTotal)}/100\n\n`;
  out += "SUBSCRIPTIONS FOUND\n";
  parsed.subs.forEach(s => {
    out += `- ${s.name} : Rs ${s.amount}/mo (${s.category}${s.autopay ? ", UPI AutoPay" : ""}) -> ${s.cancel}\n`;
  });
  if (parsed.duplicates.length) {
    out += "\nFLAGGED\n";
    parsed.duplicates.forEach(d => (out += `- Duplicate: ${d}\n`));
  }
  out += "\nACTION: cancel or pause the flagged items above.\n";
  out += "Generated on-device. No data left this phone.\n";
  return out;
}
