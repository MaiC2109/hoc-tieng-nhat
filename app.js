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
  reviewFlashcardState: null // trạng thái riêng cho phiên Ôn tập (Spaced Repetition)
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
// Logic interval:
//   Lần học đầu tiên (srMarkWordsAsLearned): interval=1, reps=0, dueDate=ngày mai
//   Tick Remember lần 1 (reps=0 → 1): interval = SR_STEPS_DAYS[1] = 3 ngày
//   Tick Remember lần 2 (reps=1 → 2): interval = SR_STEPS_DAYS[2] = 7 ngày
//   Tick Remember lần 3+ (reps≥2)   : interval *= SR_GROWTH_FACTOR
//   Tick Not Yet bất kỳ lúc nào     : interval reset về 1 ngày
function srUpdateWordState(wordId, isCorrect) {
  const data = _srGetAll();
  const id = String(wordId);
  const st = data[id] || { interval: 0, reps: 0 };

  if (isCorrect) {
    // reps hiện tại đã là "số lần đã ôn đúng từ trước" — dùng làm chỉ số cho bước KẾ TIẾP
    // SR_STEPS_DAYS[0]=1 là interval của lần học đầu (set bởi srMarkWordsAsLearned),
    // nên lần đúng đầu tiên cần nhảy lên SR_STEPS_DAYS[1]=3, tức index = reps + 1
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
    if (!st || !st.dueDate) return false; // chưa từng học -> không tính vào "ôn tập"
    return st.dueDate <= today;
  });
}

// Đếm nhanh số từ đến hạn hôm nay (dùng để hiện badge trên nav)
function srCountDueWords() {
  return srGetDueWords().length;
}

// ============================================================
//  DEVICE LOGGING (âm thầm ghi nhận loại thiết bị học viên dùng)
//  Mục đích: quan sát hành vi đa thiết bị trước khi quyết định
//  có cần xây sync qua Supabase ở giai đoạn sau hay không.
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

    // Lưu local 1 bản ghi nhẹ để debug nếu cần
    const log = JSON.parse(localStorage.getItem('device_log') || '[]');
    log.push(payload);
    if (log.length > 50) log.shift(); // giữ tối đa 50 bản ghi gần nhất
    localStorage.setItem('device_log', JSON.stringify(log));

    // Nếu đã có endpoint backend (vd: /api/log-device trên Vercel/Supabase),
    // gửi kèm lên server. Để trống an toàn nếu chưa dựng endpoint này.
