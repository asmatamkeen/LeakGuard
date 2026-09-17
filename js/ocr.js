/* ============================================================
   LeakGuard — on-device OCR wrapper (Tesseract.js)
   Runs fully in the phone's browser. No server, no upload.
   ============================================================ */

/**
 * Preprocess an image for better OCR accuracy: upscale 2x, grayscale,
 * and boost contrast. Returns a canvas Tesseract can read directly.
 */
async function preprocessImage(imageFile) {
  const url = URL.createObjectURL(imageFile);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  const scale = Math.max(1, 900 / Math.max(img.width, img.height)); // aim ~900px+ on the long edge
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  // grayscale + gentle contrast stretch
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  let min = 255, max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < px.length; i += 4) {
    const v = ((px[i] - min) / range) * 255;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/**
 * Run OCR on an image file/blob (preprocessed for accuracy).
 * @param {File|Blob} imageFile
 * @param {(progress: number, status: string) => void} onProgress
 * @returns {Promise<string>} extracted text
 */
async function runOCR(imageFile, onProgress = () => {}) {
  onProgress(5, "Loading on-device OCR engine…");
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        onProgress(10 + Math.round(m.progress * 85), "Reading text…");
      }
    },
  });
  onProgress(15, "Cleaning image…");
  const canvas = await preprocessImage(imageFile);
  const { data } = await worker.recognize(canvas);
  await worker.terminate();
  onProgress(100, "Done");
  return data.text;
}
