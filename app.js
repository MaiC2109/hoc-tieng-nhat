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
  // URL để TẢI DỮ LIỆU
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec?tab=Vocabulary",
  // URL để GỬI ĐIỂM
  scoreScriptUrl: "https://script.google.com/macros/s/AKfycbxDCDzDn2ZcBRAlE5M_OEMWNnB3J36ofdFb0VMzdBEPLURNaarOHYb6G4VG_0F1KnIPzQ/exec"
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
      // Xử lý dữ liệu linh hoạt hơn
      window.vocabularyData = Array.isArray(data) ? data : (data.Vocabulary || Object.values(data)[0] || []);
      
      console.log("Dữ liệu đã nạp:", window.vocabularyData); 
      
      if (!Array.isArray(window.vocabularyData) || window.vocabularyData.length === 0) {
        if (progressEl) progressEl.textContent = 'Không có dữ liệu hoặc lỗi cấu trúc!';
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
      console.error("Lỗi tải dữ liệu:", err);
      if (progressEl) progressEl.textContent = 'Lỗi kết nối database!';
    });
}

// HÀM GỬI ĐIỂM LÊN GOOGLE SHEET
async function sendScoreToSheet(partKey, score, total) {
  try {
    const response = await fetch(STUDENT_CONFIG.scoreScriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student: STUDENT_CONFIG.studentName,
        part: partKey,
        score: `${score}/${total}`,
        timestamp: new Date().toLocaleString()
      })
    });
    console.log("Đã lưu điểm cho:", partKey);
  } catch (err) {
    console.error("Không thể lưu điểm:", err);
  }
}

// CÁC HÀM XỬ LÝ LOGIC (Giữ nguyên các hàm cũ của bạn)
function switchMainSection(sectionId) {
  document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.main-nav-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('section-' + sectionId);
  if (panel) panel.classList.add('active');
}

function s(v) { return (v !== undefined && v !== null && v !== '') ? String(v) : '—'; }
function escAttr(v) { return String(v === undefined || v === null ? '' : v).replace(/'/g, "\\'"); }

function getUnits() {
  if (typeof vocabularyData === 'undefined') return [];
  return [...new Set(vocabularyData.map(w => w.unit))].sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true}));
}

function getPartsForUnit(unitName) {
  return [...new Set(vocabularyData.filter(w => w.unit === unitName).map(w => w.part))].sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true}));
}

function getWords(unitName, partName) {
  return vocabularyData.filter(w => w.unit === unitName && w.part === partName);
}

// Giữ lại các hàm render và logic khác của bạn tại đây...
// (Vì file cũ của bạn cắt đoạn cuối, hãy đảm bảo bạn paste phần còn thiếu nếu có)