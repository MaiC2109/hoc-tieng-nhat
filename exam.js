'use strict';
// ============================================================
//  EXAM MODULE (Luyện đề)
//  File này load SAU app.js trong index.html nên dùng chung
//  `state` global và `supabaseClient` đã khởi tạo sẵn ở app.js,
//  không tạo thêm Supabase client thứ 2.
// ============================================================

// Sub-state riêng cho module Luyện đề, gắn vào state chung
// theo đúng convention các module khác (quizState, flashcardState...).
// Debounce timer cho autosave fill_blank khi blur — biến runtime thuần túy,
// không thuộc `state` vì không phải dữ liệu app cần track/log.
const examFillBlankDebounceTimers = {};

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
  flaggedQuestions: {},          // { [exam_questions.id]: true } — đánh dấu "xem lại", CHƯA lưu DB (is_flagged), chỉ ở state
  saveStatus: {},                // { [exam_questions.id]: { status: 'saving'|'saved'|'error', message } } — trạng thái autosave từng câu
  sectionsById: {},              // { [exam_section_id]: section row (title, time_limit_seconds...) } — build lúc load đề
  lockedSections: {},            // { [exam_section_id]: true } — section đã hết giờ, khóa input
  timerActiveSectionId: null,    // section_id đang chạy đồng hồ, dùng để phát hiện khi nào cần khởi động lại timer
  currentSectionTimerId: null    // id trả về từ setInterval, dùng để clearInterval khi đổi section
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

    // Build map tra cứu nhanh section theo id (title, time_limit_seconds...)
    // dùng cho timer, không phải duyệt lại cây mỗi lần.
    const sectionsById = {};
    (structure || []).forEach(section => { sectionsById[section.id] = section; });
    state.examState.sectionsById = sectionsById;

    // Reset trạng thái timer/khóa section cho attempt mới
    state.examState.lockedSections = {};
    state.examState.timerActiveSectionId = null;
    clearSectionTimer();

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
// CHƯA làm nộp bài thật (chỉ gọi placeholder submitExamAttempt ở bước 9).
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
    clearSectionTimer();
    zone.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:40px 20px;">
        <div style="color:var(--ink-mute); font-size:13px;">Đề thi này chưa có câu hỏi nào.</div>
      </div>
    `;
    return;
  }

  // Phát hiện khi chuyển sang section khác (kể cả lần render đầu tiên) để
  // khởi động lại timer đúng section — không restart timer nếu vẫn cùng
  // section (renderExamTaking() được gọi rất nhiều lần: chọn đáp án, flag...).
  if (state.examState.timerActiveSectionId !== current.sectionId) {
    state.examState.timerActiveSectionId = current.sectionId;
    startSectionTimer(current.sectionId);
  }

  const qb = current.question_bank || {};
  const passage = qb.passage_id ? state.examState.passagesMap[qb.passage_id] : null;
  const isSectionLocked = !!state.examState.lockedSections[current.sectionId];

  let html = '';

  // Đồng hồ đếm ngược của section hiện tại
  html += `
    <div class="exam-timer-bar">
      <span class="exam-timer-section-name">${current.sectionTitle || ''}</span>
      <span class="exam-timer-display" id="exam-timer-display">--:--</span>
    </div>
  `;

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

  if (isSectionLocked) {
    html += `
      <div class="exam-locked-banner">
        <i class="ti ti-lock"></i> Đã hết giờ phần này — câu trả lời không thể chỉnh sửa thêm.
      </div>
    `;
  }

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

  // Nội dung câu hỏi theo đúng loại — chuẩn hóa question_type (trim/lowercase)
  // để tránh lệch do khoảng trắng/hoa-thường lỡ nhập từ admin, và LUÔN có
  // fallback hiển thị rõ nếu vẫn không khớp, thay vì để trống âm thầm.
  html += `<div class="exam-question-block">`;
  html += `<div class="exam-question-content">${qb.question_text || ''}</div>`;

  if (qb.audio_url) {
    html += `
      <button class="btn btn-outline exam-audio-btn" onclick="playExamAudio('${qb.audio_url}')">
        <i class="ti ti-player-play"></i> Nghe audio
      </button>
    `;
  }

  const normalizedType = (qb.question_type || '').trim().toLowerCase();

  if (normalizedType === 'multiple_choice') {
    if (Array.isArray(qb.choices) && qb.choices.length > 0) {
      html += renderMultipleChoiceAnswers(current, qb.choices, qb.correct_answer, isSectionLocked);
    } else {
      console.warn('[exam] Câu multiple_choice nhưng thiếu/rỗng choices:', current.id, qb);
      html += `<div class="exam-question-warning">⚠️ Câu hỏi này chưa có đáp án (choices rỗng trong question_bank).</div>`;
    }
  } else if (normalizedType === 'fill_blank') {
    html += renderFillBlankAnswer(current, isSectionLocked);
  } else {
    console.warn('[exam] question_type không nhận diện được:', JSON.stringify(qb.question_type), '- câu:', current.id, qb);
    html += `<div class="exam-question-warning">⚠️ Không nhận diện được loại câu hỏi ("${qb.question_type}"). Kiểm tra lại question_bank.question_type trong DB.</div>`;
  }

  html += renderSaveStatusIndicator(current.id);

  const isFlagged = !!state.examState.flaggedQuestions[current.id];
  html += `
    <label class="exam-flag-checkbox">
      <input type="checkbox" ${isFlagged ? 'checked' : ''} ${isSectionLocked ? 'disabled' : ''} onchange="toggleFlagCurrentQuestion()" />
      Đánh dấu để xem lại
    </label>
  `;

  html += `</div>`;

  // Nút điều hướng Câu trước / Câu sau — chặn ở ranh giới section:
  // không cho "Câu trước" ra khỏi section trước, "Câu sau" ở câu cuối
  // section phải qua xác nhận chuyển section.
  const prevQuestion = flatQuestions[idx - 1];
  const nextQuestion = flatQuestions[idx + 1];
  const isFirstInSection = !prevQuestion || prevQuestion.sectionId !== current.sectionId;
  const isLastInSection = !nextQuestion || nextQuestion.sectionId !== current.sectionId;
  const isLastQuestionOfExam = idx === flatQuestions.length - 1;

  html += `
    <div class="exam-nav-buttons">
      <button class="btn btn-outline" onclick="goToPrevQuestion()" ${isFirstInSection || isSectionLocked ? 'disabled' : ''}>
        <i class="ti ti-arrow-left"></i> Câu trước
      </button>
      <button class="btn btn-primary" onclick="submitExamAttempt()">
        Nộp bài
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

