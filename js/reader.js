// reader.js: หน้าอ่าน PDF เต็มจอ 2 โหมด
// - swipe:  ปัดซ้าย-ขวา ทีละหน้า (ใช้ scroll-snap ของเบราว์เซอร์ จึงลื่นเหมือนแอปจริง)
// - scroll: เลื่อนขึ้น-ลง หน้าต่อกันยาว
// หลักการไม่ให้มีหน้าขาว (NFR7):
//   1) ทุกหน้ามีภาพย่อพร้อมแสดงทันที
//   2) ภาพคมวาดทับทีหลัง เฉพาะหน้าที่อยู่ใกล้ๆ และวาดตอนหยุดเลื่อน
//   3) เก็บภาพคมไว้จำนวนจำกัด หน่วยความจำ iPhone จะได้ไม่เต็ม

import { get, put, getThumbs } from "./db.js";
import { showScreen, toast } from "./ui.js";
import { openPdf, startRender, getThumb, setReaderActive } from "./render.js";
import { loadMarks, lastRead, isBookmarked, saveReading, showBookmarkSheet, showMarksList } from "./marks.js";
import * as sync from "./sync.js";

const GAP = 10;           // ช่องว่างระหว่างหน้าในโหมดเลื่อน (px)
const MAX_ZOOM = 4;
const THUMB_AHEAD = 12;   // เตรียมภาพย่อไว้หน้า-หลังกี่หน้า
const SHARP_AHEAD = 2;    // เตรียมภาพคมไว้หน้า-หลังกี่หน้า
const IDLE_MS = 120;      // หยุดเลื่อนนานเท่านี้ ค่อยเริ่มวาดภาพคม

const ICON_SWIPE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>`;
const ICON_SCROLL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
const ICON_LIST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`;
const ICON_RIBBON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 2h8v20l-4-3-4 3z"/></svg>`;
const ICON_TAB = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h12v20l-6-4.5L6 22z"/></svg>`;

const screen = document.getElementById("screen-reader");
let onCloseHandler = () => {};
let reader, viewport, strip;
const els = {};

// สถานะทั้งหมดของหน้าอ่าน
const S = {
  book: null, pdf: null, marks: null,
  page: 1, total: 1, aspect: 1.414,
  mode: "swipe", zoom: 1,
  pageW: 0, pageH: 0, slotW: 0, slotH: 0,
  slots: [],               // element ของแต่ละหน้า
  thumbBlobs: new Map(),   // หน้า → Blob ภาพย่อ
  thumbURLs: new Map(),    // หน้า → URL ของภาพย่อที่แสดงอยู่
  missing: new Map(),      // หน้า → เวลาที่ลองหาภาพย่อล่าสุด
  sharp: new Map(),        // หน้า → { canvas, width, job, done }
  queue: [],               // หน้าที่รอวาดภาพคม
  pumping: false,
  pinch: null, pinching: false, lastGesture: 0,
  idleTimer: 0, rafScroll: 0, resizeTimer: 0,
  session: 0,              // เปลี่ยนทุกครั้งที่เปิดเล่มใหม่ กันงานของเล่มเก่ามาปน
};

const clamp = (n) => Math.min(S.total, Math.max(1, n));
const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(1, z));
const pageEl = (n) => S.slots[n - 1];
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/* =========================================================
   1. เริ่มต้น: สร้างหน้าจอครั้งเดียว
   ========================================================= */
