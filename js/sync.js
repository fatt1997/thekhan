// sync.js: คนเช็กสต็อก ทำให้ของในเครื่องกับบน Google Drive ตรงกัน
// ลำดับการทำงานทุกครั้ง: ลบ → ส่งโครงสร้างขึ้น → ดึงของใหม่ลง → อัปโหลดไฟล์ → ซิงก์บุ๊กมาร์ก
// กติกาเวลาชนกัน: ของที่แก้ล่าสุด (updatedAt ใหม่กว่า) ชนะ

import * as drive from "./drive.js";
import { get, getAll, put, remove } from "./db.js";
import { makeId } from "./ui.js";
import { hasToken } from "./auth.js";

const LIBRARY_FILE = "library.json";

let started = false;
let key = "sync-dirty";
let dirty = emptyDirty();
let appFolder = null;
let remoteBooks = [];          // หนังสือที่อยู่บน Drive แต่ยังไม่มีในเครื่อง
const downloaded = new Set();  // เล่มที่เพิ่งโหลดลงเครื่องแล้ว ไม่ต้องแสดงเป็นเมฆอีก
const progress = new Map();    // bookId → { label, value }
const listeners = [];
let state = "idle";            // idle | syncing | offline | error
let timer = 0, running = false, again = false;

/* =========================================================
   1. เปิดและปิดการซิงก์
   ========================================================= */
export function start(userKey) {
  key = `sync-dirty-${userKey}`;
  dirty = load();
  appFolder = null;
  remoteBooks = [];
  downloaded.clear();
  started = true;
  schedule(500);
}

export function stop() {
  started = false;
  clearTimeout(timer);
  remoteBooks = [];
  downloaded.clear();
  progress.clear();
  state = "idle";
}

export const isConnected = () => started && hasToken();
export const syncState = () => (!started ? "idle" : hasToken() ? state : "offline");
export const lastSync = () => Number(localStorage.getItem("lastSync") || 0);
export const getRemoteBooks = (folderId) =>
  remoteBooks.filter((r) => r.folderId === (folderId ?? null) && !downloaded.has(r.driveId));
export const bookProgress = (bookId) => progress.get(bookId) || null;

export function onSyncChange(fn) {
  listeners.push(fn);
}

function emit(kind, id) {
  for (const fn of listeners) fn(kind, id);
}

/* =========================================================
   2. บันทึกว่ามีอะไรรอส่งขึ้น Drive
   ========================================================= */
