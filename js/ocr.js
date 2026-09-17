/* ============================================================
   LeakGuard — on-device OCR wrapper (Tesseract.js)
   Runs fully in the phone's browser. No server, no upload.
   ============================================================ */

/**
 * Run OCR on an image file/blob.
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
  onProgress(15, "Reading image…");
  const { data } = await worker.recognize(imageFile);
  await worker.terminate();
  onProgress(100, "Done");
  return data.text;
}