export function initReader({ onClose }) {
  onCloseHandler = onClose;

  screen.innerHTML = `
    <div class="reader" id="reader">
      <div class="rd-viewport" id="rd-viewport"><div class="rd-strip" id="rd-strip"></div></div>
      <div class="rd-loading" id="rd-loading">กำลังเปิดหนังสือ…</div>

      <header class="rd-top">
        <button class="rd-btn" id="rd-back" aria-label="กลับไปชั้นหนังสือ">${ICON_BACK}</button>
        <div class="rd-title" id="rd-title"></div>
        <button class="rd-btn" id="rd-mode" aria-label="สลับวิธีเปลี่ยนหน้า"></button>
        <button class="rd-btn" id="rd-list" aria-label="รายการบุ๊กมาร์ก">${ICON_LIST}</button>
      </header>

      <footer class="rd-bottom">
        <div class="rd-scrub">
          <div class="rd-track" id="rd-track"></div>
          <input type="range" id="rd-range" min="1" max="1" value="1" aria-label="เลื่อนไปหน้า">
        </div>
        <div class="rd-row">
          <button class="rd-btn" id="rd-prev" aria-label="หน้าก่อน">${ICON_BACK}</button>
          <div class="rd-pagebox">หน้า <input id="rd-page" inputmode="numeric" aria-label="เลขหน้า"> / <span id="rd-total"></span></div>
          <button class="rd-btn" id="rd-next" aria-label="หน้าถัดไป">${ICON_NEXT}</button>
        </div>
        <div class="rd-actions">
          <button class="rd-act read" id="rd-save">${ICON_RIBBON}บันทึกหน้าที่อ่าน</button>
          <button class="rd-act mark" id="rd-mark">${ICON_TAB}<span id="rd-mark-label">บุ๊กมาร์กหน้านี้</span></button>
        </div>
      </footer>
    </div>`;

  reader = document.getElementById("reader");
  viewport = document.getElementById("rd-viewport");
  strip = document.getElementById("rd-strip");
  for (const id of ["loading", "title", "mode", "list", "track", "range", "prev", "next", "page", "total", "save", "mark", "mark-label", "back"]) {
    els[id] = document.getElementById("rd-" + id);
  }

  // ปุ่มในเมนู
  els.back.onclick = closeReader;
  els.mode.onclick = toggleMode;
  els.list.onclick = () => showMarksList(S.marks, { onGo: goTo, onChange: marksUpdated });
  els.prev.onclick = () => goTo(S.page - 1);
  els.next.onclick = () => goTo(S.page + 1);
  els.page.onfocus = () => els.page.select();
  els.page.onchange = () => goTo(parseInt(els.page.value, 10) || S.page);
  els.range.oninput = () => { els.page.value = els.range.value; };
  els.range.onchange = () => goTo(parseInt(els.range.value, 10));
  els.save.onclick = async () => {
    await saveReading(S.marks, S.page);
    renderTrack();
  };
  els.mark.onclick = () => showBookmarkSheet(S.marks, S.page, marksUpdated);

  // แตะหนึ่งครั้ง = เปิดหรือปิดเมนู (ไม่นับตอนเพิ่งปัดหรือซูม)
  viewport.addEventListener("click", () => {
    if (Date.now() - S.lastGesture < 400) return;
    setMenu(!reader.classList.contains("menu-open"));
  });

  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("touchstart", onTouchStart, { passive: false });
  viewport.addEventListener("touchmove", onTouchMove, { passive: false });
  viewport.addEventListener("touchend", onTouchEnd);
  viewport.addEventListener("touchcancel", onTouchEnd);
  viewport.addEventListener("wheel", onWheel, { passive: false });

  // กันไม่ให้ Safari ซูมทั้งหน้าเว็บเอง
  document.addEventListener("gesturestart", (e) => {
    if (S.pdf) e.preventDefault();
  });

  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKey);
}

/* =========================================================
   2. เปิดและปิดหนังสือ
   ========================================================= */
export async function openReader(bookId) {
  const book = await get("books", bookId);
  if (!book) return;

  cleanup();
  const session = ++S.session;
  S.book = book;
  S.mode = book.pageMode === "scroll" ? "scroll" : "swipe";
  S.zoom = 1;

  setMenu(false);
  els.title.textContent = book.name;
  els.loading.textContent = "กำลังเปิดหนังสือ…";
  els.loading.hidden = false;
  showScreen("reader");
  setReaderActive(true);

  try {
    const [pdf, marks, thumbs] = await Promise.all([
      openPdf(bookId), loadMarks(bookId), getThumbs(bookId),
    ]);
    if (session !== S.session) {
      pdf.destroy();
      return;
    }
    S.pdf = pdf;
    S.marks = marks;
    S.total = pdf.numPages;
    for (const t of thumbs) S.thumbBlobs.set(t.page, t.image);

    // ใช้สัดส่วนของหน้าแรกกับทุกหน้า
    const first = await pdf.getPage(1);
    const size = first.getViewport({ scale: 1 });
    S.aspect = size.height / size.width;

    // เปิดที่หน้าที่อ่านถึงล่าสุด (FR5)
    const last = lastRead(marks);
    S.page = last ? clamp(last.page) : 1;

    els.range.max = S.total;
    els.total.textContent = S.total;

    buildSlots();
    layout();
    scrollToPage(S.page);
    refreshThumbs();
    scheduleSharp();
    updateUI();
    els.loading.hidden = true;

    if (!localStorage.getItem("readerHint")) {
      toast("แตะหนึ่งครั้งเพื่อเปิดเมนู", 3000);
      localStorage.setItem("readerHint", "1");
    }
  } catch (err) {
    els.loading.textContent = "เปิดหนังสือไม่ได้: " + err.message;
  }
}

