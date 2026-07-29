'use strict';
// ============================================================
//  EXAM MODULE (Luyện đề)
//  File này load SAU app.js trong index.html nên dùng chung
//  `state` global và `supabaseClient` đã khởi tạo sẵn ở app.js,
//  không tạo thêm Supabase client thứ 2.
// ============================================================

// Sub-state riêng cho module Luyện đề, gắn vào state chung
// theo đúng convention các module khác (quizState, flashcardState...).
state.examState = state.examState || {
  examList: [],       // danh sách đề đã join với attempt gần nhất của user
  isLoading: false,
  currentAttempt: null,          // exam_attempts row đang làm (sau khi bấm Bắt đầu/Tiếp tục)
  currentExamStructure: null,    // cây sections -> subsections -> questions của đề đang làm
  activeSectionIndex: 0,         // section đang active trong cây trên
  flatQuestions: [],             // danh sách câu hỏi đã làm phẳng, theo đúng thứ tự sections->subsections->questions
  passagesMap: {},               // { [passage_id]: passage row } cho các câu có passage
  currentQuestionIndex: 0,       // vị trí đang xem trong flatQuestions
  selectedAnswers: {},           // { [exam_questions.id]: giá trị đáp án học viên chọn/nhập tạm — CHƯA autosave xuống DB ở bước này
  flaggedQuestions: {}           // { [exam_questions.id]: true } — đánh dấu "xem lại", CHƯA lưu DB (is_flagged), chỉ ở state
};

// ------------------------------------------------------------
// Entry point — gọi từ nav button, theo đúng pattern openReviewToday()/openDashboard()
// ------------------------------------------------------------
async function openPracticeTest() {
  stopAllAudio();
  switchMainSection('practice'); // chuyển panel + active đúng nút nav nhờ data-section="practice"

  const zone = document.getElementById('practice-zone');
  if (!zone) {
    console.error('Không tìm thấy #practice-zone trong HTML. Cần thêm 1 container rỗng với id này.');
    return;
  }

  renderPracticeTestLoading();
  await loadExamListWithAttempts();
  renderPracticeTestList();
}

// ------------------------------------------------------------
// Load danh sách đề đã publish + attempt gần nhất của user hiện tại
// ------------------------------------------------------------
async function loadExamListWithAttempts() {
  state.examState.isLoading = true;

  if (!state.currentUser) {
    state.examState.examList = [];
    state.examState.isLoading = false;
    return;
  }

  try {
    const { data: exams, error: examsError } = await supabaseClient
      .from('exams')
      .select('id, title, exam_type, pass_threshold_pct')
      .eq('is_published', true)
      .order('created_at', { ascending: false });

    if (examsError) {
      console.error('Lỗi tải danh sách đề:', examsError);
      state.examState.examList = [];
      state.examState.isLoading = false;
      return;
    }

    const examIds = (exams || []).map(e => e.id);
    let attemptsByExam = {};

    if (examIds.length > 0) {
      const { data: attempts, error: attemptsError } = await supabaseClient
        .from('exam_attempts')
        .select('id, exam_id, attempt_number, status, total_score, total_possible, submitted_at, started_at')
        .eq('user_id', state.currentUser.id)
        .in('exam_id', examIds)
        .order('attempt_number', { ascending: false });

      if (attemptsError) {
        console.error('Lỗi tải lịch sử làm bài:', attemptsError);
      } else {
        // Với mỗi exam_id, chọn 1 attempt đại diện để hiển thị trên card, ưu tiên:
        // 1. Attempt đang 'in_progress' (bất kể attempt_number, vì học viên cần
        //    được nhắc tiếp tục làm dở trước khi thấy kết quả cũ)
        // 2. Nếu không có attempt nào đang làm dở, lấy attempt có attempt_number
        //    lớn nhất (gần nhất) — đã order desc theo attempt_number ở query trên
        //    nên phần tử đầu tiên gặp mỗi exam_id chính là attempt mới nhất.
        (attempts || []).forEach(att => {
          const current = attemptsByExam[att.exam_id];
          if (!current) {
            attemptsByExam[att.exam_id] = att;
            return;
          }
          if (current.status !== 'in_progress' && att.status === 'in_progress') {
            attemptsByExam[att.exam_id] = att;
          }
        });
      }
    }

    state.examState.examList = (exams || []).map(exam => ({
      ...exam,
      latestAttempt: attemptsByExam[exam.id] || null
    }));
  } catch (err) {
    console.error('Lỗi không xác định khi tải danh sách đề:', err);
    state.examState.examList = [];
  }

  state.examState.isLoading = false;
}

