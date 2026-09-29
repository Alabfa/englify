'use strict';

/* ============================================================
   Englify — منطق التطبيق
   تُحمَّل المفردات من words.json، وتُخزَّن بيانات المستخدم
   في localStorage تحت مفتاح واحد. بدون أُطر عمل أو خادم.
   إشعارات الهاتف (Push) تُدار عبر OneSignal + GitHub Actions.
   ============================================================ */

/* ---------- الإعدادات ---------- */
const STORAGE_KEY = 'kalima-state-v1'; // تُرك كما هو للحفاظ على بيانات المستخدمين الحاليين
const LESSON_LENGTH = 10;
const XP_PER_CORRECT = 10;

const REMINDER_TIME = '18:00'; // 6:00 مساءً — ثابت لجميع المستخدمين

const ONESIGNAL_APP_ID = 'e39e7961-871c-4d5f-bb8f-15bcfefc952b';

/* ---------- أدوات صغيرة ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* صيغ العدد العربية: واحد / اثنان / جمع قلة (3-10) / جمع كثرة (11+) */
function countAr(n, forms) {
  if (n === 1) return forms[0];
  if (n === 2) return forms[1];
  if (n >= 3 && n <= 10) return `${n} ${forms[2]}`;
  return `${n} ${forms[3]}`;
}

/* ---------- التواريخ ---------- */
const pad = n => String(n).padStart(2, '0');
const dayStamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayStamp(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayStamp(d); };

