'use strict';

const state = { activeUnit: null };
const DATA_URL = "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec";

async function initApp() {
    try {
        const response = await fetch(DATA_URL);
        const data = await response.json();
        window.vocabularyData = data; 

        const units = [...new Set(window.vocabularyData.map(w => w.unit))].sort();
        if (units.length > 0) {
            state.activeUnit = units[0];
            renderUnitTabs(units);
            renderUnitContent();
            document.getElementById('global-progress').textContent = 'Đã tải xong dữ liệu';
        }
    } catch (err) {
        document.getElementById('global-progress').textContent = 'Lỗi tải dữ liệu!';
        console.error(err);
    }
}

function renderUnitTabs(units) {
    const bar = document.getElementById('unit-tabs-bar');
    if (!bar) return;
    bar.innerHTML = units.map(u => `
        <button class="unit-tab ${u === state.activeUnit ? 'active' : ''}" 
                onclick="selectUnit('${u}')">
            ${u}
        </button>`).join('');
}

function selectUnit(unitName) {
    state.activeUnit = unitName;
    renderUnitTabs([...new Set(window.vocabularyData.map(w => w.unit))].sort());
    renderUnitContent();
}

function renderUnitContent() {
    const wrap = document.getElementById('unit-content-wrap');
    if (!wrap) return;

    const words = window.vocabularyData.filter(w => w.unit === state.activeUnit);
    
    let html = `<table class="vocab-table">
                  <thead><tr><th>Kanji</th><th>Kana</th><th>Meaning</th></tr></thead>
                  <tbody>`;
    html += words.map(w => `
        <tr>
            <td>${w.kanji || ''}</td>
            <td>${w.kana || ''}</td>
            <td>${w.meaning || ''}</td>
        </tr>`).join('');
    html += `</tbody></table>`;
    
    wrap.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', initApp);
