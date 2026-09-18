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
  { match: /swiggy|zomato/i, name: "Swiggy/Zomato", category: "Food", cancel: "In-app → One/Pro" },
  { match: /google one|icloud|dropbox/i, name: "Cloud Storage", category: "Storage", cancel: "Account → Storage plan" },
  { match: /anthropic|claude/i, name: "Claude (Anthropic)", category: "AI Tools", cancel: "claude.ai → Settings → Billing" },
  { match: /chatgpt|openai/i, name: "ChatGPT", category: "AI Tools", cancel: "chat.openai.com → Billing" },
  { match: /perplexity/i, name: "Perplexity", category: "AI Tools", cancel: "Account → Subscription" },
  { match: /adobe (creative|photoshop|acrobat)/i, name: "Adobe", category: "Software", cancel: "account.adobe.com → Plans" },
  { match: /canva/i, name: "Canva", category: "Software", cancel: "canva.com → Billing & Plans" },
  { match: /notion/i, name: "Notion", category: "Software", cancel: "Settings → Billing" },
];

// Subscriptions often appear as these recurring patterns in SMS/OCR text
const CHARGE_RE =
  /(?:Rs\.?|INR|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
const AUTOPAY_RE = /(autopay|e-?mandate|e-?nach|recurring|will be charged)/i;
// A decimal amount, even with no currency prefix (e.g. "31,499.00" or "649.00").
// Decimals are required so dates like 15/09/26 and years like 2026 never match.
const BARE_AMOUNT_RE = /(\d{1,3}(?:,\d{2,3})*\.\d{2})(?!\d)/;
// Lines that describe a payment make a bare number trustworthy as an amount.
const PAYMENT_CONTEXT_RE = /(paid|payment|charged|debited|renewal|subscription|amount)/i;
// "Plan Anthropic Premium" style lines name the service without an amount.
const PLAN_NAME_RE = /^\s*plan\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40})$/i;
// Bill-summary lines (totals, taxes, fees) are NOT subscription charges.
const TOTAL_RE = /\b(grand\s*total|sub\s*-?\s*total|total|amount\s*due|balance)\b/i;
// One-time food-delivery order context (restaurant bill, not a membership).
const FOOD_ORDER_RE = /\b(order|item|qty|invoice|bill|restaurant|delivered|cart|kitchen|cuisine)\b/i;
// Swiggy/Zomato only count when it's their paid membership or a mandate.
const FOOD_MEMBERSHIP_RE = /\b(one|pro|plus|gold|membership|autopay|e-?mandate|subscription|renewal)\b/i;
// Billing-frequency keywords → months covered by one payment (used in matching above via inline regexes).
const TERM_RANGE_RE = /([A-Za-z]{3,9})\s+\d{1,2},?\s+(\d{4})\s*[-–—]\s*([A-Za-z]{3,9})\s+\d{1,2},?\s+(\d{4})/;
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

/**
 * Parse raw OCR text into subscription objects.
 * @param {string} text
 * @returns {{subs: Array<{name:string,amount:number,category:string,cancel:string,autopay:boolean,lastCharged:string}>, monthlyTotal:number, duplicates:string[]}}
 */
