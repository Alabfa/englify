'use strict';

/* ============================================================
   Englify — منطق التطبيق
   المفردات من words.json، والحالة في localStorage.
   يشمل: تكرار متباعد (SRS)، خلط جديد/مراجعة، استكمال الدرس
   المتقطع، مستويات، إنجازات، قاموس، احتفالات، مظهر فاتح/داكن —
   بلا أُطر عمل أو خادم. طول الدرس يتبع الهدف اليومي.
   ============================================================ */

/* ---------- الإعدادات ---------- */
const STORAGE_KEY = 'kalima-state-v1'; // يطابق السكربت المضمّن في <head>
const XP_PER_CORRECT = 10;
const REMINDER_TIME = '18:00';           // 6:00 مساءً — ثابت لجميع المستخدمين
const SRS_INTERVALS = [1, 3, 7, 14, 30]; // جدول التكرار المتباعد بالأيام

/* ضع هنا App ID من لوحة OneSignal (اتركه كما هو إذا لم تضبط Push بعد) */
const ONESIGNAL_APP_ID = 'e39e7961-871c-4d5f-bb8f-15bcfefc952b';

const INSTALL_DEBUG = new URLSearchParams(location.search).has('debug');

/* طول الدرس يتبع الهدف اليومي — درس واحد = هدف اليوم.
   سقف كلمات المراجعة داخل الدرس العادي ≈ 30% من الهدف */
const reviewCap = () => Math.max(3, Math.round(state.dailyGoal * 0.3));

/* ---------- أدوات صغيرة ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ربط آمن — العنصر المفقود يُطبع في الكونسول بدل إسقاط بقية الربط */
function bind(sel, ev, fn) {
  const n = $(sel);
  if (n) n.addEventListener(ev, fn);
  else console.warn('Englify: عنصر مفقود في HTML —', sel);
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* أرقام إنجليزية مع فواصل الآلاف: 1,250 */
const arNum = n => Number(n).toLocaleString('en-US');

/* صيغ العدد العربية: واحد / اثنان / جمع قلة (3-10) / جمع كثرة (11+) */
function countAr(n, forms) {
  if (n === 1) return forms[0];
  if (n === 2) return forms[1];
  if (n >= 3 && n <= 10) return `${arNum(n)} ${forms[2]}`;
  return `${arNum(n)} ${forms[3]}`;
}

/* ---------- التواريخ ---------- */
const pad = n => String(n).padStart(2, '0');
const dayStamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayStamp(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayStamp(d); };
const daysFromNow = n => { const d = new Date(); d.setDate(d.getDate() + n); return dayStamp(d); };

/* ---------- الحالة المحفوظة ---------- */
const DEFAULTS = {
  streak: 0, bestStreak: 0, lastLessonDate: null,
  xp: 0,
  dailyProgress: 0, dailyDate: today(), dailyGoal: 10,
  totalQuestions: 0, correctAnswers: 0, incorrectAnswers: 0,
  learnedWords: [], mistakes: [], dailyLog: {},
  reminderEnabled: false, lastReminderFired: null,
  theme: 'system',
  lessonsDone: 0, perfectLesson: false, masteredCount: 0,
  goalReachedOnce: false,
  achievements: {}, savedLesson: null,
  installDismissed: false,
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* التخزين غير متاح */ }
}

/* ترقية بيانات قديمة: أخطاء بلا حقول SRS */
function migrate() {
  let changed = false;
  if (Array.isArray(state.mistakes)) {
    for (const m of state.mistakes) {
      if (typeof m.stage !== 'number') { m.stage = 0; changed = true; }
      if (typeof m.due !== 'string') { m.due = today(); changed = true; }
    }
  } else { state.mistakes = []; changed = true; }
  if (changed) saveState();
}

/* تصفير العدادات اليومية عند تغيّر اليوم */
function rollDaily() {
  if (state.dailyDate !== today()) {
    state.dailyDate = today();
    state.dailyProgress = 0;
    pruneDailyLog();
    saveState();
  }
}

/* الاحتفاظ بآخر 30 يوماً فقط من سجل النشاط */
function pruneDailyLog() {
  const keep = new Set([...Array(30)].map((_, i) => daysAgo(i)));
  let changed = false;
  for (const d of Object.keys(state.dailyLog)) {
    if (!keep.has(d)) { delete state.dailyLog[d]; changed = true; }
  }
  if (changed) saveState();
}

/* لا تبقى السلسلة إلا إذا كان آخر درس اليوم أو أمس */
function refreshStreak() {
  if (state.lastLessonDate && state.lastLessonDate !== today() && state.lastLessonDate !== daysAgo(1)) {
    state.streak = 0;
    saveState();
  }
}

/* تُستدعى مرة واحدة عند إتمام الدرس */
function completeStreakDay() {
  const t = today();
  if (state.lastLessonDate === t) {
    /* حُسبت اليوم بالفعل */
  } else if (state.lastLessonDate === daysAgo(1)) {
    state.streak++;
  } else {
    state.streak = 1;
  }
  state.lastLessonDate = t;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
}

/* ---------- المفردات ---------- */
let vocabulary = [];
let vocabMap = new Map();