function emptyDirty() {
  return { folders: [], books: [], uploads: [], trash: [], marks: false };
}
function load() {
  try {
    return { ...emptyDirty(), ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return emptyDirty();
  }
}
function save() {
  try { localStorage.setItem(key, JSON.stringify(dirty)); } catch {}
}
function addDirty(list, id) {
  if (!dirty[list].includes(id)) dirty[list].push(id);
  save();
}
function removeDirty(list, id) {
  dirty[list] = dirty[list].filter((x) => x !== id);
  save();
}

// ไฟล์อื่นเรียกฟังก์ชันพวกนี้เวลามีการเปลี่ยนแปลงในเครื่อง
export function bookAdded(book) {
  addDirty("uploads", book.id);
  schedule();
}
export function bookChanged(book) {
  if (book.driveId) addDirty("books", book.id);
  dirty.marks = true; // โหมดเปลี่ยนหน้าเก็บใน library.json ด้วย
  save();
  schedule();
}
export function folderChanged(folder) {
  addDirty("folders", folder.id);
  schedule();
}
export function folderDeleted(folder) {
  removeDirty("folders", folder.id);
  if (folder.driveId) addDirty("trash", folder.driveId);
  schedule();
}
export function marksChanged() {
  dirty.marks = true;
  save();
  schedule();
}

/* =========================================================
   3. งานที่หน้าชั้นหนังสือเรียกตรงๆ
   ========================================================= */
export async function trashOnDrive(driveId) {
  await drive.trashFile(driveId);
  remoteBooks = remoteBooks.filter((r) => r.driveId !== driveId);
  emit("refresh");
}

export async function downloadBook(remote, onProgress) {
  const buffer = await drive.downloadFile(remote.driveId, remote.size, onProgress);
  const id = remote.id || (await fileHash(buffer));
  downloaded.add(remote.driveId); // ขีดฆ่าออกจากรายการฝั่ง Drive ทันที จะได้ไม่แสดงซ้ำ
  schedule(3000);
  return { buffer, id, name: remote.name, size: buffer.byteLength };
}

async function fileHash(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* =========================================================
   4. ตัวควบคุมรอบการซิงก์
   ========================================================= */
export function syncNow() {
  schedule(0);
}

function schedule(delay = 1500) {
  if (!started) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

async function run() {
  if (!started || running) {
    again = running;
    return;
  }
  if (!hasToken()) {   // token หมดอายุ รอให้ผู้ใช้กดเชื่อมต่ออีกครั้งในหน้าตั้งค่า
    state = "offline";
    emit("refresh");
    return;
  }

  running = true;
  state = "syncing";
  emit("refresh");
  try {
    await pushTrash();
    await pushStructure();
    await pull();
    await pushUploads();
    await syncMarks();
    localStorage.setItem("lastSync", String(Date.now()));
    state = "idle";
  } catch (err) {
    state = err.message === "need_login" ? "offline" : "error";
    console.warn("ซิงก์ไม่สำเร็จ", err);
  } finally {
    running = false;
    emit("refresh");
    if (again) {
      again = false;
      schedule(800);
    }
  }
}

async function folderId() {
  if (!appFolder) appFolder = await drive.ensureAppFolder();
  return appFolder;
}

/* =========================================================
   5. ส่งขึ้น Drive
   ========================================================= */
async function pushTrash() {
  for (const driveId of [...dirty.trash]) {
    try {
      await drive.trashFile(driveId);
    } catch (err) {
      if (err.message === "need_login") throw err; // ไฟล์อาจถูกลบไปแล้ว ข้ามได้
    }
    removeDirty("trash", driveId);
  }
}

async function pushStructure() {
  const root = await folderId();
  const folders = await getAll("folders");
  const byId = new Map(folders.map((f) => [f.id, f]));

  // สร้างแฟ้มใหม่บน Drive ต้องไล่จากแฟ้มแม่ก่อน
  let waiting = folders.filter((f) => !f.driveId);
  let guard = 0;
  while (waiting.length && guard++ < 50) {
    const ready = waiting.filter((f) => !f.parentId || (byId.get(f.parentId) && byId.get(f.parentId).driveId));
    if (!ready.length) break;
    for (const f of ready) {
      const parent = f.parentId ? byId.get(f.parentId) : null;
      const made = await drive.createFolder(f.name, parent ? parent.driveId : root);
      f.driveId = made.id;
      await put("folders", f);
      removeDirty("folders", f.id);
    }
    waiting = waiting.filter((f) => !f.driveId);
  }

  // แฟ้มที่เปลี่ยนชื่อหรือย้ายที่
  for (const id of [...dirty.folders]) {
    const f = byId.get(id);
    if (f && f.driveId) {
      const parent = f.parentId ? byId.get(f.parentId) : null;
      await drive.moveAndRename(f.driveId, f.name, parent ? parent.driveId : root);
    }
    removeDirty("folders", id);
  }

  // หนังสือที่เปลี่ยนชื่อหรือย้ายแฟ้ม
  for (const id of [...dirty.books]) {
    const b = await get("books", id);
    if (b && b.driveId) {
      const parent = b.folderId ? byId.get(b.folderId) : null;
      await drive.moveAndRename(b.driveId, b.name + ".pdf", parent ? parent.driveId : root);
    }
    removeDirty("books", id);
  }
}

async function pushUploads() {
  const root = await folderId();
  for (const bookId of [...dirty.uploads]) {
    const book = await get("books", bookId);
    const pdf = book ? await get("pdfs", bookId) : null;
    if (!book || !pdf || book.driveId) {
      removeDirty("uploads", bookId);
      continue;
    }

    const folders = await getAll("folders");
    const folder = book.folderId ? folders.find((f) => f.id === book.folderId) : null;
    const parentId = folder && folder.driveId ? folder.driveId : root;

    setProgress(bookId, 0);
    try {
      const driveId = await drive.uploadPdf(
        pdf.blob,
        { name: book.name, parentId, hash: book.id },
        (p) => setProgress(bookId, p)
      );
      const fresh = await get("books", bookId);
      if (fresh) {
        fresh.driveId = driveId;
        await put("books", fresh);
      }
      removeDirty("uploads", bookId);
    } finally {
      progress.delete(bookId);
      emit("progress", bookId);
    }
    emit("refresh");
  }
}

function setProgress(bookId, value) {
  progress.set(bookId, { label: `อัปโหลด ${Math.round(value * 100)}%`, value });
  emit("progress", bookId);
}

/* =========================================================
   6. ดึงของใหม่จาก Drive ลงเครื่อง
   ========================================================= */
async function pull() {
  const root = await folderId();
  const files = await drive.listFiles();
  downloaded.clear(); // ดึงรายชื่อใหม่ทั้งชุด ไม่ต้องใช้รายการที่ขีดฆ่าไว้แล้ว
  const remoteFolders = files.filter((f) => f.mimeType === drive.FOLDER_MIME && f.id !== root);
  const remotePdfs = files.filter((f) => f.mimeType === "application/pdf");

  /* --- แฟ้ม --- */
  const folders = await getAll("folders");
  const byDrive = new Map(folders.filter((f) => f.driveId).map((f) => [f.driveId, f]));

  let waiting = [...remoteFolders];
  let guard = 0;
  while (waiting.length && guard++ < 50) {
    const before = waiting.length;
    for (const rf of [...waiting]) {
      const parentDrive = (rf.parents && rf.parents[0]) || root;
      let parentId = null;
      if (parentDrive !== root) {
        const parent = byDrive.get(parentDrive);
        if (!parent) continue; // ยังไม่รู้จักแฟ้มแม่ รอรอบถัดไป
        parentId = parent.id;
      }

      let local = byDrive.get(rf.id);
      if (!local) {
        local = { id: makeId(), name: rf.name, parentId, driveId: rf.id, updatedAt: Date.now() };
        byDrive.set(rf.id, local);
        await put("folders", local);
      } else if (!dirty.folders.includes(local.id) && (local.name !== rf.name || local.parentId !== parentId)) {
        local.name = rf.name;
        local.parentId = parentId;
        await put("folders", local);
      }
      waiting = waiting.filter((x) => x !== rf);
    }
    if (waiting.length === before) break;
  }

  // แฟ้มในเครื่องที่หายไปจาก Drive (เครื่องอื่นลบทิ้ง)
  const remoteFolderIds = new Set(remoteFolders.map((f) => f.id));
  const booksNow = await getAll("books");
  for (const f of folders) {
    if (!f.driveId || remoteFolderIds.has(f.driveId) || dirty.folders.includes(f.id)) continue;
    const hasChild =
      folders.some((x) => x.parentId === f.id) || booksNow.some((b) => b.folderId === f.id);
    if (hasChild) {
      f.driveId = null; // ยังมีของข้างใน เก็บไว้ แล้วสร้างใหม่บน Drive รอบหน้า
      await put("folders", f);
      addDirty("folders", f.id);
    } else {
      await remove("folders", f.id);
    }
  }

  /* --- หนังสือ --- */
  const foldersAfter = await getAll("folders");
  const localByDrive = new Map(foldersAfter.filter((f) => f.driveId).map((f) => [f.driveId, f]));
  const books = await getAll("books");
  const byHash = new Map(books.map((b) => [b.id, b]));
  const seen = new Set();
  const nextRemote = [];

  for (const rf of remotePdfs) {
    const hash = (rf.appProperties && rf.appProperties.hash) || "";
    const parentDrive = (rf.parents && rf.parents[0]) || root;
    const folder = parentDrive === root ? null : localByDrive.get(parentDrive);
    const folderId = folder ? folder.id : null;
    const name = rf.name.replace(/\.pdf$/i, "");
    seen.add(rf.id);

    const local = hash && byHash.get(hash);
    if (local) {
      const busy = dirty.books.includes(local.id) || dirty.uploads.includes(local.id);
      const changed = local.driveId !== rf.id || (!busy && (local.name !== name || local.folderId !== folderId));
      if (changed) {
        local.driveId = rf.id;
        if (!busy) {
          local.name = name;
          local.folderId = folderId;
        }
        await put("books", local);
      }
    } else {
      nextRemote.push({ driveId: rf.id, id: hash, name, size: Number(rf.size) || 0, folderId });
    }
  }
  remoteBooks = nextRemote;

  // หนังสือที่เคยมีบน Drive แต่ถูกลบจากเครื่องอื่น ไฟล์ในเครื่องนี้ยังอยู่
  for (const b of books) {
    if (b.driveId && !seen.has(b.driveId) && !dirty.uploads.includes(b.id)) {
      b.driveId = null;
      await put("books", b);
    }
  }
}

/* =========================================================
   7. ซิงก์บุ๊กมาร์ก (library.json ในโฟลเดอร์ซ่อน)
   ========================================================= */
async function syncMarks() {
  const { id, data } = await drive.readAppData(LIBRARY_FILE);
  const remote = (data && data.books) || {};
  const localMarks = await getAll("marks");
  const books = await getAll("books");
  const merged = { ...remote };

  // ของในเครื่องที่ใหม่กว่า ทับของบน Drive
  for (const m of localMarks) {
    const book = books.find((b) => b.id === m.bookId);
    const r = merged[m.bookId];
    if (!r || m.updatedAt > (r.updatedAt || 0)) {
      merged[m.bookId] = {
        bookmarks: m.bookmarks,
        history: m.history,
        updatedAt: m.updatedAt,
        pageMode: book ? book.pageMode : (r && r.pageMode),
        name: book ? book.name : (r && r.name),
      };
    }
  }

  // ของบน Drive ที่ใหม่กว่า ลงมาที่เครื่อง
  for (const [bookId, r] of Object.entries(merged)) {
    const local = localMarks.find((m) => m.bookId === bookId);
    if (local && (r.updatedAt || 0) <= local.updatedAt) continue;
    await put("marks", {
      bookId,
      bookmarks: r.bookmarks || [],
      history: r.history || [],
      updatedAt: r.updatedAt || 0,
    });
    const book = books.find((b) => b.id === bookId);
    if (book && r.pageMode && book.pageMode !== r.pageMode) {
      book.pageMode = r.pageMode;
      await put("books", book);
    }
  }

  await drive.writeAppData(LIBRARY_FILE, id, { version: 1, updatedAt: Date.now(), books: merged });
  dirty.marks = false;
  save();
}
