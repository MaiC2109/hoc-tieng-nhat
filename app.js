'use strict';

const state = {
  activeUnit: null,
  activeAccordion: {}, // Lưu trạng thái đóng/mở của các Part
  activeSubTab: {},
  quizState: {},
  flashcardState: {},
  currentAudio: null
};

const STUDENT_CONFIG = {
  studentName: "Học viên A",
  scoreScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec",
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec?tab=Vocabulary"
};

const HEADERS = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example", "audio"];

document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang xử lý dữ liệu...';

  try {
    const response = await fetch(STUDENT_CONFIG.dataScriptUrl);
    const data = await response.json();
    
    // LOGIC NẠP DỮ LIỆU ĐÃ CHẠY ĐÚNG (Giữ nguyên)
    window.vocabularyData = Object.keys(data).map(key => {
        let row = data[key];
        let obj = {};
        HEADERS.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
    }).filter(item => item.id);

    console.log("Dữ liệu sau khi map:", window.vocabularyData);

    const units = getUnits();
    if (units.length > 0) {
      state.activeUnit = units[0];
      renderUnitTabs(units);
      renderUnitContent();
      if (progressEl) progressEl.textContent = 'Đã tải xong';
    }
  } catch (err) {
    console.error("Lỗi:", err);
    if (progressEl) progressEl.textContent = 'Lỗi xử lý dữ liệu!';
  }
}

// CÁC HÀM LOGIC HỖ TRỢ (Giữ nguyên)
function s(v) { return (v !== undefined && v !== null && v !== '') ? String(v) : '—'; }
function getUnits() { return [...new Set(vocabularyData.map(w => w.unit))].sort(); }
function getPartsForUnit(unit) { return [...new Set(vocabularyData.filter(w => w.unit === unit).map(w => w.part))].sort(); }
function getWords(unit, part) { return vocabularyData.filter(w => w.unit === unit && w.part === part); }

function renderUnitTabs(units) {
  const bar = document.getElementById('unit-tabs-bar');
  if (!bar) return;
  bar.innerHTML = units.map(u => `
    <button class="unit-tab ${u === state.activeUnit ? 'active' : ''}" onclick="selectUnit('${u}')">
      ${u}
    </button>`).join('');
}

function selectUnit(unitName) {
  state.activeUnit = unitName;
  renderUnitTabs(getUnits());
  renderUnitContent();
}

// HÀM RENDER ĐÃ ĐƯỢC CHỈNH SỬA ĐỂ KHỚP CẤU TRÚC ACCORDION CỦA CSS
function renderUnitContent() {
  const wrap = document.getElementById('unit-content-wrap');
  if (!wrap) return;
  
  const parts = getPartsForUnit(state.activeUnit);
  
  wrap.innerHTML = `
    <div class="parts-container">
      ${parts.map((p, index) => {
        const partKey = `${state.activeUnit}_${p}`;
        const isOpen = state.activeAccordion[partKey] ? 'open' : '';
        const words = getWords(state.activeUnit, p);
        
        return `
          <div class="accordion-item ${isOpen}">
            <button class="accordion-header" onclick="togglePart('${partKey}')">
              <div class="accordion-chevron">▶</div>
              <div class="accordion-part-label">${p}</div>
              <div class="accordion-meta">
                <span class="progress-badge not-started">${words.length} từ</span>
              </div>
            </button>
            <div class="accordion-body">
              <div class="workspace">
                 <table class="word-table">
                   <thead>
                     <tr><th>STT</th><th>Kanji</th><th>Kana</th><th>Meaning</th></tr>
                   </thead>
                   <tbody>
                     ${words.map((w, i) => `
                       <tr>
                         <td class="cell-num">${i + 1}</td>
                         <td class="cell-kanji">${s(w.kanji)}</td>
                         <td class="cell-kana">${s(w.kana)}</td>
                         <td class="cell-meaning">${s(w.meaning)}</td>
                       </tr>
                     `).join('')}
                   </tbody>
                 </table>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// HÀM ĐÓNG/MỞ ACCORDION
function togglePart(partKey) {
  state.activeAccordion[partKey] = !state.activeAccordion[partKey];
  renderUnitContent();
}

async function sendScoreToSheet(partKey, score, total) {
  await fetch(STUDENT_CONFIG.scoreScriptUrl, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ student: STUDENT_CONFIG.studentName, part: partKey, score: `${score}/${total}` })
  });
}