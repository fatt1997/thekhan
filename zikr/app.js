'use strict';
/* ตัวนับซิกิร — เก็บข้อมูลใน localStorage */

const KEY = 'zikr-data-v1';
const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_ITEMS = () => [
  { id: uid(), text: 'أَسْتَغْفِرُ اللّٰهَ', note: 'ขออภัยโทษต่ออัลลอฮ์', target: 3 },
  { id: uid(), text: 'سُبْحَانَ اللّٰهِ', note: 'มหาบริสุทธิ์แด่อัลลอฮ์', target: 33 },
  { id: uid(), text: 'الْحَمْدُ لِلّٰهِ', note: 'มวลการสรรเสริญเป็นของอัลลอฮ์', target: 33 },
  { id: uid(), text: 'اللّٰهُ أَكْبَرُ', note: 'อัลลอฮ์ทรงยิ่งใหญ่', target: 34 },
  { id: uid(), text: 'اللَّهُمَّ صلِّ وسلِّم على نبينا محمد', note: 'ศอลาวาตแด่ท่านนบี', target: 100 },
];

function defaultData() {
  return {
    sessions: ['ศุบฮิ', 'ซุฮ์รี', 'อัศริ', 'มัฆริบ', 'อิชาอ์'].map(name => ({ id: uid(), name, items: DEFAULT_ITEMS() })),
    progress: { date: todayKey(), counts: {} },
    opts: { vibrate: true, auto: true },
  };
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let data = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.sessions)) {
      d.opts = Object.assign({ vibrate: true, auto: true }, d.opts);
      d.progress = d.progress || { date: todayKey(), counts: {} };
      return d;
    }
  } catch (e) {}
  return defaultData();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} }
function rollDay() {
  if (data.progress.date !== todayKey()) { data.progress = { date: todayKey(), counts: {} }; save(); }
}

const $ = id => document.getElementById(id);
const countOf = item => data.progress.counts[item.id] || 0;
const isDone = item => countOf(item) >= item.target;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 1800);
}

/* กล่องถามในหน้า (แทน confirm/prompt) */
function ask({ title, text = '', input = false, area = false, value = '', ok = 'ตกลง', danger = false, cancel = true }) {
  return new Promise(res => {
    const m = $('modal'), inp = $('mInput'), ta = $('mArea');
    $('mTitle').textContent = title; $('mText').textContent = text;
    inp.hidden = !input; ta.hidden = !area; inp.value = ta.value = value;
    $('mOk').textContent = ok; $('mOk').classList.toggle('danger', danger);
    $('mCancel').hidden = !cancel;
    m.classList.remove('hidden');
    if (input) inp.focus(); else if (area) { ta.focus(); if (value) ta.select(); }
    const done = v => { m.classList.add('hidden'); $('mOk').onclick = $('mCancel').onclick = null; res(v); };
    $('mOk').onclick = () => done(input ? inp.value : area ? ta.value : true);
    $('mCancel').onclick = () => done(input || area ? null : false);
  });
}
function buzz(ms) { if (data.opts.vibrate && navigator.vibrate) navigator.vibrate(ms); }

/* ---------- หน้าแรก ---------- */
function renderHome() {
  rollDay();
  $('today').textContent = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
  $('sessionList').innerHTML = data.sessions.map((s, i) => {
    const n = s.items.length, done = s.items.filter(isDone).length;
    const pct = n ? Math.round(done / n * 100) : 0;
    return `<button class="s-card ${n && done === n ? 'done' : ''}" data-i="${i}">
      <div class="s-num">${n && done === n ? '✓' : i + 1}</div>
      <div class="s-info">
        <div class="s-name">${esc(s.name)}</div>
        <div class="s-sub">${done}/${n} บท</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div></button>`;
  }).join('');
}
$('sessionList').addEventListener('click', e => {
  const b = e.target.closest('.s-card'); if (b) openSession(+b.dataset.i);
});

/* ---------- หน้านับ ---------- */
let cur = { s: 0, i: 0 };
const sess = () => data.sessions[cur.s];
const item = () => sess().items[cur.i];

