// drive.js: คนขับรถไปรับส่งของที่โกดัง คุยกับ Google Drive REST API โดยตรง
// ไฟล์นี้ไม่รู้เรื่องแฟ้มหรือหนังสือของแอป รู้แค่วิธีเรียก API
// สิทธิ์ drive.file ทำให้ Drive คืนเฉพาะไฟล์ที่แอปนี้สร้างเอง ไฟล์อื่นในไดรฟ์เรามองไม่เห็นเลย

import { APP_FOLDER } from "./config.js";
import { requestToken, accessToken } from "./auth.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const JSON_HEAD = { "Content-Type": "application/json; charset=UTF-8" };

/* ---------- 1. ตัวกลางสำหรับทุกคำสั่ง ---------- */
async function api(url, opts = {}) {
  await requestToken(false); // ต้องมี token ที่ยังไม่หมดอายุ ไม่งั้นโยน need_login
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + accessToken() },
  });
  if (res.status === 401) throw new Error("need_login");
  if (!res.ok) throw new Error("drive_" + res.status);
  return res;
}

const json = async (url, opts) => (await api(url, opts)).json();

// ใช้ XHR เฉพาะไฟล์ใหญ่ เพราะบอกความคืบหน้าได้ (fetch ทำไม่ได้)
function sendXHR(method, url, body, onProgress, total, contentType, responseType = "") {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("Authorization", "Bearer " + accessToken());
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    if (responseType) xhr.responseType = responseType;

    const target = method === "GET" ? xhr : xhr.upload;
    target.onprogress = (e) => {
      const size = e.lengthComputable ? e.total : total;
      if (onProgress && size) onProgress(Math.min(1, e.loaded / size));
    };
    xhr.onload = () => (xhr.status < 300 ? resolve(xhr) : reject(new Error("drive_" + xhr.status)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(body);
  });
}

/* ---------- 2. แฟ้ม ---------- */
export async function ensureAppFolder() {
  const params = new URLSearchParams({
    q: `mimeType = '${FOLDER_MIME}' and name = '${APP_FOLDER}' and trashed = false`,
    fields: "files(id)",
  });
  const list = await json(`${API}/files?${params}`);
  if (list.files.length) return list.files[0].id;
  const made = await createFolder(APP_FOLDER, "root");
  return made.id;
}

export function createFolder(name, parentId) {
  return json(`${API}/files?fields=id`, {
    method: "POST",
    headers: JSON_HEAD,
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
}

// เปลี่ยนชื่อและย้ายที่อยู่ในคราวเดียว
export async function moveAndRename(id, name, parentId) {
  const file = await json(`${API}/files/${id}?fields=parents`);
  const current = file.parents || [];
  const params = new URLSearchParams({ fields: "id" });

  if (parentId && !current.includes(parentId)) {
    params.set("addParents", parentId);
    if (current.length) params.set("removeParents", current.join(","));
  }
  return json(`${API}/files/${id}?${params}`, {
    method: "PATCH",
    headers: JSON_HEAD,
    body: JSON.stringify({ name }),
  });
}

export function trashFile(id) {
  return json(`${API}/files/${id}?fields=id`, {
    method: "PATCH",
    headers: JSON_HEAD,
    body: JSON.stringify({ trashed: true }), // ย้ายไปถังขยะ กู้คืนได้ 30 วัน
  });
}

/* ---------- 3. รายการไฟล์ทั้งหมดของแอป ---------- */
export async function listFiles() {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: "trashed = false",
      fields: "nextPageToken, files(id,name,mimeType,size,parents,appProperties)",
      pageSize: "1000",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await json(`${API}/files?${params}`);
    files.push(...data.files);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

/* ---------- 4. อัปโหลดและดาวน์โหลดไฟล์ PDF ---------- */
// อัปโหลดแบบ resumable เหมาะกับไฟล์ใหญ่ ส่งเป็นช่วงๆ ได้
export async function uploadPdf(blob, { name, parentId, hash }, onProgress) {
  const res = await api(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: { ...JSON_HEAD, "X-Upload-Content-Type": "application/pdf" },
    body: JSON.stringify({
      name: name + ".pdf",
      parents: [parentId],
      mimeType: "application/pdf",
      appProperties: { hash }, // ลายนิ้วมือไฟล์ ใช้จับคู่กับหนังสือในเครื่อง
    }),
  });

  const location = res.headers.get("Location");
  if (!location) throw new Error("upload_init_failed");

  const xhr = await sendXHR("PUT", location, blob, onProgress, blob.size, "application/pdf");
  return JSON.parse(xhr.responseText).id;
}

export async function downloadFile(id, size, onProgress) {
  await requestToken(false);
  const xhr = await sendXHR("GET", `${API}/files/${id}?alt=media`, null, onProgress, size, null, "arraybuffer");
  return xhr.response;
}

/* ---------- 5. โฟลเดอร์ซ่อนสำหรับบุ๊กมาร์ก ---------- */
export async function readAppData(name) {
  const params = new URLSearchParams({
    q: `name = '${name}' and trashed = false`,
    spaces: "appDataFolder",
    fields: "files(id)",
  });
  const list = await json(`${API}/files?${params}`);
  if (!list.files.length) return { id: null, data: null };

  const id = list.files[0].id;
  const data = await json(`${API}/files/${id}?alt=media`);
  return { id, data };
}

export async function writeAppData(name, id, data) {
  const body = JSON.stringify(data);
  if (id) {
    await api(`${UPLOAD}/files/${id}?uploadType=media`, { method: "PATCH", headers: JSON_HEAD, body });
    return id;
  }
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name, parents: ["appDataFolder"] })], { type: "application/json" }));
  form.append("file", new Blob([body], { type: "application/json" }));
  const created = await json(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", body: form });
  return created.id;
}