// Toggle checkbox "Đánh dấu để xem lại" cho câu đang xem — update state
// và upsert is_flagged ngay xuống attempt_answers.
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

  upsertAttemptAnswer(current, { is_flagged: !isFlagged });
}

// ------------------------------------------------------------
// Render đáp án multiple_choice — choices hiện đang là mảng string
// (có thể là text thuần hoặc HTML <img>), render bằng innerHTML.
// Nhận `current` (item trong flatQuestions) thay vì chỉ id, để có
// sẵn current.question_id (FK question_bank) dùng cho autosave.
// ------------------------------------------------------------
function renderMultipleChoiceAnswers(current, choices, correctAnswer, isLocked) {
  if (!Array.isArray(choices)) return '';

  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  const selected = state.examState.selectedAnswers[current.id];

  const optionsHtml = choices.map((choiceValue, i) => {
    const label = labels[i] || (i + 1);
    const isSelected = selected === choiceValue;
    // Truyền INDEX thay vì giá trị đáp án thô vào onclick — đáp án có thể
    // chứa dấu ngoặc kép (HTML <img src="..." alt="...">), nếu escape rồi
    // nhét thẳng vào thuộc tính onclick="..." (cũng dùng ngoặc kép) sẽ làm
    // vỡ HTML attribute giữa chừng khiến click không chạy được hàm gì cả.
    // Dùng index -> selectMultipleChoiceAnswer tự tra lại đúng giá trị gốc
    // từ choices[i], tuyệt đối an toàn, không cần escape.
    return `
      <button
        type="button"
        class="exam-choice-btn ${isSelected ? 'selected' : ''}"
        ${isLocked ? 'disabled' : `onclick="selectMultipleChoiceAnswer('${current.id}', ${i})"`}
      >
        <span class="exam-choice-label">${label}</span>
        <span class="exam-choice-content">${choiceValue}</span>
      </button>
    `;
  }).join('');

  return `<div class="exam-choices-grid">${optionsHtml}</div>`;
}

// ------------------------------------------------------------
// Render input fill_blank — autosave khi blur, debounce nhẹ.
// ------------------------------------------------------------
function renderFillBlankAnswer(current, isLocked) {
  const currentValue = state.examState.selectedAnswers[current.id] || '';
  return `
    <div class="exam-fill-blank-wrap">
      <input
        type="text"
        class="exam-fill-blank-input"
        placeholder="Nhập câu trả lời..."
        value="${escapeHtml(currentValue)}"
        ${isLocked ? 'disabled' : `
          oninput="handleFillBlankInput('${current.id}', this.value)"
          onblur="handleFillBlankBlur('${current.id}')"
        `}
      />
    </div>
  `;
}

// ------------------------------------------------------------
// multiple_choice: chọn xong autosave NGAY (không debounce, vì click
// là hành động rời rạc, không cần đợi).
// Nhận choiceIndex thay vì giá trị đáp án thô (xem lý do ở renderMultipleChoiceAnswers).
// ------------------------------------------------------------
function selectMultipleChoiceAnswer(examQuestionId, choiceIndex) {
  const current = state.examState.flatQuestions.find(q => q.id === examQuestionId);
  if (!current) return;

  const choices = current.question_bank && current.question_bank.choices;
  if (!Array.isArray(choices) || !choices[choiceIndex]) return;

  const value = choices[choiceIndex];

  state.examState.selectedAnswers[examQuestionId] = value;
  renderExamTaking();

  upsertAttemptAnswer(current, { selected_answer: value });
}