function openSession(si) {
  rollDay();
  cur.s = si;
  const items = sess().items;
  const first = items.findIndex(it => !isDone(it));
  cur.i = first < 0 ? 0 : first;
  show('counter');
  renderCounter();
}

function renderCounter() {
  const s = sess(), items = s.items;
  $('sessionTitle').textContent = s.name;
  const allDone = items.length > 0 && items.every(isDone);
  const empty = items.length === 0;
  $('doneAll').classList.toggle('hidden', !(allDone && cur.showDone));
  $('slide').classList.toggle('hidden', allDone && cur.showDone);
  if (empty) {
    $('pos').textContent = '';
    $('dhikrText').textContent = 'ยังไม่มีบท'; $('dhikrText').dataset.id = '';
    $('dhikrNote').textContent = 'กดปุ่มดินสอด้านบนเพื่อเพิ่มบท';
    $('count').textContent = ''; $('target').textContent = '';
    $('dots').innerHTML = '';
    return;
  }
  const it = item(), c = countOf(it);
  $('pos').textContent = `บทที่ ${cur.i + 1} / ${items.length}`;
  const tx = $('dhikrText');
  if (tx.dataset.id !== it.id) { tx.dataset.id = it.id; tx.scrollTop = 0; }
  if (tx.textContent !== it.text) tx.textContent = it.text;
  requestAnimationFrame(markScroll);
  $('dhikrNote').textContent = it.note || '';
  $('count').textContent = c;
  $('target').textContent = isDone(it) ? `ครบ ${it.target} ครั้ง ✓` : `จาก ${it.target} ครั้ง`;
  $('slide').classList.toggle('complete', isDone(it));
  $('dots').innerHTML = items.map((x, k) =>
    `<i class="${k === cur.i ? 'cur' : ''} ${isDone(x) ? 'done' : ''}"></i>`).join('');
}

/* ข้อความยาว: จางด้านล่างเพื่อบอกว่าเลื่อนอ่านต่อได้ */
function markScroll() {
  const t = $('dhikrText');
  t.classList.toggle('more', t.scrollHeight > t.clientHeight + 4);
  t.classList.toggle('end', t.scrollTop + t.clientHeight >= t.scrollHeight - 4);
}
$('dhikrText').addEventListener('scroll', markScroll, { passive: true });
window.addEventListener('resize', markScroll);

let advanceT;
function tap() {
  const items = sess().items;
  if (!items.length || cur.showDone) return;
  const it = item();
  if (isDone(it)) { goNext(); return; }
  data.progress.counts[it.id] = countOf(it) + 1;
  save();
  const c = $('count'); c.classList.add('bump'); setTimeout(() => c.classList.remove('bump'), 80);
  if (isDone(it)) {
    buzz([60, 60, 120]);
    renderCounter();
    if (data.opts.auto) {
      clearTimeout(advanceT);
      advanceT = setTimeout(() => {
        if (items.every(isDone)) { cur.showDone = true; renderCounter(); }
        else goNext();
      }, 700);
    }
  } else {
    buzz(15);
    renderCounter();
  }
}

function slideTo(newI, dir) {
  clearTimeout(advanceT);
  cur.showDone = false;
  const sl = $('slide');
  sl.classList.add('anim');
  sl.style.transform = `translateX(${dir < 0 ? -40 : 40}%)`; sl.style.opacity = 0;
  setTimeout(() => {
    cur.i = newI; renderCounter();
    sl.classList.remove('anim');
    sl.style.transform = `translateX(${dir < 0 ? 40 : -40}%)`;
    requestAnimationFrame(() => {
      sl.classList.add('anim'); sl.style.transform = ''; sl.style.opacity = 1;
    });
  }, 180);
}
function goNext() {
  const n = sess().items.length;
  if (cur.i < n - 1) slideTo(cur.i + 1, -1);
  else if (sess().items.every(isDone)) { cur.showDone = true; renderCounter(); }
  else { const f = sess().items.findIndex(x => !isDone(x)); slideTo(f, -1); }
}
function goPrev() { if (cur.i > 0) slideTo(cur.i - 1, 1); }