async function loadVocabulary() {
  try {
    const res = await fetch('words.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('يجب أن يكون words.json مصفوفة');
    vocabulary = data.filter(w => w && typeof w.word === 'string' && typeof w.meaning === 'string');
    if (vocabulary.length < 4) throw new Error('نحتاج 4 كلمات على الأقل لبناء الاختبار');
    vocabMap = new Map(vocabulary.map(w => [w.word, w]));
    $('#btn-start').disabled = false;
    $('#btn-home-review').disabled = false;
  } catch (err) {
    showDataError(err);
  }
}

function showDataError(err) {
  const note = $('#data-note');
  note.hidden = false;
  note.innerHTML = '';
  note.append(
    el('strong', null, 'تعذّر تحميل ملف words.json. '),
    el('span', null, `(${err.message}) إن كنت فتحت index.html مباشرة من القرص، فشغّل التطبيق عبر خادم محلي — مثل Live Server في VS Code، أو الأمر npx serve، أو python -m http.server — حتى يسمح المتصفح بجلب الملف.`)
  );
  $('#btn-start').disabled = true;
  $('#btn-home-review').disabled = true;
}

/* ---------- الأيقونات (SVG مضمّن، تُحقن مرة واحدة) ---------- */
const ICONS = {
  home: '<path d="M3 11.3 12 3l9 8.3"/><path d="M5.5 10v10.5h13V10"/><path d="M10 20.5v-6h4v6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5z"/><path d="M20 18.5H6.5A2.5 2.5 0 0 0 4 21"/>',
  repeat: '<path d="m17 2.5 4 4-4 4"/><path d="M21 6.5H8a5 5 0 0 0-5 5v1"/><path d="m7 21.5-4-4 4-4"/><path d="M3 17.5h13a5 5 0 0 0 5-5v-1"/>',
  chart: '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V6"/><path d="M17 20v-9"/>',
  sliders: '<path d="M4 7h8"/><circle cx="15.5" cy="7" r="2.2"/><path d="M4 17h3"/><circle cx="10.5" cy="17" r="2.2"/><path d="M14 17h6"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="M4.5 12.8 9.6 18 19.5 6.8"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5v14l11-7z"/>',
  zap: '<path fill="currentColor" stroke="none" d="M13 2 3 14h7l-1 8 11-14h-7z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
  bell: '<path d="M18 9.5a6 6 0 1 0-12 0c0 5.5-2 7-2 7h16s-2-1.5-2-7"/><path d="M10.3 20.5a2 2 0 0 0 3.4 0"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 3h10v6a5 5 0 0 1-10 0V3z"/><path d="M7 5H4v1a3 3 0 0 0 3 3"/><path d="M17 5h3v1a3 3 0 0 1-3 3"/>',
  star: '<path d="M12 3l2.7 5.7 6.3.9-4.6 4.4 1.1 6.3L12 17.4 6.5 20.3l1.1-6.3L3 9.6l6.3-.9z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  download: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 19h16"/>',
};

function iconEl(name, extraClass) {
  const span = el('span', 'ic' + (extraClass ? ' ' + extraClass : ''));
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach(node => node.append(iconEl(node.dataset.icon)));
}

function makeMark(name) {
  const mark = el('span', 'mark');
  mark.append(iconEl(name));
  return mark;
}

/* ---------- المظهر ---------- */
function applyTheme() {
  const mq = matchMedia('(prefers-color-scheme: light)');
  const resolved = state.theme === 'system' ? (mq.matches ? 'light' : 'dark') : state.theme;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'light' ? '#f2efe7' : '#0b1220';
}

/* ---------- التثبيت (PWA) ---------- */
let deferredInstall = null;

const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 9v6M9 12h6"/></svg>';

function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

/* iOS + سفاري فقط — كروم على iOS لا يدعم الإضافة للشاشة الرئيسية */
function isIOSSafari() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const nativeIOSBrowser = /crios|fxios|edgi/i.test(navigator.userAgent);
  return ios && !nativeIOSBrowser;
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  updateInstallUI();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  toast('تم تثبيت Englify على جهازك 🎉');
  updateInstallUI();
});

function renderIosSteps(list) {
  list.innerHTML = '';
  const steps = [
    { svg: SHARE_SVG, text: 'اضغط زر المشاركة في شريط سفاري السفلي' },
    { svg: PLUS_SVG, text: 'اختر «إضافة إلى الشاشة الرئيسية»' },
    { text: 'أكّد بضغط «إضافة» — سيظهر التطبيق بجانب تطبيقاتك' },
  ];
  steps.forEach((s, i) => {
    const li = el('li');
    li.append(el('span', 'step-num', String(i + 1)));
    if (s.svg) {
      const ic = el('span', 'step-ic');
      ic.innerHTML = s.svg;
      li.append(ic);
    }
    li.append(el('span', null, s.text));
    list.append(li);
  });
}

function updateInstallUI() {
  const installed = isInstalled();
  const card = $('#install-card');
  const banner = $('#install-banner');
  const btn = $('#btn-install');
  const steps = $('#install-steps');
  const desc = $('#install-desc');

  /* بطاقة الإعدادات */
  if (card) {
    card.hidden = installed;
    if (!installed) {
      btn.hidden = true;
      steps.hidden = true;
      if (deferredInstall) {
        desc.textContent = 'ثبّت Englify كتطبيق مستقل — يفتح أسرع وبملء الشاشة.';
        btn.hidden = false;
      } else if (isIOSSafari()) {
        desc.textContent = 'أضف Englify إلى شاشتك الرئيسية في ثلاث خطوات:';
        renderIosSteps(steps);
        steps.hidden = false;
      } else {
        desc.textContent = 'التثبيت متاح عبر كروم (أندرويد/كمبيوتر) أو سفاري على iOS بعد الإضافة للشاشة الرئيسية.';
      }
    }
  }

  /* شريط الرئيسية */
  if (banner) {
    banner.hidden = installed
      || state.installDismissed
      || (!deferredInstall && !isIOSSafari());
  }
}

/* ---------- Push عبر OneSignal ---------- */
window.OneSignalDeferred = window.OneSignalDeferred || [];

const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

function pushConfigured() {
  return ONESIGNAL_APP_ID && !ONESIGNAL_APP_ID.startsWith('YOUR_');
}

function enablePushReminder() {
  if (!pushConfigured()) return;
  if (isIOSDevice && !isStandalone) {
    toast('لتفعيل تنبيه الهاتف: أضِف Englify إلى الشاشة الرئيسية أولاً (زر المشاركة ← "إضافة إلى الشاشة الرئيسية")');
    return;
  }
  OneSignalDeferred.push(async OneSignal => {
    try {
      await OneSignal.init({ appId: ONESIGNAL_APP_ID });
      const granted = await OneSignal.Notifications.requestPermission();
      if (!granted) return;
      OneSignal.User.addTag('push', 'on');
      toast('سيصلك تنبيه يومي على هاتفك حتى مع إغلاق التطبيق');
    } catch { /* لم يُحمَّل SDK أو المتصفح لا يدعم */ }
  });
}

function syncPushTag() {
  if (!pushConfigured() || !state.reminderEnabled) return;
  OneSignalDeferred.push(async OneSignal => {
    try {
      await OneSignal.init({ appId: ONESIGNAL_APP_ID });
      OneSignal.User.addTag('push', 'on');
    } catch { /* تجاهل */ }
  });
}

