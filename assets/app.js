import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const DATA_PATH = 'data/';
const EMOJIS = ['🌟', '🌈', '🍀', '🌻', '🙏', '🔔', '💛', '✨', '🌙', '☀️', '🌸', '🎵', '⭐', '🎐', '🎲', '🐘', '📘', '📚', '✏️', '🏆', '🎯', '🎁', '🎉', '🎈', '🍎', '🍊', '🍋', '🍌', '🍇', '🍉', '🐝', '🐢'];

const state = {
  settings: null, firebaseConfig: null, firebaseReady: false, app: null, auth: null, db: null,
  control: null, studentIndex: [], studentsByLevel: {}, chants: [], activeChants: [], selectedStudent: null, emojiCode: [],
  currentChapterIndex: 0, chapters: [], totalScore: 0, lastSubmissions: [], isAdmin: false, adminAutoTimer: null,
  audio: { stream: null, context: null, analyser: null, data: null, timeData: null, raf: null, micOn: false, startedAt: 0, totalFrames: 0, activeFrames: 0, score: 0, combo: 0, bestCombo: 0, lastRms: 0, stabilitySum: 0, noiseFloor: 0, noiseSamples: [], calibratingUntil: 0, activeStreak: 0 },
  scrollTimer: null, manualScrollTimer: null, ignoreScrollUntil: 0, autoScroll: true, nextHoldTimer: null, nextHoldStarted: 0, isSubmitting: false
};

const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('th-TH');

window.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  try {
    const [settings, firebaseConfig, studentIndex, chants] = await Promise.all([
      fetchJson('settings.json'), fetchJson('firebase_config.json'), fetchJson('student_index.json'), fetchJson('chants.json')
    ]);
    state.settings = settings;
    state.firebaseConfig = firebaseConfig;
    state.studentIndex = studentIndex;
    state.chants = (chants || []).filter(x => x.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
    renderBasicHome();
    await initFirebase();
    await ensureAnonymous();
    await refreshControl(false);
    renderHome();
  } catch (err) {
    console.error(err);
    $('homeStatus').textContent = 'โหลดระบบไม่สำเร็จ: ' + err.message;
  }
}

async function fetchJson(name) {
  const res = await fetch(DATA_PATH + name + '?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(name + ' HTTP ' + res.status);
  return res.json();
}

function bindEvents() {
  document.querySelectorAll('[data-nav="home"]').forEach(btn => btn.addEventListener('click', goHomeSafe));
  $('btnStartGate').addEventListener('click', startGate);
  $('btnCheckSystem').addEventListener('click', async () => { await refreshControl(true); renderHome(); });
  $('btnAdminOpen').addEventListener('click', () => showView('admin'));
  $('btnOpenBrowser').addEventListener('click', openSupportedBrowser);
  $('btnCopyLink').addEventListener('click', copyCurrentLink);
  $('levelSelect').addEventListener('change', onLevelChange);
  $('roomSelect').addEventListener('change', onRoomChange);
  $('studentSelect').addEventListener('change', renderStudentConfirm);
  $('studentIdInput').addEventListener('input', onStudentIdInput);
  $('btnGoEmoji').addEventListener('click', goEmojiStep);
  $('btnRandomEmoji').addEventListener('click', randomEmojiCode);
  $('btnConfirmEmoji').addEventListener('click', confirmEmojiAndStart);
  $('btnBackHomeFromChant').addEventListener('click', () => { if (confirm('ออกจากหน้าสวดหรือไม่? คะแนนที่ยังไม่จบจะไม่ถูกบันทึก')) goHomeSafe(); });
  $('btnMic').addEventListener('click', toggleMic);
  $('btnNextChapter').addEventListener('mousedown', startHoldNextChapter);
  $('btnNextChapter').addEventListener('touchstart', startHoldNextChapter, { passive: false });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => $('btnNextChapter').addEventListener(evt, cancelHoldNextChapter));
  $('chantStage').addEventListener('scroll', onManualScroll, { passive: true });
  $('btnSubmitScore').addEventListener('click', submitScoreToFirestore);
  $('btnReturnHome').addEventListener('click', goHomeSafe);
  $('btnAdminLogin').addEventListener('click', adminLogin);
  $('btnAdminLogout').addEventListener('click', adminLogout);
  $('btnOpenSystem').addEventListener('click', () => saveControlFromAdmin(true));
  $('btnCloseSystem').addEventListener('click', () => saveControlFromAdmin(false));
  $('btnSaveControl').addEventListener('click', () => saveControlFromAdmin(null));
  $('btnRefreshDashboard').addEventListener('click', refreshDashboard);
  $('btnToggleAutoRefresh').addEventListener('click', toggleDashboardAutoRefresh);
  $('btnExportCsv').addEventListener('click', exportCsv);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopDashboardAutoRefresh(); });
}

function renderBasicHome() {
  const s = state.settings || {};
  $('schoolName').textContent = s.schoolName || 'โรงเรียน';
  $('systemName').textContent = s.systemName || 'ระบบสวดมนต์สรภัญญะ';
  $('weekText').textContent = s.weekKey || '-';
}

async function initFirebase() {
  const cfg = state.firebaseConfig || {};
  if (!cfg.apiKey || String(cfg.apiKey).includes('PASTE_')) {
    $('firebaseText').textContent = 'ยังไม่ตั้งค่า';
    throw new Error('ยังไม่ได้ตั้งค่า data/firebase_config.json');
  }
  state.app = initializeApp(cfg);
  state.auth = getAuth(state.app);
  state.db = getFirestore(state.app);
  state.firebaseReady = true;
  $('firebaseText').textContent = 'พร้อม';
}

