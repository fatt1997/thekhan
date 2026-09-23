// config.js: ค่าตั้งต้นของแอป

// วาง Client ID ที่ได้จาก Google Cloud ลงในเครื่องหมายคำพูดข้างล่างนี้
export const CLIENT_ID = "922844618672-onl873lknucvqdbcou5ogio3vtqm1oub.apps.googleusercontent.com";

// สิทธิ์ที่แอปขอจากผู้ใช้ ต้องตรงกับที่ตั้งไว้ในหน้า Data Access
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
].join(" ");

// ชื่อโฟลเดอร์หลักของแอปใน Google Drive
export const APP_FOLDER = "ที่คั่น";