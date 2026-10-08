/**
 * pdf.js, imported lazily by PdfView so the library and its worker load only
 * when a PDF is opened. The legacy build carries the core-js polyfills the
 * pinned Electron's Chromium lacks (Map#getOrInsertComputed, Math.sumPrecise);
 * the worker is emitted as a same-origin asset by Vite (`?url`), which the
 * CSP's `worker-src 'self'` allows.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export { getDocument };