function closeReader() {
  cleanup();
  setReaderActive(false);
  onCloseHandler();
}

// คืนหน่วยความจำทั้งหมดของเล่มเดิม
function cleanup() {
  S.session++;
  clearTimeout(S.idleTimer);
  for (const p of [...S.sharp.keys()]) dropSharp(p);
  for (const url of S.thumbURLs.values()) URL.revokeObjectURL(url);
  S.thumbURLs.clear();
  S.thumbBlobs.clear();
  S.missing.clear();
  S.queue = [];
  S.slots = [];
  if (strip) strip.innerHTML = "";
  if (S.pdf) S.pdf.destroy();
  S.pdf = null;
  S.marks = null;
}

/* =========================================================
   3. จัดหน้า
   ========================================================= */
function buildSlots() {
  const frag = document.createDocumentFragment();
  S.slots = [];
  for (let n = 1; n <= S.total; n++) {
    const slot = document.createElement("div");
    slot.className = "rd-slot";
    const pg = document.createElement("div");
    pg.className = "rd-page";
    pg.dataset.page = n;
    slot.appendChild(pg);
    frag.appendChild(slot);
    S.slots.push(pg);
  }
  strip.innerHTML = "";
  strip.appendChild(frag);
  markFlags();
}

// คำนวณขนาดหน้าแล้วส่งให้ CSS ทีเดียว (เปลี่ยนตัวแปร CSS 4 ตัว ทุกหน้าเปลี่ยนตาม)
function layout() {
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  const swipe = S.mode === "swipe";

  const fitW = swipe ? Math.min(vw, vh / S.aspect) : Math.min(vw - 2 * GAP, 900);
  S.pageW = Math.round(fitW * S.zoom);
  S.pageH = Math.round(S.pageW * S.aspect);
  S.slotW = swipe ? Math.max(vw, S.pageW) : S.pageW;
  S.slotH = swipe ? Math.max(vh, S.pageH) : S.pageH;

  reader.dataset.mode = S.mode;
  reader.classList.toggle("zoomed", S.zoom > 1);
  strip.style.setProperty("--page-w", S.pageW + "px");
  strip.style.setProperty("--page-h", S.pageH + "px");
  strip.style.setProperty("--slot-w", S.slotW + "px");
  strip.style.setProperty("--slot-h", S.slotH + "px");
}

function pageFromScroll() {
  if (S.mode === "swipe") return clamp(Math.round(viewport.scrollLeft / S.slotW) + 1);
  const center = viewport.scrollTop + viewport.clientHeight / 2 - GAP;
  return clamp(Math.floor(center / (S.slotH + GAP)) + 1);
}

function scrollToPage(n) {
  if (S.mode === "swipe") viewport.scrollLeft = (n - 1) * S.slotW;
  else viewport.scrollTop = (n - 1) * (S.slotH + GAP);
}

function goTo(n) {
  if (!S.pdf) return;
  S.page = clamp(n);
  scrollToPage(S.page);
  updateUI();
  refreshThumbs();
  scheduleSharp();
}

/* =========================================================
   4. ภาพย่อ: แสดงทันที ไม่มีหน้าขาว
   ========================================================= */