if (STUDENT_CONFIG.deviceLogUrl) {

  fetch(STUDENT_CONFIG.deviceLogUrl, {

    method: 'POST',

    headers: {

      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsYmx5bHFvc3F3bmh1ZGVpdnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mzk0NjUsImV4cCI6MjA5ODExNTQ2NX0.Xa8FblRuypm_eHMGz8GrCpwloKnzjgjTu8z_1ivS8_4',               // ← anon key của bạn

      'Authorization': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsYmx5bHFvc3F3bmh1ZGVpdnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mzk0NjUsImV4cCI6MjA5ODExNTQ2NX0.Xa8FblRuypm_eHMGz8GrCpwloKnzjgjTu8z_1ivS8_4', // ← anon key của bạn (cùng giá trị)

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

// 2. Cấu hình đường dẫn
const STUDENT_CONFIG = {
  dataScriptUrl: "/api/data",
  googleScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec",
  // Khi có, chỉ cần điền URL vào đây, không cần sửa gì thêm ở logDeviceVisit().
  deviceLogUrl: "https://zlblylqosqwnhudeivpt.supabase.co/"
};

const HEADERS = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example", "audio"];

// 3. Hàm nạp dữ liệu từ Google Sheet (Thay thế cho file data.js cũ)
async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang đồng bộ...';

  // 1. KIỂM TRA CACHE
  const cachedData = localStorage.getItem('vocab_cache');
  const cacheTime = localStorage.getItem('vocab_cache_time');
  const ONE_HOUR = 3600000; // 1 giờ tính bằng mili giây

  // Nếu đã có dữ liệu và chưa quá 1 giờ
  if (cachedData && cacheTime && (Date.now() - parseInt(cacheTime) < ONE_HOUR)) {
    console.log("Đang dùng dữ liệu từ bộ nhớ đệm (Cache)...");
    window.vocabularyData = JSON.parse(cachedData);
    startUI(); // Hàm hiển thị giao diện
    return;
  }

  // 2. NẾU CHƯA CÓ CACHE HOẶC ĐÃ CŨ: Tải từ Google
  try {
    const response = await fetch(STUDENT_CONFIG.dataScriptUrl);
    const rawData = await response.json();
    
    window.vocabularyData = Object.keys(rawData).map(key => {
        let row = rawData[key];
        let obj = {};
        HEADERS.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
    }).filter(item => item.id);

    // Lưu vào LocalStorage
    localStorage.setItem('vocab_cache', JSON.stringify(window.vocabularyData));
    localStorage.setItem('vocab_cache_time', Date.now().toString());

    console.log("Đã tải dữ liệu mới từ Google Sheet");
    startUI();
  } catch (err) {
    console.error("Lỗi tải:", err);
    if (progressEl) progressEl.textContent = 'Lỗi mạng!';
  }
}

// Hàm này để tách biệt việc khởi tạo giao diện
// ============================================================
//  DEBUG PANEL — công cụ test Spaced Repetition NGAY TRONG APP
//  Kích hoạt: thêm ?debug=sr vào cuối URL, ví dụ:
//  https://your-site.vercel.app/?debug=sr
//  Học viên bình thường không thấy gì cả vì không ai gõ tham số này.
// ============================================================
function isDebugMode() {
  return new URLSearchParams(window.location.search).get('debug') === 'sr';
}

function renderDebugPanel() {
  if (!isDebugMode()) return; // không làm gì nếu không bật debug

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

  // Style nhanh cho nút trong panel, không cần đụng vào style.css chính
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

// Nút 1: ép toàn bộ từ đã học về due = hôm nay, để vào "Ôn tập" thấy ngay
function srDebugForceAllDueToday() {
  const data = _srGetAll();
  const today = _srToday();
  const count = Object.keys(data).length;
  Object.keys(data).forEach(id => { data[id].dueDate = today; });
  _srSaveAll(data);
  updateReviewBadge();
  _srDebugLog(`✅ Đã ép ${count} từ về dueDate = ${today}.\nBấm "Ôn tập hôm nay" trên nav để kiểm tra.`);
}

// Nút 2: giả lập N ngày trôi qua (đẩy lùi dueDate của toàn bộ từ về quá khứ)
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

// Nút 3: chạy bộ test logic đầy đủ — in kết quả ra Console (giữ chi tiết ở đó vì khá dài)
function srDebugRunFullTest() {
  if (typeof srRunFullTestSuite !== 'function') {
    _srDebugLog('⚠️ Chưa nạp bộ test đầy đủ. Hãy chắc rằng file sr_test_script.js đã được include, hoặc dùng 3 nút còn lại để test nhanh.');
    return;
  }
  _srDebugLog('🧪 Đang chạy... xem chi tiết trong tab Console (F12).');
  srRunFullTestSuite();
}

// Nút 4: xem nhanh dữ liệu hiện có, không cần mở Console
function srDebugInspect() {
  const data = _srGetAll();
  const today = _srToday();
  const lines = Object.entries(data).map(([id, st]) => {
    const isDue = st.dueDate <= today ? '🔴 ĐẾN HẠN' : '⚪ chưa';
    return `${id}: interval=${st.interval} reps=${st.reps} due=${st.dueDate} ${isDue}`;
  });
  _srDebugLog(lines.length ? lines.join('\n') : '(chưa có từ nào trong sr_vocab)');
}

// Nút 5: dọn sạch để test lại từ đầu
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
    updateReviewBadge(); // hiện số từ cần ôn hôm nay (Spaced Repetition), an toàn nếu badge chưa có trong HTML
    switchMainSection('vocab'); // panel mặc định khi mở app — thay cho class "active" viết cứng trong HTML
    renderDebugPanel(); // chỉ hiện khi URL có ?debug=sr, không ảnh hưởng học viên bình thường
    // Ẩn loading nếu bạn có dùng overlay
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }
}
// Kích hoạt khi trang web tải xong
document.addEventListener('DOMContentLoaded', () => {
  logDeviceVisit(); // ghi nhận thiết bị mỗi lần học viên mở app — không chặn luồng chính
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

// Helper dùng chung cho mặt trước Flashcard (cả Vocab thường lẫn Ôn tập):
// Nếu từ có Kanji -> hiện Kanji như bình thường.
// Nếu từ KHÔNG có Kanji (chỉ tồn tại ở dạng kana, vd: けが) -> hiện
// chính chữ Kana đó thay vì hiển thị placeholder text "Kana Only".
function getFrontCardDisplay(word) {
  const hasKanji = word.kanji && word.kanji !== '—';
  if (hasKanji) {
    return `<div class="card-kanji">${word.kanji}</div>`;
  }
  // Không có kanji: dùng kana làm chữ chính, giữ cỡ chữ to như kanji
  // để bố cục card không bị lệch trọng tâm giữa các từ có/không có kanji.
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
  
  // Lấy danh sách Unit, sau đó dùng .filter để loại bỏ những tên rác
  const units = [...new Set(window.vocabularyData.map(w => w.unit))];
  
  return units
    .filter(u => u && u !== "unit" && u !== "Unit") // Dòng này sẽ loại bỏ cái tên "unit" thừa
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
  
  // Nếu đã mở thì đóng lại
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    stopAllAudio(); // dừng audio nếu đang phát khi đóng accordion
    if (state.activeAccordion[unit] === part) {
      state.activeAccordion[unit] = null;
    }
  } else {
    // Đóng các item khác trong cùng unit
    if (state.activeAccordion[unit]) {
      const prev = document.getElementById(`acc-item-${escId(unit)}_${escId(state.activeAccordion[unit])}`);
      if (prev) prev.classList.remove('open');
    }
    
    // Mở item được chọn
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
    
    // Mặc định ban đầu sẽ đóng hết, chỉ mở khi người dùng chủ động click
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

  // Chỉ dựng Workspace panel cho những bài nào đang thực sự được mở
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

  // Spaced Repetition: đánh dấu các từ trong Part này là "đã học lần đầu"
  // (chỉ áp dụng cho từ chưa từng có trong sr_vocab, không ghi đè lịch sử ôn cũ)
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

  // Spaced Repetition: ghi nhận kết quả để tính lại lịch ôn tiếp theo cho từ này
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

  // ─── ĐOẠN CODE TỰ ĐỘNG GỬI ĐIỂM LÊN GOOGLE SHEETS ĐƯỢC CHÈN VÀO ĐÂY ───
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
  // ───────────────────────────────────────────────────────────────────

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
  btn.classList.add('rotating'); // Bắt đầu hiệu ứng xoay
  
  // Thông báo cho người dùng
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang đồng bộ lại dữ liệu...';

  // Xóa bộ nhớ đệm
  localStorage.removeItem('vocab_cache');
  localStorage.removeItem('vocab_cache_time');

  // Gọi lại hàm initApp để tải mới hoàn toàn
  initApp().then(() => {
    btn.classList.remove('rotating'); // Dừng xoay khi xong
  });
}

// ============================================================
//  TRANG "ÔN TẬP HÔM NAY" (Spaced Repetition Review)
//  Tái sử dụng giao diện flashcard hiện có, khác ở nguồn dữ liệu:
//  thay vì lấy theo Part, lấy theo danh sách từ ĐẾN HẠN ôn hôm nay.
//  Yêu cầu HTML: 1 nút/khu vực gọi openReviewToday() và 1 container
//  rỗng có id="review-zone" để render vào (xem ghi chú cuối file).
// ============================================================

// Cập nhật badge số từ cần ôn hôm nay — gọi hàm này ở bất cứ đâu
// bạn muốn hiển thị con số (vd: trên nav bar, sau khi initApp xong).
function updateReviewBadge() {
  const badge = document.getElementById('review-due-badge');
  if (!badge) return; // an toàn nếu HTML chưa có phần tử này
  const count = srCountDueWords();
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// Mở phiên Ôn tập hôm nay — gọi từ nút nav "Ôn tập hôm nay" trong index.html
function openReviewToday() {
  const zone = document.getElementById('review-zone');
  if (!zone) {
    console.error('Không tìm thấy #review-zone trong HTML. Cần thêm 1 container rỗng với id này.');
    return;
  }

  stopAllAudio();
  switchMainSection('review'); // chuyển panel + active đúng nút nav nhờ data-section="review"

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

  // Đây là bước quan trọng nhất: cập nhật lại lịch ôn tiếp theo cho từ này
  srUpdateWordState(currentWord.id, isRemembered);

  if (rState.index + 1 < rState.cards.length) {
    rState.index++;
    renderReviewFlashcard();
  } else {
    rState.isFinished = true;
    renderReviewReport();
  }

  // Cập nhật lại badge số từ còn lại đến hạn (vd: trên nav)
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
  ─────────────────────────────────────────────────────────────────
*/