/* แตะ / ปัด */
(() => {
  const st = $('stage'); let sx = 0, sy = 0, down = false, moved = false;
  st.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    down = true; moved = false; sx = e.clientX; sy = e.clientY;
  });
  st.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 12 || Math.abs(e.clientY - sy) > 12) moved = true;
    if (moved && !cur.showDone) $('slide').style.transform = `translateX(${dx * 0.5}px)`;
  });
  const end = e => {
    if (!down) return; down = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    $('slide').style.transform = '';
    if (!moved) { tap(); return; }
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) dx < 0 ? goNext() : goPrev();
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', () => { down = false; $('slide').style.transform = ''; });
  // คีย์บอร์ด (ใช้บนคอม): เว้นวรรค = นับ, ลูกศร = เปลี่ยนบท
  document.addEventListener('keydown', e => {
    if (!$('counter').classList.contains('active') || !$('sheet').classList.contains('hidden') || !$('modal').classList.contains('hidden')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); }
    if (e.key === 'ArrowLeft') goNext();
    if (e.key === 'ArrowRight') goPrev();
  });
})();

$('btnBack').onclick = () => { clearTimeout(advanceT); cur.showDone = false; show('home'); renderHome(); };
$('btnDoneBack').onclick = $('btnBack').onclick;
$('btnReset').onclick = async () => {
  if (!sess().items.length) return;
  if (!await ask({ title: 'เริ่มนับบทนี้ใหม่จาก 0 ?', ok: 'เริ่มใหม่', danger: true })) return;
  clearTimeout(advanceT); cur.showDone = false;
  delete data.progress.counts[item().id]; save(); renderCounter();
};

/* รายการบท */
$('btnList').onclick = () => {
  const items = sess().items;
  $('sheetTitle').textContent = sess().name;
  $('sheetBody').innerHTML = items.map((x, k) =>
    `<button class="li ${isDone(x) ? 'done' : ''} ${k === cur.i ? 'cur' : ''}" data-k="${k}">
      <span class="ct">${k + 1}.</span><span class="ar">${esc(x.text)}</span>
      <span class="ct">${countOf(x)}/${x.target}</span></button>`).join('') ||
    '<p class="muted">ยังไม่มีบท</p>';
  $('sheet').classList.remove('hidden');
};
$('sheet').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { $('sheet').classList.add('hidden'); return; }
  const b = e.target.closest('.li');
  if (b) { $('sheet').classList.add('hidden'); clearTimeout(advanceT); cur.showDone = false; cur.i = +b.dataset.k; renderCounter(); }
});