async function ensureAnonymous() {
  if (!state.auth) return;
  if (state.auth.currentUser) return;
  await signInAnonymously(state.auth);
}

async function refreshControl(showAlert = false) {
  if (!state.db) return null;
  const snap = await getDoc(doc(state.db, 'control', 'current'));
  state.control = snap.exists() ? snap.data() : null;
  if (showAlert) { alert(state.control ? 'โหลดสถานะระบบแล้ว' : 'ยังไม่มี control/current กรุณาให้ Admin ตั้งค่าก่อน'); }
  return state.control;
}

function isControlOpen(control = state.control) {
  if (!control || control.systemOpen !== true) return false;
  const now = Date.now();
  const openAt = toMillis(control.openAt);
  const closeAt = toMillis(control.closeAt);
  if (openAt && now < openAt) return false;
  if (closeAt && now > closeAt) return false;
  return true;
}
function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'string') return new Date(v).getTime();
  if (v.seconds) return v.seconds * 1000;
  return 0;
}

function renderHome() {
  renderBasicHome();
  const c = state.control;
  const open = isControlOpen(c);
  $('systemOpenText').textContent = open ? 'เปิด' : 'ปิด';
  $('systemOpenText').style.color = open ? 'var(--ok)' : 'var(--danger)';
  const week = c?.weekKey || state.settings?.weekKey || '-';
  $('weekText').textContent = week;
  if (!c) {
    $('homeStatus').textContent = 'ยังไม่มี control/current ใน Firestore ให้ Admin ตั้งค่าก่อนใช้งาน';
    $('btnStartGate').disabled = true;
    $('btnStartGate').textContent = 'รอ Admin ตั้งค่า';
    return;
  }
  if (open) {
    $('homeStatus').textContent = `เปิดรับคะแนน | ${c.termKey || ''} ${c.weekKey || ''} | Session ${c.sessionId || '-'}`;
    $('btnStartGate').disabled = false;
    $('btnStartGate').textContent = 'เริ่มสวดมนต์';
  } else {
    $('homeStatus').textContent = c.closedMessage || 'ระบบปิดรับคะแนนประจำสัปดาห์นี้แล้ว';
    $('btnStartGate').disabled = true;
    $('btnStartGate').textContent = 'ปิดระบบ';
  }
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view' + name.charAt(0).toUpperCase() + name.slice(1)).classList.add('active');
  document.body.classList.toggle('chant-mode', name === 'chant');
  window.scrollTo(0, 0);
}

function detectBrowserGate() {
  const ua = navigator.userAgent || '';
  const isLine = ua.includes('Line/');
  const isFacebook = ua.includes('FBAN') || ua.includes('FBAV') || ua.includes('FB_IAB') || ua.includes('FB4A');
  const isMessenger = ua.includes('Messenger') || ua.includes('FB_IAB/MESSENGER');
  const isInstagram = ua.includes('Instagram');
  const isTikTok = ua.includes('TikTok') || ua.includes('Bytedance') || ua.includes('Musical_ly');
  const isTwitter = ua.includes('Twitter') || ua.includes('XTwitter');
  const isInAppBrowser = isLine || isFacebook || isMessenger || isInstagram || isTikTok || isTwitter;
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isAndroidOk = isAndroid && /Chrome|EdgA|Firefox|SamsungBrowser|OPR/i.test(ua) && !isInAppBrowser;
  const isIOSOk = isIOS && /Safari|CriOS|FxiOS|EdgiOS/i.test(ua) && !isInAppBrowser;
  const isDesktopOk = !isAndroid && !isIOS && /Chrome|Edg|Safari|Firefox/i.test(ua) && !isInAppBrowser;
  const appName = isLine ? 'LINE' : isMessenger ? 'Messenger' : isInstagram ? 'Instagram' : isTikTok ? 'TikTok' : isFacebook ? 'Facebook' : isTwitter ? 'X/Twitter' : 'แอปนี้';
  return { isSupported: isAndroidOk || isIOSOk || isDesktopOk, isInAppBrowser, isAndroid, isIOS, appName };
}
function renderBrowserGate(gate) {
  $('browserGate').classList.remove('hidden');
  $('browserGateText').textContent = `ตอนนี้เปิดจาก ${gate.appName} ซึ่งอาจบล็อกไมโครโฟน กรุณาเปิดด้วย Chrome หรือ Safari`;
  const steps = gate.isAndroid ? ['กด “เปิดด้วย Browser เครื่อง”', 'ถ้าไม่เด้ง ให้คัดลอกลิงก์', 'เปิด Chrome เอง แล้ววางลิงก์'] : ['กด “คัดลอกลิงก์”', 'เปิด Safari หรือ Chrome', 'วางลิงก์แล้วเข้าเว็บ'];
  $('browserSteps').innerHTML = steps.map(x => `<li>${escapeHtml(x)}</li>`).join('');
}