/* ---------- نظام التكرار المتباعد (SRS) ---------- */
/* خطأ → المراجعة غداً. إجابة صحيحة → المرحلة التالية (1←3←7←14←30) → التخرّج بإتقانها */
function addMistake(word, meaning) {
  const found = state.mistakes.find(m => m.word === word);
  if (found) {
    found.count = (found.count || 1) + 1;
    found.stage = 0;            // فشل = عودة إلى بداية الجدول
    found.due = daysFromNow(1);
  } else {
    state.mistakes.push({ word, meaning, count: 1, stage: 0, due: daysFromNow(1) });
  }
}

function promoteMistake(word) {
  const found = state.mistakes.find(m => m.word === word);
  if (!found) return false;
  found.stage++;
  if (found.stage >= SRS_INTERVALS.length) {
    state.mistakes = state.mistakes.filter(m => m.word !== word);
    state.masteredCount = (state.masteredCount || 0) + 1;
    return true; // تخرّجت — أُتقنت
  }
  found.due = daysFromNow(SRS_INTERVALS[found.stage]);
  return false;
}

function dueMistakes() {
  const t = today();
  return state.mistakes.filter(m => m.due <= t);
}

/* ---------- الإنجازات ---------- */
const ACHIEVEMENTS = [
  { id: 'first-step', icon: 'play', name: 'الخطوة الأولى', desc: 'أكمل درسك الأول' },
  { id: 'perfect', icon: 'star', name: 'درس مثالي', desc: 'أجب عن كل أسئلة الدرس صحيحة' },
  { id: 'goal-first', icon: 'target', name: 'هدف اليوم', desc: 'حقق هدفك اليومي لأول مرة' },
  { id: 'streak-7', icon: 'flame', name: 'أسبوع كامل', desc: 'حافظ على سلسلة 7 أيام' },
  { id: 'streak-30', icon: 'flame', name: 'شهر من الالتزام', desc: 'حافظ على سلسلة 30 يوماً' },
  { id: 'xp-100', icon: 'zap', name: 'أول مئة', desc: 'اجمع 100 نقطة' },
  { id: 'xp-500', icon: 'zap', name: 'جامع النقاط', desc: 'اجمع 500 نقطة' },
  { id: 'words-25', icon: 'book', name: '25 كلمة', desc: 'تعلّم 25 كلمة' },
  { id: 'words-100', icon: 'book', name: 'قاموس متنامٍ', desc: 'تعلّم 100 كلمة' },
  { id: 'accuracy-90', icon: 'chart', name: 'دقة عالية', desc: 'دقة 90% بعد 50 سؤالاً' },
  { id: 'master-10', icon: 'trophy', name: 'مُتقِن', desc: 'أتقنت 10 كلمات من المراجعة' },
];

function checkAchievements() {
  const acc = state.totalQuestions ? state.correctAnswers / state.totalQuestions * 100 : 0;
  const rules = {
    'first-step': state.lessonsDone >= 1,
    'perfect': state.perfectLesson === true,
    'goal-first': state.goalReachedOnce === true,
    'streak-7': state.bestStreak >= 7,
    'streak-30': state.bestStreak >= 30,
    'xp-100': state.xp >= 100,
    'xp-500': state.xp >= 500,
    'words-25': state.learnedWords.length >= 25,
    'words-100': state.learnedWords.length >= 100,
    'accuracy-90': state.totalQuestions >= 50 && acc >= 90,
    'master-10': (state.masteredCount || 0) >= 10,
  };
  for (const a of ACHIEVEMENTS) {
    if (!state.achievements[a.id] && rules[a.id]) {
      state.achievements[a.id] = today();
      toast(`إنجاز جديد — ${a.name}!`);
    }
  }
}