function refreshThumbs() {
  const n = S.page;
  // ทิ้งภาพย่อที่อยู่ไกลเกินไป
  for (const p of [...S.thumbURLs.keys()]) {
    if (Math.abs(p - n) > THUMB_AHEAD * 2) dropThumb(p);
  }
  // เตรียมภาพย่อรอบๆ หน้าปัจจุบัน
  for (let p = Math.max(1, n - THUMB_AHEAD); p <= Math.min(S.total, n + THUMB_AHEAD); p++) {
    showThumb(p);
  }
  // ภาพคมเก่าที่อยู่ไกลแล้ว ถอดออกจากจอ
  for (const canvas of strip.querySelectorAll("canvas.rd-sharp")) {
    const p = parseInt(canvas.parentNode.dataset.page, 10);
    const entry = S.sharp.get(p);
    if ((!entry || entry.canvas !== canvas) && Math.abs(p - n) > SHARP_AHEAD + 1) {
      canvas.remove();
      canvas.width = canvas.height = 0;
    }
  }
}

function showThumb(p) {
  if (S.thumbURLs.has(p)) return;
  const blob = S.thumbBlobs.get(p);
  if (!blob) {
    fetchMissingThumb(p);
    return;
  }
  const url = URL.createObjectURL(blob);
  S.thumbURLs.set(p, url);
  const img = document.createElement("img");
  img.className = "rd-thumb";
  img.alt = "";
  img.decoding = "async";
  img.src = url;
  pageEl(p).prepend(img);
}

function dropThumb(p) {
  URL.revokeObjectURL(S.thumbURLs.get(p));
  S.thumbURLs.delete(p);
  const img = pageEl(p) && pageEl(p).querySelector(".rd-thumb");
  if (img) img.remove();
}

// ภาพย่อหน้านี้อาจเพิ่งทำเสร็จหลังเปิดหนังสือ ลองหาใหม่ทุก 3 วินาที
async function fetchMissingThumb(p) {
  const now = Date.now();
  if (now - (S.missing.get(p) || 0) < 3000) return;
  S.missing.set(p, now);
  const session = S.session;
  const blob = await getThumb(S.book.id, p);
  if (blob && session === S.session) {
    S.thumbBlobs.set(p, blob);
    showThumb(p);
  }
}

/* =========================================================
   5. ภาพคม: วาดทับภาพย่อ เฉพาะหน้าใกล้ๆ
   ========================================================= */
function deferSharp() {
  clearTimeout(S.idleTimer);
  S.idleTimer = setTimeout(scheduleSharp, IDLE_MS);
}

function cacheLimit() {
  return S.zoom > 1.5 ? 3 : 2 * SHARP_AHEAD + 3;
}

function scheduleSharp() {
  if (!S.pdf) return;
  const n = S.page;
  const wanted = [n];
  for (let i = 1; i <= SHARP_AHEAD; i++) wanted.push(n + i, n - i);
  const list = wanted.filter((p) => p >= 1 && p <= S.total);
  const wantedSet = new Set(list);

  for (const [p, e] of [...S.sharp]) {
    if (e.width !== S.pageW) forgetSharp(p);          // ขนาดเปลี่ยน ต้องวาดใหม่ (ภาพเก่ายังแสดงไว้ก่อน)
    else if (!e.done && !wantedSet.has(p)) dropSharp(p); // ยังวาดไม่เสร็จแต่เลื่อนผ่านไปแล้ว ยกเลิก
  }

  // เกินโควตา ทิ้งหน้าที่ไกลที่สุดก่อน
  const far = [...S.sharp.keys()]
    .filter((p) => !wantedSet.has(p))
    .sort((a, b) => Math.abs(b - n) - Math.abs(a - n));
  while (S.sharp.size > cacheLimit() && far.length) dropSharp(far.shift());

  S.queue = list.filter((p) => !S.sharp.has(p));
  pump();
}

// วาดทีละหน้าตามลำดับความสำคัญ หน้าปัจจุบันก่อน
async function pump() {
  if (S.pumping) return;
  S.pumping = true;
  const session = S.session;
  try {
    while (S.queue.length && session === S.session) {
      const p = S.queue.shift();
      if (S.sharp.has(p)) continue;
      const width = S.pageW;
      const page = await S.pdf.getPage(p);
      if (session !== S.session) break;
      if (width !== S.pageW) continue;

      const job = startRender(page, width);
      const entry = { canvas: job.canvas, width, job, done: false };
      S.sharp.set(p, entry);
      try {
        await job.promise;
        entry.done = true;
        if (S.sharp.get(p) === entry) attachSharp(p, entry.canvas);
      } catch (err) {
        if (S.sharp.get(p) === entry) S.sharp.delete(p); // ถูกยกเลิก
      }
    }
  } catch (err) {
    console.warn("วาดหน้าไม่สำเร็จ", err);
  } finally {
    S.pumping = false;
  }
  if (session === S.session && S.queue.length) pump();
}

