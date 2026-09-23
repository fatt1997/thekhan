// auth.js: ล็อกอินด้วยบัญชี Google
// ใช้ Google Identity Services ขอ access token หนึ่งใบ
// token ใบนี้ใช้ได้ 2 อย่าง คือ อ่านชื่อและอีเมลของผู้ใช้ และเรียก Google Drive API (ขั้น D)

import { CLIENT_ID, SCOPES } from "./config.js";

const KEY_USER = "user";
const KEY_TOKEN = "gtoken";

let user = null;      // { sub, name, email, picture }
let token = null;
let tokenExp = 0;
let tokenClient = null;
let pending = null;   // คำขอที่รอผลจากหน้าต่างล็อกอิน

export const currentUser = () => user;
export const accessToken = () => token;
export const hasToken = () => !!token && Date.now() < tokenExp;

/* ---------- 1. เตรียมระบบล็อกอิน (เรียกครั้งเดียวตอนเปิดแอป) ---------- */
export async function initAuth() {
  if (!CLIENT_ID) throw new Error("no_client_id");
  await waitForGoogle();

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (res) => {
      if (res.error) finish(null, new Error(res.error));
      else {
        token = res.access_token;
        tokenExp = Date.now() + (Number(res.expires_in || 3600) - 60) * 1000;
        save(KEY_TOKEN, { token, exp: tokenExp });
        finish(token, null);
      }
    },
    error_callback: (err) => finish(null, new Error((err && err.type) || "popup_closed")),
  });
}

// สคริปต์ของ Google โหลดแบบ async จึงต้องรอให้พร้อมก่อน
function waitForGoogle(timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (window.google && google.accounts && google.accounts.oauth2) resolve();
      else if (Date.now() - started > timeout) reject(new Error("gis_timeout"));
      else setTimeout(check, 100);
    };
    check();
  });
}

function finish(value, error) {
  if (!pending) return;
  const { resolve, reject } = pending;
  pending = null;
  if (error) reject(error);
  else resolve(value);
}

/* ---------- 2. จำบัญชีที่ล็อกอินไว้ ---------- */
export function restoreUser() {
  user = load(KEY_USER);
  const saved = load(KEY_TOKEN);
  if (saved && saved.exp > Date.now()) {
    token = saved.token;
    tokenExp = saved.exp;
  }
  return user;
}

/* ---------- 3. ขอ token ---------- */
// interactive = true ต้องเรียกจากการกดปุ่มเท่านั้น ไม่งั้น Safari จะบล็อกหน้าต่างล็อกอิน
export function requestToken(interactive) {
  if (hasToken()) return Promise.resolve(token);
  if (!interactive) return Promise.reject(new Error("need_login"));
  if (!tokenClient) return Promise.reject(new Error("gis_not_ready"));

  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    // เคยล็อกอินบัญชีนี้แล้ว ไม่ต้องถามสิทธิ์ซ้ำ
    tokenClient.requestAccessToken({ prompt: user ? "" : "consent" });
  });
}

/* ---------- 4. ล็อกอินและออกจากระบบ ---------- */
export function signIn() {
  return requestToken(true).then(fetchProfile);
}

// ถาม Google ว่าคนที่ล็อกอินคือใคร
async function fetchProfile() {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error("profile_failed");

  const p = await res.json();
  user = {
    sub: p.sub,                    // รหัสประจำตัวของบัญชี ใช้แยกข้อมูลแต่ละคน (NFR6)
    name: p.name || p.email || "",
    email: p.email || "",
    picture: p.picture || "",
  };
  save(KEY_USER, user);
  return user;
}

export function signOut() {
  if (token && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(token, () => {});
  }
  token = null;
  tokenExp = 0;
  user = null;
  localStorage.removeItem(KEY_USER);
  localStorage.removeItem(KEY_TOKEN);
}

/* ---------- 5. ข้อความบอกสาเหตุเวลาล็อกอินไม่สำเร็จ ---------- */
export function authError(err) {
  const map = {
    no_client_id: "ยังไม่ได้ใส่ Client ID ในไฟล์ config.js",
    gis_timeout: "โหลดระบบล็อกอินของ Google ไม่ได้ ลองเช็กอินเทอร์เน็ตแล้วรีเฟรช",
    gis_not_ready: "ระบบล็อกอินยังไม่พร้อม ลองรีเฟรชหน้าเว็บ",
    popup_closed: "ปิดหน้าต่างล็อกอินก่อนเสร็จ",
    popup_failed_to_open: "เบราว์เซอร์บล็อกหน้าต่างล็อกอิน ลองกดอีกครั้ง",
    access_denied: "ยังไม่ได้อนุญาตให้แอปใช้งาน",
    need_login: "ต้องล็อกอินก่อน",
    profile_failed: "อ่านข้อมูลบัญชีไม่สำเร็จ ลองอีกครั้ง",
  };
  return map[err.message] || "ล็อกอินไม่สำเร็จ: " + err.message;
}

/* ---------- ตัวช่วยเล็กๆ ---------- */
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
