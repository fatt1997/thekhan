// marks.js: บุ๊กมาร์ก 2 แบบ
// - bookmarks: บุ๊กมาร์กถาวร [{ page, note, createdAt }] เรียงตามเลขหน้า
// - history:   หน้าที่อ่านถึง [{ page, savedAt }] เรียงเก่าไปใหม่ ล่าสุดอยู่ท้ายสุด (FR4)

import { get, put } from "./db.js";
import { toast, openSheet, closeSheet, escapeHTML, formatDate } from "./ui.js";
import * as sync from "./sync.js";

// เก็บประวัติกี่รายการต่อเล่ม (0 = ไม่จำกัด) ตั้งค่าได้ในหน้าตั้งค่า
export const historyLimit = () => parseInt(localStorage.getItem("historyLimit") || "10", 10);

export async function loadMarks(bookId) {
  return (await get("marks", bookId)) || { bookId, bookmarks: [], history: [], updatedAt: 0 };
}

async function saveMarks(marks) {
  marks.updatedAt = Date.now();
  await put("marks", marks);
  sync.marksChanged(marks.bookId);
}

export const lastRead = (marks) => marks.history[marks.history.length - 1] || null;
export const isBookmarked = (marks, page) => marks.bookmarks.some((b) => b.page === page);

/* ---------- 1. บันทึกหน้าที่อ่านถึง (ปุ่มสีน้ำเงิน) ---------- */
export async function saveReading(marks, page) {
  const history = marks.history;
  const last = history[history.length - 1];

  if (last && last.page === page) last.savedAt = Date.now(); // หน้าเดิมกับล่าสุด แค่อัปเดตเวลา
  else history.push({ page, savedAt: Date.now() });

  const limit = historyLimit();
  if (limit > 0 && history.length > limit) {
    history.splice(0, history.length - limit); // ตัดรายการเก่าสุดด้านบนออก
  }

  await saveMarks(marks);
  toast(`บันทึกว่าอ่านถึงหน้า ${page} แล้ว`);
}

/* ---------- 2. เพิ่มหรือแก้บุ๊กมาร์กถาวร (ปุ่มสีเหลือง) ---------- */
export function showBookmarkSheet(marks, page, onChange) {
  const existing = marks.bookmarks.find((b) => b.page === page);

  const sheet = openSheet(`
    <h2>${existing ? "แก้บุ๊กมาร์กหน้า " : "บุ๊กมาร์กหน้า "}${page}</h2>
    <label class="field">
      <span>ชื่อบทหรือโน้ตสั้นๆ</span>
      <input id="bm-note" maxlength="80" value="${escapeHTML(existing ? existing.note : "")}" placeholder="เช่น บทที่ 2">
    </label>
    <div class="btn-row">
      ${existing ? `<button class="btn btn-ghost btn-danger" id="bm-delete">ลบบุ๊กมาร์ก</button>` : ""}
      <button class="btn btn-primary" id="bm-save">บันทึกบุ๊กมาร์ก</button>
    </div>`);

  const input = sheet.querySelector("#bm-note");
  setTimeout(() => input.focus(), 250);

  const save = async () => {
    const note = input.value.trim();
    if (existing) existing.note = note;
    else marks.bookmarks.push({ page, note, createdAt: Date.now() });
    marks.bookmarks.sort((a, b) => a.page - b.page);
    await saveMarks(marks);
    closeSheet();
    toast(existing ? "บันทึกบุ๊กมาร์กแล้ว" : `บุ๊กมาร์กหน้า ${page} แล้ว`);
    onChange();
  };

  sheet.querySelector("#bm-save").onclick = save;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) save();
  });

  const del = sheet.querySelector("#bm-delete");
  if (del) del.onclick = async () => {
    marks.bookmarks = marks.bookmarks.filter((b) => b.page !== page);
    await saveMarks(marks);
    closeSheet();
    toast("ลบบุ๊กมาร์กแล้ว");
    onChange();
  };
}

/* ---------- 3. รายการบุ๊กมาร์กของเล่มนี้ (ปุ่ม ☰) ---------- */
export function showMarksList(marks, handlers) {
  const item = (page, sub, deleteAttr, latest = false) => `
    <div class="mk-item">
      <button class="mk-go" data-go="${page}">
        <b>หน้า ${page}</b>
        ${sub ? `<span class="${latest ? "mk-latest" : ""}">${escapeHTML(sub)}</span>` : ""}
      </button>
      <button class="mk-x" ${deleteAttr} aria-label="ลบหน้า ${page}">×</button>
    </div>`;

  const bookmarks = [...marks.bookmarks].sort((a, b) => a.page - b.page);
  const history = marks.history;

  const bmHTML = bookmarks.length
    ? bookmarks.map((b) => item(b.page, b.note, `data-del-bm="${b.page}"`)).join("")
    : `<div class="none">ยังไม่มี กดปุ่มสีเหลืองเพื่อบุ๊กมาร์กหน้าที่อยู่</div>`;

  const hiHTML = history.length
    ? history.map((h, i) => {
        const latest = i === history.length - 1;
        return item(h.page, (latest ? "ล่าสุด, " : "") + formatDate(h.savedAt), `data-del-hi="${i}"`, latest);
      }).join("")
    : `<div class="none">ยังไม่มี กดปุ่มสีน้ำเงินเพื่อบันทึกหน้าที่อ่านถึง</div>`;

  const sheet = openSheet(`
    <h2>ที่คั่นของเล่มนี้</h2>
    <div class="mk-section"><i class="mk-chip tab"></i>บุ๊กมาร์กถาวร</div>
    ${bmHTML}
    <div class="mk-section"><i class="mk-chip ribbon"></i>หน้าที่อ่านถึง</div>
    ${hiHTML}`);

  sheet.querySelectorAll("[data-go]").forEach((b) => {
    b.onclick = () => {
      closeSheet();
      handlers.onGo(parseInt(b.dataset.go, 10));
    };
  });

  sheet.querySelectorAll("[data-del-bm]").forEach((b) => {
    b.onclick = async () => {
      const page = parseInt(b.dataset.delBm, 10);
      marks.bookmarks = marks.bookmarks.filter((x) => x.page !== page);
      await saveMarks(marks);
      handlers.onChange();
      showMarksList(marks, handlers); // วาดรายการใหม่
    };
  });

  sheet.querySelectorAll("[data-del-hi]").forEach((b) => {
    b.onclick = async () => {
      marks.history.splice(parseInt(b.dataset.delHi, 10), 1);
      await saveMarks(marks);
      handlers.onChange();
      showMarksList(marks, handlers);
    };
  });
}
