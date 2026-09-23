// db.js: คนดูแลตู้เก็บของหลังร้าน (IndexedDB)

const VERSION = 1; // เพิ่มเลขนี้เมื่อเปลี่ยนโครงสร้างตู้
let db = null;

/* ---------- 1. เปิดฐานข้อมูลของบัญชีนั้น ---------- */
export function openDatabase(userId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`thekhan-${userId}`, VERSION);

    // ทำงานเฉพาะครั้งแรก หรือตอนเปลี่ยน VERSION
    request.onupgradeneeded = () => {
      const d = request.result;
      d.createObjectStore("folders", { keyPath: "id" });
      d.createObjectStore("books", { keyPath: "id" });
      d.createObjectStore("pdfs", { keyPath: "bookId" });
      d.createObjectStore("thumbs", { keyPath: ["bookId", "page"] });
      d.createObjectStore("marks", { keyPath: "bookId" });
    };

    request.onsuccess = () => {
      db = request.result;
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

// ใช้ตอนออกจากระบบ ก่อนเปิดฐานข้อมูลของบัญชีอื่น
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/* ---------- 2. ตัวกลางสำหรับทุกคำสั่ง ---------- */
function run(storeName, mode, work) {
  if (!db) return Promise.reject(new Error("ยังไม่ได้เปิดฐานข้อมูล"));

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = work(tx.objectStore(storeName));

    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("บันทึกไม่สำเร็จ พื้นที่ในเครื่องอาจเต็ม"));
  });
}

/* ---------- 3. คำสั่งพื้นฐาน ---------- */
export const get = (store, key) => run(store, "readonly", (s) => s.get(key));
export const getAll = (store) => run(store, "readonly", (s) => s.getAll());
export const put = (store, value) => run(store, "readwrite", (s) => s.put(value));
export const remove = (store, key) => run(store, "readwrite", (s) => s.delete(key));

/* ---------- 4. ภาพย่อของหนังสือเล่มเดียว ---------- */
const thumbRange = (bookId) => IDBKeyRange.bound([bookId, 0], [bookId, Infinity]);

// อ่านภาพย่อทุกหน้าของเล่มนั้นในครั้งเดียว
export function getThumbs(bookId) {
  return run("thumbs", "readonly", (s) => s.getAll(thumbRange(bookId)));
}

// ลบภาพย่อทุกหน้าของเล่มนั้น
export function removeThumbs(bookId) {
  return run("thumbs", "readwrite", (s) => s.delete(thumbRange(bookId)));
}

/* ---------- 5. พื้นที่ในเครื่อง ---------- */
export function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    return navigator.storage.persist();
  }
  return Promise.resolve(false);
}

export async function storageUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return 0;
  const { usage } = await navigator.storage.estimate();
  return usage || 0;
}
