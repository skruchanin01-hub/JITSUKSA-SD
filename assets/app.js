import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs, serverTimestamp, Timestamp, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const DATA_PATH = 'data/';
const EMOJIS = ['🌟', '🌈', '🍀', '🌻', '🙏', '🔔', '💛', '✨', '🌙', '☀️', '🌸', '🎵', '⭐', '🎐', '🎲', '🐘', '📘', '📚', '✏️', '🏆', '🎯', '🎁', '🎉', '🎈', '🍎', '🍊', '🍋', '🍌', '🍇', '🍉', '🐝', '🐢'];

const state = {
  settings: null, firebaseConfig: null, firebaseReady: false, app: null, auth: null, db: null,
  control: null, studentIndex: [], studentsByLevel: {}, teachers: [], chants: [], activeChants: [], selectedStudent: null, emojiCode: [],
  currentChapterIndex: 0, chapters: [], totalScore: 0, lastSubmissions: [], isAdmin: false, adminAutoTimer: null, adminAutoStopTimer: null, publicRefreshLockedUntil: 0,
  audio: { stream: null, context: null, analyser: null, data: null, timeData: null, raf: null, micOn: false, startedAt: 0, totalFrames: 0, activeFrames: 0, score: 0, combo: 0, bestCombo: 0, lastRms: 0, stabilitySum: 0, noiseFloor: 0, noiseSamples: [], calibratingUntil: 0, activeStreak: 0 },
  scrollTimer: null, manualScrollTimer: null, ignoreScrollUntil: 0, autoScroll: true, nextHoldTimer: null, nextHoldStarted: 0, isSubmitting: false
};

const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('th-TH');

window.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  loadReadingFontSize();
  try {
    const [settings, firebaseConfig, studentIndex, chants, teachers] = await Promise.all([
      fetchJson('settings.json'),
      fetchJson('firebase_config.json'),
      fetchJson('student_index.json'),
      fetchJson('chants.json'),
      fetchJson('teachers.json').catch(() => [])
    ]);
    state.settings = settings;
    state.firebaseConfig = firebaseConfig;
    state.studentIndex = studentIndex;
    state.teachers = normalizeTeachers(teachers).filter(x => x.active !== false);
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
  $('btnRefreshPublicDashboard')?.addEventListener('click', refreshPublicDashboardOnce);
  $('btnAdminOpen').addEventListener('click', () => showView('admin'));
  $('btnOpenBrowser').addEventListener('click', openSupportedBrowser);
  $('btnCopyLink').addEventListener('click', copyCurrentLink);
  $('participantTypeSelect')?.addEventListener('change', onParticipantTypeChange);
  $('levelSelect').addEventListener('change', onLevelChange);
  $('roomSelect').addEventListener('change', onRoomChange);
  $('studentSelect').addEventListener('change', renderStudentConfirm);
  $('studentIdInput').addEventListener('input', onStudentIdInput);
  $('teacherDepartmentSelect')?.addEventListener('change', onTeacherDepartmentChange);
  $('teacherSelect')?.addEventListener('change', renderParticipantConfirm);
  $('teacherCodeInput')?.addEventListener('input', renderParticipantConfirm);
  $('btnGoEmoji').addEventListener('click', goEmojiStep);
  $('btnRandomEmoji').addEventListener('click', randomEmojiCode);
  $('btnConfirmEmoji').addEventListener('click', confirmEmojiAndStart);
  $('btnBackHomeFromChant').addEventListener('click', () => { if (confirm('ออกจากหน้าสวดหรือไม่? คะแนนที่ยังไม่จบจะไม่ถูกบันทึก')) goHomeSafe(); });
  $('btnMic').addEventListener('click', toggleMic);
  $('btnNextChapter').addEventListener('mousedown', startHoldNextChapter);
  $('btnNextChapter').addEventListener('touchstart', startHoldNextChapter, { passive: false });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => $('btnNextChapter').addEventListener(evt, cancelHoldNextChapter));
  $('chantStage').addEventListener('scroll', onManualScroll, { passive: true });
  $('btnJumpToTop')?.addEventListener('click', jumpToChantTop);
  $('btnFontSmall')?.addEventListener('click', () => setReadingFontSize('small'));
  $('btnFontNormal')?.addEventListener('click', () => setReadingFontSize('normal'));
  $('btnFontLarge')?.addEventListener('click', () => setReadingFontSize('large'));
  $('btnSubmitScore').addEventListener('click', submitScoreToFirestore);
  $('btnReturnHome').addEventListener('click', goHomeSafe);
  $('btnAdminLogin').addEventListener('click', adminLogin);
  $('btnAdminLogout').addEventListener('click', adminLogout);
  $('btnOpenSystem').addEventListener('click', () => saveControlFromAdmin(true));
  $('btnCloseSystem').addEventListener('click', () => saveControlFromAdmin(false));
  $('btnCloseAndPublish')?.addEventListener('click', closeAndPublishResults);
  $('btnSaveControl').addEventListener('click', () => saveControlFromAdmin(null));
  $('btnRefreshDashboard').addEventListener('click', refreshDashboard);
  $('btnToggleAutoRefresh').addEventListener('click', toggleDashboardAutoRefresh);
  $('btnExportCsv').addEventListener('click', exportCsv);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { stopDashboardAutoRefresh(); return; }
    if (document.body.classList.contains('chant-mode') && state.audio.context?.state === 'suspended' && state.audio.micOn) {
      await state.audio.context.resume().catch(() => { });
    }
  });
}