/* ---------- แก้ไขบท ---------- */
let draft = null;
$('btnEdit').onclick = () => {
  draft = JSON.parse(JSON.stringify(sess()));
  $('edName').value = draft.name;
  renderEditor();
  show('editor');
};
function renderEditor() {
  $('edItems').innerHTML = draft.items.map((x, k) => `
    <div class="ed-item" data-k="${k}">
      <div class="num">บทที่ ${k + 1}</div>
      <textarea class="ar" data-f="text" placeholder="คำซิกิร (อาหรับหรือไทย)">${esc(x.text)}</textarea>
      <div class="row"><input data-f="note" placeholder="ความหมาย / หมายเหตุ (ไม่ใส่ก็ได้)" value="${esc(x.note || '')}"></div>
      <div class="row">
        <span class="lbl">นับ</span><input class="n" data-f="target" type="number" inputmode="numeric" min="1" value="${x.target}"><span class="lbl">ครั้ง</span>
        <span class="sp"></span>
        <button class="mini" data-a="up" aria-label="เลื่อนขึ้น">↑</button>
        <button class="mini" data-a="down" aria-label="เลื่อนลง">↓</button>
        <button class="mini del" data-a="del" aria-label="ลบ">✕</button>
      </div>
    </div>`).join('');
}
$('edItems').addEventListener('input', e => {
  const box = e.target.closest('.ed-item'); const f = e.target.dataset.f;
  if (!box || !f) return;
  const x = draft.items[+box.dataset.k];
  x[f] = f === 'target' ? Math.max(1, parseInt(e.target.value, 10) || 1) : e.target.value;
});
$('edItems').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const k = +b.closest('.ed-item').dataset.k, a = b.dataset.a, arr = draft.items;
  if (a === 'del') { if (!await ask({ title: 'ลบบทนี้?', ok: 'ลบ', danger: true })) return; arr.splice(k, 1); }
  if (a === 'up' && k > 0) [arr[k - 1], arr[k]] = [arr[k], arr[k - 1]];
  if (a === 'down' && k < arr.length - 1) [arr[k + 1], arr[k]] = [arr[k], arr[k + 1]];
  renderEditor();
});
$('btnAddItem').onclick = () => {
  draft.items.push({ id: uid(), text: '', note: '', target: 3 });
  renderEditor();
  const all = $('edItems').querySelectorAll('textarea'); all[all.length - 1].focus();
};
$('btnPaste').onclick = async () => {
  const txt = await ask({ title: 'วางหลายบทพร้อมกัน', area: true, ok: 'เพิ่ม',
    text: 'บรรทัดละ 1 บท ใส่จำนวนครั้งท้ายบรรทัดหลัง | เช่น\nسبحان الله | 33' });
  if (!txt) return;
  txt.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
    const m = l.match(/^(.*?)\s*[|x×*]\s*(\d+)\s*$/);
    draft.items.push({ id: uid(), text: m ? m[1] : l, note: '', target: m ? +m[2] : 1 });
  });
  renderEditor();
};
$('btnEdCancel').onclick = () => { draft = null; show('counter'); renderCounter(); };
$('btnEdSave').onclick = () => {
  draft.name = $('edName').value.trim() || sess().name;
  draft.items = draft.items.filter(x => x.text.trim());
  data.sessions[cur.s] = draft; draft = null; save();
  cur.i = Math.min(cur.i, Math.max(0, sess().items.length - 1));
  cur.showDone = false;
  show('counter'); renderCounter(); toast('บันทึกแล้ว');
};

/* ---------- ตั้งค่า ---------- */
$('btnSettings').onclick = () => {
  $('optVibrate').checked = data.opts.vibrate; $('optAuto').checked = data.opts.auto;
  show('settings');
};
$('btnSetBack').onclick = () => { show('home'); renderHome(); };
$('optVibrate').onchange = e => { data.opts.vibrate = e.target.checked; save(); };
$('optAuto').onchange = e => { data.opts.auto = e.target.checked; save(); };
$('btnAddSession').onclick = async () => {
  const name = await ask({ title: 'ชื่อหมวดใหม่', input: true, ok: 'เพิ่ม' }); if (!name || !name.trim()) return;
  data.sessions.push({ id: uid(), name: name.trim(), items: [] }); save(); toast('เพิ่มหมวดแล้ว');
};
$('btnResetToday').onclick = async () => {
  if (!await ask({ title: 'ล้างการนับของวันนี้ทั้งหมด?', ok: 'ล้าง', danger: true })) return;
  data.progress = { date: todayKey(), counts: {} }; save(); toast('ล้างแล้ว');
};
$('btnExport').onclick = async () => {
  const s = JSON.stringify({ sessions: data.sessions }, null, 1);
  try { await navigator.clipboard.writeText(s); toast('คัดลอกข้อมูลแล้ว'); }
  catch (e) { ask({ title: 'คัดลอกข้อความนี้เก็บไว้', area: true, value: s, ok: 'ปิด', cancel: false }); }
};
$('btnImport').onclick = async () => {
  const s = await ask({ title: 'วางข้อมูลที่สำรองไว้', area: true, ok: 'นำเข้า' }); if (!s) return;
  try {
    const d = JSON.parse(s);
    if (!Array.isArray(d.sessions)) throw 0;
    data.sessions = d.sessions; save(); toast('นำเข้าแล้ว');
  } catch (e) { toast('ข้อมูลไม่ถูกต้อง'); }
};

/* เริ่ม */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && $('home').classList.contains('active')) renderHome();
});
renderHome();
if ('serviceWorker' in navigator && !window.ZIKR_EMBED) navigator.serviceWorker.register('sw.js').catch(() => {});