/* ---------- الاحتفالات (قصاصات ورقية) ---------- */
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.getElementById('confetti-canvas');
  const ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const colors = ['#ffb13d', '#5cd0ff', '#3ecf8e', '#ff6b6b', '#f3f0e8'];
  const parts = Array.from({ length: 90 }, () => ({
    x: Math.random() * c.width,
    y: -20 - Math.random() * c.height * 0.3,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vy: 2.2 + Math.random() * 2.8,
    vx: -1.2 + Math.random() * 2.4,
    rot: Math.random() * Math.PI,
    vr: -0.12 + Math.random() * 0.24,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  function frame(t) {
    ctx.clearRect(0, 0, c.width, c.height);
    let alive = false;
    for (const p of parts) {
      p.y += p.vy; p.x += p.vx; p.rot += p.vr;
      if (p.y < c.height + 20) alive = true;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive && t - t0 < 3200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, c.width, c.height);
  }
  requestAnimationFrame(frame);
}

/* ---------- نظام المستويات ----------
   المستوى مشتق من النقاط مباشرة — بلا حقول جديدة ولا ترحيل بيانات.
   كل مستوى يتطلب 50 نقطة أكثر من سابقه: 100، 150، 200... */
function levelInfo() {
  let level = 1, into = state.xp, need = 100;
  while (into >= need) { into -= need; level++; need += 50; }
  return { level, into, need };
}

function celebrateLevel(lv) {
  confetti();
  toast(`وصلت إلى المستوى ${arNum(lv)}!`);
}

/* ---------- التنقل ---------- */
let currentScreen = 'home';

function navigate(name) {
  if (currentScreen === 'learn' && name !== 'learn') lesson.active = false;
  currentScreen = name;
  $$('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === name));
  $$('[data-nav]').forEach(b => b.classList.toggle('is-active', b.dataset.nav === name));
  window.scrollTo({ top: 0 });
  if (name === 'home') renderHome();
  if (name === 'review') renderReview();
  if (name === 'dictionary') renderDictionary();
  if (name === 'progress') renderProgress();
  if (name === 'settings') renderSettings();
}

function onNav(name) {
  if (name === 'learn') {
    if (currentScreen === 'learn' && lesson.active) return; // عدم إعادة الدرس من أثناءه
    startNormalLesson();
    return;
  }
  navigate(name);
}

/* ---------- توليد الأسئلة ---------- */
function buildQuestion(wordObj, forcedType) {
  const type = forcedType || (Math.random() < 0.5 ? 'en2ar' : 'ar2en');
  const answer = type === 'en2ar' ? wordObj.meaning : wordObj.word;

  /* ثلاثة بدلات خاطئة من مفردات أخرى، بدون تكرار */
  const texts = new Set([answer]);
  const distractors = [];
  for (const w of shuffle(vocabulary)) {
    if (w.word === wordObj.word) continue;
    const t = type === 'en2ar' ? w.meaning : w.word;
    if (texts.has(t)) continue;
    texts.add(t);
    distractors.push(t);
    if (distractors.length === 3) break;
  }
  return { word: wordObj.word, meaning: wordObj.meaning, type, answer, options: shuffle([answer, ...distractors]) };
}

function reviewQuestion(wordObj, forcedType) {
  const q = buildQuestion(wordObj, forcedType);
  q.source = 'review';
  return q;
}

/* ---------- محرك الدرس ---------- */
const lesson = { active: false, items: [], index: 0, correct: 0, answered: false, kind: 'normal' };

/* درس عادي: طوله = الهدف اليومي، ويبدأ بما يصل إلى 30% كلمات مراجعة مستحقة */
function startNormalLesson() {
  if (!vocabulary.length) {
    toast('تعذّر تحميل words.json — راجع الملاحظة في الصفحة الرئيسية');
    return;
  }
  const len = state.dailyGoal;
  state.savedLesson = null;
  const used = new Set();
  const items = [];

  for (const m of shuffle(dueMistakes())) {
    if (items.length >= reviewCap()) break;
    const v = vocabMap.get(m.word);
    if (!v || used.has(v.word)) continue;
    used.add(v.word);
    items.push(reviewQuestion(v));
  }

  const fresh = shuffle(vocabulary.filter(w => !used.has(w.word) && !state.learnedWords.includes(w.word)));
  const rest = shuffle(vocabulary.filter(w => !used.has(w.word) && state.learnedWords.includes(w.word)));
  let bag = [...fresh, ...rest];
  let allowDup = false;

  while (items.length < len) {
    if (!bag.length) {
      const unused = shuffle(vocabulary.filter(w => !used.has(w.word)));
      bag = unused.length ? unused : shuffle(vocabulary); // مفردات أقل من طول الدرس → اسمح بالتكرار
      allowDup = !unused.length;
    }
    const w = bag.pop();
    if (used.has(w.word) && !allowDup) continue;
    used.add(w.word);
    items.push(buildQuestion(w));
  }
  startLesson(items, 'normal');
}

/* درس مراجعة: المستحق أولاً ثم الأقرب موعداً — بطول الهدف اليومي */
function startReviewLesson() {
  const t = today();
  const due = shuffle(state.mistakes.filter(m => m.due <= t));
  const upcoming = state.mistakes.filter(m => m.due > t)
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  const picked = [...due, ...upcoming].slice(0, state.dailyGoal)
    .map(m => vocabMap.get(m.word))
    .filter(Boolean)
    .map(v => reviewQuestion(v));
  if (!picked.length) return toast('لا توجد كلمات للمراجعة');
  state.savedLesson = null;
  startLesson(picked, 'review');
}

function startLesson(items, kind) {
  Object.assign(lesson, { active: true, items, index: 0, correct: 0, answered: false, kind });
  $('#summary-view').hidden = true;
  $('#quiz-view').hidden = false;
  navigate('learn');
  renderQuestion();
}

/* استكمال درس متقطع */
function resumeLesson() {
  const s = state.savedLesson;
  if (!s) return;
  Object.assign(lesson, { active: true, items: s.items, index: s.next, correct: s.correct, answered: false, kind: s.kind });
  $('#summary-view').hidden = true;
  $('#quiz-view').hidden = false;
  navigate('learn');
  renderQuestion();
}

/* حفظ نقطة الاستكمال بعد كل إجابة */
function saveSession() {
  const next = lesson.index + 1;
  state.savedLesson = next >= lesson.items.length ? null
    : { items: lesson.items, next, correct: lesson.correct, kind: lesson.kind, date: today() };
}

function renderQuestion() {
  const q = lesson.items[lesson.index];
  lesson.answered = false;

  const pct = (lesson.index / lesson.items.length) * 100;
  $('#lesson-progress-fill').style.width = pct + '%';
  const bar = $('#lesson-progressbar');
  bar.setAttribute('aria-valuenow', lesson.index);
  bar.setAttribute('aria-valuemax', lesson.items.length);
  bar.setAttribute('aria-valuetext', `السؤال ${lesson.index + 1} من ${lesson.items.length}`);
  $('#lesson-count').textContent = `${lesson.index + 1} / ${lesson.items.length}`;

  const en2ar = q.type === 'en2ar';
  const tag = $('#q-tag');
  tag.textContent = en2ar ? 'اختر المعنى العربي' : 'اختر الكلمة الإنجليزية';
  tag.classList.toggle('is-ar', !en2ar);
  $('#q-src').hidden = q.source !== 'review';
  $('#q-prompt').textContent = en2ar ? 'ما معنى هذه الكلمة؟' : 'ما الكلمة الإنجليزية المقابلة؟';
  const wordEl = $('#q-word');
  wordEl.textContent = en2ar ? q.word : q.meaning;
  wordEl.dir = en2ar ? 'ltr' : 'rtl';
  wordEl.lang = en2ar ? 'en' : 'ar';

  const wrap = $('#answers');
  wrap.innerHTML = '';
  q.options.forEach((opt, i) => {
    const b = el('button', 'answer');
    b.type = 'button';
    b.dataset.opt = opt;
    const txt = el('span', 'answer-text', opt);
    txt.dir = en2ar ? 'rtl' : 'ltr';
    txt.lang = en2ar ? 'ar' : 'en';
    b.append(txt, el('span', 'key', i + 1));
    b.addEventListener('click', () => answerQuestion(b, opt));
    wrap.append(b);
  });

  $('#feedback-dock').hidden = true;
}

function answerQuestion(btn, chosen) {
  if (lesson.answered) return;
  lesson.answered = true;

  const q = lesson.items[lesson.index];
  const correct = chosen === q.answer;

  $$('#answers .answer').forEach(b => {
    b.disabled = true;
    if (b.dataset.opt === q.answer) {
      b.classList.add(correct ? 'is-correct' : 'is-reveal');
      b.append(makeMark('check'));
    } else if (b === btn) {
      b.classList.add('is-wrong');
      b.append(makeMark('x'));
    } else {
      b.classList.add('is-dim');
    }
  });

  /* الإحصاءات والحفظ */
  state.totalQuestions++;
  state.dailyProgress++;
  state.dailyLog[today()] = (state.dailyLog[today()] || 0) + 1;

  let masteredNow = false;
  if (correct) {
    const prevLevel = levelInfo().level;
    lesson.correct++;
    state.correctAnswers++;
    state.xp += XP_PER_CORRECT;
    if (!state.learnedWords.includes(q.word)) state.learnedWords.push(q.word);
    masteredNow = promoteMistake(q.word); // إجابة صحيحة تقدّم جدول المراجعة (في أي نوع درس)
    spawnXpFloat();
    if (levelInfo().level > prevLevel) celebrateLevel(levelInfo().level);
    if (state.dailyProgress === state.dailyGoal && !state.goalReachedOnce) {
      state.goalReachedOnce = true;
      confetti(); // لحظة احتفال: تحقيق هدف اليوم
    }
  } else {
    state.incorrectAnswers++;
    addMistake(q.word, q.meaning);
  }

  checkAchievements();
  saveSession();
  saveState();

  /* شريط التغذية الراجعة */
  const dock = $('#feedback-dock');
  dock.hidden = false;
  dock.classList.toggle('is-correct', correct);
  dock.classList.toggle('is-wrong', !correct);
  $('#dock-title').textContent = correct ? 'إجابة صحيحة!' : 'إجابة خاطئة';
  const sub = $('#dock-sub');
  sub.innerHTML = '';
  if (correct) {
    if (masteredNow) {
      sub.textContent = `أتقنت "${q.word}" — خرجت من قائمة المراجعة!`;
    } else if (lesson.kind === 'review') {
      sub.textContent = 'تقدّمت خطوة في جدول مراجعتها.';
    } else {
      sub.textContent = `+${XP_PER_CORRECT} نقاط خبرة`;
    }
  } else {
    sub.append('الإجابة الصحيحة: ');
    const strong = el('strong', null, q.answer);
    strong.dir = q.type === 'en2ar' ? 'rtl' : 'ltr';
    sub.append(strong);
  }
  const last = lesson.index + 1 >= lesson.items.length;
  $('#btn-continue').textContent = last ? 'إنهاء' : 'متابعة';
  $('#btn-continue').focus();
}

function spawnXpFloat() {
  const card = $('.q-card');
  const f = el('span', 'xp-float', `+${XP_PER_CORRECT} نقاط`);
  card.append(f);
  setTimeout(() => f.remove(), 950);
}

/* ---------- ملخص الدرس ---------- */
function showSummary() {
  lesson.active = false;
  state.savedLesson = null;
  state.lessonsDone = (state.lessonsDone || 0) + 1;

  const total = lesson.items.length;
  const pct = Math.round((lesson.correct / total) * 100);
  if (lesson.kind === 'normal' && pct === 100) state.perfectLesson = true;

  completeStreakDay();
  checkAchievements();
  saveState();

  $('#quiz-view').hidden = true;
  $('#feedback-dock').hidden = true;
  $('#summary-view').hidden = false;
  $('#lesson-progress-fill').style.width = '100%';

  $('#summary-message').textContent =
    pct === 100 ? 'ممتاز! أداء مثالي.' :
      pct >= 80 ? 'رائع! تقدّم ممتاز.' :
        pct >= 50 ? 'أحسنت — واصل على هذا المعدل!' :
          'واصل التدرب، ستتحسن بسرعة!';
  $('#summary-score').textContent = `${lesson.correct} / ${total}`;
  $('#summary-pct').textContent = pct + '%';
  $('#summary-xp').textContent = '+' + lesson.correct * XP_PER_CORRECT;
  $('#summary-streak').textContent = state.streak;
  setRing($('#summary-ring'), pct);
  updateStreakChips();
  if (pct === 100) confetti(); // لحظة احتفال: درس مثالي
}

function setRing(svg, pct) {
  const c = svg.querySelector('.ring-fg');
  const circ = 2 * Math.PI * c.r.baseVal.value;
  c.style.transition = 'none';
  c.style.strokeDasharray = circ;
  c.style.strokeDashoffset = circ;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    c.style.transition = 'stroke-dashoffset .8s ease';
    c.style.strokeDashoffset = circ * (1 - pct / 100);
  }));
}

