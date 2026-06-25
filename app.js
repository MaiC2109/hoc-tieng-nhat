'use strict';

const state = {
  activeUnit: null,
  activeAccordion: {},
  activeSubTab: {}
};

const STUDENT_CONFIG = {
  studentName: "Học viên A",
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec?tab=Vocabulary",
  scoreScriptUrl: "https://script.google.com/macros/s/AKfycbxDCDzDn2ZcBRAlE5M_OEMWNnB3J36ofdFb0VMzdBEPLURNaarOHYb6G4VG_0F1KnIPzQ/exec"
};

// 1. ĐỊNH NGHĨA CẤU TRÚC CỘT (Khớp với dữ liệu bạn thấy trong console)
const COLUMNS = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example"];

function transformData(rawData) {
  // Bỏ qua dòng header nếu có, chuyển mảng con thành object
  return rawData.map(row => {
    let obj = {};
    COLUMNS.forEach((col, index) => { obj[col] = row[index]; });
    return obj;
  }).filter(item => item.id); // Lọc bỏ dòng trống
}

// 2. CÁC HÀM RENDER ĐẶT LÊN TRÊN ĐỂ TRÁNH LỖI REFERENCE
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
  renderUnitTabs([...new Set(window.vocabularyData.map(w => w.unit))]);
  console.log("Đã chọn unit:", unitName);
}

// 3. KHỞI TẠO CHÍNH
function initApp() {
  fetch(STUDENT_CONFIG.dataScriptUrl)
    .then(response => response.json())
    .then(data => {
      // Chuyển đổi dữ liệu thô thành mảng object
      window.vocabularyData = transformData(data);
      console.log("Dữ liệu đã ánh xạ thành công:", window.vocabularyData);

      const units = [...new Set(window.vocabularyData.map(w => w.unit))].sort();
      if (units.length > 0) {
        state.activeUnit = units[0];
        renderUnitTabs(units);
      }
    })
    .catch(err => console.error("Lỗi:", err));
}

document.addEventListener('DOMContentLoaded', initApp);