// ------------------------------------------------------------
// Render — trạng thái loading
// ------------------------------------------------------------
function renderPracticeTestLoading() {
  const zone = document.getElementById('practice-zone');
  if (!zone) return;
  zone.innerHTML = `
    <div class="empty-state" style="text-align:center; padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 12px;"></div>
      <div style="color:var(--ink-mute); font-size:13px;">Đang tải danh sách đề...</div>
    </div>
  `;
}

// ------------------------------------------------------------
// Render — danh sách đề thi dạng card, mỗi card theo 3 trạng thái
// ------------------------------------------------------------
function renderPracticeTestList() {
  const zone = document.getElementById('practice-zone');
  if (!zone) return;

  const list = state.examState.examList;

  if (!list || list.length === 0) {
    zone.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:40px 20px;">
        <div style="font-size:40px; margin-bottom:10px;">📝</div>
        <div style="font-weight:600; color:var(--ink);">Chưa có đề thi nào</div>
        <div style="color:var(--ink-mute); margin-top:6px; font-size:13px;">Quay lại sau khi có đề mới được đăng nhé.</div>
      </div>
    `;
    return;
  }

  zone.innerHTML = list.map(exam => renderExamCard(exam)).join('');
}

function renderExamCard(exam) {
  const attempt = exam.latestAttempt;
  const examTypeLabel = exam.exam_type === 'full' ? 'Đề tổng hợp' : 'Đề theo kỹ năng';

  let statusHtml = '';
  let actionsHtml = '';

  if (!attempt) {
    // Chưa có attempt nào -> "Chưa làm"
    statusHtml = `<span class="exam-status-badge exam-status-new">Chưa làm</span>`;
    actionsHtml = `
      <button class="btn btn-primary" onclick="startExamAttempt('${exam.id}')">
        Bắt đầu
      </button>
    `;
  } else if (attempt.status === 'in_progress') {
    statusHtml = `<span class="exam-status-badge exam-status-progress">Đang làm dở</span>`;
    actionsHtml = `
      <button class="btn btn-primary" onclick="continueExamAttempt('${attempt.id}')">
        Tiếp tục làm bài
      </button>
    `;
  } else {
    // submitted / passed / needs_retry -> hiện điểm gần nhất
    const scoreText = (attempt.total_score != null && attempt.total_possible != null)
      ? `${attempt.total_score}/${attempt.total_possible}`
      : '—';

    const statusLabelMap = {
      submitted: 'Đã nộp bài',
      passed: 'Đạt',
      needs_retry: 'Cần làm lại'
    };
    const statusClassMap = {
      submitted: 'exam-status-submitted',
      passed: 'exam-status-passed',
      needs_retry: 'exam-status-retry'
    };
    const label = statusLabelMap[attempt.status] || attempt.status;
    const cls = statusClassMap[attempt.status] || 'exam-status-submitted';

    statusHtml = `
      <span class="exam-status-badge ${cls}">${label}</span>
      <span class="exam-score-text">${scoreText} điểm</span>
    `;
    actionsHtml = `
      <button class="btn btn-outline" onclick="viewExamAttemptResult('${attempt.id}')">
        Xem lại
      </button>
      <button class="btn btn-primary" onclick="startExamAttempt('${exam.id}')">
        Làm lại
      </button>
    `;
  }

  return `
    <div class="exam-card">
      <div class="exam-card-info">
        <div class="exam-card-title">${exam.title}</div>
        <div class="exam-card-meta">
          <span>${examTypeLabel}</span>
          <span>·</span>
          <span>Điểm đạt: ${exam.pass_threshold_pct}%</span>
        </div>
        <div class="exam-card-status-row">
          ${statusHtml}
        </div>
      </div>
      <div class="exam-card-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------
// Bắt đầu làm bài — insert exam_attempts mới + load cấu trúc đề
// CHƯA render UI câu hỏi, chỉ log state để xác nhận load đúng.
// ------------------------------------------------------------
async function startExamAttempt(examId) {
  if (!state.currentUser) {
    alert('Bạn cần đăng nhập để làm bài.');
    return;
  }

  try {
    // 1. Tính attempt_number kế tiếp = số attempt trước đó của user với đề này + 1
    const { data: prevAttempts, error: prevError } = await supabaseClient
      .from('exam_attempts')
      .select('attempt_number')
      .eq('exam_id', examId)
      .eq('user_id', state.currentUser.id)
      .order('attempt_number', { ascending: false })
      .limit(1);

    if (prevError) {
      console.error('Lỗi kiểm tra lịch sử attempt:', prevError);
      alert('Không thể bắt đầu làm bài, vui lòng thử lại.');
      return;
    }

    const nextAttemptNumber = (prevAttempts && prevAttempts.length > 0)
      ? prevAttempts[0].attempt_number + 1
      : 1;

    // 2. Insert exam_attempts mới
    const { data: newAttempt, error: insertError } = await supabaseClient
      .from('exam_attempts')
      .insert({
        exam_id: examId,
        user_id: state.currentUser.id,
        attempt_number: nextAttemptNumber,
        status: 'in_progress',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('Lỗi tạo attempt mới:', insertError);
      alert('Không thể bắt đầu làm bài, vui lòng thử lại.');
      return;
    }

    // 3. Load cấu trúc đề (sections -> subsections -> questions join question_bank)
    const structure = await loadExamStructure(examId);
    if (!structure) {
      alert('Không thể tải nội dung đề thi, vui lòng thử lại.');
      return;
    }

    // 4. Làm phẳng cây thành danh sách câu hỏi tuần tự, kèm passage nếu có
    const flatQuestions = flattenExamStructure(structure);
    const passageIds = [...new Set(
      flatQuestions
        .map(q => q.question_bank && q.question_bank.passage_id)
        .filter(Boolean)
    )];
    const passagesMap = await loadPassagesByIds(passageIds);

    // 5. Lưu vào state, chuyển vào câu đầu tiên (thuộc section/subsection đầu tiên)
    state.examState.currentAttempt = newAttempt;
    state.examState.currentExamStructure = structure;
    state.examState.activeSectionIndex = 0;
    state.examState.flatQuestions = flatQuestions;
    state.examState.passagesMap = passagesMap;
    state.examState.currentQuestionIndex = 0;
    state.examState.selectedAnswers = {};

    console.log('[exam] Attempt mới đã tạo:', newAttempt);
    console.log('[exam] Cấu trúc đề đã load:', structure);
    console.log('[exam] Danh sách câu hỏi đã làm phẳng:', flatQuestions);
    console.log('[exam] Passages map:', passagesMap);

    renderExamTaking();
  } catch (err) {
    console.error('Lỗi không xác định khi bắt đầu làm bài:', err);
    alert('Đã có lỗi xảy ra, vui lòng thử lại.');
  }
}

// ------------------------------------------------------------
// Làm phẳng cây sections -> subsections -> questions thành 1 mảng
// tuần tự, mỗi phần tử giữ kèm thông tin section/subsection cha
// để tiện hiển thị instruction_text/tiêu đề khi render từng câu.
// ------------------------------------------------------------
function flattenExamStructure(structure) {
  const flat = [];
  (structure || []).forEach(section => {
    (section.subsections || []).forEach(subsection => {
      (subsection.questions || []).forEach(q => {
        flat.push({
          ...q,
          sectionId: section.id,
          sectionTitle: section.title,
          subsectionId: subsection.id,
          instruction_text: subsection.instruction_text
        });
      });
    });
  });
  return flat;
}

// ------------------------------------------------------------
// Load nội dung passages theo danh sách passage_id (dùng chung
// cho nhiều câu hỏi cùng 1 passage_id, tránh query lặp lại).
// ------------------------------------------------------------
async function loadPassagesByIds(passageIds) {
  if (!passageIds || passageIds.length === 0) return {};

  try {
    const { data, error } = await supabaseClient
      .from('passages')
      .select('id, title, content, audio_url')
      .in('id', passageIds);

    if (error) {
      console.error('Lỗi tải passages:', error);
      return {};
    }

    const map = {};
    (data || []).forEach(p => { map[p.id] = p; });
    return map;
  } catch (err) {
    console.error('Lỗi không xác định khi tải passages:', err);
    return {};
  }
}

// ------------------------------------------------------------
// Load cấu trúc đề: exam_sections -> exam_subsections -> exam_questions
// join question_bank, sort theo order_index ở mọi cấp.
// ------------------------------------------------------------
async function loadExamStructure(examId) {
  try {
    const { data: sections, error: sectionsError } = await supabaseClient
      .from('exam_sections')
      .select('id, exam_id, skill_id, title, time_limit_seconds, order_index')
      .eq('exam_id', examId)
      .order('order_index', { ascending: true });

    if (sectionsError) {
      console.error('Lỗi tải exam_sections:', sectionsError);
      return null;
    }

    const sectionIds = (sections || []).map(s => s.id);
    let subsectionsBySection = {};

    if (sectionIds.length > 0) {
      const { data: subsections, error: subsectionsError } = await supabaseClient
        .from('exam_subsections')
        .select('id, exam_section_id, instruction_text, order_index')
        .in('exam_section_id', sectionIds)
        .order('order_index', { ascending: true });

      if (subsectionsError) {
        console.error('Lỗi tải exam_subsections:', subsectionsError);
        return null;
      }

      (subsections || []).forEach(sub => {
        if (!subsectionsBySection[sub.exam_section_id]) {
          subsectionsBySection[sub.exam_section_id] = [];
        }
        subsectionsBySection[sub.exam_section_id].push(sub);
      });
    }

    const allSubsectionIds = Object.values(subsectionsBySection).flat().map(s => s.id);
    let questionsBySubsection = {};

    if (allSubsectionIds.length > 0) {
      const { data: questions, error: questionsError } = await supabaseClient
        .from('exam_questions')
        .select(`
          id, exam_subsection_id, question_id, order_index, points,
          question_bank (
            id, skill_id, passage_id, question_type, question_text,
            audio_url, choices, correct_answer, explanation, difficulty
          )
        `)
        .in('exam_subsection_id', allSubsectionIds)
        .order('order_index', { ascending: true });

      if (questionsError) {
        console.error('Lỗi tải exam_questions:', questionsError);
        return null;
      }

      (questions || []).forEach(q => {
        if (!questionsBySubsection[q.exam_subsection_id]) {
          questionsBySubsection[q.exam_subsection_id] = [];
        }
        questionsBySubsection[q.exam_subsection_id].push(q);
      });
    }

    // Ghép lại thành cây lồng nhau, đã sort sẵn theo order_index ở từng cấp
    const structuredSections = (sections || []).map(section => {
      const subsections = (subsectionsBySection[section.id] || []).map(sub => {
        return {
          ...sub,
          questions: questionsBySubsection[sub.id] || []
        };
      });
      return {
        ...section,
        subsections
      };
    });

    return structuredSections;
  } catch (err) {
    console.error('Lỗi không xác định khi load cấu trúc đề:', err);
    return null;
  }
}

// ------------------------------------------------------------
// Render màn làm bài — chỉ hiện câu hỏi hiện tại (currentQuestionIndex).
// CHƯA làm điều hướng (next/back), autosave, timer — chỉ render.
// ------------------------------------------------------------
function renderExamTaking() {
  switchMainSection('exam-taking');

  const zone = document.getElementById('exam-taking-zone');
  if (!zone) {
    console.error('Không tìm thấy #exam-taking-zone trong HTML. Cần thêm container này.');
    return;
  }

  const flatQuestions = state.examState.flatQuestions;
  const idx = state.examState.currentQuestionIndex;
  const current = flatQuestions[idx];

  if (!current) {
    zone.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:40px 20px;">
        <div style="color:var(--ink-mute); font-size:13px;">Đề thi này chưa có câu hỏi nào.</div>
      </div>
    `;
    return;
  }

  const qb = current.question_bank || {};
  const passage = qb.passage_id ? state.examState.passagesMap[qb.passage_id] : null;

  let html = '';

  // Lưới số câu hỏi trong phạm vi section hiện tại (current.sectionId),
  // click nhảy tự do tới bất kỳ câu nào trong cùng section.
  html += renderQuestionNavGrid(current.sectionId, idx);

  // Instruction của subsection hiện tại — tự đổi khi qua câu thuộc subsection khác
  // vì luôn đọc trực tiếp từ current.instruction_text mỗi lần render.
  html += `
    <div class="exam-instruction-box">
      <div class="exam-instruction-label">${current.sectionTitle || ''}</div>
      <div class="exam-instruction-text">${current.instruction_text || ''}</div>
    </div>
  `;

  // Passage dùng chung cho các câu cùng passage_id — hiện phía trên câu hỏi
  if (passage) {
    html += `
      <div class="exam-passage-box">
        ${passage.title ? `<div class="exam-passage-title">${passage.title}</div>` : ''}
        ${passage.audio_url ? `
          <button class="btn btn-outline exam-audio-btn" onclick="playExamAudio('${passage.audio_url}')">
            <i class="ti ti-player-play"></i> Nghe đoạn hội thoại
          </button>
        ` : ''}
        ${passage.content ? `<div class="exam-passage-content">${passage.content}</div>` : ''}
      </div>
    `;
  }

  // Nội dung câu hỏi theo đúng loại
  html += `<div class="exam-question-block">`;
  html += `<div class="exam-question-content">${qb.question_text || ''}</div>`;

  if (qb.audio_url) {
    html += `
      <button class="btn btn-outline exam-audio-btn" onclick="playExamAudio('${qb.audio_url}')">
        <i class="ti ti-player-play"></i> Nghe audio
      </button>
    `;
  }

  if (qb.question_type === 'multiple_choice') {
    html += renderMultipleChoiceAnswers(current.id, qb.choices, qb.correct_answer);
  } else if (qb.question_type === 'fill_blank') {
    html += renderFillBlankAnswer(current.id);
  }

  const isFlagged = !!state.examState.flaggedQuestions[current.id];
  html += `
    <label class="exam-flag-checkbox">
      <input type="checkbox" ${isFlagged ? 'checked' : ''} onchange="toggleFlagCurrentQuestion()" />
      Đánh dấu để xem lại
    </label>
  `;

  html += `</div>`;

  // Nút điều hướng Câu trước / Câu sau — chặn ở ranh giới section:
  // không cho "Câu trước" ra khỏi section trước, "Câu sau" ở câu cuối
  // section phải qua xác nhận chuyển section (chuẩn bị chỗ móc timer sau này).
  const prevQuestion = flatQuestions[idx - 1];
  const nextQuestion = flatQuestions[idx + 1];
  const isFirstInSection = !prevQuestion || prevQuestion.sectionId !== current.sectionId;
  const isLastInSection = !nextQuestion || nextQuestion.sectionId !== current.sectionId;
  const isLastQuestionOfExam = idx === flatQuestions.length - 1;

  html += `
    <div class="exam-nav-buttons">
      <button class="btn btn-outline" onclick="goToPrevQuestion()" ${isFirstInSection ? 'disabled' : ''}>
        <i class="ti ti-arrow-left"></i> Câu trước
      </button>
      <button class="btn btn-outline" onclick="goToNextQuestion()" ${isLastQuestionOfExam ? 'disabled' : ''}>
        ${isLastInSection && !isLastQuestionOfExam ? 'Hoàn thành phần này' : 'Câu sau'} <i class="ti ti-arrow-right"></i>
      </button>
    </div>
  `;

  zone.innerHTML = html;
}

// ------------------------------------------------------------
// Lưới số câu hỏi trong phạm vi section hiện tại — đánh số 1..n
// theo thứ tự trong section (không phải index toàn đề), click
// nhảy tự do tới bất kỳ câu nào cùng section.
// 4 trạng thái: chưa làm / đã làm / đã đánh dấu / đang xem
// ------------------------------------------------------------
function renderQuestionNavGrid(sectionId, activeGlobalIndex) {
  const flatQuestions = state.examState.flatQuestions;

  const sectionQuestions = flatQuestions
    .map((q, globalIndex) => ({ q, globalIndex }))
    .filter(item => item.q.sectionId === sectionId);

  const cellsHtml = sectionQuestions.map((item, localIndex) => {
    const { q, globalIndex } = item;
    const isActive = globalIndex === activeGlobalIndex;
    const isFlagged = !!state.examState.flaggedQuestions[q.id];
    const isAnswered = state.examState.selectedAnswers[q.id] !== undefined
      && state.examState.selectedAnswers[q.id] !== '';

    // Ưu tiên hiển thị: đang xem > đã đánh dấu > đã làm > chưa làm
    let stateClass = 'exam-navnum-empty';
    if (isFlagged) stateClass = 'exam-navnum-flagged';
    if (isAnswered) stateClass = 'exam-navnum-done';
    if (isActive) stateClass = 'exam-navnum-active';

    return `
      <button
        type="button"
        class="exam-navnum ${stateClass}"
        onclick="goToQuestionIndex(${globalIndex})"
      >${localIndex + 1}</button>
    `;
  }).join('');

  return `<div class="exam-navnum-grid">${cellsHtml}</div>`;
}

// ------------------------------------------------------------
// Điều hướng câu hỏi — nhảy tự do (từ lưới), câu trước/sau (từ nút)
// ------------------------------------------------------------
function goToQuestionIndex(globalIndex) {
  const flatQuestions = state.examState.flatQuestions;
  if (globalIndex < 0 || globalIndex >= flatQuestions.length) return;
  state.examState.currentQuestionIndex = globalIndex;
  renderExamTaking();
}

function goToPrevQuestion() {
  const flatQuestions = state.examState.flatQuestions;
  const idx = state.examState.currentQuestionIndex;
  const prevQuestion = flatQuestions[idx - 1];

  // Chặn cứng: không cho lùi ra khỏi section hiện tại (đúng thi thật,
  // không quay lại phần trước sau khi đã rời phần đó).
  if (!prevQuestion || prevQuestion.sectionId !== flatQuestions[idx].sectionId) return;

  goToQuestionIndex(idx - 1);
}

function goToNextQuestion() {
  const flatQuestions = state.examState.flatQuestions;
  const idx = state.examState.currentQuestionIndex;
  const current = flatQuestions[idx];
  const nextQuestion = flatQuestions[idx + 1];

  if (!nextQuestion) return; // đã ở câu cuối cùng của đề

  const isCrossingSection = nextQuestion.sectionId !== current.sectionId;

  if (isCrossingSection) {
    // TODO: khi làm timer, đây là chỗ dừng đồng hồ section cũ + khởi động
    // đồng hồ section mới. Hiện chỉ dùng confirm() đơn giản để xác nhận chuyển.
    const confirmed = confirm(
      `Bạn đã hoàn thành phần "${current.sectionTitle || ''}". ` +
      `Sau khi chuyển sang phần tiếp theo, bạn sẽ không thể quay lại phần này. Tiếp tục?`
    );
    if (!confirmed) return;
  }

  goToQuestionIndex(idx + 1);
}

// Toggle checkbox "Đánh dấu để xem lại" cho câu đang xem — chỉ update
// state.examState.flaggedQuestions, CHƯA lưu is_flagged xuống attempt_answers.
function toggleFlagCurrentQuestion() {
  const current = state.examState.flatQuestions[state.examState.currentQuestionIndex];
  if (!current) return;

  const isFlagged = !!state.examState.flaggedQuestions[current.id];
  if (isFlagged) {
    delete state.examState.flaggedQuestions[current.id];
  } else {
    state.examState.flaggedQuestions[current.id] = true;
  }
  renderExamTaking();
}

// ------------------------------------------------------------
// Render đáp án multiple_choice — choices hiện đang là mảng string
// (có thể là text thuần hoặc HTML <img>), render bằng innerHTML.
// ------------------------------------------------------------
function renderMultipleChoiceAnswers(examQuestionId, choices, correctAnswer) {
  if (!Array.isArray(choices)) return '';

  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  const selected = state.examState.selectedAnswers[examQuestionId];

  const optionsHtml = choices.map((choiceValue, i) => {
    const label = labels[i] || (i + 1);
    const isSelected = selected === choiceValue;
    return `
      <button
        type="button"
        class="exam-choice-btn ${isSelected ? 'selected' : ''}"
        onclick="selectExamAnswer('${examQuestionId}', ${escapeForAttr(choiceValue)})"
      >
        <span class="exam-choice-label">${label}</span>
        <span class="exam-choice-content">${choiceValue}</span>
      </button>
    `;
  }).join('');

  return `<div class="exam-choices-grid">${optionsHtml}</div>`;
}

// ------------------------------------------------------------
// Render input fill_blank — input text đơn giản, chưa autosave.
// ------------------------------------------------------------
function renderFillBlankAnswer(examQuestionId) {
  const currentValue = state.examState.selectedAnswers[examQuestionId] || '';
  return `
    <div class="exam-fill-blank-wrap">
      <input
        type="text"
        class="exam-fill-blank-input"
        placeholder="Nhập câu trả lời..."
        value="${escapeHtml(currentValue)}"
        oninput="selectExamAnswer('${examQuestionId}', this.value)"
      />
    </div>
  `;
}

// Lưu tạm đáp án học viên chọn/nhập vào state (chưa ghi xuống Supabase ở bước này)
function selectExamAnswer(examQuestionId, value) {
  state.examState.selectedAnswers[examQuestionId] = value;
  renderExamTaking();
}

// Escape giá trị để nhét an toàn vào onclick='...' dạng string literal JS
function escapeForAttr(value) {
  return JSON.stringify(String(value));
}

// Escape để hiển thị trong attribute value="" của input (fill_blank)
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ------------------------------------------------------------
// Phát audio cho câu hỏi/đoạn văn — tái dùng state.currentAudio
// và stopCurrentAudio() đã có sẵn ở app.js, không tạo cơ chế audio mới.
// ------------------------------------------------------------
function playExamAudio(url) {
  stopCurrentAudio();
  state.currentAudio = new Audio(url);
  state.currentAudio.play().catch(e => console.log(e));
}


// ------------------------------------------------------------
// Placeholder actions — CHƯA implement logic thật, chỉ để UI có phản hồi
// ------------------------------------------------------------
function continueExamAttempt(attemptId) {
  alert('Chức năng tiếp tục làm bài sẽ được triển khai ở bước tiếp theo. attempt_id: ' + attemptId);
}

function viewExamAttemptResult(attemptId) {
  alert('Chức năng xem lại bài làm sẽ được triển khai ở bước tiếp theo. attempt_id: ' + attemptId);
}