// ------------------------------------------------------------
// fill_blank: gõ chỉ cập nhật local state (KHÔNG re-render toàn bộ,
// tránh làm input mất focus/con trỏ giữa chừng khi đang gõ).
// ------------------------------------------------------------
function handleFillBlankInput(examQuestionId, value) {
  state.examState.selectedAnswers[examQuestionId] = value;
  // Không gọi renderExamTaking() ở đây — chỉ lưu tạm, tránh phá input đang gõ.
}

// fill_blank: khi rời khỏi ô input (blur) mới autosave, có debounce nhẹ
// để tránh spam upsert nếu blur/focus liên tục trong thời gian ngắn.
function handleFillBlankBlur(examQuestionId) {
  const current = state.examState.flatQuestions.find(q => q.id === examQuestionId);
  if (!current) return;

  const value = state.examState.selectedAnswers[examQuestionId] || '';

  // Hiện "Đang lưu..." ngay, rồi debounce việc gọi upsert thật sự.
  setSaveStatus(examQuestionId, 'saving');
  renderSaveStatusIndicatorInPlace(examQuestionId);

  clearTimeout(examFillBlankDebounceTimers[examQuestionId]);
  examFillBlankDebounceTimers[examQuestionId] = setTimeout(() => {
    upsertAttemptAnswer(current, { selected_answer: value });
  }, 900); // debounce nhẹ ~0.9s, trong khoảng ≤1-2s yêu cầu
}

// ------------------------------------------------------------
// Upsert 1 hoặc nhiều field vào attempt_answers theo (attempt_id, question_id).
// Lưu ý: attempt_answers.question_id trỏ tới question_bank.id, TỨC LÀ
// current.question_id (cột FK có sẵn trên exam_questions) — không phải
// current.id (là id của bảng exam_questions, chỉ dùng làm key state cục bộ).
// ------------------------------------------------------------
async function upsertAttemptAnswer(current, fields) {
  const attemptId = state.examState.currentAttempt && state.examState.currentAttempt.id;
  if (!attemptId) {
    console.error('Không có attempt_id hiện tại, không thể lưu đáp án.');
    return;
  }

  setSaveStatus(current.id, 'saving');
  renderSaveStatusIndicatorInPlace(current.id);

  try {
    const { error } = await supabaseClient
      .from('attempt_answers')
      .upsert(
        {
          attempt_id: attemptId,
          question_id: current.question_id,
          answered_at: new Date().toISOString(),
          ...fields
        },
        { onConflict: 'attempt_id,question_id' }
      );

    if (error) throw error;

    setSaveStatus(current.id, 'saved');
  } catch (err) {
    // KHÔNG nuốt lỗi — log rõ + báo lỗi lên UI cho học viên biết đáp án chưa lưu được.
    console.error('Lỗi lưu đáp án (attempt_answers upsert):', err);
    setSaveStatus(current.id, 'error', err.message || 'Không thể lưu đáp án, vui lòng thử lại.');
  }

  renderSaveStatusIndicatorInPlace(current.id);
}

function setSaveStatus(examQuestionId, status, message) {
  state.examState.saveStatus[examQuestionId] = { status, message: message || '' };
}

// ------------------------------------------------------------
// Chỉ render lại khối chỉ báo "Đang lưu.../Đã lưu tự động/Lỗi" —
// KHÔNG re-render toàn bộ màn hình, để không phá focus của input
// đang gõ hoặc gây giật khi autosave chạy nền.
// ------------------------------------------------------------
function renderSaveStatusIndicatorInPlace(examQuestionId) {
  const el = document.getElementById(`exam-save-status-${examQuestionId}`);
  if (!el) return; // câu hỏi đang hiện không phải câu này nữa thì bỏ qua, không lỗi gì
  el.outerHTML = renderSaveStatusIndicator(examQuestionId);
}

