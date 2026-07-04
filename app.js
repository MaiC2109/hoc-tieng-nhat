'use strict';
console.log = function() {};
// 1. Khởi tạo trạng thái ứng dụng
const state = {
  activeUnit: null,
  activeAccordion: {},
  activeSubTab: {},
  quizState: {},
  flashcardState: {},
  currentAudio: null,
  reviewFlashcardState: null, // trạng thái riêng cho phiên Ôn tập (Spaced Repetition)

  // ============================================================
  //  GRAMMAR MODULE STATE (Ngữ pháp)
  // ============================================================
  grammar: {
    points: [],              // toàn bộ grammar_points (đã sort theo week/day từ query)
    slidesByPoint: {},       // { [grammar_point_id]: [slide, ...] } đã sort theo slide_order
    examplesByPoint: {},     // { [grammar_point_id]: [example, ...] }
    progressByPoint: {},     // { [grammar_point_id]: true/false } — is_learned
    loaded: false,           // đã fetch dữ liệu lần đầu chưa (lazy-load khi vào tab)
    searchTerm: '',          // từ khóa search hiện tại (live filter, không gọi lại API)
    view: 'list',            // 'list' | 'detail'
    activeId: null,          // grammar_point_id đang xem ở trang chi tiết
    carouselIndex: 0         // vị trí slide ảnh hiện tại trong carousel trang chi tiết
  }
};

// ============================================================
//  SPACED REPETITION MODULE (SM-2 rút gọn, lưu localStorage)
//  Key lưu: 'sr_vocab' -> { [wordId]: { interval, reps, dueDate } }
// ============================================================
const SR_STORAGE_KEY = 'sr_vocab';
const SR_STEPS_DAYS = [1, 3, 7]; // 3 lần ôn đầu cố định, sau đó nhân hệ số
const SR_GROWTH_FACTOR = 2.2;

