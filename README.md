# 🛡️ LeakGuard — On-Device Subscription Leak Detector

**Track:** FinTech & Commerce · **Event:** iQOO Hyderabad Battle

LeakGuard finds the money silently leaking from bank accounts through forgotten
subscriptions and unnoticed UPI AutoPay mandates — using **100% on-device AI**.
Scan a paper bill with the camera or pick a bank SMS screenshot; OCR and a local
LLM run entirely on the phone. Airplane-mode friendly. No cloud. No data leaves
the device.

## ✨ Features
- 📷 **Camera / gallery scan** of statements, SMS, and receipts
- 🔍 **On-device OCR** (Tesseract.js) — no server
- 🤖 **Local AI parsing** — rule-based now, WebLLM (WebGPU) upgrade path
- 📊 **Leak dashboard** — monthly leak total, yearly projection, 0–100 Leak Score
- 💧 **Drip counter** — watch the money leak in real time
- 🚩 **Flags** — duplicates, UPI AutoPay mandates
- ✅ **Cancel/Keep actions** with live total drop
- 🌉 **Leak Report → laptop** via Office Kit bridge (file-share fallback)

## 🚀 Run it
```bash
# any static server works, e.g.:
npx serve .
# or: python -m http.server
```
Open on a phone (or phone-width browser window) and scan.

## 🏗️ Structure
```
index.html      phone-first app shell
css/styles.css  dark mobile theme
js/ocr.js       Tesseract.js wrapper (on-device)
js/parser.js    subscription extraction + Leak Score + report
js/app.js       navigation, pipeline, dashboard, drip counter
```

## 🔒 Privacy
Every computation — OCR, parsing, storage, report generation — happens on the
device. Nothing is uploaded, ever.

---
*Built by a 2-person first-time hackathon team with an AI pair-programmer workflow.*
