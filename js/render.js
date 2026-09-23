// render.js: วาดหน้า PDF ทำรูปปก และทำภาพย่อทุกหน้าไว้ล่วงหน้า (NFR7)

import { get, getAll, put } from "./db.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MAX_PIXELS = 16000000; // iPhone จำกัดขนาดภาพบนจอ เกินนี้จะเป็นจอขาว
const THUMB_WIDTH = 360;     // ความกว้างภาพย่อ (px)
const THUMB_QUALITY = 0.6;   // คุณภาพ JPEG ของภาพย่อ
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. เปิดไฟล์ PDF จากตู้ในเครื่อง ---------- */
export async function openPdf(bookId) {
  const record = await get("pdfs", bookId);
  if (!record) throw new Error("ไม่พบไฟล์ในเครื่อง");
  const data = await record.blob.arrayBuffer();
  return pdfjsLib.getDocument({ data }).promise;
}

/* ---------- 2. วาดหน้าให้คมตามจอ ---------- */
// คืนค่า { canvas, promise, cancel } เพื่อให้หน้าอ่านยกเลิกงานได้ถ้าเลื่อนผ่านไปเร็ว
export function startRender(page, cssWidth) {
  const base = page.getViewport({ scale: 1 });
  const wanted = (cssWidth / base.width) * (window.devicePixelRatio || 1);
  const limit = Math.sqrt(MAX_PIXELS / (base.width * base.height));
  const viewport = page.getViewport({ scale: Math.min(wanted, limit) });

  const canvas = blankCanvas(viewport.width, viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });

  return {
    canvas,
    promise: task.promise.then(() => canvas),
    cancel: () => task.cancel(),
  };
}

// วาดที่ความกว้างแน่นอน ใช้กับปกและภาพย่อ
async function renderAtPixelWidth(page, pixelWidth) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: pixelWidth / base.width });
  const canvas = blankCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

// ผืนผ้าใบพื้นขาว (ถ้าไม่ลงสีขาว หน้า PDF ที่โปร่งใสจะกลายเป็นสีดำตอนแปลงเป็น JPEG)
function blankCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width);
  canvas.height = Math.floor(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ---------- 3. รูปปกจากหน้าแรก ---------- */
export async function makeCover(pdf) {
  const page = await pdf.getPage(1);
  const canvas = await renderAtPixelWidth(page, 300);
  page.cleanup();
  return canvas.toDataURL("image/jpeg", 0.7);
}

/* ---------- 4. ภาพย่อทุกหน้า ---------- */
export async function getThumb(bookId, pageNum) {
  const record = await get("thumbs", [bookId, pageNum]);
  return record ? record.image : null;
}

const queue = [];            // รหัสหนังสือที่รอทำภาพย่อ
const progress = new Map();  // รหัสหนังสือ → 0 ถึง 1
let listener = () => {};
let running = false;
let readerActive = false;

export function onThumbProgress(fn) { listener = fn; }

export function thumbProgress(bookId) {
  return progress.has(bookId) ? progress.get(bookId) : null;
}

// ระหว่างอ่านหนังสือ ให้ทำภาพย่อช้าลง หน้าอ่านจะได้ไม่กระตุก
export function setReaderActive(value) { readerActive = value; }

export function queueThumbs(bookId) {
  if (!queue.includes(bookId)) queue.push(bookId);
  runQueue();
}

// เปิดแอปใหม่ ทำภาพย่อที่ค้างไว้ต่อจากเดิม
export async function resumeThumbs() {
  const books = await getAll("books");
  for (const b of books) {
    if (b.numPages && (b.thumbsDone || 0) < b.numPages) queueThumbs(b.id);
  }
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const bookId = queue[0];
    try {
      await makeThumbs(bookId);
    } catch (err) {
      console.warn("ทำภาพย่อไม่สำเร็จ", err);
    }
    queue.shift();
    progress.delete(bookId);
    listener(bookId);
  }
  running = false;
}

async function makeThumbs(bookId) {
  const book = await get("books", bookId);
  if (!book) return;

  const pdf = await openPdf(bookId);
  try {
    const total = pdf.numPages;
    for (let n = (book.thumbsDone || 0) + 1; n <= total; n++) {
      const page = await pdf.getPage(n);
      const canvas = await renderAtPixelWidth(page, THUMB_WIDTH);
      page.cleanup();
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", THUMB_QUALITY));
      canvas.width = canvas.height = 0; // คืนหน่วยความจำทันที

      const latest = await get("books", bookId);
      if (!latest) return; // หนังสือถูกลบระหว่างทำ
      await put("thumbs", { bookId, page: n, image: blob });

      // จดความคืบหน้าทุก 10 หน้า ถ้าปิดแอปกลางทาง ครั้งหน้าจะทำต่อจากตรงนี้
      if (n % 10 === 0 || n === total) {
        latest.thumbsDone = n;
        await put("books", latest);
      }

      progress.set(bookId, n / total);
      listener(bookId);
      await sleep(readerActive ? 150 : 5); // พักให้หน้าจอได้ทำงานอื่น
    }
  } finally {
    pdf.destroy();
  }
}
