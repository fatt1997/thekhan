// ui.js: ของที่ทุกหน้าใช้ร่วมกัน

const $ = (selector) => document.querySelector(selector);

/* ---------- 1. สลับหน้าจอ ---------- */
const screens = ["login", "library", "reader", "settings"];

export function showScreen(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
}

/* ---------- 2. ข้อความแจ้งเตือน (toast) ---------- */
let toastTimer;

export function toast(message, ms = 2200) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------- 3. แผ่นเลื่อนขึ้น (sheet) ---------- */
export function openSheet(html) {
  const sheet = $("#sheet");
  sheet.innerHTML = `<div class="sheet-grab"></div>${html}`;
  sheet.hidden = false;
  $("#backdrop").hidden = false;
  requestAnimationFrame(() => sheet.classList.add("open"));
  return sheet;
}

export function closeSheet() {
  const sheet = $("#sheet");
  sheet.classList.remove("open");
  $("#backdrop").hidden = true;
  setTimeout(() => {
    if (!sheet.classList.contains("open")) sheet.hidden = true;
  }, 220);
}

$("#backdrop").addEventListener("click", closeSheet);

/* ---------- 4. ตัวช่วย ---------- */
export function escapeHTML(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}

export function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function formatDate(time) {
  return new Date(time).toLocaleString("th-TH", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// รหัสสุ่ม 32 ตัวอักษร
export function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