/* ---------- عرض الشاشات ---------- */
function updateStreakChips() {
  const st = state.streak;
  document.body.dataset.heat = st === 0 ? 'cold' : st < 7 ? 'lit' : st < 30 ? 'blaze' : 'inferno';
  const pill = $('#home-streak-pill');
  const pillText = $('#home-streak');
  if (pill && pillText) {
    pillText.textContent = `${st} ${st <= 10 ? 'أيام' : 'يوماً'}${st === 0 ? '' : ' 🔥'}`;
    pill.title = st === 0 ? 'لا سلسلة بعد — أكمل درساً لبدء السلسلة' : `سلسلة ${st} يوماً متتالية`;
  }
  $('#sidebar-streak').textContent = st;
  $('#sidebar-xp').textContent = state.xp;
}

function accuracyPct() {
  return state.totalQuestions ? Math.round(state.correctAnswers / state.totalQuestions * 100) : null;
}

function setPill(elm, cls, text, withStar) {
  elm.className = 'stat2-pill ' + cls;
  elm.innerHTML = '';
  elm.append(el('span', null, text));
  if (withStar) elm.append(iconEl('star'));
}

function renderHome() {
  rollDaily();
  const h = new Date().getHours();
  $('#home-greeting').textContent = h < 12 ? 'صباح الخير' : 'مساء الخير';

  const done = state.dailyProgress >= state.dailyGoal;
  const s = state.savedLesson;
  const due = dueMistakes().length;
  const mc = state.mistakes.length;

  /* نصوص تكيّفية حسب حالة المستخدم */
  $('#hero-title').textContent = done ? 'أنجزت تمرين اليوم!' : 'وقت تمرين اليوم!';
  $('#home-subtitle').textContent =
    s ? 'لديك درس لم يكتمل — تابع من حيث توقفت دون فقدان تقدمك.' :
      state.lessonsDone === 0 ? 'رحلتك تبدأ من هنا — درس واحد يومياً يصنع الفرق.' :
        done ? 'حققت هدف اليوم! عُد غداً لتبقي شعلتك مشتعلة.' :
          due >= 3 ? `لديك ${countAr(due, ['كلمة مستحقة للمراجعة', 'كلمتان مستحقتان للمراجعة', 'كلمات مستحقة للمراجعة', 'كلمة مستحقة للمراجعة'])} — لا تدعها تتراكم.` :
            'مسيرتك تتقدم بشكل رائع! أكمل درس اليوم للحفاظ على الشعلة.';

  /* الزر المتكيّف: متابعة الدرس (مع شريط تقدّم) أو درس جديد */
  const startLabel = $('#btn-start-label');
  const prog = $('#cta-progress');
  const fresh = $('#btn-fresh-start');
  if (s) {
    startLabel.textContent = 'متابعة الدرس';
    prog.hidden = false;
    $('#cta-fill').style.width = (s.next / s.items.length * 100) + '%';
    $('#cta-nums').textContent = `${s.next + 1} / ${s.items.length}`;
    fresh.hidden = false;
  } else {
    startLabel.textContent = done ? 'درس إضافي' : 'ابدأ التعلم';
    prog.hidden = true;
    fresh.hidden = true;
  }
  $('#btn-start').classList.toggle('is-resume', !!s);

  /* زر المراجعة: يلفت الانتباه فقط عند وجود كلمات مستحقة الآن */
  const reviewBtn = $('#btn-home-review');
  const dueChip = $('#home-due-chip');
  reviewBtn.classList.toggle('is-attention', due > 0);
  reviewBtn.classList.toggle('is-muted', mc === 0);
  dueChip.hidden = due === 0;
  dueChip.textContent = due ? countAr(due, ['كلمة مستحقة', 'كلمتان مستحقتان', 'كلمات مستحقة', 'كلمة مستحقة']) : '';

  /* تلميح التوقّع — يتبع الهدف الحالي */
  const mins = Math.max(1, Math.round(state.dailyGoal * 3 / 10));
  $('#action-hint').textContent = s ? '' :
    `درس من ${arNum(state.dailyGoal)} أسئلة · نحو ${countAr(mins, ['دقيقة واحدة', 'دقيقتين', 'دقائق', 'دقيقة'])}`;

  /* ملاحظة السلسلة — حسب طورها */
  const st = state.streak;
  $('#streak-note').textContent =
    st === 0 ? 'ابدأ سلسلتك اليوم' :
      st < 3 ? 'بداية موفقة — واصل غداً' :
        st < 7 ? 'حافظ على تركّزك' :
          st < 30 ? 'سلسلة رائعة!' :
            'التزام أسطوري!';

  /* بطاقة الهدف اليومي */
  $('#goal-done').textContent = arNum(state.dailyProgress);
  $('#goal-total').textContent = arNum(state.dailyGoal);
  $('#goal-end-label').textContent = `${arNum(state.dailyGoal)} أسئلة`;
  const fill = $('#goal-fill');
  fill.style.width = Math.min(100, state.dailyProgress / state.dailyGoal * 100) + '%';
  fill.classList.toggle('is-done', done);
  const status = $('#goal-status');
  status.classList.toggle('is-done', done);
  status.textContent = done
    ? 'أنجزت هدف اليوم — أحسنت!'
    : `باقي ${countAr(Math.max(0, state.dailyGoal - state.dailyProgress), ['سؤال واحد', 'سؤالين', 'أسئلة', 'أسئلة'])} لإنهاء الهدف اليومي`;

  /* بطاقة الإحصاءات */
  const acc = accuracyPct();
  const lv = levelInfo();
  $('#stat-level').textContent = arNum(lv.level);
  $('#stat-words').textContent = arNum(state.learnedWords.length);
  $('#stat-accuracy').textContent = acc === null ? '—' : `${arNum(acc)}%`;
  setPill($('#pill-level'), 'is-cyan', `${arNum(lv.into)} / ${arNum(lv.need)} نقطة`);
  if (vocabulary.length) setPill($('#pill-words'), 'is-jade', `من أصل ${arNum(vocabulary.length)}`);
  else setPill($('#pill-words'), 'is-muted', '—');
  if (acc === null) setPill($('#pill-accuracy'), 'is-muted', 'ابدأ الآن');
  else if (acc >= 90) setPill($('#pill-accuracy'), 'is-amber', 'ممتاز', true);
  else if (acc >= 75) setPill($('#pill-accuracy'), 'is-amber', 'جيد جداً');
  else if (acc >= 50) setPill($('#pill-accuracy'), 'is-muted', 'جيد');
  else setPill($('#pill-accuracy'), 'is-muted', 'واصل التدرب');

  $('#review-badge').textContent = mc || '';

  updateStreakChips();
}