function attachSharp(p, canvas) {
  const pg = pageEl(p);
  if (!pg) return;
  for (const old of pg.querySelectorAll("canvas.rd-sharp")) {
    if (old !== canvas) {
      old.remove();
      old.width = old.height = 0;
    }
  }
  canvas.className = "rd-sharp";
  pg.appendChild(canvas);
}

// ลืมงานวาด แต่ปล่อยภาพเดิมไว้บนจอจนกว่าภาพใหม่จะเสร็จ
function forgetSharp(p) {
  const e = S.sharp.get(p);
  if (!e) return;
  if (!e.done) e.job.cancel();
  S.sharp.delete(p);
}

// ทิ้งภาพคมทั้งงานและภาพบนจอ
function dropSharp(p) {
  const e = S.sharp.get(p);
  if (!e) return;
  if (!e.done) e.job.cancel();
  e.canvas.remove();
  e.canvas.width = e.canvas.height = 0;
  S.sharp.delete(p);
}

/* =========================================================
   6. เลื่อน ปัด ซูม แตะ
   ========================================================= */
function onScroll() {
  if (S.rafScroll) return;
  S.rafScroll = requestAnimationFrame(() => {
    S.rafScroll = 0;
    if (!S.pdf || S.pinching) return;
    const n = pageFromScroll();
    if (n !== S.page) {
      S.page = n;
      updateUI();
    }
    refreshThumbs();
    deferSharp();
  });
}

function onTouchStart(e) {
  if (e.touches.length !== 2 || !S.pdf) return;
  const [a, b] = e.touches;
  const cx = (a.clientX + b.clientX) / 2;
  const cy = (a.clientY + b.clientY) / 2;
  S.pinch = { d0: dist(a, b), zoom0: S.zoom, scale: 1, ...focusAt(cx, cy) };

  const rect = viewport.getBoundingClientRect();
  const ox = viewport.scrollLeft + cx - rect.left;
  const oy = viewport.scrollTop + cy - rect.top;
  strip.style.transformOrigin = `${ox}px ${oy}px`;
  reader.classList.add("pinching");
  S.pinching = true;
}

