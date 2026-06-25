'use strict';

const state = { activeUnit: null };

// SỬA URL NÀY THÀNH LINK MỚI NHẤT CỦA BẠN (sau khi đã Deploy Anyone)
const DATA_URL = "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec";

// Hàm chuyển đổi mảng thô thành Object để không bị lỗi undefined
function parseData(rawData) {
    if (!Array.isArray(rawData)) return [];
    const headers = ["id", "unit", "part", "kanji", "kana", "romaji", "hanviet", "meaning", "example"];
    return rawData.map(row => {
        let obj = {};
        headers.forEach((h, i) => obj[h] = row[i]);
        return obj;
    }).filter(o => o.id); // Lọc bỏ dòng tiêu đề nếu bị lẫn vào
}

async function initApp() {
    console.log("Đang tải dữ liệu...");
    try {
        const response = await fetch(DATA_URL);
        const rawData = await response.json();
        
        // Chuyển đổi dữ liệu
        window.vocabularyData = parseData(rawData);
        console.log("Dữ liệu đã nhận:", window.vocabularyData);

        // Hiển thị nội dung
        const appContainer = document.getElementById('unit-tabs-bar');
        if (appContainer) {
            appContainer.innerHTML = "Dữ liệu đã tải thành công! (Check Console để xem)";
        }
    } catch (err) {
        console.error("Lỗi khi tải:", err);
    }
}

document.addEventListener('DOMContentLoaded', initApp);
