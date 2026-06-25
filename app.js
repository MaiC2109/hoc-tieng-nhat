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

// CẤU HÌNH QUẢN LÝ CHO HỌC VIÊN (Đặt ngay tại đây)
const STUDENT_CONFIG = {
  studentName: "Ẩn danh", // Thay tên học viên của bạn vào đây
  googleScriptUrl: "https://script.google.com/macros/s/AKfycbzwmTFWowwaAVQ-ZLmk3cveLH8l9Bi7rJZk6TDE2ikNnjlwB36Rn0a5An0PgmQu1Rag2w/exec" 
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  if (typeof vocabularyData === 'undefined' || !Array.isArray(vocabularyData)) {
    document.getElementById('global-progress').textContent = 'No data';
    return;
  }
  
  const units = getUnits();
  if (units.length > 0) {
    state.activeUnit = units[0];
    renderUnitTabs(units);
    renderUnitContent();
    updateGlobalProgress();
  }
}

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
          ${currentWord.kanji && currentWord.kanji !== '—' ? `<div class="card-kanji">${currentWord.kanji}</div>` : `<div class="card-kanji" style="font-size:28px; font-family:var(--font-ja); color:var(--ink-mute); ">Kana Only</div>`}
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