function renderReview() {
  const box = $('#review-content');
  box.innerHTML = '';

  if (!state.mistakes.length) {
    const empty = el('div', 'empty-state');
    empty.append(iconEl('check', 'empty-icon'));
    empty.append(el('p', 'empty-title', 'لا توجد أخطاء بعد.'));
    empty.append(el('p', 'empty-sub', 'واصل التعلّم!'));
    box.append(empty);
    return;
  }

  const t = today();
  const due = dueMistakes();

  const head = el('div', 'review-head');
  const all = el('button', 'btn btn-primary');
  all.type = 'button';
  all.append(iconEl('play'), el('span', null, due.length
    ? `مراجعة المستحق (${Math.min(due.length, state.dailyGoal)})`
    : `تدرّب مبكراً (${Math.min(state.mistakes.length, state.dailyGoal)})`));
  all.addEventListener('click', startReviewLesson);
  head.append(all);
  head.append(el('p', 'review-note', due.length
    ? countAr(due.length, ['كلمة واحدة مستحقة اليوم', 'كلمتان مستحقتان اليوم', 'كلمات مستحقة اليوم', 'كلمة مستحقة اليوم'])
    : 'لا شيء مستحق اليوم — جدول المراجعة يسير كما يجب.'));
  box.append(head);

  if (state.mistakes.length > state.dailyGoal) {
    box.append(el('p', 'review-note', `لديك ${arNum(state.mistakes.length)} كلمة محفوظة — تُدرَّب على ${arNum(state.dailyGoal)} في كل مرة.`));
  }

  const sorted = [...state.mistakes].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  const list = el('div', 'mistake-list');
  sorted.forEach(m => {
    const isDue = m.due <= t;
    const row = el('div', 'mistake-row');

    const info = el('div', 'mistake-info');
    const w = el('div', 'mistake-word', m.word); w.dir = 'ltr'; w.lang = 'en';
    const mean = el('div', 'mistake-meaning', m.meaning); mean.dir = 'rtl'; mean.lang = 'ar';
    info.append(w, mean);

    const meta = el('div', 'mistake-meta');
    const dots = el('span', 'srs-dots');
    dots.title = `المرحلة ${m.stage + 1} من ${SRS_INTERVALS.length}`;
    for (let i = 0; i < SRS_INTERVALS.length; i++) dots.append(el('i', i < m.stage ? 'on' : ''));
    meta.append(dots);
    if (isDue) meta.append(el('span', 'due-chip is-due', 'مستحقة الآن'));

    const one = el('button', 'btn btn-ghost btn-sm', 'تدرّب');
    one.type = 'button';
    one.addEventListener('click', () => {
      const v = vocabMap.get(m.word);
      if (!v) return toast('هذه الكلمة لم تعد موجودة في words.json');
      startLesson([reviewQuestion(v, 'en2ar'), reviewQuestion(v, 'ar2en')], 'review');
    });

    row.append(info, meta, one);
    list.append(row);
  });
  box.append(list);
}