function _srToday() {
  return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

function _srGetAll() {
  try {
    return JSON.parse(localStorage.getItem(SR_STORAGE_KEY) || '{}');
  } catch (e) {
    console.error('Lỗi đọc sr_vocab:', e);
    return {};
  }
}

function _srSaveAll(data) {
  localStorage.setItem(SR_STORAGE_KEY, JSON.stringify(data));
}

// Đánh dấu một danh sách từ (vd: cả 1 Part) là "đã học lần đầu",
// chỉ áp dụng cho những từ CHƯA có trong sr_vocab — không ghi đè từ đã có lịch sử ôn.
function srMarkWordsAsLearned(words) {
  const data = _srGetAll();
  let changed = false;
  words.forEach(w => {
    const id = String(w.id);
    if (!data[id]) {
      const due = new Date();
      due.setDate(due.getDate() + SR_STEPS_DAYS[0]); // ôn lại sau 1 ngày
      data[id] = { interval: SR_STEPS_DAYS[0], reps: 0, dueDate: due.toISOString().split('T')[0] };
      changed = true;
    }
  });
  if (changed) _srSaveAll(data);
}

// Cập nhật trạng thái ôn tập của 1 từ sau khi học viên trả lời (Đã thuộc / Chưa thuộc)
function srUpdateWordState(wordId, isCorrect) {
  const data = _srGetAll();
  const id = String(wordId);
  const st = data[id] || { interval: 0, reps: 0 };

  if (isCorrect) {
    const nextIndex = st.reps + 1;
    st.interval = nextIndex < SR_STEPS_DAYS.length
      ? SR_STEPS_DAYS[nextIndex]
      : Math.round(st.interval * SR_GROWTH_FACTOR);
    st.reps += 1;
  } else {
    st.interval = 1;
    st.reps = Math.max(0, st.reps - 1);
  }

  const due = new Date();
  due.setDate(due.getDate() + st.interval);
  st.dueDate = due.toISOString().split('T')[0];

  data[id] = st;
  _srSaveAll(data);
}

// Lấy danh sách từ đến hạn ôn hôm nay, từ toàn bộ vocabularyData đã load
function srGetDueWords() {
  if (typeof window.vocabularyData === 'undefined') return [];
  const data = _srGetAll();
  const today = _srToday();

  return window.vocabularyData.filter(w => {
    const st = data[String(w.id)];
    if (!st || !st.dueDate) return false;
    return st.dueDate <= today;
  });
}

function srCountDueWords() {
  return srGetDueWords().length;
}

// ============================================================
//  DEVICE LOGGING
// ============================================================
function logDeviceVisit() {
  try {
    const ua = navigator.userAgent || '';
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const deviceType = isMobile ? 'mobile' : 'desktop';

    const payload = {
      deviceType,
      platform: navigator.platform || '',
      screenWidth: window.screen ? window.screen.width : null,
      timestamp: new Date().toISOString()
    };

    const log = JSON.parse(localStorage.getItem('device_log') || '[]');
    log.push(payload);
    if (log.length > 50) log.shift();
    localStorage.setItem('device_log', JSON.stringify(log));

    if (STUDENT_CONFIG.deviceLogUrl) {
      fetch(STUDENT_CONFIG.deviceLogUrl, {
        method: 'POST',
        headers: {
          'apikey': STUDENT_CONFIG.supabaseAnonKey,
          'Authorization': `Bearer ${STUDENT_CONFIG.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          device_type: payload.deviceType,
          platform: payload.platform,
          screen_width: payload.screenWidth,
          visited_at: payload.timestamp
        })
      }).catch(() => {});
    }
  } catch (e) {
    console.error('Lỗi log thiết bị:', e);
  }
}

// 2. Cấu hình — tập trung toàn bộ thông tin kết nối tại đây
const STUDENT_CONFIG = {
  // Supabase
  supabaseUrl: "https://zlblylqosqwnhudeivpt.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsYmx5bHFvc3F3bmh1ZGVpdnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mzk0NjUsImV4cCI6MjA5ODExNTQ2NX0.Xa8FblRuypm_eHMGz8GrCpwloKnzjgjTu8z_1ivS8_4",
  vocabUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/vocabulary?order=id.asc",
  deviceLogUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/device_logs",
  googleScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec",

  // ── GRAMMAR MODULE (Ngữ pháp) ──
  // Tên cột Supabase: grammar_points(id, jlpt_level, title, meaning_short, meaning_long,
  //   structure, week_number, day_number, related_grammar_id, related_note, is_active, created_at)
  // meaning_long: giải thích chi tiết + nuance, CHỈ hiển thị ở trang chi tiết (không hiện ở list).
  grammarPointsUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/grammar_points?is_active=eq.true&order=week_number.asc,day_number.asc,id.asc",
  // grammar_point_slides(id, grammar_point_id, slide_order, image_url)
  grammarSlidesUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/grammar_point_slides?order=slide_order.asc",
  // grammar_examples(id, grammar_point_id, example_jp, example_vn) — không còn audio cho ví dụ
  grammarExamplesUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/grammar_examples",
  // user_grammar_progress(id, user_id, grammar_point_id, is_learned, learned_at)
  grammarProgressUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/user_grammar_progress",
  // ID học viên tạm thời (chưa có hệ thống đăng nhập) — dùng để lưu tiến độ "Đã học".
  // Khi có bảng users/auth thật, thay giá trị này bằng user id thật của học viên.
  studentId: "default_student"
};

// 3. Nạp dữ liệu từ Supabase
async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang tải dữ liệu...';

  const cachedData = localStorage.getItem('vocab_cache');
  const cacheTime  = localStorage.getItem('vocab_cache_time');
  const ONE_HOUR   = 3600000;

  if (cachedData && cacheTime && (Date.now() - parseInt(cacheTime) < ONE_HOUR)) {
    window.vocabularyData = JSON.parse(cachedData);
    startUI();
    return;
  }

  try {
    const response = await fetch(STUDENT_CONFIG.vocabUrl, {
      headers: {
        'apikey':        STUDENT_CONFIG.supabaseAnonKey,
        'Authorization': `Bearer ${STUDENT_CONFIG.supabaseAnonKey}`,
        'Content-Type':  'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Supabase trả về lỗi: ${response.status} ${response.statusText}`);
    }

    const rows = await response.json();
    window.vocabularyData = rows.filter(item => item.id);

    localStorage.setItem('vocab_cache', JSON.stringify(window.vocabularyData));
    localStorage.setItem('vocab_cache_time', Date.now().toString());

    startUI();
  } catch (err) {
    console.error("Lỗi tải:", err);
    if (cachedData) {
      window.vocabularyData = JSON.parse(cachedData);
      startUI();
      if (progressEl) progressEl.textContent = '⚠️ Dùng dữ liệu cũ (offline)';
    } else {
      if (progressEl) progressEl.textContent = '❌ Lỗi kết nối!';
    }
  }
}

// ============================================================
//  DEBUG PANEL — công cụ test Spaced Repetition NGAY TRONG APP
// ============================================================
function isDebugMode() {
  return new URLSearchParams(window.location.search).get('debug') === 'sr';
}

function renderDebugPanel() {
  if (!isDebugMode()) return;

  const panel = document.createElement('div');
  panel.id = 'sr-debug-panel';
  panel.style.cssText = `
    position: fixed; bottom: 16px; right: 16px; z-index: 9999;
    background: var(--paper-card, #fff); border: 1px solid var(--line, #ddd);
    border-radius: 12px; padding: 14px; width: 280px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15); font-family: var(--font-ui, sans-serif);
    font-size: 12.5px; color: var(--ink, #222); max-height: 80vh; overflow-y: auto;
  `;
  panel.innerHTML = `
    <div style="font-weight:700; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      🧪 SR Debug Panel
      <button onclick="document.getElementById('sr-debug-panel').remove()" style="border:none;background:none;cursor:pointer;font-size:14px;">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:6px;">
      <button class="sr-debug-btn" onclick="srDebugForceAllDueToday()">⏩ Ép tất cả từ về "đến hạn hôm nay"</button>
      <button class="sr-debug-btn" onclick="srDebugSimulateDaysPassed()">📅 Giả lập trôi qua N ngày</button>
      <button class="sr-debug-btn" onclick="srDebugRunFullTest()">🧪 Chạy bộ test đầy đủ (xem Console)</button>
      <button class="sr-debug-btn" onclick="srDebugInspect()">🔍 Xem dữ liệu sr_vocab hiện tại</button>
      <button class="sr-debug-btn" style="color:#c0392b;" onclick="srDebugClearAll()">🗑️ Xóa toàn bộ sr_vocab (reset sạch)</button>
    </div>
    <div id="sr-debug-output" style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--line,#ddd); white-space:pre-wrap; max-height:240px; overflow-y:auto; font-family:monospace; font-size:11px;"></div>
  `;
  document.body.appendChild(panel);

  const style = document.createElement('style');
  style.textContent = `
    .sr-debug-btn {
      padding: 7px 10px; border-radius: 7px; border: 1px solid var(--line, #ddd);
      background: var(--paper-soft, #f7f7f5); cursor: pointer; text-align: left; font-size: 12px;
    }
    .sr-debug-btn:hover { background: var(--paper-card, #fff); }
  `;
  document.head.appendChild(style);
}

function _srDebugLog(msg) {
  const out = document.getElementById('sr-debug-output');
  if (out) out.textContent = msg;
  console.log(msg);
}

function srDebugForceAllDueToday() {
  const data = _srGetAll();
  const today = _srToday();
  const count = Object.keys(data).length;
  Object.keys(data).forEach(id => { data[id].dueDate = today; });
  _srSaveAll(data);
  updateReviewBadge();
  _srDebugLog(`✅ Đã ép ${count} từ về dueDate = ${today}.\nBấm "Ôn tập hôm nay" trên nav để kiểm tra.`);
}

function srDebugSimulateDaysPassed() {
  const n = parseInt(prompt('Giả lập đã trôi qua bao nhiêu ngày?', '7'), 10);
  if (isNaN(n)) return;
  const data = _srGetAll();
  Object.keys(data).forEach(id => {
    const d = new Date(data[id].dueDate);
    d.setDate(d.getDate() - n);
    data[id].dueDate = d.toISOString().split('T')[0];
  });
  _srSaveAll(data);
  updateReviewBadge();
  _srDebugLog(`✅ Đã đẩy lùi dueDate của toàn bộ từ về sớm hơn ${n} ngày.\nSố từ đến hạn ngay bây giờ: ${srCountDueWords()}`);
}

function srDebugRunFullTest() {
  if (typeof srRunFullTestSuite !== 'function') {
    _srDebugLog('⚠️ Chưa nạp bộ test đầy đủ. Hãy chắc rằng file sr_test_script.js đã được include, hoặc dùng 3 nút còn lại để test nhanh.');
    return;
  }
  _srDebugLog('🧪 Đang chạy... xem chi tiết trong tab Console (F12).');
  srRunFullTestSuite();
}

function srDebugInspect() {
  const data = _srGetAll();
  const today = _srToday();
  const lines = Object.entries(data).map(([id, st]) => {
    const isDue = st.dueDate <= today ? '🔴 ĐẾN HẠN' : '⚪ chưa';
    return `${id}: interval=${st.interval} reps=${st.reps} due=${st.dueDate} ${isDue}`;
  });
  _srDebugLog(lines.length ? lines.join('\n') : '(chưa có từ nào trong sr_vocab)');
}

function srDebugClearAll() {
  if (!confirm('Xóa toàn bộ dữ liệu Spaced Repetition? (chỉ ảnh hưởng máy/trình duyệt này)')) return;
  localStorage.removeItem(SR_STORAGE_KEY);
  updateReviewBadge();
  _srDebugLog('🗑️ Đã xóa sạch sr_vocab.');
}

function startUI() {
  const units = getUnits();
  if (units.length > 0) {
    state.activeUnit = units[0];
    renderUnitTabs(units);
    renderUnitContent();
    updateGlobalProgress();
    updateReviewBadge();
    switchMainSection('vocab');
    renderDebugPanel();
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  logDeviceVisit();
  initApp();
});

function switchMainSection(sectionId) {
  document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.main-nav-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('section-' + sectionId);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.main-nav-btn').forEach(b => {
    if (b.dataset.section === sectionId) b.classList.add('active');
  });
}

function s(v) { return (v !== undefined && v !== null && v !== '') ? String(v) : '—'; }

function escAttr(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function escId(str) {
  return encodeURIComponent(str).replace(/%/g, '_');
}

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _digits(str) {
  const m = String(str || '').match(/\d+/);
  return m ? m[0] : '0';
}

function getFrontCardDisplay(word) {
  const hasKanji = word.kanji && word.kanji !== '—';
  if (hasKanji) {
    return `<div class="card-kanji">${word.kanji}</div>`;
  }
  return `<div class="card-kanji">${s(word.kana)}</div>`;
}

function buildAudioPath(wordObj) {
  if (wordObj.audio) return `audio/${wordObj.audio}`;
  const u = _digits(wordObj.unit);
  const p = _digits(wordObj.part);
  return `audio/u${u}_p${p}_word-${wordObj.id}.mp3`;
}

function getUnits() {
  if (typeof window.vocabularyData === 'undefined') return [];
  const units = [...new Set(window.vocabularyData.map(w => w.unit))];
  return units
    .filter(u => u && u !== "unit" && u !== "Unit")
    .sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'}));
}

function getPartsForUnit(unitName) {
  if (typeof vocabularyData === 'undefined') return [];
  const filtered = vocabularyData.filter(w => w.unit === unitName);
  const parts = [...new Set(filtered.map(w => w.part))];
  return parts.sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'}));
}

function getWords(unitName, partName) {
  return vocabularyData.filter(w => w.unit === unitName && w.part === partName);
}

function renderUnitTabs(units) {
  const bar = document.getElementById('unit-tabs-bar');
  if (!bar) return;

  bar.innerHTML = units.map(u => {
    const totalWords = vocabularyData.filter(w => w.unit === u).length;
    const activeClass = (u === state.activeUnit) ? 'active' : '';
    return `
      <button class="unit-tab ${activeClass}" onclick="selectUnit('${escAttr(u)}')">
        ${u} <span class="unit-word-count">${totalWords}</span>
      </button>
    `;
  }).join('');
}

function selectUnit(unitName) {
  stopAllAudio();
  state.activeUnit = unitName;
  renderUnitTabs(getUnits());
  renderUnitContent();
}

function toggleAccordion(unit, part) {
  const partKey = `${unit}_${part}`;
  const el = document.getElementById(`acc-item-${escAttr(partKey)}`);
  if (!el) return;

  if (el.classList.contains('open')) {
    el.classList.remove('open');
    stopAllAudio();
    if (state.activeAccordion[unit] === part) {
      state.activeAccordion[unit] = null;
    }
  } else {
    if (state.activeAccordion[unit]) {
      const prev = document.getElementById(`acc-item-${escId(unit)}_${escId(state.activeAccordion[unit])}`);
      if (prev) prev.classList.remove('open');
    }

    el.classList.add('open');
    state.activeAccordion[unit] = part;

    const curTab = state.activeSubTab[partKey] || 'study';
    buildWorkspacePanels(partKey, curTab);
  }
}

function renderUnitContent() {
  const wrap = document.getElementById('unit-content-wrap');
  if (!wrap) return;

  const unit = state.activeUnit;
  const parts = getPartsForUnit(unit);

  if (parts.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No data available for this Unit.</div>`;
    return;
  }

  let html = `<div class="parts-container">`;

  parts.forEach((p, idx) => {
    const partKey = `${unit}_${p}`;
    const isOpen = (state.activeAccordion[unit] === p);

    const savedScore = localStorage.getItem(`quiz_${partKey}`);
    let badgeHtml = `<div class="progress-badge not-started">Not Started</div>`;
    let fillWidth = '0%';
    let partialClass = '';

    if (savedScore !== null) {
      const [score, total] = savedScore.split('/').map(Number);
      if (total > 0) {
        fillWidth = `${(score / total) * 100}%`;
        if (score === total) {
          badgeHtml = `<div class="progress-badge complete">✓ Passed (${score}/${total})</div>`;
        } else {
          badgeHtml = `<div class="progress-badge in-progress">${score}/${total}</div>`;
          partialClass = 'partial';
        }
      }
    }

    const curTab = state.activeSubTab[partKey] || 'study';

    html += `
      <div class="accordion-item ${isOpen ? 'open' : ''}" id="acc-item-${escAttr(partKey)}">
        <button class="accordion-header" onclick="toggleAccordion('${escAttr(unit)}', '${escAttr(p)}')">
          <span class="accordion-chevron">▶</span>
          <span class="accordion-part-label">${p}</span>
          <div class="accordion-meta">
            ${badgeHtml}
            <div class="progress-bar-mini">
              <div class="progress-bar-mini-fill ${partialClass}" style="width: ${fillWidth}"></div>
            </div>
          </div>
        </button>
        <div class="accordion-body">
          <div class="workspace">
            <div class="sub-tabs-bar">
              <button class="sub-tab ${curTab === 'study' ? 'active' : ''}" id="tab-btn-${partKey}-study" onclick="switchSubTab('${escAttr(partKey)}', 'study')"><span class="tab-icon">📖</span> Study & Listen</button>
              <button class="sub-tab ${curTab === 'card' ? 'active' : ''}" id="tab-btn-${partKey}-card" onclick="switchSubTab('${escAttr(partKey)}', 'card')"><span class="tab-icon">🎴</span> Flashcard</button>
              <button class="sub-tab ${curTab === 'quiz' ? 'active' : ''}" id="tab-btn-${partKey}-quiz" onclick="switchSubTab('${escAttr(partKey)}', 'quiz')"><span class="tab-icon">📝</span> Quiz</button>
            </div>
            <div class="sub-tabs-panels" id="panels-${escAttr(partKey)}">
            </div>
          </div>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  wrap.innerHTML = html;

  parts.forEach((p, idx) => {
    const partKey = `${unit}_${p}`;
    const isOpen = (state.activeAccordion[unit] === p);
    if (isOpen) {
      const curTab = state.activeSubTab[partKey] || 'study';
      buildWorkspacePanels(partKey, curTab);
    }
  });
}

function switchSubTab(partKey, tabName) {
  stopAllAudio();
  state.activeSubTab[partKey] = tabName;

  const container = document.getElementById(`panels-${partKey}`);
  if (!container) return;

  [`study`, `card`, `quiz`].forEach(t => {
    const btn = document.getElementById(`tab-btn-${partKey}-${t}`);
    if (btn) btn.classList.toggle('active', t === tabName);
  });

  buildWorkspacePanels(partKey, tabName);
}

function buildWorkspacePanels(partKey, activeTab) {
  const container = document.getElementById(`panels-${partKey}`);
  if (!container) return;

  const [u, p] = partKey.split('_');
  const words = getWords(u, p);

  let studyActive = activeTab === 'study' ? 'active' : '';
  let cardActive  = activeTab === 'card' ? 'active' : '';
  let quizActive  = activeTab === 'quiz' ? 'active' : '';

  let rowsHtml = words.map((w, index) => {
    return `
      <tr id="row-${partKey}-${w.id}">
        <td class="cell-num">${index + 1}</td>
        <td class="cell-kanji">${s(w.kanji)}</td>
        <td class="cell-kana">${s(w.kana)}</td>
        <td class="cell-meaning">
          <div style="font-weight:600; color:var(--ink)">${s(w.meaning)}</div>
          <div style="font-size:12px; color:var(--ink-mute); margin-top:2px;">${s(w.hanviet)}</div>
        </td>
        <td class="cell-example">${s(w.example)}</td>
        <td class="cell-action">
          <button class="quiz-listen-btn" style="width:32px; height:32px; font-size:13px;" onclick="playSingleAudio(${w.id}, '${buildAudioPath(w)}', '${partKey}')">🎵</button>
        </td>
      </tr>
    `;
  }).join('');

  let studyHtml = `
    <div class="sub-panel ${studyActive}">
      <div class="study-toolbar">
        <div class="study-toolbar-left">
          <button class="btn btn-primary" id="btn-autoplay-${partKey}" onclick="toggleAutoplay('${partKey}')">▶ Autoplay Audio</button>
        </div>
      </div>
      <table class="word-table">
        <thead>
          <tr>
            <th style="width:40px">#</th>
            <th>Kanji</th>
            <th>Kana</th>
            <th>Meaning</th>
            <th>Example</th>
            <th style="width:48px; text-align:center">Audio</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  let cardHtml = `
    <div class="sub-panel ${cardActive}">
      <div class="flashcard-area" id="flashcard-zone-${partKey}"></div>
    </div>
  `;

  let quizHtml = `
    <div class="sub-panel ${quizActive}">
      <div class="quiz-mode-selector">
        <button class="quiz-mode-btn active" id="mode-btn-${partKey}-k2m" onclick="changeQuizMode('${partKey}', 'k2m')">Kanji ➔ Meaning</button>
        <button class="quiz-mode-btn" id="mode-btn-${partKey}-f2k" onclick="changeQuizMode('${partKey}', 'f2k')">Kana ➔ Kanji</button>
        <button class="quiz-mode-btn" id="mode-btn-${partKey}-m2k" onclick="changeQuizMode('${partKey}', 'm2k')">Meaning ➔ Kanji</button>
      </div>
      <div class="quiz-area" id="quiz-zone-${partKey}"></div>
      <div class="quiz-review-screen" id="quiz-review-${partKey}"></div>
    </div>
  `;

  container.innerHTML = studyHtml + cardHtml + quizHtml;

  if (activeTab === 'card') initFlashcardEngine(partKey);
  if (activeTab === 'quiz') initQuizEngine(partKey);
}

function stopAllAudio() {
  state.isAutoplay = false;
  document.querySelectorAll("[id^='btn-autoplay-']").forEach(b => b.textContent = '▶ Autoplay Audio');
  document.querySelectorAll('.word-table tbody tr').forEach(r => r.classList.remove('playing'));
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
}

function playSingleAudio(wordId, path, partKey) {
  if (state.isAutoplay) stopAllAudio();

  document.querySelectorAll('.word-table tbody tr').forEach(r => r.classList.remove('playing'));
  const row = document.getElementById(`row-${partKey}-${wordId}`);
  if (row) row.classList.add('playing');

  if (state.currentAudio) state.currentAudio.pause();

  state.currentAudio = new Audio(path);
  state.currentAudio.onended = () => { if (row) row.classList.remove('playing'); };
  state.currentAudio.onerror = () => { if (row) row.classList.remove('playing'); };
  state.currentAudio.play().catch(e => console.log(e));
}

function toggleAutoplay(partKey) {
  if (state.isAutoplay) { stopAllAudio(); return; }
  if (state.currentAudio) state.currentAudio.pause();

  state.isAutoplay = true;
  const btn = document.getElementById(`btn-autoplay-${partKey}`);
  if (btn) btn.textContent = '⏹ Stop Autoplay';

  const [u, p] = partKey.split('_');
  const words = getWords(u, p);

  state.playlist = words.map(w => ({ id: w.id, path: buildAudioPath(w) }));
  state.playlistIndex = 0;

  runAutoplayCycle(partKey);
}

function runAutoplayCycle(partKey) {
  if (!state.isAutoplay || state.playlistIndex >= state.playlist.length) { stopAllAudio(); return; }

  document.querySelectorAll('.word-table tbody tr').forEach(r => r.classList.remove('playing'));
  const targetItem = state.playlist[state.playlistIndex];
  const row = document.getElementById(`row-${partKey}-${targetItem.id}`);
  if (row) {
    row.classList.add('playing');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  state.currentAudio = new Audio(targetItem.path);
  state.currentAudio.onended = () => {
    if (row) row.classList.remove('playing');
    state.playlistIndex++;
    setTimeout(() => runAutoplayCycle(partKey), 800);
  };
  state.currentAudio.onerror = () => {
    if (row) row.classList.remove('playing');
    state.playlistIndex++;
    runAutoplayCycle(partKey);
  };
  state.currentAudio.play().catch(() => {
    state.playlistIndex++;
    runAutoplayCycle(partKey);
  });
}

function initFlashcardEngine(partKey) {
  const [u, p] = partKey.split('_');
  const words = _shuffle(getWords(u, p)).slice(0, 20);

  state.flashcardState[partKey] = {
    index: 0,
    cards: words,
    remembered: 0,
    notYet: 0,
    notYetList: [],
    isFinished: false
  };

  srMarkWordsAsLearned(words);

  renderFlashcard(partKey);
}

function renderFlashcard(partKey) {
  const zone = document.getElementById(`flashcard-zone-${partKey}`);
  if (!zone) return;

  const fState = state.flashcardState[partKey];
  if (!fState || fState.cards.length === 0) {
    zone.innerHTML = `<div class="empty-state">No flashcards available.</div>`;
    return;
  }

  if (fState.isFinished) {
    renderFlashcardReport(partKey);
    return;
  }

  const idx = fState.index;
  const currentWord = fState.cards[idx];
  const progressPct = ((idx) / fState.cards.length) * 100;

  zone.innerHTML = `
    <div class="flashcard-counter">Card <span>${idx + 1}</span> of <span>${fState.cards.length}</span></div>

    <div class="flashcard-scene" id="card-scene-${partKey}" onclick="this.classList.toggle('flipped')">
      <div class="flashcard-inner">
        <div class="card-face card-front">
          ${getFrontCardDisplay(currentWord)}
          <div class="card-example">${s(currentWord.example)}</div>
          <div style="margin-top: 12px;" onclick="event.stopPropagation();">
             <button class="card-listen-btn-front" style="background:#fff; color:var(--ink); border-color:#fff;" onclick="playSingleAudio(${currentWord.id}, '${buildAudioPath(currentWord)}', '${partKey}')">🎵</button>
          </div>
          <div class="flip-hint" style="color:rgba(255,255,255,0.3); margin-top:16px;">Click card to flip</div>
        </div>

        <div class="card-face card-back" onclick="event.stopPropagation();">
          <div class="card-kana-big">${s(currentWord.kana)}</div>
          <div class="card-hanviet">${s(currentWord.hanviet)}</div>
          <div class="card-meaning">${s(currentWord.meaning)}</div>
          <div class="flip-hint" style="margin-top:16px;" onclick="document.getElementById('card-scene-${partKey}').classList.toggle('flipped')">Click to turn back</div>
        </div>
      </div>
    </div>

    <div class="flashcard-actions">
      <button class="btn btn-action-notyet" onclick="evaluateFlashcard('${partKey}', false)">❌ Not Yet</button>
      <button class="btn btn-action-remember" onclick="evaluateFlashcard('${partKey}', true)">✓ Remember</button>
    </div>

    <div class="flashcard-nav" style="margin-top:5px;">
      <div class="flashcard-progress-bar" style="width: 260px;">
        <div class="flashcard-progress-fill" style="width: ${progressPct}%"></div>
      </div>
    </div>
  `;
}

function evaluateFlashcard(partKey, isRemembered) {
  const fState = state.flashcardState[partKey];
  if (!fState) return;

  const currentWord = fState.cards[fState.index];
  if (isRemembered) { fState.remembered++; } else { fState.notYet++; fState.notYetList.push(currentWord); }

  srUpdateWordState(currentWord.id, isRemembered);

  if (fState.index + 1 < fState.cards.length) {
    fState.index++;
    renderFlashcard(partKey);
  } else {
    fState.isFinished = true;
    renderFlashcardReport(partKey);
  }
}

function renderFlashcardReport(partKey) {
  const zone = document.getElementById(`flashcard-zone-${partKey}`);
  if (!zone) return;
  const fState = state.flashcardState[partKey];

  let listItemsHtml = fState.notYetList.map(w => `
    <div class="notyet-item">
      <span><strong>${w.kanji !== '—' ? w.kanji : w.kana}</strong> (${w.kana})</span>
      <span style="color:var(--vermillion); text-align:right;">${w.meaning}</span>
    </div>
  `).join('');

  if (fState.notYetList.length === 0) {
    listItemsHtml = `<div class="empty-state" style="padding:15px;">🎉 Tuyệt vời! Bạn đã thuộc toàn bộ từ vựng!</div>`;
  }

  zone.innerHTML = `
    <div class="flashcard-report">
      <h3 style="text-align:center; font-size:18px; color:var(--ink);">📊 KẾT QUẢ ÔN TẬP</h3>
      <div class="report-grid">
        <div class="report-box remembered">
          <span class="report-num">${fState.remembered}</span>
          <span class="report-title">Remember</span>
        </div>
        <div class="report-box notyet">
          <span class="report-num">${fState.notYet}</span>
          <span class="report-title">Not Yet</span>
        </div>
      </div>
      <h4 style="font-size:13px; margin-top:15px; color:var(--ink-soft);">📝 Danh sách từ chưa nhớ cần ôn lại:</h4>
      <div class="notyet-list">${listItemsHtml}</div>
      <div style="margin-top:20px; text-align:center;">
        <button class="btn btn-outline" style="width:100%; justify-content:center;" onclick="initFlashcardEngine('${partKey}')">🔄 Restart Session</button>
      </div>
    </div>
  `;
}

function changeQuizMode(partKey, newMode) {
  [`k2m`, `f2k`, `m2k`].forEach(m => {
    const btn = document.getElementById(`mode-btn-${partKey}-${m}`);
    if (btn) btn.classList.toggle('active', m === newMode);
  });
  initQuizEngine(partKey, newMode);
}

function initQuizEngine(partKey, mode = 'k2m') {
  const [u, p] = partKey.split('_');
  const words = _shuffle(getWords(u, p));

  state.quizState[partKey] = {
    index: 0,
    score: 0,
    quizMode: mode,
    questions: words.map(w => {
      let questionMain = '';
      let questionSub = '';
      let correctAnswer = '';
      let optionPool = [];

      switch(mode) {
        case 'f2k':
          questionMain = w.kana;
          questionSub = w.meaning;
          correctAnswer = w.kanji !== '—' ? w.kanji : w.kana;
          optionPool = vocabularyData.map(item => item.kanji !== '—' ? item.kanji : item.kana);
          break;
        case 'm2k':
          questionMain = w.meaning;
          questionSub = `(${w.hanviet})`;
          correctAnswer = w.kanji !== '—' ? w.kanji : w.kana;
          optionPool = vocabularyData.map(item => item.kanji !== '—' ? item.kanji : item.kana);
          break;
        case 'k2m':
        default:
          questionMain = w.kanji !== '—' ? w.kanji : w.kana;
          questionSub = w.kana;
          correctAnswer = w.meaning;
          optionPool = vocabularyData.map(item => item.meaning);
          break;
      }

      const cleanPool = [...new Set(optionPool.filter(opt => opt !== correctAnswer))];
      const distractors = _shuffle(cleanPool).slice(0, 3);
      const choices = _shuffle([correctAnswer, ...distractors]);

      return {
        word: w,
        questionMain: questionMain,
        questionSub: questionSub,
        correctAnswer: correctAnswer,
        choices: choices,
        selected: null,
        status: 'unanswered'
      };
    })
  };

  document.getElementById(`quiz-zone-${partKey}`).style.display = 'flex';
  document.getElementById(`quiz-review-${partKey}`).style.display = 'none';

  renderQuizQuestion(partKey);
}

function renderQuizQuestion(partKey) {
  const zone = document.getElementById(`quiz-zone-${partKey}`);
  const quiz = state.quizState[partKey];
  if (!zone || !quiz) return;

  if (quiz.questions.length === 0) {
    zone.innerHTML = `<div class="empty-state">No question sets found for this mode.</div>`;
    return;
  }

  const q = quiz.questions[quiz.index];
  const progressPct = (quiz.index / quiz.questions.length) * 100;
  const labels = ['A', 'B', 'C', 'D'];

  zone.innerHTML = `
    <div class="quiz-header">
      <div class="quiz-progress-track">
        <div class="quiz-progress-fill" style="width: ${progressPct}%"></div>
      </div>
      <div class="quiz-score">Score: ${quiz.score}/${quiz.questions.length}</div>
    </div>

    <div class="quiz-card">
      <div class="quiz-question-label">
        <span class="quiz-q-number">Q${quiz.index + 1}</span> Multiple Choice Quiz
      </div>

      <div class="quiz-word-display">
        <div>
          <div class="quiz-word-main">${q.questionMain}</div>
        </div>
        <button class="quiz-listen-btn" onclick="playSingleAudio(${q.word.id}, '${buildAudioPath(q.word)}', '${partKey}')">🎵</button>
      </div>

      <div class="quiz-choices">
        ${q.choices.map((c, i) => {
          let btnClass = '';
          if (q.status !== 'unanswered') {
            if (c === q.correctAnswer) btnClass = 'correct';
            else if (c === q.selected) btnClass = 'wrong';
          }
          const isDisabled = q.status !== 'unanswered' ? 'disabled' : '';
          return `
            <button class="choice-btn ${btnClass}" ${isDisabled} onclick="submitQuizAnswer('${partKey}', '${escAttr(c)}')">
              <span class="choice-label">${labels[i]}</span> ${s(c)}
            </button>
          `;
        }).join('')}
      </div>

      ${q.status !== 'unanswered' ? `
        <div style="margin-top:20px; display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" onclick="nextQuizQuestion('${partKey}')">
            ${quiz.index + 1 === quiz.questions.length ? 'Finish Quiz' : 'Next Question ➜'}
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

function submitQuizAnswer(partKey, answerStr) {
  const quiz = state.quizState[partKey];
  if (!quiz) return;
  const q = quiz.questions[quiz.index];
  if (q.status !== 'unanswered') return;

  q.selected = answerStr;
  if (answerStr === q.correctAnswer) { q.status = 'correct'; quiz.score++; } else { q.status = 'wrong'; }
  renderQuizQuestion(partKey);
}

function nextQuizQuestion(partKey) {
  const quiz = state.quizState[partKey];
  if (!quiz) return;
  if (quiz.index + 1 < quiz.questions.length) { quiz.index++; renderQuizQuestion(partKey); } else { evaluateQuizEnd(partKey); }
}

function evaluateQuizEnd(partKey) {
  document.getElementById(`quiz-zone-${partKey}`).style.display = 'none';
  const review = document.getElementById(`quiz-review-${partKey}`);
  if (!review) return;

  const quiz = state.quizState[partKey];
  const total = quiz.questions.length;
  const score = quiz.score;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  localStorage.setItem(`quiz_${partKey}`, `${score}/${total}`);
  updateGlobalProgress();
  refreshBadgeOnAccordion(partKey, score, total);

  if (STUDENT_CONFIG.googleScriptUrl && STUDENT_CONFIG.googleScriptUrl !== "") {
    const payload = {
      studentName: STUDENT_CONFIG.studentName,
      partKey: partKey,
      quizMode: quiz.quizMode === 'k2m' ? 'Kanji -> Meaning' : (quiz.quizMode === 'f2k' ? 'Kana -> Kanji' : 'Meaning -> Kanji'),
      scoreText: `${score}/${total}`,
      accuracy: `${pct}%`
    };

    fetch(STUDENT_CONFIG.googleScriptUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    .then(() => console.log("Gửi điểm thành công về Google Sheets!"))
    .catch(err => console.error("Lỗi gửi điểm:", err));
  }

  let emoji = '🎉'; let title = 'Excellent Work!';
  if (pct < 50) { emoji = '🩹'; title = 'Keep Practicing!'; } else if (pct < 80) { emoji = '👍'; title = 'Good Effort!'; }

  review.style.display = 'block';
  review.innerHTML = `
    <div class="review-emoji">${emoji}</div>
    <div class="review-title">${title}</div>
    <div class="review-sub">You finished the quiz for this section!</div>
    <div class="review-stats">
      <div class="review-stat"><span class="review-stat-val green">${score}</span><span class="review-stat-label">Correct</span></div>
      <div class="review-stat"><span class="review-stat-val red">${total - score}</span><span class="review-stat-label">Wrong</span></div>
      <div class="review-stat"><span class="review-stat-val" style="color:var(--ink)">${pct}%</span><span class="review-stat-label">Accuracy</span></div>
    </div>
    <button class="btn btn-outline" onclick="initQuizEngine('${partKey}', '${quiz.quizMode}')">🔄 Retry Quiz</button>
  `;
}

function refreshBadgeOnAccordion(partKey, score, total) {
  const item = document.getElementById(`acc-item-${partKey}`);
  if (!item) return;
  const meta = item.querySelector('.accordion-meta');
  if (!meta) return;

  const width = `${(score / total) * 100}%`;
  let badgeClass = 'in-progress'; let partialClass = 'partial'; let label = `${score}/${total}`;
  if (score === total) { badgeClass = 'complete'; partialClass = ''; label = `✓ Passed (${score}/${total})`; }

  meta.innerHTML = `
    <div class="progress-badge ${badgeClass}">${label}</div>
    <div class="progress-bar-mini"><div class="progress-bar-mini-fill ${partialClass}" style="width: ${width}"></div></div>
  `;
}

function updateGlobalProgress() {
  const el = document.getElementById('global-progress');
  if (!el || typeof vocabularyData === 'undefined') return;
  let passedCount = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('quiz_')) {
      const val = localStorage.getItem(key);
      if (val) {
        const [score, total] = val.split('/').map(Number);
        if (score === total && total > 0) passedCount++;
      }
    }
  }
  el.innerHTML = `Total Progress: <strong>${passedCount}</strong> Section(s) Passed`;
}

function syncData() {
  const btn = document.getElementById('sync-btn');
  btn.classList.add('rotating');

  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang đồng bộ lại dữ liệu...';

  localStorage.removeItem('vocab_cache');
  localStorage.removeItem('vocab_cache_time');

  initApp().then(() => {
    btn.classList.remove('rotating');
  });
}

// ============================================================
//  TRANG "ÔN TẬP HÔM NAY" (Spaced Repetition Review)
// ============================================================
function updateReviewBadge() {
  const badge = document.getElementById('review-due-badge');
  if (!badge) return;
  const count = srCountDueWords();
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function openReviewToday() {
  const zone = document.getElementById('review-zone');
  if (!zone) {
    console.error('Không tìm thấy #review-zone trong HTML. Cần thêm 1 container rỗng với id này.');
    return;
  }

  stopAllAudio();
  switchMainSection('review');

  const dueWords = _shuffle(srGetDueWords());

  state.reviewFlashcardState = {
    index: 0,
    cards: dueWords,
    remembered: 0,
    notYet: 0,
    notYetList: [],
    isFinished: dueWords.length === 0
  };

  renderReviewFlashcard();
}

function renderReviewFlashcard() {
  const zone = document.getElementById('review-zone');
  if (!zone) return;

  const rState = state.reviewFlashcardState;
  if (!rState || rState.cards.length === 0) {
    zone.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:40px 20px;">
        <div style="font-size:40px; margin-bottom:10px;">🎉</div>
        <div style="font-weight:600; color:var(--ink);">Không có từ nào cần ôn hôm nay!</div>
        <div style="color:var(--ink-mute); margin-top:6px; font-size:13px;">Quay lại vào buổi học tiếp theo nhé.</div>
      </div>
    `;
    return;
  }

  if (rState.isFinished) {
    renderReviewReport();
    return;
  }

  const idx = rState.index;
  const currentWord = rState.cards[idx];
  const progressPct = (idx / rState.cards.length) * 100;

  zone.innerHTML = `
    <div class="flashcard-counter">Ôn tập <span>${idx + 1}</span> / <span>${rState.cards.length}</span></div>

    <div class="flashcard-scene" id="review-card-scene" onclick="this.classList.toggle('flipped')">
      <div class="flashcard-inner">
        <div class="card-face card-front">
          ${getFrontCardDisplay(currentWord)}
          <div class="card-example">${s(currentWord.example)}</div>
          <div style="margin-top: 12px;" onclick="event.stopPropagation();">
             <button class="card-listen-btn-front" style="background:#fff; color:var(--ink); border-color:#fff;" onclick="playSingleAudio(${currentWord.id}, '${buildAudioPath(currentWord)}', 'review')">🎵</button>
          </div>
          <div class="flip-hint" style="color:rgba(255,255,255,0.3); margin-top:16px;">Click card to flip</div>
        </div>

        <div class="card-face card-back" onclick="event.stopPropagation();">
          <div class="card-kana-big">${s(currentWord.kana)}</div>
          <div class="card-hanviet">${s(currentWord.hanviet)}</div>
          <div class="card-meaning">${s(currentWord.meaning)}</div>
          <div class="flip-hint" style="margin-top:16px;" onclick="document.getElementById('review-card-scene').classList.toggle('flipped')">Click to turn back</div>
        </div>
      </div>
    </div>

    <div class="flashcard-actions">
      <button class="btn btn-action-notyet" onclick="evaluateReviewFlashcard(false)">❌ Chưa thuộc</button>
      <button class="btn btn-action-remember" onclick="evaluateReviewFlashcard(true)">✓ Đã thuộc</button>
    </div>

    <div class="flashcard-nav" style="margin-top:5px;">
      <div class="flashcard-progress-bar" style="width: 260px;">
        <div class="flashcard-progress-fill" style="width: ${progressPct}%"></div>
      </div>
    </div>
  `;
}

function evaluateReviewFlashcard(isRemembered) {
  const rState = state.reviewFlashcardState;
  if (!rState) return;

  const currentWord = rState.cards[rState.index];
  if (isRemembered) { rState.remembered++; } else { rState.notYet++; rState.notYetList.push(currentWord); }

  srUpdateWordState(currentWord.id, isRemembered);

  if (rState.index + 1 < rState.cards.length) {
    rState.index++;
    renderReviewFlashcard();
  } else {
    rState.isFinished = true;
    renderReviewReport();
  }

  updateReviewBadge();
}

function renderReviewReport() {
  const zone = document.getElementById('review-zone');
  if (!zone) return;
  const rState = state.reviewFlashcardState;

  let listItemsHtml = rState.notYetList.map(w => `
    <div class="notyet-item">
      <span><strong>${w.kanji !== '—' ? w.kanji : w.kana}</strong> (${w.kana})</span>
      <span style="color:var(--vermillion); text-align:right;">${w.meaning}</span>
    </div>
  `).join('');

  if (rState.notYetList.length === 0) {
    listItemsHtml = `<div class="empty-state" style="padding:15px;">🎉 Tuyệt vời! Bạn đã ôn xong toàn bộ từ hôm nay!</div>`;
  }

  zone.innerHTML = `
    <div class="flashcard-report">
      <h3 style="text-align:center; font-size:18px; color:var(--ink);">📊 KẾT QUẢ ÔN TẬP HÔM NAY</h3>
      <div class="report-grid">
        <div class="report-box remembered">
          <span class="report-num">${rState.remembered}</span>
          <span class="report-title">Đã thuộc</span>
        </div>
        <div class="report-box notyet">
          <span class="report-num">${rState.notYet}</span>
          <span class="report-title">Chưa thuộc</span>
        </div>
      </div>
      <h4 style="font-size:13px; margin-top:15px; color:var(--ink-soft);">📝 Từ chưa thuộc, sẽ được nhắc lại sớm hơn:</h4>
      <div class="notyet-list">${listItemsHtml}</div>
      <div style="margin-top:20px; text-align:center;">
        <button class="btn btn-outline" style="width:100%; justify-content:center;" onclick="openReviewToday()">🔄 Ôn lại từ đầu</button>
      </div>
    </div>
  `;
}

// ============================================================
//  GRAMMAR MODULE (Ngữ pháp) — Soumatome N3, chia theo Tuần/Ngày
//  Data nguồn: Supabase bảng grammar_points, grammar_point_slides,
//  grammar_examples, user_grammar_progress (xem STUDENT_CONFIG).
//
//  Cấu trúc màn hình:
//   - openGrammarModule()   : entry point khi bấm nav "Ngữ pháp"
//   - loadGrammarData()     : fetch 1 lần, cache vào state.grammar (lazy-load)
//   - renderGrammarSection(): dispatcher, chọn render list hay detail
//   - renderGrammarListView() / renderGrammarListRows() / filterGrammarList()
//   - renderGrammarDetail() / renderGrammarCarousel() / carouselNav()
//   - toggleGrammarLearned(), navigateGrammarPoint(), playGrammarAudio()
// ============================================================

function openGrammarModule() {
  stopAllAudio();
  switchMainSection('grammar');

  if (!state.grammar.loaded) {
    renderGrammarLoading();
    loadGrammarData();
  } else {
    state.grammar.view = 'list';
    state.grammar.activeId = null;
    renderGrammarSection();
  }
}

function renderGrammarLoading() {
  const wrap = document.getElementById('grammar-content-wrap');
  if (wrap) wrap.innerHTML = `<div class="empty-state">Đang tải dữ liệu ngữ pháp...</div>`;
}

async function loadGrammarData() {
  try {
    const headers = {
      'apikey': STUDENT_CONFIG.supabaseAnonKey,
      'Authorization': `Bearer ${STUDENT_CONFIG.supabaseAnonKey}`,
      'Content-Type': 'application/json'
    };

    const progressUrl = `${STUDENT_CONFIG.grammarProgressUrl}?user_id=eq.${encodeURIComponent(STUDENT_CONFIG.studentId)}`;

    const [pointsRes, slidesRes, examplesRes, progressRes] = await Promise.all([
      fetch(STUDENT_CONFIG.grammarPointsUrl, { headers }),
      fetch(STUDENT_CONFIG.grammarSlidesUrl, { headers }),
      fetch(STUDENT_CONFIG.grammarExamplesUrl, { headers }),
      fetch(progressUrl, { headers })
    ]);

    if (!pointsRes.ok) {
      throw new Error(`Supabase grammar_points lỗi: ${pointsRes.status} ${pointsRes.statusText}`);
    }

    const points = await pointsRes.json();
    const slides = slidesRes.ok ? await slidesRes.json() : [];
    const examples = examplesRes.ok ? await examplesRes.json() : [];
    const progress = progressRes.ok ? await progressRes.json() : [];

    const slidesByPoint = {};
    slides.forEach(sl => {
      if (!slidesByPoint[sl.grammar_point_id]) slidesByPoint[sl.grammar_point_id] = [];
      slidesByPoint[sl.grammar_point_id].push(sl);
    });
    Object.keys(slidesByPoint).forEach(id => {
      slidesByPoint[id].sort((a, b) => a.slide_order - b.slide_order);
    });

    const examplesByPoint = {};
    examples.forEach(ex => {
      if (!examplesByPoint[ex.grammar_point_id]) examplesByPoint[ex.grammar_point_id] = [];
      examplesByPoint[ex.grammar_point_id].push(ex);
    });

    const progressByPoint = {};
    progress.forEach(pr => { progressByPoint[pr.grammar_point_id] = !!pr.is_learned; });

    state.grammar.points = points;
    state.grammar.slidesByPoint = slidesByPoint;
    state.grammar.examplesByPoint = examplesByPoint;
    state.grammar.progressByPoint = progressByPoint;
    state.grammar.loaded = true;
    state.grammar.view = 'list';
    state.grammar.activeId = null;
    state.grammar.searchTerm = '';

    renderGrammarSection();
  } catch (err) {
    console.error('Lỗi tải dữ liệu ngữ pháp:', err);
    const wrap = document.getElementById('grammar-content-wrap');
    if (wrap) {
      wrap.innerHTML = `<div class="empty-state">❌ Không tải được dữ liệu ngữ pháp. Vui lòng bấm lại vào tab Ngữ pháp để thử lại.</div>`;
    }
  }
}

// Dispatcher: quyết định render trang danh sách hay trang chi tiết
function renderGrammarSection() {
  const wrap = document.getElementById('grammar-content-wrap');
  if (!wrap) return;

  if (state.grammar.view === 'detail' && state.grammar.activeId !== null) {
    renderGrammarDetail(wrap);
  } else {
    renderGrammarListView(wrap);
  }
}

// ── TRANG DANH SÁCH ──────────────────────────────────────────

function renderGrammarListView(wrap) {
  const points = state.grammar.points;
  const total = points.length;
  const learnedCount = points.filter(p => state.grammar.progressByPoint[p.id]).length;
  const pct = total > 0 ? Math.round((learnedCount / total) * 100) : 0;
  const level = total > 0 ? points[0].jlpt_level : 'N3';

  wrap.innerHTML = `
    <div class="grammar-list-header">
      <div class="grammar-list-title-row">
        <h2>Ngữ pháp ${s(level)}</h2>
        <span class="grammar-count-badge">${total} mẫu</span>
      </div>
      <div class="grammar-progress-summary">
        <div class="progress-bar-mini" style="width:130px;">
          <div class="progress-bar-mini-fill" style="width:${pct}%"></div>
        </div>
        <span>${learnedCount}/${total} đã học (${pct}%)</span>
      </div>
      <div class="grammar-search-wrap">
        <input
          type="text"
          id="grammar-search-input"
          class="grammar-search-input"
          placeholder="🔍 Tìm theo mẫu ngữ pháp hoặc nghĩa..."
          value="${escAttr(state.grammar.searchTerm)}"
          oninput="filterGrammarList(this.value)"
        />
      </div>
    </div>
    <div class="grammar-list-body" id="grammar-list-body"></div>
  `;

  renderGrammarListRows();
}

function filterGrammarList(term) {
  state.grammar.searchTerm = term;
  renderGrammarListRows();
}

function renderGrammarListRows() {
  const body = document.getElementById('grammar-list-body');
  if (!body) return;

  const term = state.grammar.searchTerm.trim().toLowerCase();
  const filtered = state.grammar.points.filter(p => {
    if (!term) return true;
    return (p.title || '').toLowerCase().includes(term) ||
           (p.meaning_short || '').toLowerCase().includes(term);
  });

  if (filtered.length === 0) {
    body.innerHTML = `<div class="empty-state">Không tìm thấy mẫu ngữ pháp phù hợp.</div>`;
    return;
  }

  body.innerHTML = filtered.map(p => {
    const isLearned = !!state.grammar.progressByPoint[p.id];
    return `
      <div class="grammar-row ${isLearned ? 'learned' : ''}" onclick="openGrammarDetail(${p.id})">
        <div class="grammar-row-check">${isLearned ? '✓' : ''}</div>
        <div class="grammar-row-text">
          <div class="grammar-row-title">${s(p.title)}</div>
          <div class="grammar-row-meaning">${s(p.meaning_short)}</div>
        </div>
        <div class="grammar-row-meta">Tuần ${s(p.week_number)} · Ngày ${s(p.day_number)}</div>
      </div>
    `;
  }).join('');
}

// ── TRANG CHI TIẾT ───────────────────────────────────────────

function openGrammarDetail(id) {
  stopAllAudio();
  state.grammar.view = 'detail';
  state.grammar.activeId = id;
  state.grammar.carouselIndex = 0;
  renderGrammarSection();
  const wrap = document.getElementById('grammar-content-wrap');
  if (wrap) wrap.scrollTop = 0;
}

function backToGrammarList() {
  stopAllAudio();
  state.grammar.view = 'list';
  state.grammar.activeId = null;
  renderGrammarSection();
}

function navigateGrammarPoint(direction) {
  const points = state.grammar.points;
  const curIndex = points.findIndex(p => p.id === state.grammar.activeId);
  if (curIndex === -1) return;
  const nextIndex = curIndex + direction;
  if (nextIndex < 0 || nextIndex >= points.length) return;
  openGrammarDetail(points[nextIndex].id);
}

function renderGrammarDetail(wrap) {
  const point = state.grammar.points.find(p => p.id === state.grammar.activeId);
  if (!point) {
    wrap.innerHTML = `<div class="empty-state">Không tìm thấy mẫu ngữ pháp này.</div>`;
    return;
  }

  const examples = state.grammar.examplesByPoint[point.id] || [];
  const points = state.grammar.points;
  const curIndex = points.findIndex(p => p.id === point.id);
  const isLearned = !!state.grammar.progressByPoint[point.id];

  const examplesHtml = examples.length > 0 ? examples.map(ex => `
    <div class="grammar-example-item">
      <div class="grammar-example-text">
        <div class="grammar-example-jp">${s(ex.example_jp)}</div>
        <div class="grammar-example-vn">${s(ex.example_vn)}</div>
      </div>
    </div>
  `).join('') : `<div class="empty-state" style="padding:16px;">Chưa có ví dụ cho mẫu ngữ pháp này.</div>`;

  wrap.innerHTML = `
    <div class="grammar-detail-topbar">
      <button class="btn btn-outline" onclick="backToGrammarList()">← Danh sách</button>
    </div>

    <div class="grammar-detail-header">
      <div class="grammar-detail-title-row">
        <h2>${s(point.title)}</h2>
        <span class="grammar-level-badge">${s(point.jlpt_level)}</span>
      </div>
      <div class="grammar-detail-meaning">${s(point.meaning_short)}</div>
      ${point.structure ? `<div class="grammar-detail-structure">📐 ${s(point.structure)}</div>` : ''}
      ${point.meaning_long ? `<div class="grammar-detail-meaning-long">${s(point.meaning_long)}</div>` : ''}
      <div class="grammar-detail-position">Tuần ${s(point.week_number)} · Ngày ${s(point.day_number)}</div>
    </div>

    <div class="grammar-carousel-wrap" id="grammar-carousel-wrap">
      ${renderGrammarCarousel(point.id)}
    </div>

    <div class="grammar-section-block">
      <h4 class="grammar-block-heading">📝 Ví dụ</h4>
      <div class="grammar-example-list">${examplesHtml}</div>
    </div>

    ${renderRelatedGrammarBox(point)}

    <div class="grammar-detail-actions">
      <button class="btn ${isLearned ? 'btn-outline' : 'btn-primary'}" style="flex:1; justify-content:center;" onclick="toggleGrammarLearned(${point.id})">
        ${isLearned ? '✓ Đã học' : 'Đánh dấu Đã học'}
      </button>
    </div>

    <div class="grammar-detail-nav">
      <button class="btn btn-outline" onclick="navigateGrammarPoint(-1)" ${curIndex <= 0 ? 'disabled' : ''}>‹ Mẫu trước</button>
      <button class="btn btn-outline" onclick="navigateGrammarPoint(1)" ${curIndex >= points.length - 1 ? 'disabled' : ''}>Mẫu tiếp theo ›</button>
    </div>
  `;
}

// Carousel ảnh slide (mỗi mẫu ngữ pháp có 3-4 ảnh riêng, không dùng chung slide cả ngày)
function renderGrammarCarousel(pointId) {
  const slides = state.grammar.slidesByPoint[pointId] || [];
  if (slides.length === 0) {
    return `<div class="empty-state" style="padding:30px;">Chưa có slide minh họa cho mẫu này.</div>`;
  }

  const idx = Math.min(state.grammar.carouselIndex, slides.length - 1);

  return `
    <div class="grammar-carousel">
      <button class="carousel-arrow carousel-prev" onclick="carouselNav(-1)" ${idx === 0 ? 'disabled' : ''}>‹</button>
      <div class="carousel-image-wrap">
        <img src="${escAttr(slides[idx].image_url)}" alt="Slide ${idx + 1}" class="carousel-image" />
      </div>
      <button class="carousel-arrow carousel-next" onclick="carouselNav(1)" ${idx === slides.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <div class="carousel-dots">
      ${slides.map((sl, i) => `<span class="carousel-dot ${i === idx ? 'active' : ''}" onclick="carouselGoTo(${i})"></span>`).join('')}
    </div>
  `;
}

function carouselNav(direction) {
  const id = state.grammar.activeId;
  const slides = state.grammar.slidesByPoint[id] || [];
  const next = state.grammar.carouselIndex + direction;
  if (next < 0 || next >= slides.length) return;
  state.grammar.carouselIndex = next;
  const carouselWrap = document.getElementById('grammar-carousel-wrap');
  if (carouselWrap) carouselWrap.innerHTML = renderGrammarCarousel(id);
}

function carouselGoTo(i) {
  state.grammar.carouselIndex = i;
  const carouselWrap = document.getElementById('grammar-carousel-wrap');
  if (carouselWrap) carouselWrap.innerHTML = renderGrammarCarousel(state.grammar.activeId);
}

// Box cảnh báo "Dễ nhầm với" — chỉ hiện nếu related_grammar_id khác null
function renderRelatedGrammarBox(point) {
  if (!point.related_grammar_id) return '';
  const related = state.grammar.points.find(p => p.id === point.related_grammar_id);
  if (!related) return '';

  return `
    <div class="grammar-related-box" onclick="openGrammarDetail(${related.id})">
      <div class="related-box-icon">⚠️</div>
      <div class="related-box-content">
        <div class="related-box-title">Dễ nhầm với: <strong>${s(related.title)}</strong></div>
        ${point.related_note ? `<div class="related-box-note">${s(point.related_note)}</div>` : ''}
      </div>
    </div>
  `;
}

// Toggle "Đã học" — cập nhật UI ngay (optimistic), rồi ghi lên Supabase.
// LƯU Ý: bảng user_grammar_progress cần có UNIQUE constraint trên (user_id, grammar_point_id)
// để upsert (on_conflict) hoạt động đúng — xem ghi chú cuối file.
async function toggleGrammarLearned(pointId) {
  const current = !!state.grammar.progressByPoint[pointId];
  const next = !current;

  state.grammar.progressByPoint[pointId] = next;
  renderGrammarSection();

  try {
    const headers = {
      'apikey': STUDENT_CONFIG.supabaseAnonKey,
      'Authorization': `Bearer ${STUDENT_CONFIG.supabaseAnonKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    };

    const url = `${STUDENT_CONFIG.grammarProgressUrl}?on_conflict=user_id,grammar_point_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: STUDENT_CONFIG.studentId,
        grammar_point_id: pointId,
        is_learned: next,
        learned_at: next ? new Date().toISOString() : null
      })
    });

    if (!res.ok) throw new Error(`Lưu tiến độ ngữ pháp lỗi: ${res.status}`);
  } catch (err) {
    console.error('Lỗi lưu tiến độ ngữ pháp, hoàn tác lại UI:', err);
    // Hoàn tác nếu lưu thất bại, tránh UI hiển thị sai trạng thái thật trên server
    state.grammar.progressByPoint[pointId] = current;
    renderGrammarSection();
  }
}