function parseStatement(text) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const found = new Map(); // name -> sub
  let lastKnown = null;    // service name remembered from a nearby line (plan pages)
  let lastTermMonths = null; // months-per-payment remembered from a term line

  for (const line of lines) {
    // bill-summary lines (totals/taxes/balance) never name a subscription —
    // skip before they can poison lastKnown or be read as charges
    if (TOTAL_RE.test(line)) continue;

    // remember service names from name-bearing lines (e.g. "Plan Anthropic Premium")
    const svcAnywhere = KNOWN_SERVICES.find(s => s.match.test(line));

    // Swiggy/Zomato appear on every food-order bill header; only a paid
    // membership/mandate line counts, and order lines never seed lastKnown
    if (svcAnywhere && svcAnywhere.name === "Swiggy/Zomato" && !FOOD_MEMBERSHIP_RE.test(line)) {
      continue;
    }

    // one-time food-order lines (items, fees, taxes) are not subscriptions
    if (FOOD_ORDER_RE.test(line) && !amtOnLine(line)) { /* fallthrough */ }
    else if (FOOD_ORDER_RE.test(line) && !svcAnywhere) continue;

    const planName = line.match(PLAN_NAME_RE);
    if (svcAnywhere) lastKnown = svcAnywhere;
    else if (planName && !amtOnLine(line)) {
      lastKnown = {
        name: planName[1].trim(),
        category: "Other",
        cancel: "Check the service's subscription page",
      };
    }

    // remember billing period from a term line like "Oct 1, 2026 - Sep 30, 2027"
    const term = line.match(TERM_RANGE_RE);
    if (term) {
      const m1 = MONTHS[term[1].slice(0, 3).toLowerCase()];
      const m2 = MONTHS[term[3].slice(0, 3).toLowerCase()];
      if (m1 !== undefined && m2 !== undefined) {
        // inclusive month span: Oct 2026 - Sep 2027 = 12 months
        const span = (parseInt(term[4], 10) - parseInt(term[2], 10)) * 12 + (m2 - m1) + 1;
        if (span >= 1 && span <= 36) lastTermMonths = span;
      }
    }

    // amount: currency-prefixed (₹/Rs/INR) or, failing that, a bare decimal
    // on a payment-context line
    let amount = null;
    const amtMatch = [...line.matchAll(CHARGE_RE)];
    if (amtMatch.length) amount = parseFloat(amtMatch[0][1].replace(/,/g, ""));
    else if (PAYMENT_CONTEXT_RE.test(line)) {
      const bare = line.match(BARE_AMOUNT_RE);
      if (bare) amount = parseFloat(bare[1].replace(/,/g, ""));
    }
    if (!amount || amount < 10) continue;

    const svc = svcAnywhere || lastKnown;
    let name = svc ? svc.name : guessName(line);
    if (!name) continue;
    // guessed names that swallowed the currency token ("Chicken Biryani Rs")
    // are OCR noise from item lines, not services
    if (!svc && /(rs\.?|inr|₹)$/i.test(name)) continue;

    // months covered by one payment: explicit keyword > term span > monthly
    let monthsPerPayment = 1;
    if (/\b(annual|yearly|per year|\/ ?year|12[- ]month)\b/i.test(line)) monthsPerPayment = 12;
    else if (/\b(quarterly|per quarter)\b/i.test(line)) monthsPerPayment = 3;
    else if (/\b(weekly|per week)\b/i.test(line)) monthsPerPayment = 52 / 12;
    else if (lastTermMonths) monthsPerPayment = lastTermMonths;

    const autopay = AUTOPAY_RE.test(line);
    const dateMatch = line.match(/(\d{1,2}[-\/][A-Za-z]{3}[-\/]\d{2,4})|(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/);
    const sub = {
      name,
      amount,                              // as billed (one payment)
      monthsPerPayment,                    // payment covers this many months
      monthly: Math.round((amount / monthsPerPayment) * 100) / 100, // normalized per-month
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

  const monthlyTotal = subs.reduce((sum, s) => sum + s.monthly, 0);
  return { subs, monthlyTotal, duplicates };
}

/** Does the line carry any currency-prefixed amount? */
function amtOnLine(line) {
  return [...line.matchAll(CHARGE_RE)].length > 0;
}

/** Fallback name guess: longest capitalized token cluster in the line */
function guessName(line) {
  const words = line.match(/[A-Za-z][A-Za-z&. ]{2,}/g);
  if (!words) return null;
  let best = words.sort((a, b) => b.length - a.length)[0].trim();
  best = best.replace(/^(plan|last|payment|paid)\s+/i, "").trim();
  return best.length > 2 ? best : null;
}

/** Leak Score 0–100: 100 = no leaks, decaying smoothly with size & count. */
function leakScore(subs, monthlyTotal) {
  if (!subs.length) return 100;
  // exponential decay on the money leak: ₹500/mo → ~57, ₹2645/mo → ~7
  const moneyPart = 100 * Math.exp(-monthlyTotal / 900);
  // each extra subscription multiplies away a little more (max ×0.75)
  const countFactor = 1 - Math.min(0.25, (subs.length - 1) * 0.05);
  return Math.max(0, Math.min(100, Math.round(moneyPart * countFactor)));
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
    const mpp = s.monthsPerPayment || 1;
    const billed = mpp === 12 ? `Rs ${s.amount}/yr` : mpp === 3 ? `Rs ${s.amount}/quarter` : `Rs ${s.amount}/mo`;
    out += `- ${s.name} : ${billed} (= Rs ${s.monthly}/mo) (${s.category}${s.autopay ? ", UPI AutoPay" : ""}) -> ${s.cancel}\n`;
  });
  if (parsed.duplicates.length) {
    out += "\nFLAGGED\n";
    parsed.duplicates.forEach(d => (out += `- Duplicate: ${d}\n`));
  }
  out += "\nACTION: cancel or pause the flagged items above.\n";
  out += "Generated on-device. No data left this phone.\n";
  return out;
}