function renderSaveStatusIndicator(examQuestionId) {
  const info = state.examState.saveStatus[examQuestionId];
  if (!info) {
    return `<div class="exam-save-status" id="exam-save-status-${examQuestionId}"></div>`;
  }

  if (info.status === 'saving') {
    return `<div class="exam-save-status exam-save-status-saving" id="exam-save-status-${examQuestionId}">Đang lưu...</div>`;
  }
  if (info.status === 'saved') {
    return `<div class="exam-save-status exam-save-status-saved" id="exam-save-status-${examQuestionId}"><i class="ti ti-check"></i> Đã lưu tự động</div>`;
  }
  if (info.status === 'error') {
    return `<div class="exam-save-status exam-save-status-error" id="exam-save-status-${examQuestionId}"><i class="ti ti-alert-triangle"></i> Lỗi lưu: ${escapeHtml(info.message)}</div>`;
  }
  return `<div class="exam-save-status" id="exam-save-status-${examQuestionId}"></div>`;
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

// ============================================================
// TIMER THEO SECTION
// Nguyên tắc: KHÔNG dựa hoàn toàn vào setInterval đếm lùi trong bộ nhớ
// (dễ sai khi tab bị treo/máy sleep). Mỗi tick đều tính lại từ đầu:
// remaining = time_limit_seconds - (Date.now() - section_started_at).
// section_started_at lưu ở exam_attempts.section_timing (jsonb), nên
// F5 lại trang (khi làm continueExamAttempt sau này) vẫn tính đúng.
// ============================================================

// Đảm bảo section đã có started_at — nếu chưa có thì set now() và lưu DB,
// nếu có rồi (ví dụ quay lại xem sau khi F5) thì dùng lại giá trị cũ.
async function ensureSectionStartedAt(sectionId) {
  const attempt = state.examState.currentAttempt;
  if (!attempt) return null;

  const timing = attempt.section_timing || {};
  if (timing[sectionId]) {
    return timing[sectionId];
  }

  const startedAt = new Date().toISOString();
  const newTiming = { ...timing, [sectionId]: startedAt };

  try {
    const { error } = await supabaseClient
      .from('exam_attempts')
      .update({ section_timing: newTiming })
      .eq('id', attempt.id);

    if (error) {
      // Không chặn học viên làm bài nếu lưu timing lỗi, nhưng log rõ vì
      // lần sau F5 (continueExamAttempt) sẽ tính lại từ đầu — không chính xác.
      console.error('Lỗi lưu section_timing:', error);
    }
  } catch (err) {
    console.error('Lỗi không xác định khi lưu section_timing:', err);
  }

  // Cập nhật cache local dù DB có lỗi hay không, để timer vẫn chạy đúng trong phiên này.
  attempt.section_timing = newTiming;
  return startedAt;
}

// Khởi động timer cho 1 section — gọi mỗi khi vào section mới (kể cả lần đầu).
function startSectionTimer(sectionId) {
  clearSectionTimer();

  const section = state.examState.sectionsById[sectionId];
  if (!section || !section.time_limit_seconds) {
    console.error('Không tìm thấy section hoặc thiếu time_limit_seconds:', sectionId);
    return;
  }

  ensureSectionStartedAt(sectionId).then(startedAtIso => {
    if (!startedAtIso) return;

    // Nếu section đang được xem lúc này không còn là section đang active nữa
    // (học viên bấm rất nhanh qua nhiều câu), bỏ qua để tránh 2 timer chồng nhau.
    if (state.examState.timerActiveSectionId !== sectionId) return;

    tickSectionTimer(sectionId, section.time_limit_seconds, startedAtIso);
    state.examState.currentSectionTimerId = setInterval(() => {
      tickSectionTimer(sectionId, section.time_limit_seconds, startedAtIso);
    }, 1000);
  });
}

function clearSectionTimer() {
  if (state.examState.currentSectionTimerId) {
    clearInterval(state.examState.currentSectionTimerId);
    state.examState.currentSectionTimerId = null;
  }
}

// Tính lại remaining từ mốc thời gian thật mỗi lần tick (không phải đếm lùi biến số).
function tickSectionTimer(sectionId, limitSeconds, startedAtIso) {
  const elapsedSeconds = Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 1000);
  const remaining = limitSeconds - elapsedSeconds;

  updateTimerDisplay(remaining);

  if (remaining <= 0) {
    clearSectionTimer();
    handleSectionTimeout(sectionId);
  }
}

// Chỉ update text đồng hồ trực tiếp qua DOM — KHÔNG gọi renderExamTaking()
// mỗi giây, tránh phá input đang gõ / giật màn hình liên tục.
function updateTimerDisplay(remainingSeconds) {
  const el = document.getElementById('exam-timer-display');
  if (!el) return;

  const clamped = Math.max(0, remainingSeconds);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  el.textContent = `${m}:${String(s).padStart(2, '0')}`;

  el.classList.toggle('exam-timer-warning', clamped > 0 && clamped <= 300);
  el.classList.toggle('exam-timer-danger', clamped > 0 && clamped <= 60);
}