const READING_FONT_SCALES = { small: 0.88, normal: 1, large: 1.14 };
function setReadingFontSize(mode) {
  const safeMode = Object.prototype.hasOwnProperty.call(READING_FONT_SCALES, mode) ? mode : 'normal';
  document.documentElement.style.setProperty('--reading-scale', READING_FONT_SCALES[safeMode]);
  try { localStorage.setItem('chantReadingFontSize', safeMode); } catch (_) { }
  document.querySelectorAll('.mobile-font-btn').forEach(btn => btn.classList.remove('active'));
  const map = { small: 'btnFontSmall', normal: 'btnFontNormal', large: 'btnFontLarge' };
  $(map[safeMode])?.classList.add('active');
}
function loadReadingFontSize() {
  let saved = 'normal';
  try { saved = localStorage.getItem('chantReadingFontSize') || 'normal'; } catch (_) { }
  setReadingFontSize(saved);
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
    renderPublicDashboard();
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
  renderPublicDashboard();
}


function renderPublicDashboard() {
  const card = $('publicDashboardCard');
  if (!card) return;
  const c = state.control || {};
  const dashboard = c.publicDashboard;
  const onlyClosed = state.settings?.publicDashboardOnlyWhenClosed !== false;
  const shouldShow = !!(c.dashboardPublished && dashboard && (!onlyClosed || !isControlOpen(c)));
  card.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;
  $('publicDashboardTitle').textContent = `ผลการสวดมนต์ ${dashboard.weekKey || c.weekKey || ''}`;
  $('publicDashboardMeta').textContent = `Session ${dashboard.sessionId || c.sessionId || '-'} | ประกาศ ${dashboard.publishedAtText || '-'}`;
  $('publicTopLevel').textContent = dashboard.topLevel?.name || '-';
  $('publicTopLevelScore').textContent = dashboard.topLevel ? `Fair Score ${Number(dashboard.topLevel.fairScore || 0).toFixed(2)}` : '-';
  $('publicTopRoom').textContent = dashboard.topRoom?.name || '-';
  $('publicTopRoomScore').textContent = dashboard.topRoom ? `Fair Score ${Number(dashboard.topRoom.fairScore || 0).toFixed(2)}` : '-';
  $('publicTotalSubmitted').textContent = fmt(dashboard.totalSubmitted || 0);
  $('publicAverageScore').textContent = `เฉลี่ย ${Number(dashboard.avgScore || 0).toFixed(2)}`;
  const top = Array.isArray(dashboard.top10) ? dashboard.top10 : [];
  $('publicTop10').innerHTML = top.length ? top.map((r, i) => `<div class="public-rank-row"><span class="public-rank-no">${i + 1}</span><div class="public-rank-person"><strong>${escapeHtml(r.displayName || '-')}</strong><small>${escapeHtml((r.level || '') + '/' + (r.room || ''))} ${r.emojiCode ? `| ${escapeHtml(r.emojiCode)}` : ''}</small></div><span class="public-rank-score">${fmt(r.score || 0)}</span></div>`).join('') : '<p class="muted">ยังไม่มีข้อมูลอันดับ</p>';
}

