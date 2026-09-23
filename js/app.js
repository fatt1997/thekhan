// app.js: ผู้จัดการร้าน เริ่มแอปและต่อทุกส่วนเข้าด้วยกัน

import { showScreen, toast } from "./ui.js";
import { openDatabase, closeDatabase } from "./db.js";
import { initLibrary, renderLibrary, setAvatar } from "./library.js";
import { initReader, openReader } from "./reader.js";
import { initSettings, openSettings } from "./settings.js";
import { initAuth, restoreUser, signIn, authError } from "./auth.js";
import { resumeThumbs } from "./render.js";
import * as sync from "./sync.js";

const loginScreen = document.getElementById("screen-login");

/* ---------- หน้าล็อกอิน ---------- */
function renderLogin(message = "") {
  loginScreen.innerHTML = `
    <div class="login">
      <div class="login-mark" aria-hidden="true">
        <svg viewBox="0 0 48 48"><rect x="8" y="4" width="32" height="40" rx="3" fill="currentColor" opacity=".12"/>
        <path d="M26 4h9v26l-4.5-3.4L26 30z" fill="currentColor"/></svg>
      </div>
      <h1>ที่คั่น</h1>
      <p>อ่าน PDF และคั่นหน้าที่อ่านถึง ไฟล์และบุ๊กมาร์กเก็บใน Google Drive ของคุณเอง</p>
      <button class="btn btn-primary" id="login-btn">ล็อกอินด้วย Google</button>
      <p class="login-note" id="login-note">${message}</p>
    </div>`;

  document.getElementById("login-btn").onclick = async (e) => {
    const btn = e.currentTarget;
    const note = document.getElementById("login-note");
    btn.disabled = true;
    btn.textContent = "กำลังล็อกอิน…";
    note.textContent = "";
    try {
      const user = await signIn();
      await enterApp(user);
    } catch (err) {
      note.textContent = authError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = "ล็อกอินด้วย Google";
    }
  };
}

/* ---------- เข้าและออกจากแอป ---------- */
async function enterApp(user) {
  await openDatabase("u-" + user.sub); // ฐานข้อมูลแยกตามบัญชี (NFR6)
  setAvatar(user);
  await renderLibrary();
  showScreen("library");
  resumeThumbs();
  sync.start(user.sub);
}

function leaveApp() {
  sync.stop();
  closeDatabase();
  setAvatar(null);
  renderLogin();
  showScreen("login");
}

/* ---------- เริ่มแอป ---------- */
async function start() {
  renderLogin();

  initSettings({ onSignedOut: leaveApp });

  initReader({
    onClose: async () => {
      showScreen("library");
      await renderLibrary(); // อัปเดตแถบอ่านถึงบนปก
    },
  });

  initLibrary({
    onOpenBook: (bookId) => openReader(bookId),
    onOpenSettings: openSettings,
  });

  // กลับมาเปิดแอปอีกครั้ง ลองซิงก์ใหม่
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sync.syncNow();
  });

  try {
    await initAuth();
  } catch (err) {
    renderLogin(authError(err));
    showScreen("login");
    return;
  }

  const user = restoreUser();
  if (user) await enterApp(user);
  else showScreen("login");
}

start().catch((err) => toast("เริ่มแอปไม่สำเร็จ: " + err.message, 5000));
