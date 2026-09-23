// library.js: พนักงานโซนชั้นหนังสือ แฟ้ม ปก เพิ่ม ย้าย เปลี่ยนชื่อ ลบ

import { get, getAll, put, remove, removeThumbs, requestPersist } from "./db.js";
import { toast, openSheet, closeSheet, escapeHTML, formatSize, makeId } from "./ui.js";
import { openPdf, makeCover, queueThumbs, thumbProgress, onThumbProgress } from "./render.js";
import * as sync from "./sync.js";

let currentFolderId = null;       // null = หน้าแรกสุดของชั้น
let openBookHandler = () => {};   // app.js ส่งฟังก์ชันเปิดหน้าอ่านมาให้
let longPressFired = false;
const downloads = new Map();      // driveId → ความคืบหน้าดาวน์โหลด 0 ถึง 1

const screen = document.getElementById("screen-library");
const sortByName = (a, b) => a.name.localeCompare(b.name, "th");
const defaultPageMode = () => localStorage.getItem("defaultPageMode") || "swipe";

const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>`;

/* =========================================================
   1. เริ่มต้น
   ========================================================= */
export function initLibrary({ onOpenBook, onOpenSettings = null }) {
  openBookHandler = onOpenBook;

  screen.innerHTML = `
    <header class="lib-top">
      <button class="lib-back" id="lib-back" hidden></button>
      <div class="lib-row">
        <h1 class="lib-title" id="lib-title">ชั้นหนังสือ</h1>
        <button class="avatar" id="lib-avatar" aria-label="ตั้งค่า" hidden></button>
        <button class="icon-btn" id="lib-add" aria-label="เพิ่ม">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </header>
    <div class="shelf" id="shelf"></div>
    <input type="file" id="file-input" accept="application/pdf,.pdf" multiple hidden>
  `;

  const shelf = document.getElementById("shelf");
  document.getElementById("lib-add").addEventListener("click", showAddMenu);
  document.getElementById("lib-back").addEventListener("click", goUp);
  document.getElementById("lib-title").addEventListener("click", showPath);
  shelf.addEventListener("click", onShelfClick);
  setupLongPress(shelf);

  if (onOpenSettings) {
    document.getElementById("lib-avatar").addEventListener("click", onOpenSettings);
  }

  document.getElementById("file-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = ""; // ล้างค่า จะได้เลือกไฟล์เดิมซ้ำได้
    await addFiles(files);
  });

  // ความคืบหน้าทำภาพย่อ: อัปเดตแค่แถบบนปก ไม่ต้องวาดทั้งชั้นใหม่
  onThumbProgress((bookId) => updateStatus(bookId));

  // ข้อมูลจาก Drive เปลี่ยน
  sync.onSyncChange((kind, id) => {
    if (kind === "progress") updateStatus(id);
    else renderLibrary();
  });
}

// แสดงรูปโปรไฟล์มุมบน (ใช้ตอนมีระบบล็อกอินแล้ว)
export function setAvatar(user) {
  const el = document.getElementById("lib-avatar");
  if (!user) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = user.picture
    ? `<img src="${escapeHTML(user.picture)}" alt="" referrerpolicy="no-referrer">`
    : escapeHTML((user.name || "?").slice(0, 1));
}

/* =========================================================
   2. วาดชั้นหนังสือ
   ========================================================= */
export async function renderLibrary() {
  const [folders, books, marks] = await Promise.all([
    getAll("folders"), getAll("books"), getAll("marks"),
  ]);

  const current = folders.find((f) => f.id === currentFolderId);
  if (currentFolderId && !current) currentFolderId = null;
  renderHeader(current, folders);

  const marksById = new Map(marks.map((m) => [m.bookId, m]));
  const subFolders = folders.filter((f) => f.parentId === currentFolderId).sort(sortByName);

  // หนังสือในเครื่อง และหนังสือที่อยู่บน Drive อย่างเดียว เรียงรวมกันตามชื่อ
  const items = [
    ...books.filter((b) => b.folderId === currentFolderId).map((b) => ({ kind: "book", name: b.name, data: b })),
    ...sync.getRemoteBooks(currentFolderId).map((r) => ({ kind: "remote", name: r.name, data: r })),
  ].sort(sortByName);

  const shelf = document.getElementById("shelf");

  if (!subFolders.length && !items.length) {
    shelf.innerHTML = `
      <div class="shelf-empty">
        <p>${currentFolderId ? "แฟ้มนี้ยังว่าง" : "ยังไม่มีหนังสือบนชั้น"}</p>
        <button class="btn btn-primary" data-action="add-pdf">เพิ่ม PDF</button>
      </div>`;
    return;
  }

  shelf.innerHTML =
    subFolders.map((f) => folderTile(f, folders, books)).join("") +
    items.map((it) => (it.kind === "book"
      ? bookTile(it.data, marksById.get(it.data.id))
      : remoteTile(it.data))).join("");
}

function renderHeader(current, folders) {
  const back = document.getElementById("lib-back");
  const title = document.getElementById("lib-title");

  if (!current) {
    back.hidden = true;
    title.textContent = "ชั้นหนังสือ";
    return;
  }
  const parent = folders.find((f) => f.id === current.parentId);
  back.hidden = false;
  back.textContent = "‹ " + (parent ? parent.name : "ชั้นหนังสือ");
  title.textContent = current.name;
}

function countInside(folderId, folders, books) {
  return (
    folders.filter((f) => f.parentId === folderId).length +
    books.filter((b) => b.folderId === folderId).length +
    sync.getRemoteBooks(folderId).length
  );
}

function folderTile(folder, folders, books) {
  const count = countInside(folder.id, folders, books);
  return `
    <button class="tile" data-folder="${folder.id}">
      <div class="tile-cover folder-cover">${FOLDER_ICON}</div>
      <div class="tile-name">${escapeHTML(folder.name)}</div>
      <div class="tile-sub">${count ? count + " รายการ" : "ว่าง"}</div>
    </button>`;
}

function bookTile(book, marks) {
  const cover = book.cover
    ? `<img src="${book.cover}" alt="">`
    : `<span class="cover-placeholder">${escapeHTML(book.name)}</span>`;

  return `
    <button class="tile" data-book="${book.id}">
      <div class="tile-cover book-cover">
        ${cover}${progressBar(book, marks)}${statusBox(book.id)}
      </div>
      <div class="tile-name">${escapeHTML(book.name)}</div>
    </button>`;
}

// หนังสือที่อยู่บน Drive แต่ยังไม่ได้โหลดลงเครื่องนี้
function remoteTile(remote) {
  return `
    <button class="tile" data-remote="${remote.driveId}">
      <div class="tile-cover book-cover cloud">
        <span class="cover-placeholder">${escapeHTML(remote.name)}</span>
        <span class="cloud-badge" aria-label="อยู่บน Google Drive">☁️</span>
        ${statusBox(remote.driveId)}
      </div>
      <div class="tile-name">${escapeHTML(remote.name)}</div>
    </button>`;
}

// แถบบางๆ ที่ขอบล่างของปก: น้ำเงิน = อ่านถึง, ขีดเหลือง = บุ๊กมาร์กถาวร
function progressBar(book, marks) {
  if (!marks || !book.numPages) return "";
  const last = marks.history[marks.history.length - 1]; // ล่าสุดอยู่ท้ายสุด (FR4)
  const percent = (page) => ((page - 1) / Math.max(1, book.numPages - 1)) * 100;

  const fill = last ? `<i class="fill" style="width:${Math.max(3, percent(last.page))}%"></i>` : "";
  const ticks = marks.bookmarks.map((b) => `<i class="tick" style="left:${percent(b.page)}%"></i>`).join("");
  return `<div class="cover-progress">${fill}${ticks}</div>`;
}

/* ---------- สถานะบนปก: ดาวน์โหลด อัปโหลด เตรียมหน้า ---------- */
function currentStatus(id) {
  if (downloads.has(id)) {
    const p = downloads.get(id);
    return { label: `ดาวน์โหลด ${Math.round(p * 100)}%`, value: p };
  }
  const transfer = sync.bookProgress(id);
  if (transfer) return transfer;
  const t = thumbProgress(id);
  if (t !== null) return { label: `เตรียมหน้า ${Math.round(t * 100)}%`, value: t };
  return null;
}

function statusBox(id) {
  const s = currentStatus(id);
  return `
    <div class="cover-status" data-status="${id}" ${s ? "" : "hidden"}>
      <span>${s ? s.label : ""}</span>
      <i style="width:${s ? Math.round(s.value * 100) : 0}%"></i>
    </div>`;
}

function updateStatus(id) {
  const el = screen.querySelector(`[data-status="${id}"]`);
  if (!el) return;
  const s = currentStatus(id);
  el.hidden = !s;
  if (s) {
    el.querySelector("span").textContent = s.label;
    el.querySelector("i").style.width = Math.round(s.value * 100) + "%";
  }
}

/* =========================================================
   3. แตะบนชั้น
   ========================================================= */
function onShelfClick(e) {
  if (longPressFired) {        // เพิ่งกดค้าง ไม่ต้องเปิดหนังสือ
    longPressFired = false;
    return;
  }
  const folder = e.target.closest("[data-folder]");
  if (folder) {
    currentFolderId = folder.dataset.folder;
    renderLibrary();
    return;
  }
  const book = e.target.closest("[data-book]");
  if (book) {
    openBookHandler(book.dataset.book);
    return;
  }
  const remote = e.target.closest("[data-remote]");
  if (remote) {
    downloadRemote(remote.dataset.remote);
    return;
  }
  if (e.target.closest('[data-action="add-pdf"]')) pickFiles();
}

async function goUp() {
  const current = await get("folders", currentFolderId);
  currentFolderId = current ? current.parentId : null;
  renderLibrary();
}

/* =========================================================
   4. ปุ่ม + : เพิ่ม PDF และสร้างแฟ้ม
   ========================================================= */
function showAddMenu() {
  const sheet = openSheet(`
    <h2>เพิ่มบนชั้นนี้</h2>
    <div class="menu">
      <button data-action="add-pdf">เพิ่ม PDF จากเครื่อง</button>
      <button data-action="new-folder">สร้างแฟ้มใหม่</button>
    </div>`);

  sheet.querySelector('[data-action="add-pdf"]').onclick = () => {
    closeSheet();
    pickFiles();
  };
  sheet.querySelector('[data-action="new-folder"]').onclick = showNewFolder;
}

function pickFiles() {
  document.getElementById("file-input").click();
}

function showNewFolder() {
  const sheet = openSheet(`
    <h2>สร้างแฟ้มใหม่</h2>
    <label class="field">
      <span>ชื่อแฟ้ม</span>
      <input id="folder-name" maxlength="60" placeholder="เช่น นิทานลูก">
    </label>
    <div class="btn-row">
      <button class="btn btn-primary" id="folder-save">สร้างแฟ้ม</button>
    </div>`);

  const input = sheet.querySelector("#folder-name");
  setTimeout(() => input.focus(), 250);

  const save = async () => {
    const name = input.value.trim();
    if (!name) {
      toast("ใส่ชื่อแฟ้มก่อน");
      return;
    }
    const folder = await createFolder(name, currentFolderId);
    closeSheet();
    toast(`สร้างแฟ้ม ${folder.name} แล้ว`);
    renderLibrary();
  };

  sheet.querySelector("#folder-save").onclick = save;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) save();
  });
}

async function createFolder(name, parentId) {
  const folder = { id: makeId(), name, parentId, driveId: null, updatedAt: Date.now() };
  await put("folders", folder);
  sync.folderChanged(folder);
  return folder;
}

/* ---------- เพิ่ม PDF ---------- */
async function addFiles(files) {
  if (!window.isSecureContext) {
    toast("เพิ่ม PDF ได้เฉพาะตอนเปิดผ่าน https หรือ localhost", 4000);
    return;
  }

  for (const file of files) {
    try {
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        toast(`${file.name} ไม่ใช่ไฟล์ PDF`);
        continue;
      }
      toast(`กำลังเพิ่ม ${file.name}…`, 60000);

      const buffer = await file.arrayBuffer();
      const id = await fileHash(buffer);
      if (await get("books", id)) {
        toast("ไฟล์นี้อยู่บนชั้นแล้ว");
        continue;
      }

      const book = await storeBook({
        buffer, id,
        name: file.name.replace(/\.pdf$/i, ""),
        size: file.size,
        folderId: currentFolderId,
      });
      toast(`เพิ่ม ${book.name} แล้ว`);
      renderLibrary();
    } catch (err) {
      toast(`เพิ่ม ${file.name} ไม่สำเร็จ: ${err.message}`, 5000);
    }
  }
  requestPersist();
  renderLibrary();
}

// เก็บหนังสือเล่มใหม่ลงเครื่อง ใช้ทั้งตอนเพิ่มจากเครื่องและตอนดาวน์โหลดจาก Drive
async function storeBook({ buffer, id, name, size, folderId, driveId = null }) {
  // 1) เก็บตัวไฟล์ก่อน
  await put("pdfs", { bookId: id, blob: new Blob([buffer], { type: "application/pdf" }) });

  // 2) เปิดไฟล์เพื่อนับจำนวนหน้าและทำรูปปก
  let numPages;
  let cover;
  try {
    const pdf = await openPdf(id);
    numPages = pdf.numPages;
    cover = await makeCover(pdf);
    pdf.destroy();
  } catch (err) {
    await remove("pdfs", id);
    throw new Error("เปิดไฟล์ไม่ได้ ไฟล์อาจเสียหรือมีรหัสผ่าน");
  }

  // 3) เก็บบัตรรายการ
  const book = {
    id, name, folderId, size, numPages, cover, driveId,
    pageMode: defaultPageMode(),
    thumbsDone: 0,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await put("books", book);

  // 4) ทำภาพย่อทุกหน้าอยู่เบื้องหลัง และอัปโหลดขึ้น Drive ถ้ายังไม่มี
  queueThumbs(id);
  if (!driveId) sync.bookAdded(book);
  return book;
}

// ลายนิ้วมือของไฟล์: ไฟล์เดียวกันได้ค่าเดียวกันเสมอ ไม่ว่าจะชื่ออะไร
async function fileHash(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ---------- ดาวน์โหลดจาก Drive (แตะที่ปก ☁️) ---------- */
async function downloadRemote(driveId) {
  const remote = sync.getRemoteBooks(currentFolderId).find((r) => r.driveId === driveId);
  if (!remote || downloads.has(driveId)) return;

  downloads.set(driveId, 0);
  updateStatus(driveId);
  try {
    const data = await sync.downloadBook(remote, (p) => {
      downloads.set(driveId, p);
      updateStatus(driveId);
    });
    await storeBook({ ...data, folderId: remote.folderId, driveId });
    toast(`ดาวน์โหลด ${remote.name} แล้ว`);
  } catch (err) {
    toast(`ดาวน์โหลดไม่สำเร็จ: ${err.message}`, 5000);
  } finally {
    downloads.delete(driveId);
    requestPersist();
    renderLibrary();
  }
}

/* =========================================================
   5. กดค้าง (คลิกขวาบน Mac)
   ========================================================= */
function setupLongPress(shelf) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const selector = "[data-folder], [data-book], [data-remote]";

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  shelf.addEventListener("pointerdown", (e) => {
    const tile = e.target.closest(selector);
    if (!tile) return;
    longPressFired = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      longPressFired = true;
      openItemMenu(tile);
    }, 500);
  });

  shelf.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  shelf.addEventListener("pointerup", cancel);
  shelf.addEventListener("pointercancel", cancel);

  shelf.addEventListener("contextmenu", (e) => {
    const tile = e.target.closest(selector);
    if (!tile) return;
    e.preventDefault();
    cancel();
    openItemMenu(tile);
  });
}

function openItemMenu(tile) {
  if (tile.dataset.book) showBookMenu(tile.dataset.book);
  else if (tile.dataset.folder) showFolderMenu(tile.dataset.folder);
  else if (tile.dataset.remote) showRemoteMenu(tile.dataset.remote);
}

/* =========================================================
   6. เมนูของหนังสือ แฟ้ม และหนังสือบน Drive
   ========================================================= */
async function showBookMenu(bookId) {
  const book = await get("books", bookId);
  const marks = await get("marks", bookId);
  if (!book) return;

  const last = marks && marks.history[marks.history.length - 1];
  const readLine = last
    ? `อ่านถึงหน้า ${last.page} จาก ${book.numPages}`
    : `ยังไม่ได้บันทึกหน้าที่อ่าน (${book.numPages} หน้า)`;
  const markCount = marks ? marks.bookmarks.length : 0;
  const connected = sync.isConnected();

  let driveLine = "";
  if (book.driveId) driveLine = "มีสำเนาบน Google Drive";
  else if (connected) driveLine = "ยังไม่ได้อัปโหลดขึ้น Google Drive";

  const sheet = openSheet(`
    <h2>${escapeHTML(book.name)}</h2>
    <div class="sheet-info">
      <div>${readLine}</div>
      <div>บุ๊กมาร์ก ${markCount} หน้า, ขนาด ${formatSize(book.size)}</div>
      ${driveLine ? `<div>${driveLine}</div>` : ""}
    </div>
    <div class="menu">
      <button data-action="move">ย้ายเข้าแฟ้ม</button>
      <button data-action="rename">เปลี่ยนชื่อ</button>
      ${!book.driveId && connected ? `<button data-action="upload">อัปโหลดขึ้น Google Drive</button>` : ""}
      <button data-action="delete" class="btn-danger">ลบออกจากเครื่องนี้</button>
      ${book.driveId && connected ? `<button data-action="trash" class="btn-danger">ลบออกจาก Google Drive</button>` : ""}
    </div>`);

  sheet.querySelector('[data-action="move"]').onclick = () => showMovePicker({ type: "book", item: book });
  sheet.querySelector('[data-action="rename"]').onclick = () => showRename({ type: "book", item: book });
  sheet.querySelector('[data-action="delete"]').onclick = () => deleteBookLocal(book);

  const upload = sheet.querySelector('[data-action="upload"]');
  if (upload) upload.onclick = () => {
    sync.bookAdded(book);
    closeSheet();
    toast("เริ่มอัปโหลดแล้ว");
  };
  const trash = sheet.querySelector('[data-action="trash"]');
  if (trash) trash.onclick = () => deleteBookFromDrive(book);
}

async function showFolderMenu(folderId) {
  const [folder, folders, books] = await Promise.all([
    get("folders", folderId), getAll("folders"), getAll("books"),
  ]);
  if (!folder) return;
  const count = countInside(folderId, folders, books);

  const sheet = openSheet(`
    <h2>${escapeHTML(folder.name)}</h2>
    <div class="sheet-info"><div>${count ? `มี ${count} รายการข้างใน` : "แฟ้มว่าง"}</div></div>
    <div class="menu">
      <button data-action="move">ย้ายไปแฟ้มอื่น</button>
      <button data-action="rename">เปลี่ยนชื่อ</button>
      <button data-action="delete" class="btn-danger">ลบแฟ้ม</button>
    </div>`);

  sheet.querySelector('[data-action="move"]').onclick = () => showMovePicker({ type: "folder", item: folder });
  sheet.querySelector('[data-action="rename"]').onclick = () => showRename({ type: "folder", item: folder });
  sheet.querySelector('[data-action="delete"]').onclick = () => deleteFolder(folder, count);
}

function showRemoteMenu(driveId) {
  const remote = sync.getRemoteBooks(currentFolderId).find((r) => r.driveId === driveId);
  if (!remote) return;

  const sheet = openSheet(`
    <h2>${escapeHTML(remote.name)}</h2>
    <div class="sheet-info">
      <div>อยู่บน Google Drive ยังไม่มีในเครื่องนี้</div>
      <div>ขนาด ${formatSize(remote.size)}</div>
    </div>
    <div class="menu">
      <button data-action="download">ดาวน์โหลดลงเครื่อง</button>
      <button data-action="trash" class="btn-danger">ลบออกจาก Google Drive</button>
    </div>`);

  sheet.querySelector('[data-action="download"]').onclick = () => {
    closeSheet();
    downloadRemote(driveId);
  };
  sheet.querySelector('[data-action="trash"]').onclick = async () => {
    if (!confirm(`ย้าย "${remote.name}" ไปถังขยะของ Google Drive?\nกู้คืนได้ภายใน 30 วัน`)) return;
    try {
      await sync.trashOnDrive(driveId);
      closeSheet();
      toast("ย้ายไปถังขยะของ Drive แล้ว");
      renderLibrary();
    } catch (err) {
      toast("ลบจาก Drive ไม่สำเร็จ: " + err.message, 5000);
    }
  };
}

/* =========================================================
   7. เปลี่ยนชื่อและลบ
   ========================================================= */
function showRename({ type, item }) {
  const sheet = openSheet(`
    <h2>เปลี่ยนชื่อ</h2>
    <label class="field">
      <span>ชื่อใหม่</span>
      <input id="rename-input" maxlength="80" value="${escapeHTML(item.name)}">
    </label>
    <div class="btn-row">
      <button class="btn btn-primary" id="rename-save">บันทึกชื่อ</button>
    </div>`);

  const input = sheet.querySelector("#rename-input");
  setTimeout(() => { input.focus(); input.select(); }, 250);

  const save = async () => {
    const name = input.value.trim();
    if (!name) {
      toast("ใส่ชื่อก่อน");
      return;
    }
    item.name = name;
    await saveItem(type, item);
    closeSheet();
    toast("เปลี่ยนชื่อแล้ว");
    renderLibrary();
  };

  sheet.querySelector("#rename-save").onclick = save;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) save();
  });
}

// บันทึกหนังสือหรือแฟ้มที่แก้ไข แล้วแจ้ง Drive
async function saveItem(type, item) {
  item.updatedAt = Date.now();
  if (type === "book") {
    await put("books", item);
    sync.bookChanged(item);
  } else {
    await put("folders", item);
    sync.folderChanged(item);
  }
}

async function deleteBookLocal(book) {
  const ok = confirm(
    `ลบ "${book.name}" ออกจากเครื่องนี้?\n` +
    (book.driveId
      ? "ไฟล์บน Google Drive และบุ๊กมาร์กยังอยู่ ดาวน์โหลดกลับมาได้"
      : "บุ๊กมาร์กยังเก็บไว้ ถ้าเพิ่มไฟล์เดิมกลับมาจะเห็นอีกครั้ง")
  );
  if (!ok) return;

  await remove("books", book.id);
  await remove("pdfs", book.id);
  await removeThumbs(book.id);
  closeSheet();
  toast("ลบออกจากเครื่องแล้ว");
  renderLibrary();
}

async function deleteBookFromDrive(book) {
  const ok = confirm(
    `ย้าย "${book.name}" ไปถังขยะของ Google Drive?\n` +
    "กู้คืนได้ภายใน 30 วัน ไฟล์ในเครื่องนี้ยังอยู่"
  );
  if (!ok) return;

  try {
    await sync.trashOnDrive(book.driveId);
    book.driveId = null;
    book.updatedAt = Date.now();
    await put("books", book);
    closeSheet();
    toast("ย้ายไปถังขยะของ Drive แล้ว");
    renderLibrary();
  } catch (err) {
    toast("ลบจาก Drive ไม่สำเร็จ: " + err.message, 5000);
  }
}

async function deleteFolder(folder, count) {
  if (count > 0) {
    toast("ลบได้เฉพาะแฟ้มว่าง ย้ายหรือลบของข้างในออกก่อน", 3500);
    return;
  }
  if (!confirm(`ลบแฟ้ม "${folder.name}"?`)) return;

  await remove("folders", folder.id);
  sync.folderDeleted(folder);
  closeSheet();
  toast("ลบแฟ้มแล้ว");
  renderLibrary();
}

/* =========================================================
   8. ย้ายเข้าแฟ้ม
   ========================================================= */
// หาแฟ้มนี้และแฟ้มลูกหลานทุกชั้น กันไม่ให้ย้ายแฟ้มเข้าไปในตัวเอง
function selfAndDescendants(folderId, folders) {
  const result = new Set([folderId]);
  let found = true;
  while (found) {
    found = false;
    for (const f of folders) {
      if (!result.has(f.id) && result.has(f.parentId)) {
        result.add(f.id);
        found = true;
      }
    }
  }
  return result;
}

async function showMovePicker(target, browseId = null) {
  const { type, item } = target;
  const folders = await getAll("folders");
  const blocked = type === "folder" ? selfAndDescendants(item.id, folders) : new Set();

  const here = folders.find((f) => f.id === browseId);
  const parent = here && folders.find((f) => f.id === here.parentId);
  const children = folders
    .filter((f) => f.parentId === browseId && !blocked.has(f.id))
    .sort(sortByName);
  const currentPlace = type === "book" ? item.folderId : item.parentId;

  const sheet = openSheet(`
    <h2>ย้าย "${escapeHTML(item.name)}" ไปที่</h2>
    ${here ? `<button class="lib-back" data-up>‹ ${escapeHTML(parent ? parent.name : "ชั้นหนังสือ")}</button>` : ""}
    <div class="picker-here">${escapeHTML(here ? here.name : "ชั้นหนังสือ")}</div>
    <div class="menu">
      ${children.length
        ? children.map((f) => `<button data-go="${f.id}">📁 ${escapeHTML(f.name)} ›</button>`).join("")
        : `<div class="none">ไม่มีแฟ้มย่อย</div>`}
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" data-new>+ แฟ้มใหม่</button>
      <button class="btn btn-primary" data-here ${browseId === currentPlace ? "disabled" : ""}>ย้ายมาที่นี่</button>
    </div>`);

  const up = sheet.querySelector("[data-up]");
  if (up) up.onclick = () => showMovePicker(target, here.parentId);

  sheet.querySelectorAll("[data-go]").forEach((b) => {
    b.onclick = () => showMovePicker(target, b.dataset.go);
  });

  sheet.querySelector("[data-new]").onclick = async () => {
    const name = (prompt("ชื่อแฟ้มใหม่") || "").trim();
    if (!name) return;
    const folder = await createFolder(name, browseId);
    showMovePicker(target, folder.id); // เข้าไปในแฟ้มใหม่ทันที
  };

  sheet.querySelector("[data-here]").onclick = async () => {
    if (type === "book") item.folderId = browseId;
    else item.parentId = browseId;
    await saveItem(type, item);
    closeSheet();
    toast(`ย้ายไป ${here ? here.name : "ชั้นหนังสือ"} แล้ว`);
    renderLibrary();
  };
}

/* =========================================================
   9. ดูเส้นทางแฟ้ม (แตะหัวข้อ)
   ========================================================= */
async function showPath() {
  if (!currentFolderId) return;
  const folders = await getAll("folders");

  const chain = [];
  let f = folders.find((x) => x.id === currentFolderId);
  while (f) {
    chain.unshift(f);
    const parentId = f.parentId;
    f = folders.find((x) => x.id === parentId);
  }
  const rows = [{ id: "", name: "ชั้นหนังสือ" }, ...chain];

  const sheet = openSheet(`
    <h2>ตอนนี้อยู่ที่</h2>
    <div class="path">
      ${rows.map((r, i) => `
        <button data-jump="${r.id}" style="padding-left:${i * 18}px">
          ${i ? "└ " : ""}${escapeHTML(r.name)}${i === rows.length - 1 ? " ✓" : ""}
        </button>`).join("")}
    </div>`);

  sheet.querySelectorAll("[data-jump]").forEach((b) => {
    b.onclick = () => {
      currentFolderId = b.dataset.jump || null;
      closeSheet();
      renderLibrary();
    };
  });
}