async function startGate() {
  const gate = detectBrowserGate();
  if (!gate.isSupported) { renderBrowserGate(gate); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Browser นี้ไม่รองรับไมโครโฟน กรุณาใช้ Chrome หรือ Safari'); return; }
  await refreshControl(false);
  if (!isControlOpen()) { alert(state.control?.closedMessage || 'ระบบปิดรับคะแนน'); renderHome(); return; }
  setupStudentSelectors();
  showView('select');
}

function setupStudentSelectors() {
  const levels = state.studentIndex.map(x => x.level).filter(Boolean);
  fillSelect($('levelSelect'), levels, 'เลือกระดับชั้น');
  fillSelect($('roomSelect'), [], 'เลือกห้อง');
  fillSelect($('studentSelect'), [], 'เลือกชื่อ-นามสกุล');
  $('studentIdInput').value = '';
  $('studentConfirmBox').classList.add('hidden');
}
async function onLevelChange() {
  const level = $('levelSelect').value;
  if (!level) return;
  await loadStudentsForLevel(level);
  const list = state.studentsByLevel[level] || [];
  const rooms = unique(list.map(s => String(s.room))).sort(numSort);
  fillSelect($('roomSelect'), rooms, 'เลือกห้อง');
  fillSelect($('studentSelect'), [], 'เลือกชื่อ-นามสกุล');
  $('studentIdInput').value = ''; renderStudentConfirm();
}
async function loadStudentsForLevel(level) {
  if (state.studentsByLevel[level]) return;
  const item = state.studentIndex.find(x => x.level === level);
  if (!item) throw new Error('ไม่พบไฟล์รายชื่อของ ' + level);
  const data = await fetchJson(item.file);
  state.studentsByLevel[level] = normalizeStudents(data).filter(x => x.active !== false);
}
function onRoomChange() {
  const level = $('levelSelect').value, room = $('roomSelect').value;
  const list = (state.studentsByLevel[level] || []).filter(s => String(s.room) === String(room)).sort((a, b) => numSort(a.no, b.no));
  $('studentSelect').innerHTML = '<option value="">เลือกชื่อ-นามสกุล</option>' + list.map(s => `<option value="${escapeAttr(s.studentKey)}">เลขที่ ${escapeHtml(s.no)} - ${escapeHtml(s.fullName)}</option>`).join('');
  $('studentIdInput').value = ''; renderStudentConfirm();
}
function onStudentIdInput() { $('studentIdInput').value = $('studentIdInput').value.replace(/\D/g, '').slice(0, 5); renderStudentConfirm(); }
function renderStudentConfirm() {
  const stu = getSelectedStudent(); const box = $('studentConfirmBox');
  if (!stu) { box.classList.add('hidden'); return; }
  const id = $('studentIdInput').value.trim(); const idOk = /^\d{5}$/.test(id);
  box.innerHTML = `<strong>${escapeHtml(stu.fullName)}</strong><div>ชั้น ${escapeHtml(stu.level)}/${escapeHtml(stu.room)} เลขที่ ${escapeHtml(stu.no)}</div><div class="muted">${idOk ? 'เลขประจำตัวครบ 5 หลัก' : 'กรอกเลขประจำตัว 5 หลักเพื่อยืนยัน'}</div>`;
  box.classList.remove('hidden');
}
function getSelectedStudent() {
  const level = $('levelSelect').value, key = $('studentSelect').value;
  return (state.studentsByLevel[level] || []).find(s => String(s.studentKey) === String(key)) || null;
}
function normalizeStudents(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(x => x && x.studentKey && x.level && x.room && x.no && x.fullName).map(x => ({ studentKey: String(x.studentKey).trim(), level: String(x.level).trim(), room: String(x.room).trim(), no: String(x.no).trim(), fullName: String(x.fullName).replace(/\s+/g, ' ').trim(), studentId: x.studentId ? String(x.studentId).trim() : '', active: x.active !== false && String(x.active).toLowerCase() !== 'false' }));
}
function fillSelect(el, values, first) { el.innerHTML = `<option value="">${first}</option>` + values.map(v => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join(''); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function numSort(a, b) { return String(a).localeCompare(String(b), 'th', { numeric: true }); }

function goEmojiStep() {
  const stu = getSelectedStudent();
  if (!stu) { alert('กรุณาเลือกชื่อ-นามสกุล'); return; }
  const inputId = $('studentIdInput').value.trim();
  if (state.settings.requireStudentId && !/^\d{5}$/.test(inputId)) { alert('กรุณากรอกเลขประจำตัวนักเรียน 5 หลัก'); return; }
  if (state.settings.validateStudentIdWithRoster && stu.studentId && stu.studentId !== inputId) { alert('เลขประจำตัวไม่ตรงกับรายชื่อ'); return; }
  state.selectedStudent = { ...stu, enteredStudentId: inputId };
  state.emojiCode = []; renderEmojiPicker(); showView('emoji');
}
function renderEmojiPicker() {
  $('emojiSlots').innerHTML = Array.from({ length: 4 }, (_, i) => `<div class="emoji-slot">${state.emojiCode[i] || '+'}</div>`).join('');
  $('emojiPool').innerHTML = EMOJIS.map(e => `<button class="emoji-btn ${state.emojiCode.includes(e) ? 'selected' : ''}" data-emoji="${e}">${e}</button>`).join('');
  document.querySelectorAll('.emoji-btn').forEach(btn => btn.addEventListener('click', () => pickEmoji(btn.dataset.emoji)));
}
function pickEmoji(e) {
  const idx = state.emojiCode.indexOf(e);
  if (idx >= 0) state.emojiCode.splice(idx, 1); else if (state.emojiCode.length < 4) state.emojiCode.push(e); else { state.emojiCode.shift(); state.emojiCode.push(e); }
  renderEmojiPicker();
}
function randomEmojiCode() {
  const pool = [...EMOJIS]; state.emojiCode = [];
  for (let i = 0; i < 4; i++) { const idx = Math.floor(Math.random() * pool.length); state.emojiCode.push(pool.splice(idx, 1)[0]); }
  renderEmojiPicker();
}
async function confirmEmojiAndStart() {
  if (state.emojiCode.length !== 4) { alert('กรุณาเลือกอีโมจิให้ครบ 4 ตัว'); return; }
  await refreshControl(false);
  if (!isControlOpen()) { alert(state.control?.closedMessage || 'ระบบปิดรับคะแนน'); renderHome(); showView('home'); return; }
  try { await requestMicOnce(); beginChantSession(); }
  catch (err) { alert('ไม่สามารถเปิดไมโครโฟนได้: ' + (err.name || err.message) + '\nกรุณาอนุญาตไมค์ หรือเปิดผ่าน Chrome/Safari'); }
}
async function requestMicOnce() { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()); }

function beginChantSession() {
  const level = state.selectedStudent.level;
  state.activeChants = state.chants.filter(c => c.levelGroup === 'all' || c.levelGroup === level || (Array.isArray(c.levelGroup) && c.levelGroup.includes(level)));
  if (!state.activeChants.length) { alert('ยังไม่มีบทสวดที่เปิดใช้งาน'); return; }
  state.currentChapterIndex = 0; state.chapters = []; state.totalScore = 0; showView('chant'); loadCurrentChapter(); startMic();
}
function loadCurrentChapter() {
  stopChapterTimers(false);
  const chant = state.activeChants[state.currentChapterIndex], stu = state.selectedStudent;
  $('chantStudentLine').textContent = `${stu.fullName} | ชั้น ${stu.level}/${stu.room} เลขที่ ${stu.no} | รหัส ${stu.enteredStudentId || '-'} | อีโมจิ ${state.emojiCode.join('')}`;
  $('chantTitle').textContent = chant.title;
  $('chantMeta').textContent = `${state.control?.weekKey || state.settings.weekKey} | บทที่ ${state.currentChapterIndex + 1}/${state.activeChants.length}`;
  $('mobileChantMeta').textContent = `${state.control?.weekKey || state.settings.weekKey} | บท ${state.currentChapterIndex + 1}/${state.activeChants.length}`;
  $('mobileStudentName').textContent = stu.fullName;
  $('mobileStudentSummary').textContent = `👤 ${stu.fullName} ▼`;
  $('mobileEmojiCode').textContent = state.emojiCode.join('');
  $('mobileLiveScore').textContent = Math.round(state.totalScore);
  $('chantText').innerHTML = (chant.lines || []).map(line => `<div class="chant-line">${escapeHtml(line)}</div>`).join('');
  $('chantStage').scrollTop = 0; state.ignoreScrollUntil = Date.now() + 700; $('liveTotalScore').textContent = Math.round(state.totalScore); $('mobileLiveScore').textContent = Math.round(state.totalScore);
  $('btnNextChapter').textContent = state.currentChapterIndex === state.activeChants.length - 1 ? 'กดค้าง 2 วิ: จบบทสวด' : 'กดค้าง 2 วิ: บทถัดไป';
  resetAudioStats(); startChapterTimers();
}
function startChapterTimers() {
  state.audio.startedAt = Date.now(); state.autoScroll = true; clearInterval(state.scrollTimer);
  state.scrollTimer = setInterval(() => { const stage = $('chantStage'); if (state.autoScroll && stage.scrollHeight > stage.clientHeight + 10) { state.ignoreScrollUntil = Date.now() + 120; stage.scrollTop += Number(state.settings.autoScrollSpeed || 1.35); } updateTimer(); }, 50);
}
function stopChapterTimers(stopMicToo = true) { clearInterval(state.scrollTimer); clearTimeout(state.manualScrollTimer); if (stopMicToo) stopMic(); }
function onManualScroll() { if (!$('viewChant').classList.contains('active')) return; if (Date.now() < state.ignoreScrollUntil) return; state.autoScroll = false; $('micStateText').textContent = 'เลื่อนเองชั่วคราว ระบบจะเลื่อนต่อให้อัตโนมัติ'; clearTimeout(state.manualScrollTimer); state.manualScrollTimer = setTimeout(() => { state.autoScroll = true; }, Number(state.settings.manualScrollPauseMs || 4500)); }
function updateTimer() { const sec = Math.floor((Date.now() - state.audio.startedAt) / 1000); $('timerText').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }
async function startMic() {
  try {
    state.audio.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    state.audio.context = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audio.context.createMediaStreamSource(state.audio.stream);
    state.audio.analyser = state.audio.context.createAnalyser(); state.audio.analyser.fftSize = 2048;
    state.audio.data = new Uint8Array(state.audio.analyser.frequencyBinCount); state.audio.timeData = new Uint8Array(state.audio.analyser.fftSize); source.connect(state.audio.analyser);
    state.audio.micOn = true; state.audio.noiseFloor = 0; state.audio.noiseSamples = []; state.audio.activeStreak = 0; state.audio.calibratingUntil = Date.now() + Number(state.settings.micCalibrationMs || 1600);
    $('btnMic').textContent = 'ไมค์: เปิด'; $('micStateText').textContent = 'กำลังวัดเสียงพื้นหลัง...'; audioLoop();
  } catch (err) { $('micStateText').textContent = 'เปิดไมค์ไม่สำเร็จ'; alert('เปิดไมค์ไม่สำเร็จ: ' + err.message); }
}
function stopMic() { if (state.audio.raf) cancelAnimationFrame(state.audio.raf); state.audio.raf = null; if (state.audio.stream) state.audio.stream.getTracks().forEach(t => t.stop()); if (state.audio.context) state.audio.context.close().catch(() => { }); Object.assign(state.audio, { stream: null, context: null, analyser: null, data: null, micOn: false }); }
async function toggleMic() { if (!state.audio.context) return; if (state.audio.micOn) { state.audio.micOn = false; await state.audio.context.suspend().catch(() => { }); $('btnMic').textContent = 'ไมค์: ปิด'; $('micStateText').textContent = 'ไมค์ปิดชั่วคราว'; } else { state.audio.micOn = true; await state.audio.context.resume().catch(() => { }); $('btnMic').textContent = 'ไมค์: เปิด'; $('micStateText').textContent = 'ไมค์เปิด กำลังวิเคราะห์เสียง'; } }
function resetAudioStats() { Object.assign(state.audio, { totalFrames: 0, activeFrames: 0, score: 0, combo: 0, bestCombo: 0, lastRms: 0, stabilitySum: 0, noiseSamples: [], noiseFloor: 0, activeStreak: 0 }); $('comboText').textContent = 'คอมโบ x0'; $('micStateText').textContent = 'กำลังเตรียมไมค์'; }
function audioLoop() {
  if (!state.audio.analyser) return;
  if (state.audio.micOn) {
    state.audio.analyser.getByteTimeDomainData(state.audio.timeData); const rms = calculateTimeRms(state.audio.timeData);
    if (Date.now() < state.audio.calibratingUntil) { state.audio.noiseSamples.push(rms); $('micStateText').textContent = `กำลังวัดเสียงพื้นหลัง ${average(state.audio.noiseSamples).toFixed(1)}`; state.audio.raf = requestAnimationFrame(audioLoop); return; }
    if (!state.audio.noiseFloor) state.audio.noiseFloor = Math.max(0, average(state.audio.noiseSamples));
    const threshold = Math.max(Number(state.settings.minRmsThreshold || 10), state.audio.noiseFloor + Number(state.settings.noiseMargin || 8));
    const rawActive = rms >= threshold; state.audio.activeStreak = rawActive ? state.audio.activeStreak + 1 : 0; const active = state.audio.activeStreak >= Number(state.settings.activeHoldFrames || 4);
    state.audio.totalFrames++;
    if (active) {
      state.audio.activeFrames++;
      state.audio.combo++;
      state.audio.bestCombo = Math.max(state.audio.bestCombo, state.audio.combo);
      const diff = Math.abs(rms - state.audio.lastRms);
      state.audio.stabilitySum += Math.max(0, 100 - diff * 5);
      if (state.audio.combo > 0 && state.audio.combo % Number(state.settings.comboRgbEvery || 6) === 0) triggerRgb();
      if (state.audio.combo > 0 && state.audio.combo % 100 === 0) triggerComboFire(state.audio.combo);
      $('micStateText').textContent = rms > threshold * 2.4 ? 'เสียงดีมาก' : 'เสียงชัดเจน';
    }
    else { state.audio.combo = 0; $('micStateText').textContent = rawActive ? 'กำลังจับเสียง...' : 'เสียงยังไม่ชัด'; }
    state.audio.lastRms = rms;
    const chapterScore = calculateCurrentChapterScore();
    state.audio.score = chapterScore;
    const liveScore = Math.round(state.totalScore + chapterScore);
    $('liveTotalScore').textContent = liveScore;
    $('mobileLiveScore').textContent = liveScore;
    $('comboText').textContent = `คอมโบ x${state.audio.combo}`;
  }
  state.audio.raf = requestAnimationFrame(audioLoop);
}
function calculateTimeRms(data) { let sum = 0; for (let i = 0; i < data.length; i++) { const v = data[i] - 128; sum += v * v; } return Math.sqrt(sum / data.length); }
function average(arr) { return arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function calculateCurrentChapterScore() { const a = state.audio, total = Math.max(1, a.totalFrames), activePercent = a.activeFrames / total, stability = a.activeFrames ? (a.stabilitySum / a.activeFrames) / 100 : 0, comboFactor = Math.min(1, a.bestCombo / 240), durationSec = Math.max(1, (Date.now() - a.startedAt) / 1000), expectedSec = state.activeChants[state.currentChapterIndex]?.expectedSec || 60, durationFactor = Math.min(1, durationSec / expectedSec), score = (activePercent * 45) + (stability * 25) + (comboFactor * 15) + (durationFactor * 15); return Math.max(0, Math.min(100, score)); }
function triggerRgb() { const f = $('rgbFrame'); f.classList.remove('rgb-on'); void f.offsetWidth; f.classList.add('rgb-on'); setTimeout(() => f.classList.remove('rgb-on'), 1200); }
function triggerComboFire(combo) {
  const overlay = $('comboFireOverlay');
  if (!overlay) return;
  const title = overlay.querySelector('.combo-fire-title');
  if (title) title.textContent = `🔥 COMBO x${combo} 🔥`;
  overlay.classList.remove('show');
  void overlay.offsetWidth;
  overlay.classList.add('show');
  clearTimeout(overlay._hideTimer);
  overlay._hideTimer = setTimeout(() => overlay.classList.remove('show'), 1000);
}
function startHoldNextChapter(evt) { evt?.preventDefault(); if (state.nextHoldTimer) return; const holdSec = Number(state.settings.nextChapterHoldSec || 2); state.nextHoldStarted = Date.now(); state.nextHoldTimer = setInterval(() => { const elapsed = (Date.now() - state.nextHoldStarted) / 1000; const remain = Math.ceil(Math.max(0, holdSec - elapsed)); $('btnNextChapter').textContent = remain > 0 ? `ปล่อยไม่ได้... ${remain}` : 'กำลังบันทึกบท'; if (elapsed >= holdSec) { clearInterval(state.nextHoldTimer); state.nextHoldTimer = null; nextChapter(); } }, 80); }
function cancelHoldNextChapter() { if (!state.nextHoldTimer) return; clearInterval(state.nextHoldTimer); state.nextHoldTimer = null; $('btnNextChapter').textContent = state.currentChapterIndex === state.activeChants.length - 1 ? 'กดค้าง 2 วิ: จบบทสวด' : 'กดค้าง 2 วิ: บทถัดไป'; }
function nextChapter() { const chant = state.activeChants[state.currentChapterIndex]; const score = Math.round(calculateCurrentChapterScore()); const duration = Math.floor((Date.now() - state.audio.startedAt) / 1000); state.chapters.push({ chantId: chant.chantId, title: chant.title, score, durationSec: duration, bestCombo: state.audio.bestCombo }); state.totalScore = state.chapters.reduce((s, c) => s + c.score, 0); if (state.currentChapterIndex < state.activeChants.length - 1) { state.currentChapterIndex++; loadCurrentChapter(); } else finishChant(); }
function finishChant() { stopChapterTimers(true); const total = Math.round(state.totalScore); const requiredTotal = Number(state.settings.passScore || 70) * Math.max(1, state.chapters.length); const stu = state.selectedStudent; showView('result'); $('resultStudentLine').textContent = `${stu.fullName} | ชั้น ${stu.level}/${stu.room} เลขที่ ${stu.no} | สัปดาห์ ${state.control?.weekKey || state.settings.weekKey}`; $('resultTotalScore').textContent = total; $('resultStatus').textContent = total >= requiredTotal ? (state.settings.resultTextPass || 'ผ่าน') : (state.settings.resultTextFail || 'ยังไม่ผ่าน'); $('chapterResultList').innerHTML = state.chapters.map((c, i) => `<div class="chapter-row"><span>${i + 1}. ${escapeHtml(c.title)}</span><strong>${c.score} คะแนน</strong></div>`).join('') + `<div class="chapter-row"><span>รวมทุกบท</span><strong>${total} คะแนน</strong></div>`; $('resultEmojiCode').textContent = state.emojiCode.join(''); $('receiptCode').textContent = state.emojiCode.join(''); $('receiptBox').classList.add('hidden'); $('submitStatus').textContent = ''; $('btnSubmitScore').disabled = false; $('btnSubmitScore').textContent = 'ส่งคะแนนเข้า Firebase'; state.isSubmitting = false; }

async function submitScoreToFirestore() {
  if (state.isSubmitting) return; state.isSubmitting = true; $('btnSubmitScore').disabled = true; $('submitStatus').textContent = 'กำลังตรวจสถานะระบบ...';
  try {
    await ensureAnonymous(); await refreshControl(false);
    if (!isControlOpen()) { throw new Error(state.control?.closedMessage || 'ระบบปิดรับคะแนนแล้ว'); }
    const stu = state.selectedStudent; const sessionId = state.control.sessionId || state.settings.sessionId; const docId = stu.studentKey;
    const ref = doc(state.db, 'sessions', sessionId, 'submissions', docId);
    const existing = await getDoc(ref);
    if (existing.exists()) { $('submitStatus').textContent = 'นักเรียนคนนี้ส่งคะแนนประจำสัปดาห์นี้แล้ว'; $('receiptBox').classList.remove('hidden'); $('btnSubmitScore').textContent = 'ส่งแล้ว'; return; }
    $('submitStatus').textContent = 'กำลังบันทึกคะแนน กรุณาอย่าปิดหน้านี้...';
    const totalScore = Math.round(state.totalScore); const requiredTotal = Number(state.settings.passScore || 70) * Math.max(1, state.chapters.length);
    const payload = { uid: state.auth.currentUser.uid, sessionId, termKey: state.control.termKey || state.settings.termKey, weekKey: state.control.weekKey || state.settings.weekKey, studentKey: stu.studentKey, studentId: stu.enteredStudentId || stu.studentId || '', level: stu.level, room: stu.room, no: stu.no, fullName: stu.fullName, totalScore, result: totalScore >= requiredTotal ? 'ผ่าน' : 'ยังไม่ผ่าน', emojiCode: state.emojiCode.join(''), chapterCount: state.chapters.length, chapters: state.chapters, submittedAt: serverTimestamp(), clientTime: new Date().toISOString(), source: 'github-pages-firebase-v3' };
    await setDoc(ref, payload);
    localStorage.setItem('submitted:' + sessionId + '::' + stu.studentKey, 'yes');
    $('submitStatus').textContent = 'บันทึกคะแนนสำเร็จแล้ว'; $('receiptBox').classList.remove('hidden'); $('btnSubmitScore').textContent = 'ส่งแล้ว';
  } catch (err) {
    console.error(err); $('submitStatus').textContent = 'ส่งคะแนนไม่สำเร็จ: ' + err.message; $('btnSubmitScore').disabled = false; $('btnSubmitScore').textContent = 'ลองส่งอีกครั้ง'; state.isSubmitting = false;
  }
}

async function adminLogin() {
  const email = $('adminEmail').value.trim(), pass = $('adminPassword').value;
  if (!email || !pass) { alert('กรุณากรอก Email และ Password'); return; }
  try {
    const cred = await signInWithEmailAndPassword(state.auth, email, pass);
    const adminSnap = await getDoc(doc(state.db, 'admins', cred.user.uid));
    if (!adminSnap.exists() || adminSnap.data().active === false) { await signOut(state.auth); alert('บัญชีนี้ยังไม่ได้รับสิทธิ์ Admin'); return; }
    state.isAdmin = true; $('adminUserText').textContent = email; $('adminLoginBox').classList.add('hidden'); $('adminPanel').classList.remove('hidden'); $('controlPanel').classList.remove('hidden'); $('dashboardPanel').classList.remove('hidden'); await loadControlToAdminForm(); showView('admin');
  } catch (err) { alert('เข้าสู่ระบบไม่สำเร็จ: ' + err.message); }
}
async function adminLogout() { stopDashboardAutoRefresh(); await signOut(state.auth); state.isAdmin = false; $('adminLoginBox').classList.remove('hidden'); $('adminPanel').classList.add('hidden'); $('controlPanel').classList.add('hidden'); $('dashboardPanel').classList.add('hidden'); await ensureAnonymous(); }
async function loadControlToAdminForm() { await refreshControl(false); const c = state.control || {}; $('adminTermKey').value = c.termKey || state.settings.termKey || ''; $('adminWeekKey').value = c.weekKey || state.settings.weekKey || ''; $('adminSessionId').value = c.sessionId || state.settings.sessionId || ''; $('adminClosedMessage').value = c.closedMessage || 'ระบบปิดรับคะแนนประจำสัปดาห์นี้แล้ว'; $('adminOpenAt').value = toDatetimeLocal(c.openAt); $('adminCloseAt').value = toDatetimeLocal(c.closeAt); $('adminControlStatus').textContent = c.systemOpen ? 'สถานะปัจจุบัน: เปิด' : 'สถานะปัจจุบัน: ปิด'; }
function toDatetimeLocal(v) { const ms = toMillis(v); if (!ms) return ''; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function localToTimestamp(v) { return v ? Timestamp.fromDate(new Date(v)) : null; }
async function saveControlFromAdmin(openValue) {
  if (!state.isAdmin) { alert('ต้องเข้าสู่ระบบ Admin'); return; }
  const openAtRaw = $('adminOpenAt').value;
  const closeAtRaw = $('adminCloseAt').value;
  const payload = { termKey: $('adminTermKey').value.trim(), weekKey: $('adminWeekKey').value.trim(), sessionId: $('adminSessionId').value.trim(), closedMessage: $('adminClosedMessage').value.trim() || 'ระบบปิดรับคะแนนประจำสัปดาห์นี้แล้ว', openAt: localToTimestamp(openAtRaw), closeAt: localToTimestamp(closeAtRaw), updatedAt: serverTimestamp(), updatedBy: state.auth.currentUser.email || state.auth.currentUser.uid };
  if (openValue !== null) payload.systemOpen = openValue; else payload.systemOpen = state.control?.systemOpen === true;
  if (!payload.termKey || !payload.weekKey || !payload.sessionId) { alert('กรุณากรอก termKey / weekKey / sessionId'); return; }
  if (!openAtRaw || !closeAtRaw) { alert('กรุณาตั้งเวลาเปิดและเวลาปิด เพื่อให้ Security Rules ตรวจรอบเวลาได้ถูกต้อง'); return; }
  if (new Date(openAtRaw).getTime() >= new Date(closeAtRaw).getTime()) { alert('เวลาเปิดต้องมาก่อนเวลาปิด'); return; }
  await setDoc(doc(state.db, 'control', 'current'), payload);
  $('adminControlStatus').textContent = 'บันทึกสถานะระบบแล้ว'; await refreshControl(false); renderHome(); await loadControlToAdminForm();
}

async function refreshDashboard() {
  if (!state.isAdmin) { alert('ต้องเข้าสู่ระบบ Admin'); return; }
  await refreshControl(false); const sessionId = state.control?.sessionId || state.settings.sessionId;
  $('dashboardStatus').textContent = 'กำลังโหลด submissions...';
  const snap = await getDocs(collection(state.db, 'sessions', sessionId, 'submissions'));
  state.lastSubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const summary = buildSummary(state.lastSubmissions, sessionId);
  renderDashboard(summary);
  await saveSummaryDocs(sessionId, summary);
  $('dashboardStatus').textContent = `อัปเดตล่าสุด ${new Date().toLocaleString('th-TH')} | อ่าน ${fmt(state.lastSubmissions.length)} รายการ`;
}
function buildSummary(rows, sessionId) {
  const totalSubmitted = rows.length; const totalScore = rows.reduce((s, r) => s + Number(r.totalScore || 0), 0); const avgScore = totalSubmitted ? totalScore / totalSubmitted : 0;
  const levels = groupRows(rows, r => r.level); const rooms = groupRows(rows, r => `${r.level}/${r.room}`); const top10 = [...rows].sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0)).slice(0, 10);
  return { sessionId, totalSubmitted, totalScore, avgScore, levels, rooms, top10, updatedAt: new Date().toISOString() };
}
function groupRows(rows, keyFn) {
  const map = new Map(); rows.forEach(r => { const k = keyFn(r) || '-'; if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
  return [...map.entries()].map(([name, arr]) => { const totalScore = arr.reduce((s, r) => s + Number(r.totalScore || 0), 0); const pass = arr.filter(r => String(r.result) === 'ผ่าน').length; return { name, submitted: arr.length, totalScore, avgScore: arr.length ? totalScore / arr.length : 0, passRate: arr.length ? (pass / arr.length) * 100 : 0 }; }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th', { numeric: true }));
}
async function saveSummaryDocs(sessionId, summary) {
  const base = ['sessions', sessionId, 'summary'];
  await Promise.all([
    setDoc(doc(state.db, ...base, 'current'), { sessionId, totalSubmitted: summary.totalSubmitted, totalScore: summary.totalScore, avgScore: summary.avgScore, updatedAt: serverTimestamp() }),
    setDoc(doc(state.db, ...base, 'levels'), { sessionId, rows: summary.levels, updatedAt: serverTimestamp() }),
    setDoc(doc(state.db, ...base, 'rooms'), { sessionId, rows: summary.rooms, updatedAt: serverTimestamp() })
  ]);
}
function renderDashboard(s) {
  $('dashboardSummary').innerHTML = `<div class="mini-card"><span>ส่งแล้ว</span><strong>${fmt(s.totalSubmitted)}</strong></div><div class="mini-card"><span>คะแนนรวม</span><strong>${fmt(s.totalScore)}</strong></div><div class="mini-card"><span>เฉลี่ย</span><strong>${Number(s.avgScore || 0).toFixed(2)}</strong></div><div class="mini-card"><span>Session</span><strong>${escapeHtml(s.sessionId)}</strong></div>`;
  const top = s.top10.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.fullName)}</td><td>${escapeHtml(r.level + '/' + r.room)}</td><td>${escapeHtml(r.no)}</td><td><strong>${fmt(r.totalScore)}</strong></td><td>${escapeHtml(r.emojiCode || '')}</td></tr>`).join('');
  $('dashboardTables').innerHTML = `${renderGroupTable('สรุปรายระดับ', s.levels)}${renderGroupTable('สรุปรายห้อง', s.rooms)}<h3>Top 10</h3><table class="data-table"><thead><tr><th>#</th><th>ชื่อ</th><th>ชั้น/ห้อง</th><th>เลขที่</th><th>คะแนน</th><th>อีโมจิ</th></tr></thead><tbody>${top}</tbody></table>`;
}
function renderGroupTable(title, rows) { return `<h3>${title}</h3><table class="data-table"><thead><tr><th>กลุ่ม</th><th>ส่งแล้ว</th><th>เฉลี่ย</th><th>ผ่าน</th><th>คะแนนรวม</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${fmt(r.submitted)}</td><td>${Number(r.avgScore || 0).toFixed(2)}</td><td>${Number(r.passRate || 0).toFixed(1)}%</td><td>${fmt(r.totalScore)}</td></tr>`).join('')}</tbody></table>`; }
function toggleDashboardAutoRefresh() { if (state.adminAutoTimer) { stopDashboardAutoRefresh(); return; } refreshDashboard(); const sec = Number(state.settings.dashboardAutoRefreshSec || 60); state.adminAutoTimer = setInterval(refreshDashboard, sec * 1000); $('btnToggleAutoRefresh').textContent = `Auto refresh: ทุก ${sec} วิ`; }
function stopDashboardAutoRefresh() { if (state.adminAutoTimer) { clearInterval(state.adminAutoTimer); state.adminAutoTimer = null; $('btnToggleAutoRefresh').textContent = 'Auto refresh: ปิด'; } }
function exportCsv() {
  if (!state.lastSubmissions.length) { alert('กรุณา Refresh Dashboard ก่อน'); return; }
  const headers = ['sessionId', 'weekKey', 'studentKey', 'studentId', 'level', 'room', 'no', 'fullName', 'totalScore', 'result', 'emojiCode', 'clientTime'];
  const rows = [headers, ...state.lastSubmissions.map(r => headers.map(h => r[h] ?? ''))];
  const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `chant_${state.control?.sessionId || 'session'}_submissions.csv`; a.click(); URL.revokeObjectURL(a.href);
}

function cleanCurrentUrl() { return window.location.origin + window.location.pathname + window.location.search; }
function openSupportedBrowser() { const url = cleanCurrentUrl(), ua = navigator.userAgent || ''; copyCurrentLink(false); if (/Android/i.test(ua)) { const without = url.replace(/^https?:\/\//, ''); window.location.href = `intent://${without}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`; return; } if (/iPhone|iPad|iPod/i.test(ua)) { const chromeUrl = url.replace(/^https:\/\//, 'googlechromes://').replace(/^http:\/\//, 'googlechrome://'); window.location.href = chromeUrl; setTimeout(() => alert('คัดลอกลิงก์แล้ว หากยังไม่เด้ง ให้เปิด Safari หรือ Chrome แล้ววางลิงก์'), 900); return; } window.open(url, '_blank', 'noopener'); }
async function copyCurrentLink(showAlert = true) { const url = cleanCurrentUrl(); try { await navigator.clipboard.writeText(url); if (showAlert) alert('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์นี้', url); } }
function goHomeSafe() { stopChapterTimers(true); stopDashboardAutoRefresh(); state.selectedStudent = null; state.chapters = []; state.totalScore = 0; state.isSubmitting = false; showView('home'); renderHome(); }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(v) { return escapeHtml(v).replace(/'/g, '&#039;'); }