function onTouchMove(e) {
  if (!S.pinching || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const raw = S.pinch.zoom0 * (dist(a, b) / S.pinch.d0);
  const visual = Math.min(MAX_ZOOM * 1.1, Math.max(0.85, raw)); // ยืดเกินได้นิดหน่อยให้รู้สึกเด้ง
  S.pinch.scale = visual / S.pinch.zoom0;
  strip.style.transform = `scale(${S.pinch.scale})`;
}

function onTouchEnd(e) {
  if (!S.pinching || e.touches.length > 1) return;
  const { zoom0, scale } = S.pinch;
  S.pinching = false;
  S.lastGesture = Date.now();
  strip.style.transform = "";
  reader.classList.remove("pinching");
  setZoom(clampZoom(zoom0 * scale), S.pinch);
}

// Mac: ถ่างนิ้วบน trackpad (เบราว์เซอร์ส่งมาเป็น wheel + ctrlKey)
function onWheel(e) {
  if (!e.ctrlKey || !S.pdf) return;
  e.preventDefault();
  setZoom(clampZoom(S.zoom * Math.exp(-e.deltaY * 0.01)), focusAt(e.clientX, e.clientY));
}

// จุดที่นิ้วอยู่ อยู่ตรงไหนของหน้าไหน (เป็นสัดส่วน 0 ถึง 1)
function focusAt(cx, cy) {
  const hit = document.elementFromPoint(cx, cy);
  const pg = hit && hit.closest(".rd-page");
  const page = pg ? parseInt(pg.dataset.page, 10) : S.page;
  const r = pageEl(page).getBoundingClientRect();
  return { page, fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height, cx, cy };
}

function setZoom(z, focus) {
  S.zoom = z < 1.05 ? 1 : z;
  layout();

  // เลื่อนให้จุดเดิมกลับมาอยู่ใต้นิ้ว
  const r = pageEl(focus.page).getBoundingClientRect();
  viewport.scrollLeft += r.left + focus.fx * r.width - focus.cx;
  viewport.scrollTop += r.top + focus.fy * r.height - focus.cy;

  if (S.mode === "swipe" && S.zoom === 1) scrollToPage(focus.page); // กลับมาพอดีจอ
  S.page = pageFromScroll();
  updateUI();
  refreshThumbs();
  deferSharp();
}

function onResize() {
  if (!S.pdf) return;
  clearTimeout(S.resizeTimer);
  S.resizeTimer = setTimeout(() => {
    const p = S.page;
    layout();
    scrollToPage(p);
    S.page = p;
    refreshThumbs();
    scheduleSharp();
  }, 150);
}

function onKey(e) {
  if (!S.pdf || screen.hidden || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowRight" || e.key === "PageDown") goTo(S.page + 1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") goTo(S.page - 1);
  else if (e.key === "Escape") setMenu(false);
}

/* =========================================================
   7. เมนูและบุ๊กมาร์ก
   ========================================================= */
function setMenu(open) {
  reader.classList.toggle("menu-open", open);
  if (open) {
    updateUI();
    renderTrack();
  }
}

function updateUI() {
  if (!S.marks) return;
  els.page.value = S.page;
  els.range.value = S.page;
  els.prev.disabled = S.page <= 1;
  els.next.disabled = S.page >= S.total;

  const on = isBookmarked(S.marks, S.page);
  els.mark.classList.toggle("on", on);
  els["mark-label"].textContent = on ? "หน้านี้มีบุ๊กมาร์ก" : "บุ๊กมาร์กหน้านี้";

  els.mode.innerHTML = S.mode === "swipe" ? ICON_SWIPE : ICON_SCROLL;
  els.mode.setAttribute("aria-label", S.mode === "swipe" ? "ตอนนี้ปัดซ้าย-ขวา แตะเพื่อเปลี่ยน" : "ตอนนี้เลื่อนขึ้น-ลง แตะเพื่อเปลี่ยน");
}

// แถบเลื่อนหน้า: น้ำเงิน = อ่านถึง, ขีดเหลือง = บุ๊กมาร์กถาวร
function renderTrack() {
  if (!S.marks) return;
  const percent = (p) => ((p - 1) / Math.max(1, S.total - 1)) * 100;
  const last = lastRead(S.marks);
  els.track.innerHTML =
    (last ? `<i class="fill" style="width:${Math.max(2, percent(last.page))}%"></i>` : "") +
    S.marks.bookmarks.map((b) => `<i class="tick" style="left:${percent(b.page)}%"></i>`).join("");
}

// ธงเหลืองมุมขวาบนของหน้าที่มีบุ๊กมาร์ก
function markFlags() {
  if (!S.marks) return;
  const pages = new Set(S.marks.bookmarks.map((b) => b.page));
  S.slots.forEach((pg, i) => pg.classList.toggle("marked", pages.has(i + 1)));
}

function marksUpdated() {
  markFlags();
  updateUI();
  renderTrack();
}

async function toggleMode() {
  const p = S.page;
  S.mode = S.mode === "swipe" ? "scroll" : "swipe";
  S.zoom = 1;
  layout();
  scrollToPage(p);
  S.page = p;
  refreshThumbs();
  scheduleSharp();
  updateUI();
  toast(S.mode === "swipe" ? "เปลี่ยนหน้าแบบปัดซ้าย-ขวา" : "เปลี่ยนหน้าแบบเลื่อนขึ้น-ลง");

  // จำโหมดแยกแต่ละเล่ม (อ่านข้อมูลล่าสุดก่อน เพราะระหว่างนี้ภาพย่ออาจอัปเดตข้อมูลเล่มนี้อยู่)
  const fresh = await get("books", S.book.id);
  if (!fresh) return;
  fresh.pageMode = S.mode;
  fresh.updatedAt = Date.now();
  await put("books", fresh);
  S.book = fresh;
  sync.bookChanged(fresh);
}