// Xử lý khi 1 section hết giờ: khóa input, thông báo, rồi tự chuyển
// sang section tiếp theo — hoặc gọi nộp bài (bước 9) nếu là section cuối.
function handleSectionTimeout(sectionId) {
  state.examState.lockedSections[sectionId] = true;

  const section = state.examState.sectionsById[sectionId];
  const flatQuestions = state.examState.flatQuestions;

  // Tìm vị trí câu hỏi đầu tiên của section tiếp theo (nếu có), bằng cách
  // tìm index cuối cùng thuộc sectionId này rồi +1.
  let lastIndexOfSection = -1;
  flatQuestions.forEach((q, i) => {
    if (q.sectionId === sectionId) lastIndexOfSection = i;
  });
  const nextIndex = lastIndexOfSection + 1;
  const hasNextSection = nextIndex < flatQuestions.length;

  alert(`Đã hết giờ phần "${section ? section.title : ''}". ` +
    (hasNextSection
      ? 'Hệ thống sẽ tự động chuyển sang phần tiếp theo.'
      : 'Bài làm sẽ được nộp tự động.'));

  if (hasNextSection) {
    state.examState.currentQuestionIndex = nextIndex;
    renderExamTaking(); // renderExamTaking tự phát hiện đổi section và khởi động timer mới
  } else {
    submitExamAttempt({ skipConfirm: true }); // section cuối hết giờ -> tự nộp, không hỏi lại
  }
}

// ============================================================
// NỘP BÀI — chấm điểm, tính total_score/section_scores, cập nhật status.
// ============================================================
async function submitExamAttempt(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;

  const attempt = state.examState.currentAttempt;
  if (!attempt) {
    console.error('Không có attempt hiện tại, không thể nộp bài.');
    return;
  }

  // Nộp thủ công (nút "Nộp bài") -> hỏi xác nhận, kèm số câu chưa trả lời.
  // Nộp tự động (hết giờ section cuối) -> bỏ qua confirm, nộp ngay.
  if (!skipConfirm) {
    const flatQuestions = state.examState.flatQuestions;
    const answeredCount = flatQuestions.filter(q => {
      const val = state.examState.selectedAnswers[q.id];
      return val !== undefined && val !== null && val !== '';
    }).length;
    const unansweredCount = flatQuestions.length - answeredCount;

    const confirmMsg = unansweredCount > 0
      ? `Bạn còn ${unansweredCount} câu chưa trả lời, chắc chắn muốn nộp bài?`
      : 'Nộp bài — không thể chỉnh sửa sau khi nộp. Xác nhận?';

    if (!confirm(confirmMsg)) return;
  }

  clearSectionTimer();

  try {
    // 1. Lấy toàn bộ attempt_answers đã lưu của attempt này
    const { data: savedAnswers, error: answersError } = await supabaseClient
      .from('attempt_answers')
      .select('id, question_id, selected_answer')
      .eq('attempt_id', attempt.id);

    if (answersError) throw answersError;

    // Map question_bank.id -> { correctAnswer, points, skillId } lấy từ
    // flatQuestions đã có sẵn (question_bank đã join lúc load cấu trúc đề).
    const questionInfoByBankId = {};
    state.examState.flatQuestions.forEach(q => {
      questionInfoByBankId[q.question_id] = {
        correctAnswer: q.question_bank ? q.question_bank.correct_answer : null,
        points: q.points || 1,
        skillId: q.question_bank ? q.question_bank.skill_id : null
      };
    });

    // 2. Chấm từng attempt_answers: so chuỗi trực tiếp — multiple_choice và
    // fill_blank dùng chung 1 rule (exact match), đúng như đã chốt trước đó.
    const gradedByBankId = {}; // { question_bank_id: true/false } — dùng để tính điểm ở bước 3
    for (const ans of (savedAnswers || [])) {
      const info = questionInfoByBankId[ans.question_id];
      if (!info) continue; // câu không còn thuộc đề (phòng hờ)

      const isCorrect = ans.selected_answer != null && ans.selected_answer === info.correctAnswer;
      gradedByBankId[ans.question_id] = isCorrect;

      // Update từng row — Supabase không hỗ trợ update nhiều giá trị is_correct
      // khác nhau trong 1 câu lệnh duy nhất nên phải loop, chấp nhận được ở
      // quy mô đề thi hiện tại (vài chục câu).
      const { error: updateError } = await supabaseClient
        .from('attempt_answers')
        .update({ is_correct: isCorrect })
        .eq('id', ans.id);

      if (updateError) {
        console.error('Lỗi cập nhật is_correct cho câu trả lời:', ans.id, updateError);
      }
    }

    // 3. Tính total_score / total_possible / section_scores (group theo skill_code)
    // Gom skill_id từ cả question_bank lẫn section (phòng trường hợp fallback
    // phải dùng section.skill_id) để query 1 lần, tránh query thiếu.
    const sectionSkillIds = Object.values(state.examState.sectionsById)
      .map(s => s.skill_id)
      .filter(id => id != null);
    const skillIds = [...new Set([
      ...Object.values(questionInfoByBankId).map(i => i.skillId).filter(id => id != null),
      ...sectionSkillIds
    ])];

    let skillCodeById = {};
    if (skillIds.length > 0) {
      const { data: skillsData, error: skillsError } = await supabaseClient
        .from('skills')
        .select('id, code')
        .in('id', skillIds);

      if (skillsError) {
        console.error('Lỗi tải skills:', skillsError);
      } else {
        (skillsData || []).forEach(s => { skillCodeById[s.id] = s.code; });
      }
    }

    let totalScore = 0;
    let totalPossible = 0;
    const sectionScores = {}; // { "<skill_code>": { score, total } }

    state.examState.flatQuestions.forEach(q => {
      const points = q.points || 1;

      // Ưu tiên skill_id của chính câu hỏi (question_bank.skill_id). Nếu vì lý
      // do nào đó không lấy được (join lỗi/thiếu dữ liệu), fallback về
      // skill_id của SECTION chứa câu này — cột này NOT NULL theo schema
      // exam_sections nên luôn có giá trị, tránh group_key bị rơi về "null".
      const section = state.examState.sectionsById[q.sectionId];
      const skillId = (q.question_bank && q.question_bank.skill_id != null)
        ? q.question_bank.skill_id
        : (section ? section.skill_id : null);

      const skillCode = skillCodeById[skillId] || (skillId != null ? String(skillId) : 'khac');

      if (!sectionScores[skillCode]) {
        sectionScores[skillCode] = { score: 0, total: 0 };
      }
      sectionScores[skillCode].total += points;
      totalPossible += points;

      const isCorrect = gradedByBankId[q.question_id];
      if (isCorrect) {
        sectionScores[skillCode].score += points;
        totalScore += points;
      }
    });

    // TODO Tier 7: cập nhật question_mistake_tracker ở đây

    // 4. Cập nhật exam_attempts — status='submitted', KHÔNG tính next_retry_date/retry_note ở bước này
    const { data: updatedAttempt, error: submitError } = await supabaseClient
      .from('exam_attempts')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        total_score: totalScore,
        total_possible: totalPossible,
        section_scores: sectionScores,
        next_retry_date: null,
        retry_note: null
      })
      .eq('id', attempt.id)
      .select(`
        id, exam_id, attempt_number, status,
        total_score, total_possible, section_scores,
        started_at, submitted_at, next_retry_date, retry_note,
        exams ( title, pass_threshold_pct )
      `)
      .single();

    if (submitError) throw submitError;

    console.log('[exam] Đã nộp bài, kết quả:', updatedAttempt);

    // 5. Hiển thị màn kết quả đơn giản (dùng chung renderExamResultScreen với "Xem lại")
    renderExamResultScreen(updatedAttempt);
  } catch (err) {
    console.error('Lỗi khi nộp bài:', err);
    alert('Đã có lỗi xảy ra khi nộp bài, vui lòng thử lại. Chi tiết: ' + (err.message || err));
  }
}


