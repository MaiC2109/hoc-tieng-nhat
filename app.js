'use strict';

const state = {
  activeUnit: null,
  activeAccordion: {}, 
  activeSubTab: {},    
  quizState: {},        
  flashcardState: {},  
  currentAudio: null,  
  playlist: [],        
  playlistIndex: -1,
  isAutoplay: false
};

// CẤU HÌNH QUẢN LÝ
const STUDENT_CONFIG = {
  studentName: "Học viên A",
  // URL để GỬI ĐIỂM (Giữ nguyên URL của bạn)
  scoreScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec",
  // URL để TẢI DỮ LIỆU (Đã thêm ?tab=Vocabulary)
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbxDCDzDn2ZcBRAlE5M_OEMWNnB3J36ofdFb0VMzdBEPLURNaarOHYb6G4VG_0F1KnIPzQ/exec?tab=Vocabulary"
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang tải dữ liệu...';

  fetch(STUDENT_CONFIG.dataScriptUrl)
    .then(response => response.json())
    .then(data => {
      // FIX LỖI OBJECT: 
      // Nếu dữ liệu trả về là Object { "Vocabulary": [...] }, lấy mảng bên trong
      // Nếu là mảng rồi thì giữ nguyên
      window.vocabularyData = Array.isArray(data) ? data : (data.Vocabulary || Object.values(data)[0]);
      
      console.log("Dữ liệu đã xử lý:", window.vocabularyData); 
      
      if (!Array.isArray(window.vocabularyData)) {
        console.error("Dữ liệu vẫn không phải là mảng, kiểm tra cấu trúc:", data);
        if (progressEl) progressEl.textContent = 'Lỗi cấu trúc dữ liệu!';
        return;
      }

      const units = getUnits();
      if (units.length > 0) {
        state.activeUnit = units[0];
        renderUnitTabs(units);
        renderUnitContent();
        updateGlobalProgress();
      }
    })
    .catch(err => {
      console.error("Lỗi:", err);
      if (progressEl) progressEl.textContent = 'Lỗi kết nối database!';
    });
}

// CÁC HÀM XỬ LÝ LOGIC
function switchMainSection(sectionId) {
  document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.main-nav-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('section-' + sectionId);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.main-nav-btn').forEach(b => {
    if (b.textContent.trim().toLowerCase().includes(sectionId.toLowerCase()))
      b.classList.add('active');
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

function buildAudioPath(wordObj) {
  if (wordObj.audio) return `audio/${wordObj.audio}`;
  const u = _digits(wordObj.unit);
  const p = _digits(wordObj.part);
  return `audio/u${u}_p${p}_word-${wordObj.id}.mp3`;
}

function getUnits() {
  if (typeof vocabularyData === 'undefined') return [];
  const units = [...new Set(vocabularyData.map(w => w.unit))];
  return units.sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'}));
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
  const el = document.getElementById(`acc-item-${partKey}`);
  if (!el) return;
  
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    if (state.activeAccordion[unit] === part) {
      state.activeAccordion[unit] = null;
    }
  } else {
    if (state.activeAccordion[unit]) {
      const prev = document.getElementById(`acc-item-${unit}_${state.activeAccordion[unit]}`);
      if (prev) prev.classList.remove('open');
    }
    el.classList.add('open');
    state.activeAccordion[unit] = part;
    
    const curTab = state.activeSubTab[partKey] || 'study';
    switchSubTab(partKey, curTab);
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
  
  parts.forEach((p) => {
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
            <div class="sub-tabs-panels" id="panels-${escAttr(partKey)}"></div>
          </div>
        </div>
      </div>
    `;
  });
  
  html += `</div>`;
  wrap.innerHTML = html;

  parts.forEach((p) => {
    const partKey = `${unit}_${p}`;
    if (state.activeAccordion[unit] === p) {
      buildWorkspacePanels(partKey, state.activeSubTab[partKey] || 'study');
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
  
  let studyHtml = `<div class="sub-panel ${activeTab === 'study' ? 'active' : ''}"><table class="word-table"><tbody>${words.map((w, index) => `
      <tr id="row-${partKey}-${w.id}">
        <td>${index + 1}</td>
        <td>${s(w.kanji)}</td>
        <td>${s(w.kana)}</td>
        <td>${s(w.meaning)}</td>
        <td><button onclick="playSingleAudio(${w.id}, '${buildAudioPath(w)}', '${partKey}')">🎵</button></td>
      </tr>`).join('')}</tbody></table></div>`;

  let cardHtml = `<div class="sub-panel ${activeTab === 'card' ? 'active' : ''}"><div class="flashcard-area" id="flashcard-zone-${partKey}"></div></div>`;
  let quizHtml = `<div class="sub-panel ${activeTab === 'quiz' ? 'active' : ''}"><div class="quiz-area" id="quiz-zone-${partKey}"></div><div class="quiz-review-screen" id="quiz-review-${partKey}"></div></div>`;

  container.innerHTML = studyHtml + cardHtml + quizHtml;
  if (activeTab === 'card') initFlashcardEngine(partKey);
  if (activeTab === 'quiz') initQuizEngine(partKey);
}

// CÁC HÀM PHỤ TRỢ (LƯU Ý: XÓA CÁC HÀM CŨ NẾU BẠN CÓ HÀM DƯ THỪA)
function stopAllAudio() {
  if (state.currentAudio) { state.currentAudio.pause(); state.currentAudio = null; }
}

function playSingleAudio(wordId, path, partKey) {
  stopAllAudio();
  state.currentAudio = new Audio(path);
  state.currentAudio.play().catch(e => console.log(e));
}

// Thêm các hàm engine Quiz/Flashcard của bạn vào đây (giữ nguyên logic cũ)
// ...