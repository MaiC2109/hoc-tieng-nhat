'use strict';

const state = {
  activeUnit: null,
  activeAccordion: {},
  activeSubTab: {},
  quizState: {},
  flashcardState: {},
  currentAudio: null
};

const STUDENT_CONFIG = {
  studentName: "Học viên A",
  scoreScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec",
  dataScriptUrl: "https://script.google.com/macros/s/AKfycbxDCDzDn2ZcBRAlE5M_OEMWNnB3J36ofdFb0VMzdBEPLURNaarOHYb6G4VG_0F1KnIPzQ/exec?tab=Vocabulary"
};

// Định nghĩa thứ tự cột của Google Sheet
const HEADERS = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example", "audio"];

document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang tải dữ liệu...';

  try {
    const response = await fetch(STUDENT_CONFIG.dataScriptUrl);
    const data = await response.json();
    
    console.log("Dữ liệu gốc nhận được:", data);

    // TỰ ĐỘNG TÌM MẢNG: 
    // Nếu data là Object, nó sẽ tìm thuộc tính đầu tiên là mảng.
    let arrayData = Array.isArray(data) ? data : null;
    if (!arrayData) {
      for (let key in data) {
        if (Array.isArray(data[key])) {
          arrayData = data[key];
          break;
        }
      }
    }

    if (!arrayData) {
      throw new Error("Không tìm thấy mảng dữ liệu trong kết quả trả về!");
    }

    // CHUYỂN ĐỔI: Nếu phần tử đầu tiên là mảng (dòng dữ liệu), ta map nó sang Object
    if (arrayData.length > 0 && Array.isArray(arrayData[0])) {
       window.vocabularyData = arrayData.map(row => {
          let obj = {};
          HEADERS.forEach((h, i) => { obj[h] = row[i]; });
          return obj;
       }).filter(item => item.id);
    } else {
       window.vocabularyData = arrayData;
    }

    console.log("Dữ liệu sau khi xử lý thành công:", window.vocabularyData);

    const units = getUnits();
    if (units.length > 0) {
      state.activeUnit = units[0];
      renderUnitTabs(units);
      renderUnitContent();
      if (progressEl) progressEl.textContent = 'Đã tải xong';
    }
  } catch (err) {
    console.error("Lỗi:", err);
    if (progressEl) progressEl.textContent = 'Lỗi dữ liệu!';
  }
}

// CÁC HÀM XỬ LÝ LOGIC (Giữ nguyên các hàm của bạn)
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

// Hàm render content (sửa lại để dùng với dữ liệu dạng Object)
function renderUnitContent() {
  const wrap = document.getElementById('unit-content-wrap');
  if (!wrap) return;
  
  const parts = getPartsForUnit(state.activeUnit);
  wrap.innerHTML = parts.map(p => `
    <div class="part-section">
      <h3>${p}</h3>
      <table class="word-table">
        ${getWords(state.activeUnit, p).map(w => `
          <tr>
            <td>${s(w.kanji)}</td>
            <td>${s(w.kana)}</td>
            <td>${s(w.meaning)}</td>
          </tr>`).join('')}
      </table>
    </div>
  `).join('');
}

// Hàm gửi điểm (để bạn dùng cho Quiz)
async function sendScoreToSheet(partKey, score, total) {
  await fetch(STUDENT_CONFIG.scoreScriptUrl, {
    method: 'POST',
    mode: 'no-cors',
    body: JSON.stringify({ student: STUDENT_CONFIG.studentName, part: partKey, score: `${score}/${total}` })
  });
}