// ------------------------------------------------------------
// Tiếp tục làm bài dở (status='in_progress'):
// 1. Load lại attempt + cấu trúc đề + attempt_answers đã lưu, điền sẵn
//    selected_answer/is_flagged vào đúng câu.
// 2. Đọc section_timing để xác định nên resume ở section nào theo
//    thời gian thực đã trôi qua (section nào còn giờ đầu tiên theo
//    thứ tự order_index; section nào chưa từng bắt đầu cũng tính là
//    "còn giờ" vì chưa hề chạy đồng hồ).
// 3. Nếu TẤT CẢ section đã hết giờ khi quay lại → gọi nộp bài luôn
//    (bước 9, hiện là placeholder submitExamAttempt()).
// ------------------------------------------------------------
async function continueExamAttempt(attemptId) {
  try {
    const { data: attempt, error: attemptError } = await supabaseClient
      .from('exam_attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    if (attemptError || !attempt) {
      console.error('Lỗi tải attempt:', attemptError);
      alert('Không thể tải lại bài làm dở, vui lòng thử lại.');
      return;
    }

    if (attempt.status !== 'in_progress') {
      console.warn('[exam] Attempt không còn ở trạng thái in_progress:', attempt.status);
    }

    // 1. Load lại cấu trúc đề (giống bước 3)
    const structure = await loadExamStructure(attempt.exam_id);
    if (!structure) {
      alert('Không thể tải nội dung đề thi, vui lòng thử lại.');
      return;
    }

    const flatQuestions = flattenExamStructure(structure);
    const passageIds = [...new Set(
      flatQuestions
        .map(q => q.question_bank && q.question_bank.passage_id)
        .filter(Boolean)
    )];
    const passagesMap = await loadPassagesByIds(passageIds);

    const sectionsById = {};
    (structure || []).forEach(section => { sectionsById[section.id] = section; });

    // 2. Load toàn bộ attempt_answers đã lưu của attempt này
    const { data: savedAnswers, error: answersError } = await supabaseClient
      .from('attempt_answers')
      .select('question_id, selected_answer, is_flagged')
      .eq('attempt_id', attemptId);

    if (answersError) {
      console.error('Lỗi tải attempt_answers:', answersError);
      alert('Không thể tải lại đáp án đã lưu, vui lòng thử lại.');
      return;
    }

    // attempt_answers.question_id trỏ tới question_bank.id, còn state cục bộ
    // dùng exam_questions.id làm key -> cần map ngược lại qua current.question_id.
    const questionBankIdToExamQuestionId = {};
    flatQuestions.forEach(q => { questionBankIdToExamQuestionId[q.question_id] = q.id; });

    const selectedAnswers = {};
    const flaggedQuestions = {};
    (savedAnswers || []).forEach(a => {
      const examQuestionId = questionBankIdToExamQuestionId[a.question_id];
      if (!examQuestionId) return; // câu hỏi không còn thuộc đề (hiếm, phòng hờ)

      if (a.selected_answer !== null && a.selected_answer !== undefined && a.selected_answer !== '') {
        selectedAnswers[examQuestionId] = a.selected_answer;
      }
      if (a.is_flagged) {
        flaggedQuestions[examQuestionId] = true;
      }
    });

    // Lưu vào state trước khi tính resume section (submitExamAttempt cần currentAttempt)
    state.examState.currentAttempt = attempt;
    state.examState.currentExamStructure = structure;
    state.examState.flatQuestions = flatQuestions;
    state.examState.passagesMap = passagesMap;
    state.examState.sectionsById = sectionsById;
    state.examState.selectedAnswers = selectedAnswers;
    state.examState.flaggedQuestions = flaggedQuestions;
    state.examState.saveStatus = {};
    state.examState.lockedSections = {};
    state.examState.timerActiveSectionId = null;
    clearSectionTimer();

    console.log('[exam] Resume attempt:', attempt);
    console.log('[exam] Cấu trúc đề đã load lại:', structure);
    console.log('[exam] selectedAnswers khôi phục từ attempt_answers:', selectedAnswers);
    console.log('[exam] flaggedQuestions khôi phục từ attempt_answers:', flaggedQuestions);

    // 3. Xác định section nên resume dựa vào section_timing + time_limit_seconds
    const timing = attempt.section_timing || {};
    const now = Date.now();
    let resumeSectionId = null;

    // structure đã được order theo order_index từ loadExamStructure()
    for (const section of structure) {
      const startedAtIso = timing[section.id];

      if (!startedAtIso) {
        // Section chưa từng bắt đầu -> đây chính là section nên vào (dù là
        // section đầu tiên của đề, hay section đầu tiên chưa kịp chạy vì
        // học viên thoát ngay khi section trước đó vừa hết giờ).
        resumeSectionId = section.id;
        break;
      }

      const elapsedSeconds = Math.floor((now - new Date(startedAtIso).getTime()) / 1000);
      const remaining = section.time_limit_seconds - elapsedSeconds;

      if (remaining > 0) {
        resumeSectionId = section.id;
        break;
      }

      // Section này đã hết giờ trong lúc học viên vắng mặt -> khóa lại, xét section kế tiếp.
      state.examState.lockedSections[section.id] = true;
    }

    if (!resumeSectionId) {
      // Tất cả section đều đã hết giờ khi quay lại -> nộp bài luôn.
      console.log('[exam] Tất cả section đã hết giờ khi quay lại, tự động nộp bài.');
      submitExamAttempt();
      return;
    }

    const resumeIndex = flatQuestions.findIndex(q => q.sectionId === resumeSectionId);
    state.examState.currentQuestionIndex = resumeIndex >= 0 ? resumeIndex : 0;

    console.log('[exam] Resume tại section:', resumeSectionId, '- question index:', state.examState.currentQuestionIndex);

    renderExamTaking();
  } catch (err) {
    console.error('Lỗi không xác định khi tiếp tục làm bài:', err);
    alert('Đã có lỗi xảy ra, vui lòng thử lại.');
  }
}