/* ---------- القاموس ---------- */
let dictFilter = 'all';
let dictQuery = '';

function renderDictionary() {
  $$('#dict-filter .seg-btn').forEach(b => {
    const on = b.dataset.filter === dictFilter;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });

  const q = dictQuery.trim();
  const ql = q.toLowerCase();
  const inReview = new Set(state.mistakes.map(m => m.word));
  const learned = new Set(state.learnedWords);

  const rows = vocabulary
    .filter(w => !q || w.word.toLowerCase().includes(ql) || w.meaning.includes(q))
    .filter(w => {
      if (dictFilter === 'learned') return learned.has(w.word);
      if (dictFilter === 'review') return inReview.has(w.word);
      if (dictFilter === 'new') return !learned.has(w.word) && !inReview.has(w.word);
      return true;
    })
    .sort((a, b) => a.word.localeCompare(b.word));

  $('#dict-sub').textContent = `${arNum(vocabulary.length)} كلمة — تعلّمت ${arNum(learned.size)} منها.`;

  const box = $('#dict-list');
  box.innerHTML = '';
  if (!rows.length) {
    box.append(el('p', 'empty-sub dict-empty', 'لا توجد نتائج مطابقة.'));
    return;
  }
  for (const w of rows) {
    const row = el('div', 'dict-row');
    const info = el('div', 'dict-info');
    const word = el('span', 'dict-word', w.word); word.dir = 'ltr'; word.lang = 'en';
    const mean = el('span', 'dict-meaning', w.meaning); mean.dir = 'rtl'; mean.lang = 'ar';
    info.append(word, mean);
    let chip;
    if (inReview.has(w.word)) chip = el('span', 'status-chip is-review', 'قيد المراجعة');
    else if (learned.has(w.word)) chip = el('span', 'status-chip is-learned', 'متعلَّمة');
    else chip = el('span', 'status-chip is-new', 'جديدة');
    row.append(info, chip);
    box.append(row);
  }
}

/* ---------- التقدم + الإنجازات ---------- */
function renderProgress() {
  const acc = accuracyPct();
  setRing($('#progress-ring'), acc || 0);
  $('#progress-pct').textContent = acc === null ? '—' : acc + '%';
  $('#p-total').textContent = arNum(state.totalQuestions);
  $('#p-correct').textContent = arNum(state.correctAnswers);
  $('#p-wrong').textContent = arNum(state.incorrectAnswers);
  $('#p-xp').textContent = arNum(state.xp);
  $('#p-level').textContent = arNum(levelInfo().level);
  $('#p-words').textContent = arNum(state.learnedWords.length);
  $('#p-mastered').textContent = arNum(state.masteredCount || 0);
  $('#p-best').textContent = arNum(state.bestStreak);

  /* آخر 7 أيام من النشاط */
  const wrap = $('#week-bars');
  wrap.innerHTML = '';
  const days = [...Array(7)].map((_, i) => daysAgo(6 - i));
  const vals = days.map(d => state.dailyLog[d] || 0);
  const max = Math.max(...vals, 1);
  days.forEach((d, i) => {
    const col = el('div', 'bar-col' + (i === 6 ? ' is-today' : ''));
    col.append(el('span', 'bar-val', vals[i] || ''));
    const track = el('div', 'bar-track');
    const bar = el('div', 'bar');
    bar.style.height = '0%';
    track.append(bar);
    col.append(track);
    col.append(el('span', 'bar-day', new Date(d + 'T12:00:00').toLocaleDateString('ar', { weekday: 'narrow' })));
    wrap.append(col);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.height = (vals[i] / max * 100) + '%';
    }));
  });

  /* سحابة الكلمات المتعلَّمة */
  const cloud = $('#word-cloud');
  cloud.innerHTML = '';
  $('#p-words-big').textContent = arNum(state.learnedWords.length);
  if (!state.learnedWords.length) {
    cloud.append(el('p', 'empty-sub', 'أجب عن الأسئلة بشكل صحيح لتجمع كلماتك هنا.'));
  } else {
    [...state.learnedWords].reverse().forEach(w => {
      const c = el('span', 'chip', w);
      c.dir = 'ltr'; c.lang = 'en';
      cloud.append(c);
    });
  }

  renderAchievements();
}

function renderAchievements() {
  const grid = $('#ach-grid');
  grid.innerHTML = '';
  let n = 0;
  for (const a of ACHIEVEMENTS) {
    const date = state.achievements[a.id];
    if (date) n++;
    const card = el('div', 'ach ' + (date ? 'is-earned' : 'is-locked'));
    const ic = el('span', 'ach-icon');
    ic.append(iconEl(date ? a.icon : 'lock'));
    card.append(ic);
    card.append(el('p', 'ach-name', a.name));
    card.append(el('p', 'ach-desc', a.desc));
    if (date) card.append(el('p', 'ach-date',
      'حقّقته ' + new Date(date + 'T12:00:00').toLocaleDateString('ar-u-nu-latn', { day: 'numeric', month: 'long' })));
    grid.append(card);
  }
  $('#p-ach-count').textContent = `${n} / ${ACHIEVEMENTS.length}`;
}

