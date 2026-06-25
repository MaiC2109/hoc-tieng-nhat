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
  studentName: "Ẩn danh",
  // URL lấy dữ liệu từ Google Sheet (đã map vào biến window.vocabularyData)
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec?tab=Vocabulary",
  // URL gửi điểm
  googleScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec" 
};

const HEADERS = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example", "audio"];

document.addEventListener('DOMContentLoaded', initApp);

// --- LOGIC LẤY DATA TỪ GG SHEET (Từ app-now02.js) ---
async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang đồng bộ dữ liệu...';

  try {
    const response = await fetch(STUDENT_CONFIG.dataScriptUrl);
    const rawData = await response.json();
    
    // Convert object {0: [...], 1: [...]} sang array object chuẩn
    window.vocabularyData = Object.keys(rawData).map(key => {
        let row = rawData[key];
        let obj = {};
        HEADERS.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
    }).filter(item => item.id);

    console.log("Data loaded:", window.vocabularyData);
    
    // Khởi chạy giao diện sau khi có data
    const units = getUnits();
    if (units.length > 0) {
      state.activeUnit = units[0];
      renderUnitTabs(units);
      renderUnitContent();
      updateGlobalProgress();
    }
  } catch (err) {
    console.error("Lỗi:", err);
    if (progressEl) progressEl.textContent = 'Lỗi tải dữ liệu!';
  }
}

// --- CÁC LOGIC CHỨC NĂNG (Giữ nguyên từ file bạn cung cấp) ---
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
function escAttr(v) { return String(v === undefined || v === null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function _shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function _digits(str) { const m = String(str || '').match(/\d+/); return m ? m[0] : '0'; }

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

function getWords(unitName, partName) { return vocabularyData.filter(w => w.unit === unitName && w.part === partName); }

// (BẠN GIỮ NGUYÊN TOÀN BỘ CÁC HÀM RENDER, QUIZ, FLASHCARD, AUDIO... TỪ FILE CŨ CỦA BẠN DÁN TIẾP VÀO ĐÂY)
// Các hàm renderUnitTabs, selectUnit, toggleAccordion, renderUnitContent, switchSubTab, buildWorkspacePanels... 
// ...dán toàn bộ phần còn lại từ file cũ vào đây.