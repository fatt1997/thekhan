// settings.js: หน้าตั้งค่า

import { showScreen, toast, formatSize, formatDate, escapeHTML } from "./ui.js";
import { storageUsage } from "./db.js";
import { currentUser, hasToken, requestToken, signOut, authError } from "./auth.js";
import * as sync from "./sync.js";

const screen = document.getElementById("screen-settings");
let onSignedOut = () => {};

export function initSettings({ onSignedOut: handler }) {
  onSignedOut = handler;
  // สถานะซิงก์เปลี่ยน ให้อัปเดตเฉพาะส่วน Drive ถ้าหน้านี้เปิดอยู่
  sync.onSyncChange(() => {
    if (!screen.hidden) renderDrive();
  });
}

export function openSettings() {
  render();
  showScreen("settings");
}

function render() {
  const user = currentUser() || { name: "", email: "", picture: "" };
  const pageMode = localStorage.getItem("defaultPageMode") || "swipe";
  const limit = localStorage.getItem("historyLimit") || "10";
  const limits = [
    ["5", "5 รายการล่าสุด"],
    ["10", "10 รายการล่าสุด"],
    ["20", "20 รายการล่าสุด"],
    ["0", "ไม่จำกัด"],
  ];

  screen.innerHTML = `
    <header class="lib-top">
      <button class="lib-back" id="st-back">‹ ชั้นหนังสือ</button>
      <h1>ตั้งค่า</h1>
    </header>

    <section class="card">
      <div class="st-user">
        <div class="avatar big">${user.picture
          ? `<img src="${escapeHTML(user.picture)}" alt="" referrerpolicy="no-referrer">`
          : escapeHTML((user.name || "?").slice(0, 1))}</div>
        <div class="st-who">
          <div class="st-name">${escapeHTML(user.name)}</div>
          <div class="small">${escapeHTML(user.email)}</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost btn-danger" id="st-signout">ออกจากระบบ</button>
      </div>
    </section>

    <section class="card">
      <div class="st-label">Google Drive</div>
      <div class="small" id="st-drive"></div>
      <div class="btn-row" id="st-drive-actions"></div>
    </section>

    <section class="card">
      <div class="st-label">วิธีเปลี่ยนหน้าของเล่มใหม่</div>
      <label class="st-radio">
        <input type="radio" name="pagemode" value="swipe" ${pageMode === "swipe" ? "checked" : ""}>
        <span>ปัดซ้าย-ขวา</span>
      </label>
      <label class="st-radio">
        <input type="radio" name="pagemode" value="scroll" ${pageMode === "scroll" ? "checked" : ""}>
        <span>เลื่อนขึ้น-ลง</span>
      </label>
      <div class="small">เล่มที่เปิดอ่านแล้วจะจำโหมดของตัวเองไว้ ค่านี้ใช้กับเล่มที่เพิ่มใหม่</div>
    </section>

    <section class="card">
      <label class="field">
        <span>เก็บประวัติหน้าที่อ่านไว้กี่รายการต่อเล่ม</span>
        <select id="st-limit">
          ${limits.map(([v, label]) => `<option value="${v}" ${v === limit ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
    </section>

    <section class="card">
      <div class="st-label">พื้นที่ในเครื่องนี้</div>
      <div class="small" id="st-usage">กำลังคำนวณ…</div>
    </section>`;

  screen.querySelector("#st-back").onclick = () => showScreen("library");

  screen.querySelectorAll('input[name="pagemode"]').forEach((input) => {
    input.onchange = () => {
      localStorage.setItem("defaultPageMode", input.value);
      toast("บันทึกแล้ว");
    };
  });

  screen.querySelector("#st-limit").onchange = (e) => {
    localStorage.setItem("historyLimit", e.target.value);
    toast("บันทึกแล้ว");
  };

  screen.querySelector("#st-signout").onclick = () => {
    if (!confirm("ออกจากระบบ?\nไฟล์ในเครื่องของบัญชีนี้ยังอยู่ ล็อกอินกลับมาก็เห็นเหมือนเดิม")) return;
    signOut();
    onSignedOut();
  };

  renderDrive();
  storageUsage().then((bytes) => {
    const el = screen.querySelector("#st-usage");
    if (el) el.textContent = `ใช้ไปประมาณ ${formatSize(bytes)}`;
  });
}

function renderDrive() {
  const status = screen.querySelector("#st-drive");
  const actions = screen.querySelector("#st-drive-actions");
  if (!status) return;

  const last = sync.lastSync();
  const lastText = last ? `ซิงก์ล่าสุด ${formatDate(last)}` : "ยังไม่เคยซิงก์";
  const texts = {
    syncing: "กำลังซิงก์…",
    idle: `เชื่อมต่อแล้ว ${lastText}`,
    error: `ซิงก์ไม่สำเร็จ ลองใหม่อีกครั้ง (${lastText})`,
    offline: `หมดเวลาเชื่อมต่อ (ปกติประมาณ 1 ชั่วโมงต่อครั้ง) ไฟล์ในเครื่องยังอ่านได้ตามปกติ ${lastText}`,
  };
  const state = sync.syncState();
  status.textContent = texts[state] || lastText;

  if (!hasToken()) {
    actions.innerHTML = `<button class="btn btn-primary" id="st-connect">เชื่อมต่ออีกครั้ง</button>`;
    screen.querySelector("#st-connect").onclick = (e) => {
      e.currentTarget.disabled = true;
      requestToken(true)
        .then(() => {
          toast("เชื่อมต่อแล้ว");
          sync.syncNow();
          renderDrive();
        })
        .catch((err) => {
          toast(authError(err), 4000);
          renderDrive();
        });
    };
    return;
  }

  actions.innerHTML = `<button class="btn btn-ghost" id="st-sync" ${state === "syncing" ? "disabled" : ""}>ซิงก์ตอนนี้</button>`;
  screen.querySelector("#st-sync").onclick = () => {
    sync.syncNow();
    toast("เริ่มซิงก์แล้ว");
  };
}