function renderSettings() {
  $$('#theme-seg .seg-btn').forEach(b => {
    const on = b.dataset.themeOpt === state.theme;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $$('#goal-seg .seg-btn').forEach(b => {
    const on = Number(b.dataset.goal) === state.dailyGoal;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#reminder-toggle').checked = state.reminderEnabled;
  updateReminderStatus();
}

/* ---------- التنبيهات ---------- */
function updateReminderStatus() {
  const s = $('#reminder-status');
  if (!('Notification' in window)) {
    s.textContent = 'متصفحك لا يدعم الإشعارات، سيظهر التنبيه داخل التطبيق عند فتحه.';
    return;
  }
  const p = Notification.permission;
  s.textContent =
    p === 'granted' ? (state.reminderEnabled
      ? 'التنبيهات مفعّلة — يصلك إشعار يومي الساعة 6:00 مساءً.'
      : 'الإذن ممنوح، فعّل التنبيه لاستخدامه.') :
      p === 'denied' ? 'الإشعارات محظورة في إعدادات المتصفح.' :
        'سنطلب إذن الإشعارات عند التفعيل.';
}

/* التنبيه داخل التطبيق — يعمل فقط طالما الصفحة مفتوحة */
function checkReminder() {
  if (!state.reminderEnabled) return;
  const now = new Date();
  if (`${pad(now.getHours())}:${pad(now.getMinutes())}` !== REMINDER_TIME) return;
  if (state.lastReminderFired === today()) return;
  state.lastReminderFired = today();
  saveState();
  const message = 'حان وقت التدرب على الإنجليزية!';
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Englify', { body: message, lang: 'ar', dir: 'rtl' });
  } else {
    toast(message);
  }
}

/* ---------- التنبيه العائم ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), 2600);
}

/* ---------- الربط ---------- */
function bindEvents() {
  $$('[data-nav]').forEach(b => b.addEventListener('click', () => onNav(b.dataset.nav)));

  /* الزر الرئيسي: متابعة الدرس المتقطع أو درس جديد */
  bind('#btn-start', 'click', () => {
    if (state.savedLesson) resumeLesson();
    else startNormalLesson();
  });
  bind('#btn-fresh-start', 'click', () => {
    state.savedLesson = null;
    saveState();
    startNormalLesson();
  });

  /* زر المراجعة: يبدأ الدرس مباشرة عند وجود كلمات مستحقة، وإلا يعرض القائمة */
  bind('#btn-home-review', 'click', () => {
    if (dueMistakes().length) startReviewLesson();
    else navigate('review');
  });

  /* الدرس */
  bind('#btn-exit', 'click', () => {
    if (lesson.active) { state.savedLesson = null; saveState(); } // خروج مقصود = إلغاء الجلسة
    navigate('home');
  });
  bind('#btn-continue', 'click', () => {
    if (!lesson.active || !lesson.answered) return;
    lesson.index++;
    if (lesson.index >= lesson.items.length) showSummary();
    else renderQuestion();
  });
  bind('#btn-summary-continue', 'click', startNormalLesson);
  bind('#btn-summary-review', 'click', () => navigate('review'));
  bind('#btn-summary-home', 'click', () => navigate('home'));

  /* القاموس */
  bind('#dict-search', 'input', e => { dictQuery = e.target.value; renderDictionary(); });
  bind('#dict-filter', 'click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    dictFilter = b.dataset.filter;
    renderDictionary();
  });

  /* الإعدادات */
  bind('#theme-seg', 'click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.theme = b.dataset.themeOpt;
    saveState();
    applyTheme();
    renderSettings();
    toast(state.theme === 'system' ? 'المظهر يتبع النظام'
      : state.theme === 'light' ? 'تم تفعيل المظهر الفاتح'
        : 'تم تفعيل المظهر الداكن');
  });
  bind('#goal-seg', 'click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.dailyGoal = Number(b.dataset.goal);
    saveState();
    renderSettings();
    renderHome();
    toast('تم تحديث الهدف اليومي');
  });
  bind('#reminder-toggle', 'change', e => {
    state.reminderEnabled = e.target.checked;
    state.lastReminderFired = null;
    saveState();
    if (state.reminderEnabled) {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(updateReminderStatus);
      }
      enablePushReminder();
      toast('تم حفظ التنبيه');
    }
    renderSettings();
  });

  bind('#install-card', 'click', (() => {
    let taps = 0, timer;
    return () => {
      if (!INSTALL_DEBUG) return;
      clearTimeout(timer);
      timer = setTimeout(() => taps = 0, 1500);
      if (++taps >= 5) {
        state.installDismissed = false;
        saveState();
        updateInstallUI();
        toast('أُعيد ضبط حالة التثبيت');
      }
    };
  })());

  /* إعادة التعيين على خطوتين */
  const resetBtn = $('#btn-reset');
  let armed = false, armTimer;
  const disarm = () => {
    armed = false;
    resetBtn.classList.remove('is-armed');
    resetBtn.textContent = 'إعادة تعيين كل التقدم';
  };
  bind('#btn-reset', 'click', () => {
    if (!armed) {
      armed = true;
      resetBtn.classList.add('is-armed');
      resetBtn.textContent = 'اضغط مرة أخرى للتأكيد';
      armTimer = setTimeout(disarm, 4000);
    } else {
      clearTimeout(armTimer);
      const keep = { reminderEnabled: state.reminderEnabled, theme: state.theme };
      state = { ...DEFAULTS, dailyDate: today(), ...keep };
      saveState();
      disarm();
      updateStreakChips();
      renderSettings();
      renderHome();
      toast('تمت إعادة تعيين التقدم');
    }
  });

  /* لوحة المفاتيح: 1-4 للإجابة، Enter للمتابعة */
  document.addEventListener('keydown', e => {
    if (currentScreen !== 'learn' || !lesson.active) return;
    if (lesson.answered) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btn-continue').click(); }
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      const b = $$('#answers .answer')[n - 1];
      if (b && !b.disabled) b.click();
    }
  });

  /* التثبيت */
  bind('#btn-install', 'click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice; // appinstalled يكمل الباقي
    deferredInstall = null;
    updateInstallUI();
  });
  bind('#install-close', 'click', e => {
    e.stopPropagation();
    state.installDismissed = true;
    saveState();
    $('#install-banner').hidden = true;
  });
  bind('#install-banner', 'click', () => {
    if (deferredInstall) $('#btn-install')?.click();
    else navigate('settings');
  });
}

/* ---------- التشغيل ---------- */
async function init() {
  hydrateIcons();
  bindEvents();
  migrate();
  rollDaily();
  pruneDailyLog();
  refreshStreak();
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme();
  });
  renderHome();
  renderSettings();
  syncPushTag();
  await loadVocabulary();
  renderHome(); // تحديث الواجهة بعد معرفة حالة تحميل المفردات
  setInterval(() => { rollDaily(); checkReminder(); }, 30000);
}

init();