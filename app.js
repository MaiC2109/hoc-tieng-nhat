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

const STUDENT_CONFIG = {
  studentName: "Học viên A",
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec?tab=Vocabulary",
  googleScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec"
};

const HEADERS = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example", "audio"];

document.addEventListener('DOMContentLoaded', initApp);

// --- 1. LOGIC NẠP DỮ LIỆU (TỪ GOOGLE SHEETS) ---
async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang đồng bộ dữ liệu...';

  try {
    const response = await fetch(STUDENT_CONFIG.dataScriptUrl);
    const rawData = await response.json();
    
    // Ánh xạ dữ liệu Object {0: [...]} sang Mảng Object chuẩn
    window.vocabularyData = Object.keys(rawData).map(key => {
        let row = rawData[key];
        let obj = {};
        HEADERS.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
    }).filter(item => item.id);

    console.log("Dữ liệu đã sẵn sàng:", window.vocabularyData);
    
    // Sau khi nạp xong, khởi chạy các logic cũ
    const units = getUnits();
    if (units.length > 0) {
      state.activeUnit = units[0];
      renderUnitTabs(units);
      renderUnitContent();
      updateGlobalProgress();
    }
  } catch (err) {
    console.error("Lỗi:", err);
    if (progressEl) progressEl.textContent = 'Lỗi hệ thống!';
  }
}

// --- 2. LOGIC CƠ BẢN (Giữ nguyên) ---
function s(v) { return (v !== undefined && v !== null && v !== '') ? String(v) : '—'; }
function getUnits() { return [...new Set(vocabularyData.map(w => w.unit))].sort(); }
function getPartsForUnit(unit) { return [...new Set(vocabularyData.filter(w => w.unit === unit).map(w => w.part))].sort(); }
function getWords(unit, part) { return vocabularyData.filter(w => w.unit === unit && w.part === part); }

// --- 3. CÁC TÍNH NĂNG CŨ (Quiz, Flashcard, Audio...) ---
// Bạn hãy copy toàn bộ các hàm render, quizEngine, flashcard, v.v. từ file "app-dúng.js" 
// dán tiếp vào dưới đây.
// Vì `window.vocabularyData` đã ở định dạng mảng object chuẩn, các hàm cũ sẽ chạy bình thường.

// Ví dụ hàm render đã cập nhật để khớp với accordion cũ:
function renderUnitContent() {
  const wrap = document.getElementById('unit-content-wrap');
  if (!wrap) return;
  const parts = getPartsForUnit(state.activeUnit);
  
  wrap.innerHTML = parts.map(p => `
    <div class="accordion-item" id="acc-item-${state.activeUnit}_${p}">
       <button class="accordion-header" onclick="togglePart('${state.activeUnit}_${p}')">
         ${p} <span class="accordion-meta"></span>
       </button>
       <div class="accordion-body" id="body-${state.activeUnit}_${p}"></div>
    </div>
  `).join('');
}