/* ---------- الحالة المحفوظة ---------- */
const DEFAULTS = {
  streak: 0, bestStreak: 0, lastLessonDate: null,
  xp: 0,
  dailyProgress: 0, dailyDate: today(), dailyGoal: 10,
  totalQuestions: 0, correctAnswers: 0, incorrectAnswers: 0,
  learnedWords: [], mistakes: [], dailyLog: {},
  reminderEnabled: false, lastReminderFired: null,
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

/* تصفير العدادات اليومية عند تغيّر اليوم */
function rollDaily() {
  if (state.dailyDate !== today()) {
    state.dailyDate = today();
    state.dailyProgress = 0;
    saveState();
  }
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
    /* حُسبت اليوم بالفعل — تبقى كما هي */
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
}

/* ---------- الأيقونات (SVG مضمّن، تُحقن مرة واحدة) ---------- */
const ICONS = {
  home: '<path d="M3 11.3 12 3l9 8.3"/><path d="M5.5 10v10.5h13V10"/><path d="M10 20.5v-6h4v6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5z"/><path d="M20 18.5H6.5A2.5 2.5 0 0 0 4 21"/>',
  repeat: '<path d="m17 2.5 4 4-4 4"/><path d="M21 6.5H8a5 5 0 0 0-5 5v1"/><path d="m7 21.5-4-4 4-4"/><path d="M3 17.5h13a5 5 0 0 0 5-5v-1"/>',
  chart: '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V6"/><path d="M17 20v-9"/>',
  sliders: '<path d="M4 7h8"/><circle cx="15.5" cy="7" r="2.2"/><path d="M4 17h3"/><circle cx="10.5" cy="17" r="2.2"/><path d="M14 17h6"/>',
  flame: '<path class="flame-outer" stroke="none" d="M12 2.4c.7 3-.8 4.8-2.1 6.4C8.5 10.5 7 12.4 7 14.7 7 18.2 9.2 20.7 12 20.7s5-2.5 5-6c0-1.6-.6-3-1.4-4.2-.5 1.2-1.4 2.1-2.6 2.5 1-2.6.4-5.4-1-7.5-.6-.9-1.2-1.9-1-3.1z"/><path class="flame-core" stroke="none" d="M12 20.7c-1.8 0-3.1-1.5-3.1-3.4 0-1.4.8-2.5 1.7-3.6.6-.8 1.1-1.6 1.4-2.7 1 1.6 3.1 3 3.1 6.3 0 1.9-1.3 3.4-3.1 3.4z"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="M4.5 12.8 9.6 18 19.5 6.8"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5v14l11-7z"/>',
  zap: '<path fill="currentColor" stroke="none" d="M13 2 3 14h7l-1 8 11-14h-7z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
  bell: '<path d="M18 9.5a6 6 0 1 0-12 0c0 5.5-2 7-2 7h16s-2-1.5-2-7"/><path d="M10.3 20.5a2 2 0 0 0 3.4 0"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
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

/* ---------- Push عبر OneSignal ---------- */
window.OneSignalDeferred = window.OneSignalDeferred || [];

const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

function pushConfigured() {
  return ONESIGNAL_APP_ID && !ONESIGNAL_APP_ID.startsWith('YOUR_');
}

/* تُستدعى عند تفعيل المستخدم للتنبيه — تطلب الإذن وتسجّل وسم الاشتراك */
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

/* تُستدعى عند كل فتح — تعيد مزامنة الوسم إذا كان التنبيه مفعّلاً */
function syncPushTag() {
  if (!pushConfigured() || !state.reminderEnabled) return;
  OneSignalDeferred.push(async OneSignal => {
    try {
      await OneSignal.init({ appId: ONESIGNAL_APP_ID });
      OneSignal.User.addTag('push', 'on');
    } catch { /* تجاهل */ }
  });
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

/* ---------- محرك الدرس ---------- */
const lesson = { active: false, items: [], index: 0, correct: 0, answered: false, kind: 'normal' };

function startNormalLesson() {
  if (!vocabulary.length) {
    toast('تعذّر تحميل words.json — راجع الملاحظة في الصفحة الرئيسية');
    return;
  }
  const items = [];
  let bag = [];
  while (items.length < LESSON_LENGTH) {
    if (!bag.length) bag = shuffle(vocabulary); // إعادة الملء فقط إذا كانت المفردات أقل من 10
    items.push(buildQuestion(bag.pop()));
  }
  startLesson(items, 'normal');
}

function startLesson(items, kind) {
  Object.assign(lesson, { active: true, items, index: 0, correct: 0, answered: false, kind });
  $('#summary-view').hidden = true;
  $('#quiz-view').hidden = false;
  navigate('learn');
  renderQuestion();
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

  if (correct) {
    lesson.correct++;
    state.correctAnswers++;
    state.xp += XP_PER_CORRECT;
    if (!state.learnedWords.includes(q.word)) state.learnedWords.push(q.word);
    if (lesson.kind === 'review') reduceMistake(q.word);
    spawnXpFloat();
  } else {
    state.incorrectAnswers++;
    addMistake(q.word, q.meaning);
  }
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
    sub.textContent = lesson.kind === 'review'
      ? 'خطأ واحد أقل في قائمتك.'
      : `+${XP_PER_CORRECT} نقاط خبرة`;
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

function addMistake(word, meaning) {
  const found = state.mistakes.find(m => m.word === word);
  if (found) found.count++;
  else state.mistakes.push({ word, meaning, count: 1 });
}

function reduceMistake(word) {
  const found = state.mistakes.find(m => m.word === word);
  if (!found) return;
  found.count--;
  if (found.count <= 0) state.mistakes = state.mistakes.filter(m => m.word !== word);
}

/* ---------- ملخص الدرس ---------- */
function showSummary() {
  lesson.active = false;
  completeStreakDay();
  saveState();

  const total = lesson.items.length;
  const pct = Math.round((lesson.correct / total) * 100);

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
  document.body.dataset.heat = heatTier();   // ← السطر الجديد
  $('#topbar-streak-num').textContent = state.streak;
  $('#sidebar-streak').textContent = state.streak;
  $('#sidebar-xp').textContent = state.xp;
  $('#home-streak').textContent = state.streak;
}

function heatTier() {
  const s = state.streak;
  return s === 0 ? 'cold' : s < 7 ? 'lit' : s < 30 ? 'blaze' : 'inferno';
}

function accuracyPct() {
  return state.totalQuestions ? Math.round(state.correctAnswers / state.totalQuestions * 100) : null;
}

function renderHome() {
  rollDaily();
  const h = new Date().getHours();
  $('#home-greeting').textContent = h < 12 ? 'صباح الخير' : 'مساء الخير';

  $('#goal-count').textContent = `${state.dailyProgress} / ${state.dailyGoal} سؤال`;
  const fill = $('#goal-fill');
  fill.style.width = Math.min(100, state.dailyProgress / state.dailyGoal * 100) + '%';
  fill.classList.toggle('is-done', state.dailyProgress >= state.dailyGoal);
  const remaining = Math.max(0, state.dailyGoal - state.dailyProgress);
  $('#goal-status').textContent = remaining === 0
    ? 'أحسنت! حققت هدف اليوم.'
    : `تبقّى ${countAr(remaining, ['سؤال واحد', 'سؤالان', 'أسئلة', 'سؤالاً'])}`;

  const acc = accuracyPct();
  $('#stat-xp').textContent = state.xp;
  $('#stat-words').textContent = state.learnedWords.length;
  $('#stat-accuracy').textContent = acc === null ? '—' : acc + '%';

  const mc = state.mistakes.length;
  const pill = $('#home-mistake-count');
  pill.hidden = mc === 0;
  pill.textContent = mc;
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

  const head = el('div', 'review-head');
  const all = el('button', 'btn btn-primary');
  all.type = 'button';
  all.append(iconEl('play'), el('span', null, `تدرّب على الكل (${Math.min(state.mistakes.length, LESSON_LENGTH)})`));
  all.addEventListener('click', () => {
    const items = shuffle(state.mistakes).slice(0, LESSON_LENGTH)
      .map(m => vocabMap.get(m.word))
      .filter(Boolean)
      .map(w => buildQuestion(w));
    if (!items.length) return toast('هذه الكلمات لم تعد موجودة في words.json');
    startLesson(items, 'review');
  });
  head.append(all);
  if (state.mistakes.length > LESSON_LENGTH) {
    head.append(el('p', 'review-note', `لديك ${state.mistakes.length} كلمة محفوظة — تُدرَّب على ${LESSON_LENGTH} في كل مرة.`));
  }
  box.append(head);

  const list = el('div', 'mistake-list');
  [...state.mistakes].sort((a, b) => b.count - a.count).forEach(m => {
    const row = el('div', 'mistake-row');
    const info = el('div', 'mistake-info');
    const w = el('div', 'mistake-word', m.word); w.dir = 'ltr'; w.lang = 'en';
    const mean = el('div', 'mistake-meaning', m.meaning); mean.dir = 'rtl'; mean.lang = 'ar';
    info.append(w, mean);
    const badge = el('span', 'mistake-count', `×${m.count}`);
    badge.title = `عدد الأخطاء: ${m.count}`;
    const one = el('button', 'btn btn-ghost btn-sm', 'تدرّب');
    one.type = 'button';
    one.addEventListener('click', () => {
      const v = vocabMap.get(m.word);
      if (!v) return toast('هذه الكلمة لم تعد موجودة في words.json');
      startLesson([buildQuestion(v, 'en2ar'), buildQuestion(v, 'ar2en')], 'review');
    });
    row.append(info, badge, one);
    list.append(row);
  });
  box.append(list);
}

function renderProgress() {
  const acc = accuracyPct();
  setRing($('#progress-ring'), acc || 0);
  $('#progress-pct').textContent = acc === null ? '—' : acc + '%';
  $('#p-total').textContent = state.totalQuestions;
  $('#p-correct').textContent = state.correctAnswers;
  $('#p-wrong').textContent = state.incorrectAnswers;
  $('#p-xp').textContent = state.xp;
  $('#p-words').textContent = state.learnedWords.length;
  $('#p-best').textContent = state.bestStreak;

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
  $('#p-words-big').textContent = state.learnedWords.length;
  if (!state.learnedWords.length) {
    cloud.append(el('p', 'empty-sub', 'أجب عن الأسئلة بشكل صحيح لتجمع كلماتك هنا.'));
  } else {
    [...state.learnedWords].reverse().forEach(w => {
      const c = el('span', 'chip', w);
      c.dir = 'ltr'; c.lang = 'en';
      cloud.append(c);
    });
  }
}

function renderSettings() {
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

  $('#btn-start').addEventListener('click', startNormalLesson);
  $('#btn-home-review').addEventListener('click', () => navigate('review'));
  $('#btn-exit').addEventListener('click', () => navigate('home'));
  $('#btn-continue').addEventListener('click', () => {
    if (!lesson.active || !lesson.answered) return;
    lesson.index++;
    if (lesson.index >= lesson.items.length) showSummary();
    else renderQuestion();
  });
  $('#btn-summary-continue').addEventListener('click', startNormalLesson);
  $('#btn-summary-review').addEventListener('click', () => navigate('review'));
  $('#btn-summary-home').addEventListener('click', () => navigate('home'));

  /* الإعدادات */
  $('#goal-seg').addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.dailyGoal = Number(b.dataset.goal);
    saveState();
    renderSettings();
    renderHome();
  });
  $('#reminder-toggle').addEventListener('change', e => {
    state.reminderEnabled = e.target.checked;
    state.lastReminderFired = null; // السماح بتنبيه جديد اليوم
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

  /* إعادة التعيين على خطوتين — بدون نوافذ confirm */
  const resetBtn = $('#btn-reset');
  let armed = false, armTimer;
  const disarm = () => {
    armed = false;
    resetBtn.classList.remove('is-armed');
    resetBtn.textContent = 'إعادة تعيين كل التقدم';
  };
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetBtn.classList.add('is-armed');
      resetBtn.textContent = 'اضغط مرة أخرى للتأكيد';
      armTimer = setTimeout(disarm, 4000);
    } else {
      clearTimeout(armTimer);
      const keep = { reminderEnabled: state.reminderEnabled };
      state = { ...DEFAULTS, dailyDate: today(), ...keep };
      saveState();
      disarm();
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
}

/* ---------- التشغيل ---------- */
async function init() {
  hydrateIcons();
  bindEvents();
  rollDaily();
  refreshStreak();
  renderHome();
  renderSettings();
  syncPushTag();
  await loadVocabulary();
  renderHome(); // تحديث شارة الأخطاء بعد معرفة حالة البيانات
  setInterval(() => { rollDaily(); checkReminder(); }, 30000);
}

init();