// ------------------------------------------------------------
// "Xem lại" — hiển thị màn điểm số đơn giản, CHỈ load total_score/
// total_possible/section_scores của attempt đã chọn, KHÔNG load lại
// toàn bộ câu hỏi/cấu trúc đề (khác hẳn continueExamAttempt).
//
// Lưu ý: Đây là lần đầu màn kết quả được code trong dự án này — trước
// đó "Bước 9" (nộp bài) mới chỉ có placeholder alert() ở submitExamAttempt(),
// chưa có UI kết quả thật để tái dùng. Hàm renderExamResultScreen() ở dưới
// được thiết kế để dùng chung cho cả 2 chỗ: "Xem lại" (ở đây) và sau này
// khi submitExamAttempt() thực sự tính điểm xong sẽ gọi lại đúng hàm này.
// ------------------------------------------------------------
async function viewExamAttemptResult(attemptId) {
  try {
    const { data: attempt, error } = await supabaseClient
      .from('exam_attempts')
      .select(`
        id, exam_id, attempt_number, status,
        total_score, total_possible, section_scores,
        started_at, submitted_at, next_retry_date, retry_note,
        exams ( title, pass_threshold_pct )
      `)
      .eq('id', attemptId)
      .single();

    if (error || !attempt) {
      console.error('Lỗi tải kết quả attempt:', error);
      alert('Không thể tải kết quả bài làm, vui lòng thử lại.');
      return;
    }

    renderExamResultScreen(attempt);
  } catch (err) {
    console.error('Lỗi không xác định khi tải kết quả:', err);
    alert('Đã có lỗi xảy ra, vui lòng thử lại.');
  }
}