/*
  ─────────────────────────────────────────────────────────────────
  GHI CHÚ TÍCH HỢP HTML (đã áp dụng sẵn trong index.html mới):

  1) Mỗi nút trong .main-nav cần có thuộc tính data-section khớp với
     id của panel tương ứng (id="section-XXX" -> data-section="XXX").
     switchMainSection() dựa vào thuộc tính này để active đúng nút,
     không còn dò theo nội dung chữ trên nút như bản cũ.

  2) Nút "Ôn tập hôm nay" gọi openReviewToday() thay vì
     switchMainSection() trực tiếp — vì cần khởi tạo lại
     state.reviewFlashcardState mỗi lần mở. Hàm này tự gọi
     switchMainSection('review') ở bên trong.

  3) Panel "Vocab" không còn gắn class "active" cứng trong HTML —
     startUI() gọi switchMainSection('vocab') ngay khi app load xong,
     đảm bảo đúng 1 nguồn sự thật duy nhất cho việc panel nào active.

  4) Nút "Ngữ pháp" gọi openGrammarModule() thay vì switchMainSection()
     trực tiếp — vì cần lazy-load dữ liệu Supabase lần đầu tiên vào tab.
     Panel #section-grammar chỉ chứa 1 container rỗng
     id="grammar-content-wrap" để render() ghi vào.

  5) YÊU CẦU SUPABASE: chạy file grammar_schema.sql (SQL Editor trên
     Supabase) để tạo đủ 4 bảng grammar_points, grammar_point_slides,
     grammar_examples, user_grammar_progress kèm UNIQUE constraint
     (user_id, grammar_point_id) trên user_grammar_progress — bắt buộc
     để upsert on_conflict=user_id,grammar_point_id hoạt động đúng khi
     bấm "Đã học" (nếu thiếu, mỗi lần bấm sẽ tạo dòng mới thay vì update).

  6) studentId trong STUDENT_CONFIG hiện đang hard-code "default_student"
     vì chưa có hệ thống đăng nhập. Khi có auth thật, thay giá trị này
     bằng user id thực tế của từng học viên.

  7) grammar_examples KHÔNG còn cột audio_url — ví dụ ngữ pháp chỉ hiện
     text (câu tiếng Nhật + nghĩa tiếng Việt), không có audio.

  8) meaning_long (text, nullable) trên grammar_points dùng để giải
     thích chi tiết + nuance của mẫu ngữ pháp, chỉ hiển thị ở trang
     chi tiết (renderGrammarDetail), KHÔNG hiện ở trang danh sách.
  ─────────────────────────────────────────────────────────────────
*/