async function refreshPublicDashboardOnce() {
  const now = Date.now();
  if (now < state.publicRefreshLockedUntil) {
    const remain = Math.ceil((state.publicRefreshLockedUntil - now) / 1000);
    alert(`กรุณารออีก ${remain} วินาทีก่อนอัปเดตผลอีกครั้ง`);
    return;
  }
  const btn = $('btnRefreshPublicDashboard');
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังอัปเดต...'; }
  try {
    await refreshControl(false);
    renderHome();
    const cooldown = Number(state.settings?.publicDashboardRefreshCooldownSec || 60);
    state.publicRefreshLockedUntil = Date.now() + cooldown * 1000;
  } catch (err) {
    alert('อัปเดตผลไม่สำเร็จ: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'อัปเดตผลล่าสุด'; }
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
  // iPadOS 13+ มักรายงานตัวเองเป็น Macintosh จึงต้องตรวจจอสัมผัสร่วมด้วย
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || isIPadOS;
  const isAndroid = /Android/i.test(ua);
  const isLine = /Line\//i.test(ua);
  const isFacebook = /FBAN|FBAV|FB_IAB|FB4A/i.test(ua);
  const isMessenger = /Messenger|FB_IAB\/MESSENGER/i.test(ua);
  const isInstagram = /Instagram/i.test(ua);
  const isTikTok = /TikTok|Bytedance|Musical_ly/i.test(ua);
  const isTwitter = /Twitter|XTwitter/i.test(ua);
  const isInAppBrowser = isLine || isFacebook || isMessenger || isInstagram || isTikTok || isTwitter;
  const hasMicApi = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  // อย่าล็อกตามชื่อ Browser มากเกินไป: อนุญาตทุก Browser หลักที่มี Mic API และไม่ใช่ in-app browser
  const isSupported = window.isSecureContext && hasMicApi && !isInAppBrowser;
  const appName = isLine ? 'LINE' : isMessenger ? 'Messenger' : isInstagram ? 'Instagram' : isTikTok ? 'TikTok' : isFacebook ? 'Facebook' : isTwitter ? 'X/Twitter' : 'แอปนี้';
  return { isSupported, isInAppBrowser, isAndroid, isIOS, isIPadOS, hasMicApi, appName };
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
  const enableTeachers = state.settings?.enableTeachers !== false && state.teachers.length > 0;
  const typeSelect = $('participantTypeSelect');
  if (typeSelect) {
    typeSelect.value = 'student';
    const teacherOption = typeSelect.querySelector('option[value="teacher"]');
    if (teacherOption) teacherOption.disabled = !enableTeachers;
  }
  const levels = state.studentIndex.map(x => x.level).filter(Boolean);
  fillSelect($('levelSelect'), levels, 'เลือกระดับชั้น');
  fillSelect($('roomSelect'), [], 'เลือกห้อง');
  fillSelect($('studentSelect'), [], 'เลือกชื่อ-นามสกุล');
  fillSelect($('teacherDepartmentSelect'), unique(state.teachers.map(t => t.department)).sort(thSort), 'เลือกฝ่าย / กลุ่มสาระ');
  fillSelect($('teacherSelect'), [], 'เลือกชื่อ');
  $('studentIdInput').value = '';
  $('teacherCodeInput').value = '';
  $('studentConfirmBox').classList.add('hidden');
  onParticipantTypeChange();
}
function onParticipantTypeChange() {
  const type = $('participantTypeSelect')?.value || 'student';
  $('studentFields')?.classList.toggle('hidden', type !== 'student');
  $('teacherFields')?.classList.toggle('hidden', type !== 'teacher');
  const needTeacherCode = type === 'teacher' && state.settings?.requireTeacherCode === true;
  $('teacherCodeLabel')?.classList.toggle('hidden', !needTeacherCode);
  renderParticipantConfirm();
}
async function onLevelChange() {
  const level = $('levelSelect').value;
  if (!level) return;
  await loadStudentsForLevel(level);
  const list = state.studentsByLevel[level] || [];
  const rooms = unique(list.map(s => String(s.room))).sort(numSort);
  fillSelect($('roomSelect'), rooms, 'เลือกห้อง');
  fillSelect($('studentSelect'), [], 'เลือกชื่อ-นามสกุล');
  $('studentIdInput').value = ''; renderParticipantConfirm();
}
async function loadStudentsForLevel(level) {
  if (state.studentsByLevel[level]) return;
  const item = state.studentIndex.find(x => x.level === level);
  if (!item) throw new Error('ไม่พบไฟล์รายชื่อของ ' + level);
  const data = await fetchJson(item.file);
  state.studentsByLevel[level] = normalizeStudents(data).filter(x => x.active !== false);
}
async function loadAllStudentRosters() {
  for (const item of state.studentIndex) {
    if (item?.level) await loadStudentsForLevel(item.level);
  }
}
function onRoomChange() {
  const level = $('levelSelect').value, room = $('roomSelect').value;
  const list = (state.studentsByLevel[level] || []).filter(s => String(s.room) === String(room)).sort((a, b) => numSort(a.no, b.no));
  $('studentSelect').innerHTML = '<option value="">เลือกชื่อ-นามสกุล</option>' + list.map(s => `<option value="${escapeAttr(s.studentKey)}">เลขที่ ${escapeHtml(s.no)} - ${escapeHtml(s.fullName)}</option>`).join('');
  $('studentIdInput').value = ''; renderParticipantConfirm();
}
function onTeacherDepartmentChange() {
  const dep = $('teacherDepartmentSelect').value;
  const list = state.teachers.filter(t => !dep || t.department === dep).sort((a, b) => thSort(a.fullName, b.fullName));
  $('teacherSelect').innerHTML = '<option value="">เลือกชื่อ</option>' + list.map(t => `<option value="${escapeAttr(t.studentKey)}">${escapeHtml(t.fullName)}</option>`).join('');
  $('teacherCodeInput').value = ''; renderParticipantConfirm();
}
function onStudentIdInput() { $('studentIdInput').value = $('studentIdInput').value.replace(/\D/g, '').slice(0, 5); renderParticipantConfirm(); }
function renderParticipantConfirm() {
  const person = getSelectedParticipant(); const box = $('studentConfirmBox');
  if (!person) { box.classList.add('hidden'); return; }
  if (person.participantType === 'teacher') {
    const needCode = state.settings?.requireTeacherCode === true;
    const code = $('teacherCodeInput').value.trim();
    const codeText = needCode ? (code ? 'กรอกรหัสแล้ว' : 'กรุณากรอกรหัสยืนยันครู') : 'ไม่บังคับรหัสยืนยันครู';
    box.innerHTML = `<strong>${escapeHtml(person.fullName)}</strong><div>ครูและบุคลากร | ${escapeHtml(person.department || '-')}</div><div class="muted">${escapeHtml(codeText)}</div>`;
  } else {
    const id = $('studentIdInput').value.trim(); const idOk = /^\d{5}$/.test(id);
    box.innerHTML = `<strong>${escapeHtml(person.fullName)}</strong><div>ชั้น ${escapeHtml(person.level)}/${escapeHtml(person.room)} เลขที่ ${escapeHtml(person.no)}</div><div class="muted">${idOk ? 'เลขประจำตัวครบ 5 หลัก' : 'กรอกเลขประจำตัว 5 หลักเพื่อยืนยัน'}</div>`;
  }
  box.classList.remove('hidden');
}
function renderStudentConfirm() { renderParticipantConfirm(); }
function getSelectedStudent() { return getSelectedParticipant(); }
function getSelectedParticipant() {
  const type = $('participantTypeSelect')?.value || 'student';
  if (type === 'teacher') {
    const key = $('teacherSelect')?.value || '';
    return state.teachers.find(t => String(t.studentKey) === String(key)) || null;
  }
  const level = $('levelSelect').value, key = $('studentSelect').value;
  return (state.studentsByLevel[level] || []).find(s => String(s.studentKey) === String(key)) || null;
}
function normalizeStudents(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(x => x && x.studentKey && x.level && x.room && x.no && x.fullName).map(x => ({ studentKey: String(x.studentKey).trim(), participantKey: String(x.studentKey).trim(), participantType: 'student', level: String(x.level).trim(), room: String(x.room).trim(), no: String(x.no).trim(), fullName: String(x.fullName).replace(/\s+/g, ' ').trim(), studentId: x.studentId ? String(x.studentId).trim() : '', department: '', active: x.active !== false && String(x.active).toLowerCase() !== 'false' }));
}
function normalizeTeachers(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(x => x && (x.teacherKey || x.participantKey) && x.fullName).map((x, i) => { const key = String(x.teacherKey || x.participantKey || `T${i + 1}`).trim(); return { studentKey: key, participantKey: key, participantType: 'teacher', level: 'ครู', room: String(x.department || 'บุคลากร').trim(), department: String(x.department || 'บุคลากร').trim(), no: String(x.no || '-'), fullName: String(x.fullName).replace(/\s+/g, ' ').trim(), studentId: '', verifyCode: x.verifyCode ? String(x.verifyCode).trim() : '', active: x.active !== false && String(x.active).toLowerCase() !== 'false' }; });
}
function fillSelect(el, values, first) { if (!el) return; el.innerHTML = `<option value="">${first}</option>` + values.map(v => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join(''); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function numSort(a, b) { return String(a).localeCompare(String(b), 'th', { numeric: true }); }
function thSort(a, b) { return String(a).localeCompare(String(b), 'th', { numeric: true }); }

async function goEmojiStep() {
  const person = getSelectedParticipant();
  if (!person) { alert('กรุณาเลือกชื่อผู้สวด'); return; }
  let enteredId = '';
  if (person.participantType === 'student') {
    enteredId = $('studentIdInput').value.trim();
    if (state.settings.requireStudentId && !/^\d{5}$/.test(enteredId)) { alert('กรุณากรอกเลขประจำตัวนักเรียน 5 หลัก'); return; }
    const validateRoster = state.settings.validateStudentIdWithRoster === true || String(state.settings.validateStudentIdWithRoster).toLowerCase() === 'true';
    if (validateRoster) {
      if (!/^\d{5}$/.test(String(person.studentId || ''))) { alert('รายชื่อนี้ยังไม่มีเลขประจำตัว 5 หลักในไฟล์ระบบ กรุณาแจ้ง Admin'); return; }
      if (String(person.studentId) !== enteredId) { alert('เลขประจำตัวไม่ตรงกับรายชื่อที่เลือก'); return; }
    }
  } else {
    enteredId = $('teacherCodeInput')?.value.trim() || '';
    if (state.settings.requireTeacherCode === true) {
      if (!enteredId) { alert('กรุณากรอกรหัสยืนยันครู'); return; }
      if (person.verifyCode && person.verifyCode !== enteredId) { alert('รหัสยืนยันครูไม่ถูกต้อง'); return; }
    }
  }

  const btn = $('btnGoEmoji'); const oldText = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังตรวจสิทธิ์...';
  try {
    await ensureAnonymous();
    if (!isControlOpen()) {
      alert(state.control?.closedMessage || 'ระบบปิดรับคะแนน');
      renderHome(); showView('home'); return;
    }
    const sessionId = state.control?.sessionId || state.settings.sessionId;
    const personKey = person.participantKey || person.studentKey;
    const localKey = 'submitted:' + sessionId + '::' + personKey;
    if (localStorage.getItem(localKey) === 'yes') {
      alert('รายชื่อนี้ส่งคะแนนประจำสัปดาห์นี้แล้ว ไม่สามารถเข้าสวดซ้ำได้'); return;
    }
    const lockRef = doc(state.db, 'sessions', sessionId, 'submissionLocks', personKey);
    const lockSnap = await getDoc(lockRef);
    if (lockSnap.exists()) {
      localStorage.setItem(localKey, 'yes');
      alert('รายชื่อนี้ส่งคะแนนประจำสัปดาห์นี้แล้ว ไม่สามารถเข้าสวดซ้ำได้'); return;
    }
    state.selectedStudent = { ...person, enteredStudentId: enteredId };
    state.emojiCode = []; renderEmojiPicker(); showView('emoji');
  } catch (err) {
    console.error(err);
    alert('ตรวจสิทธิ์ไม่สำเร็จ: ' + err.message + '\nกรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่');
  } finally {
    btn.disabled = false; btn.textContent = oldText;
  }
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
  const btn = $('btnConfirmEmoji'); const oldText = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังเปิดไมโครโฟน...';
  let stream = null;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Browser นี้ไม่รองรับไมโครโฟน');
    // เรียก getUserMedia ทันทีภายใน click event ก่อน network await เพื่อรักษา user gesture บน iPadOS/Safari
    const micPromise = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    stream = await micPromise;
    await refreshControl(false);
    if (!isControlOpen()) {
      stream.getTracks().forEach(t => t.stop());
      alert(state.control?.closedMessage || 'ระบบปิดรับคะแนน'); renderHome(); showView('home'); return;
    }
    beginChantSession(stream);
    stream = null;
  } catch (err) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    console.error(err);
    let message = 'ไม่สามารถเปิดไมโครโฟนได้: ' + (err.name || err.message);
    if (err?.name === 'NotAllowedError') message = 'iPad/iPhone ยังไม่ได้อนุญาตไมโครโฟน กรุณาเปิดเว็บด้วย Safari/Chrome โดยตรง แล้วอนุญาต Microphone ในการตั้งค่าเว็บไซต์';
    if (err?.name === 'NotFoundError') message = 'ไม่พบไมโครโฟนในอุปกรณ์นี้';
    alert(message);
  } finally {
    btn.disabled = false; btn.textContent = oldText;
  }
}

function beginChantSession(initialStream = null) {
  const level = state.selectedStudent.level;
  state.activeChants = state.chants.filter(c => c.levelGroup === 'all' || c.levelGroup === level || (Array.isArray(c.levelGroup) && c.levelGroup.includes(level)));
  if (!state.activeChants.length) { alert('ยังไม่มีบทสวดที่เปิดใช้งาน'); return; }
  state.currentChapterIndex = 0; state.chapters = []; state.totalScore = 0; showView('chant'); loadCurrentChapter(); startMic(initialStream);
}
function loadCurrentChapter() {
  stopChapterTimers(false);
  const chant = state.activeChants[state.currentChapterIndex], stu = state.selectedStudent;
  const personInfo = stu.participantType === 'teacher' ? `ครูและบุคลากร | ${stu.department || stu.room || '-'}` : `ชั้น ${stu.level}/${stu.room} เลขที่ ${stu.no} | รหัส ${stu.enteredStudentId || '-'}`;
  $('chantStudentLine').textContent = `${stu.fullName} | ${personInfo} | อีโมจิ ${state.emojiCode.join('')}`;
  $('chantTitle').textContent = chant.title;
  $('chantMeta').textContent = `${state.control?.weekKey || state.settings.weekKey} | บทที่ ${state.currentChapterIndex + 1}/${state.activeChants.length}`;
  $('mobileChantMeta').textContent = `${state.control?.weekKey || state.settings.weekKey} | บท ${state.currentChapterIndex + 1}/${state.activeChants.length}`;
  $('mobileChantTitle').textContent = chant.title || 'บทสวด';
  $('mobileStudentName').textContent = stu.participantType === 'teacher' ? `${stu.fullName} | ครูและบุคลากร | ${stu.department || stu.room || '-'}` : `${stu.fullName} | ${stu.level}/${stu.room} เลขที่ ${stu.no} | รหัส ${stu.enteredStudentId || stu.studentId || '-'}`;
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
function jumpToChantTop() { const stage = $('chantStage'); if (!stage) return; state.autoScroll = false; state.ignoreScrollUntil = Date.now() + 700; stage.scrollTo({ top: 0, behavior: 'smooth' }); $('micStateText').textContent = 'กลับไปต้นบทแล้ว ระบบจะเลื่อนต่ออัตโนมัติ'; clearTimeout(state.manualScrollTimer); state.manualScrollTimer = setTimeout(() => { state.autoScroll = true; }, Number(state.settings.manualScrollPauseMs || 4500)); }
function updateTimer() { const sec = Math.floor((Date.now() - state.audio.startedAt) / 1000); $('timerText').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }
async function startMic(initialStream = null) {
  try {
    state.audio.stream = initialStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('อุปกรณ์นี้ไม่รองรับ Web Audio');
    state.audio.context = new AudioCtx();
    if (state.audio.context.state === 'suspended') await state.audio.context.resume().catch(() => { });
    const source = state.audio.context.createMediaStreamSource(state.audio.stream);
    state.audio.analyser = state.audio.context.createAnalyser(); state.audio.analyser.fftSize = 2048;
    state.audio.data = new Uint8Array(state.audio.analyser.frequencyBinCount); state.audio.timeData = new Uint8Array(state.audio.analyser.fftSize); source.connect(state.audio.analyser);
    const audioRunning = state.audio.context.state === 'running';
    state.audio.micOn = audioRunning; state.audio.noiseFloor = 0; state.audio.noiseSamples = []; state.audio.activeStreak = 0; state.audio.calibratingUntil = Date.now() + Number(state.settings.micCalibrationMs || 1600);
    $('btnMic').textContent = audioRunning ? 'ไมค์: เปิด' : 'แตะเปิดไมค์';
    $('micStateText').textContent = audioRunning ? 'กำลังวัดเสียงพื้นหลัง...' : 'iPad ระงับเสียงชั่วคราว กรุณาแตะปุ่มเปิดไมค์';
    audioLoop();
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
function finishChant() { stopChapterTimers(true); const total = Math.round(state.totalScore); const requiredTotal = Number(state.settings.passScore || 70) * Math.max(1, state.chapters.length); const stu = state.selectedStudent; showView('result'); const personLine = stu.participantType === 'teacher' ? `${stu.fullName} | ครูและบุคลากร | ${stu.department || stu.room || '-'}` : `${stu.fullName} | ชั้น ${stu.level}/${stu.room} เลขที่ ${stu.no}`; $('resultStudentLine').textContent = `${personLine} | สัปดาห์ ${state.control?.weekKey || state.settings.weekKey}`; $('resultTotalScore').textContent = total; $('resultStatus').textContent = total >= requiredTotal ? (state.settings.resultTextPass || 'ผ่าน') : (state.settings.resultTextFail || 'ยังไม่ผ่าน'); $('chapterResultList').innerHTML = state.chapters.map((c, i) => `<div class="chapter-row"><span>${i + 1}. ${escapeHtml(c.title)}</span><strong>${c.score} คะแนน</strong></div>`).join('') + `<div class="chapter-row"><span>รวมทุกบท</span><strong>${total} คะแนน</strong></div>`; $('resultEmojiCode').textContent = state.emojiCode.join(''); $('receiptCode').textContent = state.emojiCode.join(''); $('receiptBox').classList.add('hidden'); $('submitStatus').textContent = ''; $('btnSubmitScore').disabled = false; $('btnSubmitScore').textContent = 'ส่งคะแนนเข้า Firebase'; state.isSubmitting = false; }

async function submitScoreToFirestore() {
  if (state.isSubmitting) return;
  state.isSubmitting = true;
  $('btnSubmitScore').disabled = true;
  $('submitStatus').textContent = 'กำลังตรวจสถานะระบบ...';

  const person = state.selectedStudent;
  let sessionId = state.control?.sessionId || state.settings.sessionId;
  let personKey = person?.participantKey || person?.studentKey || '';
  let lockRef = null;

  try {
    await ensureAnonymous();
    await refreshControl(false);
    if (!isControlOpen()) throw new Error(state.control?.closedMessage || 'ระบบปิดรับคะแนนแล้ว');

    sessionId = state.control.sessionId || state.settings.sessionId;
    personKey = person.participantKey || person.studentKey;
    const ref = doc(state.db, 'sessions', sessionId, 'submissions', personKey);
    lockRef = doc(state.db, 'sessions', sessionId, 'submissionLocks', personKey);
    $('submitStatus').textContent = 'กำลังบันทึกคะแนน กรุณาอย่าปิดหน้านี้...';

    const totalScore = Math.round(state.totalScore);
    const requiredTotal = Number(state.settings.passScore || 70) * Math.max(1, state.chapters.length);
    const payload = {
      uid: state.auth.currentUser.uid,
      sessionId,
      termKey: state.control.termKey || state.settings.termKey,
      weekKey: state.control.weekKey || state.settings.weekKey,
      participantKey: personKey,
      participantType: person.participantType || 'student',
      studentKey: personKey,
      studentId: person.participantType === 'student' ? (person.enteredStudentId || person.studentId || '') : '',
      level: person.level,
      room: person.room,
      no: person.no,
      department: person.department || '',
      fullName: person.fullName,
      totalScore,
      result: totalScore >= requiredTotal ? 'ผ่าน' : 'ยังไม่ผ่าน',
      emojiCode: state.emojiCode.join(''),
      chapterCount: state.chapters.length,
      chapters: state.chapters,
      submittedAt: serverTimestamp(),
      clientTime: new Date().toISOString(),
      source: 'github-pages-firebase-v3.2'
    };

    const batch = writeBatch(state.db);
    batch.set(ref, payload);
    batch.set(lockRef, {
      sessionId,
      participantKey: personKey,
      participantType: payload.participantType,
      submitted: true,
      lockedAt: serverTimestamp()
    });
    await batch.commit();

    localStorage.setItem('submitted:' + sessionId + '::' + personKey, 'yes');
    $('submitStatus').textContent = 'บันทึกคะแนนสำเร็จแล้ว';
    $('receiptBox').classList.remove('hidden');
    $('btnSubmitScore').textContent = 'ส่งแล้ว';
  } catch (err) {
    console.error(err);
    let isDuplicate = false;
    if (lockRef && (err?.code === 'permission-denied' || /already|exists|permission/i.test(String(err?.message || '')))) {
      try { isDuplicate = (await getDoc(lockRef)).exists(); } catch (_) { }
    }
    if (isDuplicate) {
      localStorage.setItem('submitted:' + sessionId + '::' + personKey, 'yes');
      $('submitStatus').textContent = 'รายชื่อนี้ส่งคะแนนประจำสัปดาห์นี้แล้ว';
      $('receiptBox').classList.remove('hidden');
      $('btnSubmitScore').textContent = 'ส่งแล้ว';
      return;
    }
    $('submitStatus').textContent = 'ส่งคะแนนไม่สำเร็จ: ' + err.message;
    $('btnSubmitScore').disabled = false;
    $('btnSubmitScore').textContent = 'ลองส่งอีกครั้ง';
    state.isSubmitting = false;
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
  if (openValue === true) payload.dashboardPublished = false;
  if (!payload.termKey || !payload.weekKey || !payload.sessionId) { alert('กรุณากรอก termKey / weekKey / sessionId'); return; }
  if (!openAtRaw || !closeAtRaw) { alert('กรุณาตั้งเวลาเปิดและเวลาปิด เพื่อให้ Security Rules ตรวจรอบเวลาได้ถูกต้อง'); return; }
  if (new Date(openAtRaw).getTime() >= new Date(closeAtRaw).getTime()) { alert('เวลาเปิดต้องมาก่อนเวลาปิด'); return; }
  await setDoc(doc(state.db, 'control', 'current'), payload, { merge: true });
  $('adminControlStatus').textContent = 'บันทึกสถานะระบบแล้ว'; await refreshControl(false); renderHome(); await loadControlToAdminForm();
}

async function refreshDashboard() {
  if (!state.isAdmin) { alert('ต้องเข้าสู่ระบบ Admin'); return; }
  await refreshControl(false);
  const sessionId = state.control?.sessionId || state.settings.sessionId;
  $('dashboardStatus').textContent = 'กำลังโหลด submissions...';
  const snap = await getDocs(collection(state.db, 'sessions', sessionId, 'submissions'));
  state.lastSubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  await loadAllStudentRosters();
  const summary = buildSummary(state.lastSubmissions, sessionId);
  renderDashboard(summary);
  $('dashboardStatus').textContent = `อัปเดตล่าสุด ${new Date().toLocaleString('th-TH')} | อ่าน ${fmt(state.lastSubmissions.length)} รายการ | ยังไม่ได้เขียนผลสาธารณะ`;
  return summary;
}
function rosterTotals() {
  const levelTotals = {}; const roomTotals = {};
  Object.values(state.studentsByLevel).flat().forEach(s => {
    levelTotals[s.level] = (levelTotals[s.level] || 0) + 1;
    const roomKey = `${s.level}/${s.room}`;
    roomTotals[roomKey] = (roomTotals[roomKey] || 0) + 1;
  });
  return { levelTotals, roomTotals };
}
function buildSummary(rows, sessionId) {
  const totalSubmitted = rows.length;
  const totalScore = rows.reduce((sum, r) => sum + Number(r.totalScore || 0), 0);
  const avgScore = totalSubmitted ? totalScore / totalSubmitted : 0;
  const students = rows.filter(r => (r.participantType || 'student') !== 'teacher');
  const totals = rosterTotals();
  const levels = groupRows(students, r => r.level, totals.levelTotals);
  const rooms = groupRows(students, r => `${r.level}/${r.room}`, totals.roomTotals);
  const includeTeachers = state.settings?.includeTeachersInPublicRanking === true;
  const rankingRows = includeTeachers ? rows : students;
  const top10 = [...rankingRows].sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0)).slice(0, 10);
  const minRate = Number(state.settings?.rankingMinSubmissionRate || 0);
  const chooseTop = list => {
    const eligible = list.filter(x => (x.submitRate || 0) >= minRate);
    return [...(eligible.length ? eligible : list)].sort((a, b) => Number(b.fairScore || 0) - Number(a.fairScore || 0))[0] || null;
  };
  return { sessionId, totalSubmitted, totalScore, avgScore, levels, rooms, top10, topLevel: chooseTop(levels), topRoom: chooseTop(rooms), updatedAt: new Date().toISOString() };
}
function groupRows(rows, keyFn, totalMap = {}) {
  const map = new Map();
  rows.forEach(r => { const key = keyFn(r) || '-'; if (!map.has(key)) map.set(key, []); map.get(key).push(r); });
  return [...map.entries()].map(([name, arr]) => {
    const totalScore = arr.reduce((sum, r) => sum + Number(r.totalScore || 0), 0);
    const passed = arr.filter(r => String(r.result) === 'ผ่าน').length;
    const totalStudents = Number(totalMap[name] || arr.length || 1);
    const avgScore = arr.length ? totalScore / arr.length : 0;
    const passRate = arr.length ? passed / arr.length : 0;
    const submitRate = Math.min(1, arr.length / Math.max(1, totalStudents));
    const fairScore = (avgScore * 0.60) + (submitRate * 100 * 0.25) + (passRate * 100 * 0.15);
    return { name, totalStudents, submitted: arr.length, totalScore, avgScore, passRate: passRate * 100, submitRate, fairScore };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th', { numeric: true }));
}
function maskPublicName(fullName) {
  const clean = String(fullName || '').replace(/^(เด็กชาย|เด็กหญิง|นาย|นางสาว|นาง|ดร\.|ครู)\s*/, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return '-';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1].charAt(0)}.`;
}
function publicDashboardPayload(summary) {
  return {
    sessionId: summary.sessionId,
    weekKey: state.control?.weekKey || state.settings.weekKey,
    totalSubmitted: summary.totalSubmitted,
    avgScore: Number(summary.avgScore || 0),
    topLevel: summary.topLevel ? { name: summary.topLevel.name, fairScore: Number(summary.topLevel.fairScore || 0) } : null,
    topRoom: summary.topRoom ? { name: summary.topRoom.name, fairScore: Number(summary.topRoom.fairScore || 0) } : null,
    top10: summary.top10.map(r => ({ displayName: maskPublicName(r.fullName), level: r.level || '', room: r.room || '', score: Number(r.totalScore || 0), emojiCode: r.emojiCode || '' })),
    publishedAtText: new Date().toLocaleString('th-TH')
  };
}
async function closeAndPublishResults() {
  if (!state.isAdmin) { alert('ต้องเข้าสู่ระบบ Admin'); return; }
  if (!confirm('ยืนยันปิดรับคะแนน และประกาศ TOP 10 / ระดับ / ห้องบนหน้าแรกหรือไม่?')) return;
  const btn = $('btnCloseAndPublish'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังสรุปและประกาศผล...';
  try {
    const summary = await refreshDashboard();
    const publicDashboard = publicDashboardPayload(summary);
    await updateDoc(doc(state.db, 'control', 'current'), {
      systemOpen: false,
      dashboardPublished: true,
      publicDashboard,
      dashboardPublishedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: state.auth.currentUser.email || state.auth.currentUser.uid
    });
    $('adminControlStatus').textContent = 'ปิดรอบและประกาศผลสำเร็จแล้ว';
    await refreshControl(false); renderHome(); await loadControlToAdminForm();
    alert('ปิดรอบและประกาศผลสำเร็จ หน้าแรกจะแสดงผลหลังผู้ใช้โหลดหน้าใหม่หรือกดอัปเดตผลล่าสุด');
  } catch (err) {
    console.error(err); alert('ปิดรอบ/ประกาศผลไม่สำเร็จ: ' + err.message);
  } finally { btn.disabled = false; btn.textContent = old; }
}
function renderDashboard(s) {
  $('dashboardSummary').innerHTML = `<div class="mini-card"><span>ส่งแล้ว</span><strong>${fmt(s.totalSubmitted)}</strong></div><div class="mini-card"><span>คะแนนรวม</span><strong>${fmt(s.totalScore)}</strong></div><div class="mini-card"><span>เฉลี่ย</span><strong>${Number(s.avgScore || 0).toFixed(2)}</strong></div><div class="mini-card"><span>Session</span><strong>${escapeHtml(s.sessionId)}</strong></div>`;
  const top = s.top10.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.fullName)}</td><td>${escapeHtml(r.participantType === 'teacher' ? 'ครู' : (r.level + '/' + r.room))}</td><td>${escapeHtml(r.no || '-')}</td><td><strong>${fmt(r.totalScore)}</strong></td><td>${escapeHtml(r.emojiCode || '')}</td></tr>`).join('');
  const winners = `<div class="dashboard-summary"><div class="mini-card"><span>ระดับโหดสุด</span><strong>${escapeHtml(s.topLevel?.name || '-')}</strong><small>${Number(s.topLevel?.fairScore || 0).toFixed(2)}</small></div><div class="mini-card"><span>ห้องโหดสุด</span><strong>${escapeHtml(s.topRoom?.name || '-')}</strong><small>${Number(s.topRoom?.fairScore || 0).toFixed(2)}</small></div></div>`;
  $('dashboardTables').innerHTML = `${winners}${renderGroupTable('สรุปรายระดับ', s.levels)}${renderGroupTable('สรุปรายห้อง', s.rooms)}<h3>Top 10</h3><table class="data-table"><thead><tr><th>#</th><th>ชื่อ</th><th>กลุ่ม</th><th>เลขที่</th><th>คะแนน</th><th>อีโมจิ</th></tr></thead><tbody>${top}</tbody></table>`;
}
function renderGroupTable(title, rows) { return `<h3>${title}</h3><table class="data-table"><thead><tr><th>กลุ่ม</th><th>ทั้งหมด</th><th>ส่ง</th><th>เฉลี่ย</th><th>อัตราส่ง</th><th>ผ่าน</th><th>Fair Score</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${fmt(r.totalStudents)}</td><td>${fmt(r.submitted)}</td><td>${Number(r.avgScore || 0).toFixed(2)}</td><td>${(Number(r.submitRate || 0) * 100).toFixed(1)}%</td><td>${Number(r.passRate || 0).toFixed(1)}%</td><td><strong>${Number(r.fairScore || 0).toFixed(2)}</strong></td></tr>`).join('')}</tbody></table>`; }
function toggleDashboardAutoRefresh() {
  if (state.adminAutoTimer) { stopDashboardAutoRefresh(); return; }
  refreshDashboard();
  const sec = Math.max(300, Number(state.settings.dashboardAutoRefreshSec || 300));
  state.adminAutoTimer = setInterval(refreshDashboard, sec * 1000);
  state.adminAutoStopTimer = setTimeout(stopDashboardAutoRefresh, 30 * 60 * 1000);
  $('btnToggleAutoRefresh').textContent = `Auto refresh: ทุก ${Math.round(sec / 60)} นาที (หยุดใน 30 นาที)`;
}
function stopDashboardAutoRefresh() {
  if (state.adminAutoTimer) clearInterval(state.adminAutoTimer);
  if (state.adminAutoStopTimer) clearTimeout(state.adminAutoStopTimer);
  state.adminAutoTimer = null; state.adminAutoStopTimer = null;
  if ($('btnToggleAutoRefresh')) $('btnToggleAutoRefresh').textContent = 'Auto refresh: ปิด';
}
function exportCsv() {
  if (!state.lastSubmissions.length) { alert('กรุณา Refresh Dashboard ก่อน'); return; }
  const headers = ['sessionId', 'weekKey', 'participantKey', 'participantType', 'studentId', 'level', 'room', 'no', 'department', 'fullName', 'totalScore', 'result', 'emojiCode', 'clientTime'];
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