// ------------------------------------------------------------
// Render màn kết quả đơn giản — dùng chung cho "Xem lại" (viewExamAttemptResult)
// và tương lai sẽ dùng lại khi submitExamAttempt() tính điểm xong.
// `attempt` cần có: total_score, total_possible, section_scores, status,
// và nested `exams` { title, pass_threshold_pct } (từ join hoặc tự gán tay).
//
// needs_retry hiển thị/xử lý giống hệt submitted ở tier này — dùng chung
// 1 khối hiển thị, chỉ khác nhãn trạng thái (statusLabelMap y hệt renderExamCard).
// ------------------------------------------------------------
function renderExamResultScreen(attempt) {
  switchMainSection('exam-result');

  const zone = document.getElementById('exam-result-zone');
  if (!zone) {
    console.error('Không tìm thấy #exam-result-zone trong HTML.');
    return;
  }

  const exam = attempt.exams || {};

  // Nếu đã có total_possible (tức là bài đã chấm xong) nhưng total_score vì
  // lý do gì đó là null (dữ liệu cũ/lỗi), coi như 0 điểm — KHÔNG để lộ chữ
  // "null" ra UI. Chỉ hiện dấu "—" khi bài thực sự chưa được chấm (cả 2 đều null).
  const hasScoreData = attempt.total_possible != null;
  const safeTotalScore = attempt.total_score ?? 0;
  const scoreText = hasScoreData
    ? `${safeTotalScore}/${attempt.total_possible}`
    : '—';

  const scorePct = hasScoreData && attempt.total_possible > 0
    ? Math.round((safeTotalScore / attempt.total_possible) * 100)
    : null;

  const statusLabelMap = {
    submitted: 'Đã nộp bài',
    passed: 'Đạt',
    needs_retry: 'Cần làm lại',
    in_progress: 'Đang làm dở'
  };
  const statusClassMap = {
    submitted: 'exam-status-submitted',
    passed: 'exam-status-passed',
    needs_retry: 'exam-status-retry',
    in_progress: 'exam-status-progress'
  };
  const statusLabel = statusLabelMap[attempt.status] || attempt.status;
  const statusClass = statusClassMap[attempt.status] || 'exam-status-submitted';

  let html = `
    <div class="review-page-header">
      <h2>📊 Kết quả bài làm</h2>
      <p>${exam.title || ''}</p>
    </div>

    <div class="exam-result-box">
      <div class="exam-result-status-row">
        <span class="exam-status-badge ${statusClass}">${statusLabel}</span>
        <span class="exam-result-attempt-number">Lần thi thứ ${attempt.attempt_number || 1}</span>
      </div>

      <div class="exam-result-score-big">
        ${scoreText}
        ${scorePct != null ? `<span class="exam-result-score-pct">(${scorePct}%)</span>` : ''}
      </div>

      ${exam.pass_threshold_pct != null ? `
        <div class="exam-result-threshold">Điểm đạt yêu cầu: ${exam.pass_threshold_pct}%</div>
      ` : ''}
  `;

  // section_scores format: { "<skill_code>": { score, total } } — hiện dạng
  // "score/total" dễ đọc thay vì dump JSON thô.
  if (attempt.section_scores && typeof attempt.section_scores === 'object') {
    const entries = Object.entries(attempt.section_scores);
    if (entries.length > 0) {
      html += `<div class="exam-result-sections"><div class="exam-result-sections-title">Điểm theo phần</div>`;
      entries.forEach(([key, value]) => {
        const displayKey = (key === 'null' || key === 'undefined' || !key) ? 'Khác' : key;
        let displayValue = '—';
        if (value && typeof value === 'object') {
          const score = value.score ?? 0;
          const total = value.total ?? 0;
          displayValue = `${score}/${total}`;
        } else if (value != null) {
          displayValue = String(value);
        }
        html += `
          <div class="exam-result-section-row">
            <span>${displayKey}</span>
            <span>${displayValue}</span>
          </div>
        `;
      });
      html += `</div>`;
    }
  }

  if (attempt.status === 'needs_retry' && attempt.next_retry_date) {
    html += `<div class="exam-result-retry-note">Ngày có thể làm lại: ${attempt.next_retry_date}${attempt.retry_note ? ' — ' + attempt.retry_note : ''}</div>`;
  }

  html += `
      <div class="exam-result-meta">
        ${attempt.submitted_at ? `Nộp lúc: ${new Date(attempt.submitted_at).toLocaleString('vi-VN')}` : ''}
      </div>

      <button class="btn btn-outline" style="margin-top:16px;" onclick="openPracticeTest()">
        <i class="ti ti-arrow-left"></i> Quay lại danh sách đề
      </button>
    </div>
  `;

  zone.innerHTML = html;
}
