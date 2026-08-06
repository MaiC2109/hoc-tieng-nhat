'use strict';

// ============================================================
//  ADMIN — KẾT QUẢ THI (bảng exam_attempts)
//  Nạp sau admin.js, questions.js, exams.js (dùng chung supabaseClient,
//  ADMIN_CONFIG, sbAuthedHeaders, escHtml, formatDateVN, currentAdmin —
//  KHÔNG tạo Supabase client mới).
//
//  BƯỚC HIỆN TẠI: chỉ danh sách attempts (tên học viên, tên đề,
//  attempt_number, status, điểm, ngày nộp) + filter theo đề thi/học viên.
//  CHƯA làm: xem chi tiết từng câu trả lời của 1 attempt (drill-down) —
//  sẽ join attempt_answers -> question_bank ở bước sau.
// ============================================================

let resultsFragmentLoaded = false;
const resultAdminState = {
  rows: [],           // toàn bộ attempts đã load cho bộ filter hiện tại
  examOptions: [],     // [{id, title}]
  studentOptions: []   // [{id, full_name}]
};

// admin/results.html chỉ là fragment — fetch và inject 1 lần duy nhất vào
// #results-fragment-mount (đặt sẵn trong index.html, bên trong
// <section data-section="results">). Cùng pattern với admin/exams.html.
async function ensureResultsFragmentLoaded() {
  if (resultsFragmentLoaded) return;
  const mount = document.getElementById('results-fragment-mount');
  if (!mount) {
    console.error('Không tìm thấy #results-fragment-mount trong index.html');
    return;
  }

  try {
    const res = await fetch('/admin/results.html');
    if (!res.ok) throw new Error(`Không tải được admin/results.html (HTTP ${res.status})`);
    mount.innerHTML = await res.text();
    resultsFragmentLoaded = true;
    initResultFilterControls();
  } catch (err) {
    console.error('Lỗi nạp giao diện kết quả thi:', err);
    mount.innerHTML = '<div class="empty-state">Không tải được giao diện kết quả thi. Thử tải lại trang.</div>';
  }
}

// Gọi từ switchAdminSection() trong admin.js khi vào section 'results'.
async function loadResultsSection() {
  await ensureResultsFragmentLoaded();
  if (!resultsFragmentLoaded) return;
  showResultListView();
  await populateResultFilterDropdowns();
  await loadResultAdminList();
}

// ── Đổ dữ liệu 2 dropdown filter: Đề thi + Học viên ─────────────────────
async function populateResultFilterDropdowns() {
  const examSelect = document.getElementById('filter-result-exam');
  const studentSelect = document.getElementById('filter-result-student');
  if (!examSelect || !studentSelect) return;

  try {
    const [examsRes, profilesRes] = await Promise.all([
      supabaseClient.from('exams').select('id, title').order('title', { ascending: true }),
      supabaseClient.from(ADMIN_CONFIG.profilesTable).select('id, full_name').order('full_name', { ascending: true })
    ]);

    if (examsRes.error) throw examsRes.error;
    if (profilesRes.error) throw profilesRes.error;

    resultAdminState.examOptions = examsRes.data || [];
    resultAdminState.studentOptions = profilesRes.data || [];

    examSelect.innerHTML = '<option value="">Tất cả đề thi</option>' +
      resultAdminState.examOptions.map(e => `<option value="${e.id}">${escHtml(e.title)}</option>`).join('');

    studentSelect.innerHTML = '<option value="">Tất cả học viên</option>' +
      resultAdminState.studentOptions.map(s => `<option value="${s.id}">${escHtml(s.full_name || '(chưa có tên)')}</option>`).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách đề thi/học viên cho filter:', err);
  }
}

// ── Danh sách exam_attempts (áp filter hiện tại nếu có) ─────────────────
async function loadResultAdminList() {
  const tbody = document.getElementById('result-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>';

  const examId = document.getElementById('filter-result-exam')?.value || '';
  const studentId = document.getElementById('filter-result-student')?.value || '';

  try {
    const headers = await sbAuthedHeaders();

    // exam_attempts.exam_id -> exams(id) có FK nên dùng embed PostgREST lấy
    // luôn tên đề trong 1 lần gọi. exam_attempts.user_id lại trỏ tới
    // auth.users(id) (không phải profiles(id)) nên KHÔNG embed được — phải
    // map tên học viên riêng ở phía client từ resultAdminState.studentOptions
    // (đã tải sẵn ở populateResultFilterDropdowns, không gọi lại profiles).
    let url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_attempts` +
      `?select=id,exam_id,user_id,attempt_number,status,total_score,total_possible,submitted_at,next_retry_date,exams(title)` +
      `&order=submitted_at.desc.nullslast`;

    if (examId) url += `&exam_id=eq.${examId}`;
    if (studentId) url += `&user_id=eq.${studentId}`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Lỗi tải danh sách kết quả thi (HTTP ${res.status})`);

    const rows = await res.json();
    resultAdminState.rows = rows;
    renderResultAdminTable(rows);
  } catch (err) {
    console.error('Lỗi tải danh sách kết quả thi:', err);
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Có lỗi khi tải dữ liệu. Thử tải lại trang.</div></td></tr>';
  }
}

// Badge trạng thái — dùng đúng class exam-status-* đã có sẵn trong style.css
// (được tạo ra cho màn học viên, style.css đã được /admin/index.html include
// nên tái dùng thẳng, không tạo class CSS mới). Giữ y hệt nhãn/màu đã dùng ở
// renderExamResultScreen()/renderExamCard() trong exam.js để nhất quán.
const RESULT_STATUS_LABEL_MAP = {
  in_progress: 'Đang làm dở',
  submitted: 'Đã nộp bài',
  passed: 'Đạt',
  needs_retry: 'Cần làm lại'
};
const RESULT_STATUS_CLASS_MAP = {
  in_progress: 'exam-status-progress',
  submitted: 'exam-status-submitted',
  passed: 'exam-status-passed',
  needs_retry: 'exam-status-retry'
};

function renderResultAdminTable(rows) {
  const tbody = document.getElementById('result-table-body');
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Chưa có bài làm nào khớp bộ lọc.</div></td></tr>';
    return;
  }

  // Map user_id -> full_name từ dropdown Học viên đã tải sẵn — không query
  // lại profiles cho từng dòng.
  const studentNameById = {};
  resultAdminState.studentOptions.forEach(s => {
    studentNameById[s.id] = s.full_name || '(chưa có tên)';
  });

  tbody.innerHTML = rows.map(r => {
    const studentName = studentNameById[r.user_id] || '(không rõ)';
    const examTitle = r.exams?.title || '(đề đã bị xóa)';
    const label = RESULT_STATUS_LABEL_MAP[r.status] || r.status;
    const cls = RESULT_STATUS_CLASS_MAP[r.status] || 'exam-status-submitted';
    const scoreText = (r.total_score != null && r.total_possible != null)
      ? `${r.total_score}/${r.total_possible}`
      : '—';
    const submittedText = r.submitted_at ? formatDateVN(r.submitted_at) : '—';
    const retryText = r.next_retry_date ? formatDateVN(r.next_retry_date) : '—';

    return `
      <tr class="student-row" onclick="openResultDetail('${r.id}')">
        <td>${escHtml(studentName)}</td>
        <td>${escHtml(examTitle)}</td>
        <td style="text-align:center;">${escHtml(r.attempt_number)}</td>
        <td><span class="exam-status-badge ${cls}">${escHtml(label)}</span></td>
        <td style="text-align:center;">${escHtml(scoreText)}</td>
        <td>${escHtml(submittedText)}</td>
        <td>${escHtml(retryText)}</td>
      </tr>
    `;
  }).join('');
}

function initResultFilterControls() {
  const examSelect = document.getElementById('filter-result-exam');
  const studentSelect = document.getElementById('filter-result-student');
  if (examSelect) examSelect.addEventListener('change', loadResultAdminList);
  if (studentSelect) studentSelect.addEventListener('change', loadResultAdminList);
}

// ============================================================
//  MÀN CHI TIẾT 1 ATTEMPT (click vào dòng trong bảng)
//
//  Tái dùng LOGIC/CẤU TRÚC HTML đã làm ở Bước 2+3 cho học viên
//  (renderExamResultScreen/buildQuestionsReview/renderResultQuestion*
//  trong exam.js) — vì admin/index.html KHÔNG load exam.js (file đó gọi
//  switchMainSection()/openPracticeTest() và target #exam-result-zone,
//  đều là global/DOM chỉ tồn tại bên site học viên), nên các hàm liên
//  quan được PORT SANG ĐÂY nguyên cấu trúc/class CSS, chỉ đổi:
//   - Bỏ switchMainSection(), đổi target sang #result-detail-zone (admin)
//   - Nút "Quay lại" gọi closeResultDetail() thay vì openPracticeTest()
//   - Thêm dòng tên học viên (ngữ cảnh admin cần biết đang xem của ai)
//   - Thêm toggle filter Đúng/Sai (yêu cầu mới, không có ở bản học viên)
//  Đạt/Chưa đạt so pass_threshold_pct: giữ NGUYÊN logic đã chốt ở Bước 2.
// ============================================================

// skills.code -> label hiển thị — giữ đúng bản đã dùng ở Bước 2 (exam.js).
const RESULT_SKILL_CODE_LABELS = {
  kanji: 'Kanji',
  vocab: 'Vocabulary',
  grammar: 'Grammar',
  reading: 'Reading',
  listening: 'Listening'
};

const resultDetailState = {
  attempt: null,
  questionsReview: [],
  answerFilter: 'all' // 'all' | 'correct' | 'wrong'
};

function showResultListView() {
  const listView = document.getElementById('result-list-view');
  const detailView = document.getElementById('result-detail-view');
  if (listView) listView.style.display = '';
  if (detailView) detailView.style.display = 'none';
}

function showResultDetailView() {
  const listView = document.getElementById('result-list-view');
  const detailView = document.getElementById('result-detail-view');
  if (listView) listView.style.display = 'none';
  if (detailView) detailView.style.display = '';
}

function closeResultDetail() {
  showResultListView();
}

// ── Load cấu trúc đề (exam_sections -> exam_subsections -> exam_questions
// join question_bank) — copy nguyên logic loadExamStructure()/
// flattenExamStructure() từ exam.js (hàm thuần load data, không đụng DOM/
// session học viên nên port nguyên vẹn được, chỉ đổi tên tránh nhầm lẫn). ──
async function loadExamStructureForAdmin(examId) {
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

    return (sections || []).map(section => ({
      ...section,
      subsections: (subsectionsBySection[section.id] || []).map(sub => ({
        ...sub,
        questions: questionsBySubsection[sub.id] || []
      }))
    }));
  } catch (err) {
    console.error('Lỗi không xác định khi tải cấu trúc đề:', err);
    return null;
  }
}

function flattenExamStructureForAdmin(structure) {
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

// Copy nguyên buildQuestionsReview() từ exam.js.
function buildAdminQuestionsReview(flatQuestions, answersByBankId) {
  return flatQuestions.map((q, i) => {
    const qb = q.question_bank || {};
    const answer = answersByBankId[q.question_id] || { selected_answer: null, is_correct: false };

    return {
      examQuestionId: q.id,
      sectionId: q.sectionId,
      sectionTitle: q.sectionTitle,
      globalNumber: i + 1,
      question_type: qb.question_type,
      question_text: qb.question_text,
      choices: qb.choices,
      correct_answer: qb.correct_answer,
      explanation: qb.explanation,
      audio_url: qb.audio_url,
      selected_answer: answer.selected_answer,
      is_correct: !!answer.is_correct
    };
  });
}

// Click vào 1 dòng trong bảng danh sách -> mở màn chi tiết.
async function openResultDetail(attemptId) {
  showResultDetailView();
  const zone = document.getElementById('result-detail-zone');
  if (zone) zone.innerHTML = '<div class="empty-state" style="padding:40px 0;">Đang tải chi tiết bài làm...</div>';

  try {
    const { data: attempt, error } = await supabaseClient
      .from('exam_attempts')
      .select(`
        id, exam_id, user_id, attempt_number, status,
        total_score, total_possible, section_scores,
        started_at, submitted_at, next_retry_date, retry_note,
        exams ( title, pass_threshold_pct )
      `)
      .eq('id', attemptId)
      .single();

    if (error || !attempt) {
      console.error('Lỗi tải chi tiết attempt:', error);
      if (zone) zone.innerHTML = '<div class="empty-state">Không tải được chi tiết bài làm. Thử lại.</div>';
      return;
    }

    const structure = await loadExamStructureForAdmin(attempt.exam_id);
    if (!structure) {
      resultDetailState.attempt = attempt;
      resultDetailState.questionsReview = [];
      renderAdminResultDetail();
      return;
    }
    const flatQuestions = flattenExamStructureForAdmin(structure);

    const { data: savedAnswers, error: answersError } = await supabaseClient
      .from('attempt_answers')
      .select('question_id, selected_answer, is_correct')
      .eq('attempt_id', attemptId);

    if (answersError) {
      console.error('Lỗi tải attempt_answers:', answersError);
    }

    const answersByBankId = {};
    (savedAnswers || []).forEach(a => {
      answersByBankId[a.question_id] = {
        selected_answer: a.selected_answer,
        is_correct: !!a.is_correct
      };
    });

    resultDetailState.attempt = attempt;
    resultDetailState.questionsReview = buildAdminQuestionsReview(flatQuestions, answersByBankId);
    resultDetailState.answerFilter = 'all';
    renderAdminResultDetail();
  } catch (err) {
    console.error('Lỗi không xác định khi tải chi tiết:', err);
    if (zone) zone.innerHTML = '<div class="empty-state">Đã có lỗi xảy ra, vui lòng thử lại.</div>';
  }
}

function setResultAnswerFilter(filterValue) {
  resultDetailState.answerFilter = filterValue;
  renderAdminResultDetail();
}

// Lưu tay next_retry_date + retry_note — CHỈ update 2 cột này, không đụng
// `status`/`section_scores`/điểm. Không tự tính theo exam_retry_rules
// (đó là việc của Tier 6, chưa làm ở đây).
async function saveAttemptRetryInfo(attemptId) {
  const btn = document.getElementById('retry-save-btn');
  const errorEl = document.getElementById('retry-save-error');
  const dateInput = document.getElementById('retry-date-input');
  const noteInput = document.getElementById('retry-note-input');
  if (!btn || !dateInput || !noteInput) return;

  if (errorEl) errorEl.textContent = '';
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = 'Đang lưu...';

  // input[type=date] rỗng trả về '' — chuyển thành null để xóa hẳn ngày
  // trong DB thay vì lưu chuỗi rỗng (cột kiểu `date`).
  const nextRetryDate = dateInput.value ? dateInput.value : null;
  const retryNoteValue = noteInput.value.trim();
  const retryNote = retryNoteValue ? retryNoteValue : null;

  try {
    const { data, error } = await supabaseClient
      .from('exam_attempts')
      .update({ next_retry_date: nextRetryDate, retry_note: retryNote })
      .eq('id', attemptId)
      .select('next_retry_date, retry_note')
      .single();

    if (error) throw error;

    // Cập nhật state tại chỗ rồi render lại — không gọi lại
    // loadExamStructureForAdmin()/attempt_answers, giữ nguyên questionsReview
    // đã tải, tránh query thừa.
    if (resultDetailState.attempt && resultDetailState.attempt.id === attemptId) {
      resultDetailState.attempt.next_retry_date = data.next_retry_date;
      resultDetailState.attempt.retry_note = data.retry_note;
    }
    // Đồng bộ luôn dòng tương ứng trong bảng danh sách (Bước 4) — cập nhật
    // cả state lẫn render lại bảng (dù đang ẩn) để khi bấm "Quay lại danh
    // sách" cột Retry dự kiến hiện đúng ngay, không cần tải lại trang.
    const listRow = resultAdminState.rows.find(r => r.id === attemptId);
    if (listRow) {
      listRow.next_retry_date = data.next_retry_date;
      listRow.retry_note = data.retry_note;
    }
    renderResultAdminTable(resultAdminState.rows);

    renderAdminResultDetail();

    // Thông báo cho giáo viên biết đã lưu thành công — hiện sau khi
    // renderAdminResultDetail() vẽ lại DOM (nếu không sẽ bị ghi đè mất).
    const successEl = document.getElementById('retry-save-success');
    if (successEl) {
      successEl.style.display = 'block';
      clearTimeout(window.__retrySaveSuccessTimer);
      window.__retrySaveSuccessTimer = setTimeout(() => {
        successEl.style.display = 'none';
      }, 3000);
    }
  } catch (err) {
    console.error('Lỗi lưu next_retry_date/retry_note:', err);
    if (errorEl) errorEl.textContent = 'Có lỗi khi lưu, vui lòng thử lại.';
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// Lưới tổng quan tất cả câu — copy renderResultQuestionsGrid() từ exam.js.
function renderAdminReviewGrid(questionsReview) {
  const cellsHtml = questionsReview.map(q => {
    const cls = q.is_correct ? 'exam-review-navnum-correct' : 'exam-review-navnum-wrong';
    return `
      <button type="button" class="exam-review-navnum ${cls}" onclick="scrollToAdminReviewQuestion('${q.examQuestionId}')">
        ${q.globalNumber}
      </button>
    `;
  }).join('');

  return `<div class="exam-review-navnum-grid">${cellsHtml}</div>`;
}

function scrollToAdminReviewQuestion(examQuestionId) {
  const el = document.getElementById(`admin-review-q-${examQuestionId}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Chi tiết 1 câu — copy renderResultQuestionDetail() từ exam.js, chỉ đổi
// id phần tử (admin-review-q-...) để không đụng id bên site học viên nếu
// lỡ mở song song 2 tab.
function renderAdminReviewQuestionDetail(q) {
  let answerHtml = '';
  const normalizedType = (q.question_type || '').trim().toLowerCase();

  if (normalizedType === 'multiple_choice' && Array.isArray(q.choices)) {
    const optionsHtml = q.choices.map(choiceValue => {
      const isSelected = q.selected_answer === choiceValue;
      const isCorrectChoice = q.correct_answer === choiceValue;

      let cls = '';
      let badge = '';
      if (isSelected && isCorrectChoice) {
        cls = 'exam-review-choice-correct';
        badge = '<span class="exam-review-choice-badge">✓ Học viên chọn — Đúng</span>';
      } else if (isSelected && !isCorrectChoice) {
        cls = 'exam-review-choice-wrong';
        badge = '<span class="exam-review-choice-badge">✗ Học viên chọn</span>';
      } else if (!isSelected && isCorrectChoice) {
        cls = 'exam-review-choice-correct-unselected';
        badge = '<span class="exam-review-choice-badge">✓ Đáp án đúng</span>';
      }

      return `
        <div class="exam-choice-btn exam-review-choice ${cls}">
          <span class="exam-choice-content">${choiceValue}</span>
          ${badge}
        </div>
      `;
    }).join('');

    answerHtml = `<div class="exam-choices-grid">${optionsHtml}</div>`;
  } else if (normalizedType === 'fill_blank') {
    const yourAnswerText = (q.selected_answer != null && q.selected_answer !== '')
      ? q.selected_answer
      : '(Chưa trả lời)';

    answerHtml = `
      <div class="exam-review-fillblank">
        <div class="${q.is_correct ? 'exam-review-answer-correct' : 'exam-review-answer-wrong'}">
          Học viên trả lời: <strong>${yourAnswerText}</strong>
        </div>
        ${!q.is_correct ? `<div class="exam-review-answer-correct">Đáp án đúng: <strong>${q.correct_answer || ''}</strong></div>` : ''}
      </div>
    `;
  }

  const feedbackHtml = q.explanation ? `
    <div class="exam-review-feedback">💡 Feedback: ${q.explanation}</div>
  ` : '';

  return `
    <div class="exam-question-block exam-review-question-block" id="admin-review-q-${q.examQuestionId}">
      <div class="exam-question-number">
        Câu ${q.globalNumber} <span class="exam-review-section-tag">${q.sectionTitle || ''}</span>
        <span class="exam-status-badge ${q.is_correct ? 'exam-status-passed' : 'exam-status-retry'}">
          ${q.is_correct ? 'Đúng' : 'Sai'}
        </span>
      </div>
      <div class="exam-question-content">${q.question_text || ''}</div>
      ${answerHtml}
      ${feedbackHtml}
    </div>
  `;
}

// Toggle filter Đúng/Sai (yêu cầu mới ở admin — "có thì càng tốt, tái
// dùng luôn" — dùng lại class .admin-subtabs/.admin-subtab-btn đã có sẵn
// từ section Ngân hàng câu hỏi, không tạo CSS mới).
function renderAdminAnswerFilterBar(questionsReview) {
  const total = questionsReview.length;
  const correctCount = questionsReview.filter(q => q.is_correct).length;
  const wrongCount = total - correctCount;

  const tabs = [
    { key: 'all', label: `Tất cả (${total})` },
    { key: 'correct', label: `Đúng (${correctCount})` },
    { key: 'wrong', label: `Sai (${wrongCount})` }
  ];

  return `
    <div class="admin-subtabs" style="margin-bottom:16px;">
      ${tabs.map(t => `
        <button type="button" class="admin-subtab-btn ${resultDetailState.answerFilter === t.key ? 'active' : ''}"
          onclick="setResultAnswerFilter('${t.key}')">${t.label}</button>
      `).join('')}
    </div>
  `;
}

function renderAdminReviewQuestionsList(questionsReview) {
  if (!questionsReview || questionsReview.length === 0) {
    return '<div class="empty-state">Không có câu nào khớp bộ lọc.</div>';
  }
  return questionsReview.map(q => renderAdminReviewQuestionDetail(q)).join('');
}

// ── Màn chi tiết chính — PORT từ renderExamResultScreen() trong exam.js.
// Logic điểm tổng/Đạt-Chưa đạt/điểm theo kỹ năng GIỮ NGUYÊN 100% (đã chốt
// ở Bước 2), chỉ khác phần khung ngoài (không switchMainSection, có tên
// học viên, có filter Đúng/Sai, nút quay lại gọi closeResultDetail()). ──
function renderAdminResultDetail() {
  const zone = document.getElementById('result-detail-zone');
  if (!zone) return;

  const attempt = resultDetailState.attempt;
  if (!attempt) return;

  const exam = attempt.exams || {};
  const studentName = (resultAdminState.studentOptions.find(s => s.id === attempt.user_id) || {}).full_name
    || '(không rõ học viên)';

  const hasScoreData = attempt.total_possible != null;
  const safeTotalScore = attempt.total_score ?? 0;
  const scoreText = hasScoreData ? `${safeTotalScore}/${attempt.total_possible}` : '—';

  const scorePct = hasScoreData && attempt.total_possible > 0
    ? Math.round((safeTotalScore / attempt.total_possible) * 100)
    : null;

  const hasPassThreshold = scorePct != null && exam.pass_threshold_pct != null;
  const isPassed = hasPassThreshold && scorePct >= exam.pass_threshold_pct;

  const statusLabel = RESULT_STATUS_LABEL_MAP[attempt.status] || attempt.status;
  const statusClass = RESULT_STATUS_CLASS_MAP[attempt.status] || 'exam-status-submitted';

  let sidebarHtml = `
    <div class="exam-result-box">
      <div class="exam-result-status-row">
        <span class="exam-status-badge ${statusClass}">${statusLabel}</span>
        <span class="exam-result-attempt-number">Lần thi thứ ${attempt.attempt_number || 1}</span>
      </div>

      <div style="font-size:13px; color:var(--ink-mute); margin-top:4px;">${escHtml(studentName)}</div>

      <div class="exam-result-score-big">
        ${scoreText}
        ${scorePct != null ? `<span class="exam-result-score-pct">(${scorePct}%)</span>` : ''}
      </div>

      ${hasPassThreshold ? `
        <div class="exam-result-status-row">
          <span class="exam-status-badge ${isPassed ? 'exam-status-passed' : 'exam-status-retry'}">
            ${isPassed ? 'Đạt' : 'Chưa đạt'}
          </span>
        </div>
        <div class="exam-result-threshold">Điểm đạt yêu cầu: ${exam.pass_threshold_pct}%</div>
      ` : exam.pass_threshold_pct != null ? `
        <div class="exam-result-threshold">Điểm đạt yêu cầu: ${exam.pass_threshold_pct}%</div>
      ` : ''}
  `;

  // section_scores format: { "<skill_code>": { score, total } } — giữ
  // nguyên logic đọc/hiển thị đã chốt ở Bước 2.
  if (attempt.section_scores && typeof attempt.section_scores === 'object') {
    const entries = Object.entries(attempt.section_scores);
    if (entries.length > 0) {
      sidebarHtml += `<div class="exam-result-sections"><div class="exam-result-sections-title">Điểm theo phần</div>`;
      entries.forEach(([key, value]) => {
        const displayKey = (key === 'null' || key === 'undefined' || !key)
          ? 'Khác'
          : (RESULT_SKILL_CODE_LABELS[key] || RESULT_SKILL_CODE_LABELS[key.toLowerCase()] || key);
        let displayValue = '—';
        if (value && typeof value === 'object') {
          const score = value.score ?? 0;
          const total = value.total ?? 0;
          displayValue = `${score}/${total}`;
        } else if (value != null) {
          displayValue = String(value);
        }
        sidebarHtml += `
          <div class="exam-result-section-row">
            <span>${displayKey}</span>
            <span>${displayValue}</span>
          </div>
        `;
      });
      sidebarHtml += `</div>`;
    }
  }

  if (attempt.status === 'needs_retry' && attempt.next_retry_date) {
    sidebarHtml += `<div class="exam-result-retry-note">Ngày có thể làm lại: ${attempt.next_retry_date}${attempt.retry_note ? ' — ' + attempt.retry_note : ''}</div>`;
  }

  sidebarHtml += `
      <div class="exam-result-meta">
        ${attempt.submitted_at ? `Nộp lúc: ${new Date(attempt.submitted_at).toLocaleString('vi-VN')}` : ''}
      </div>

      <button class="btn btn-outline" style="margin-top:16px;" onclick="closeResultDetail()">
        <i class="ti ti-arrow-left"></i> Quay lại danh sách
      </button>
    </div>
  `;

  // ── Set tay next_retry_date / retry_note (Bước 6 hiện tại) ──────────
  // CHỈ set tay 1 giá trị + Lưu, KHÔNG tự tính theo exam_retry_rules
  // (thuộc Tier 6 sau này) — dùng lại .admin-form-group (input/textarea đã
  // có sẵn CSS chung) và .admin-panel-card, không tạo class mới.
  sidebarHtml += `
    <div class="admin-panel-card" style="margin-top:16px; padding:16px;">
      <div class="exam-result-sections-title">Lịch làm lại (set tay)</div>
      <div class="admin-form-group">
        <label for="retry-date-input">Ngày có thể làm lại</label>
        <input type="date" id="retry-date-input" value="${attempt.next_retry_date || ''}" />
      </div>
      <div class="admin-form-group">
        <label for="retry-note-input">Ghi chú của giáo viên</label>
        <textarea id="retry-note-input" rows="3" placeholder="Vd: cần ôn lại phần Kanji trước khi thi lại">${escHtml(attempt.retry_note || '')}</textarea>
      </div>
      <div id="retry-save-error" class="login-error" style="margin-bottom:8px;"></div>
      <div id="retry-save-success" style="display:none; color:#0f6e56; background:#e1f5ee; padding:8px 10px; border-radius:8px; font-size:13px; margin-bottom:8px;">
        ✓ Đã lưu lịch làm lại.
      </div>
      <button type="button" class="btn btn-primary" id="retry-save-btn" onclick="saveAttemptRetryInfo('${attempt.id}')">
        <i class="ti ti-device-floppy"></i> Lưu
      </button>
    </div>
  `;

  const questionsReview = resultDetailState.questionsReview || [];

  if (questionsReview.length > 0) {
    sidebarHtml += `
      <div class="exam-review-navnum-title">Câu hỏi</div>
      ${renderAdminReviewGrid(questionsReview)}
    `;
  }

  let mainHtml = '';
  if (questionsReview.length > 0) {
    const filtered = questionsReview.filter(q => {
      if (resultDetailState.answerFilter === 'correct') return q.is_correct;
      if (resultDetailState.answerFilter === 'wrong') return !q.is_correct;
      return true;
    });
    mainHtml = `
      <div class="exam-review-section-title">Chi tiết bài làm</div>
      ${renderAdminAnswerFilterBar(questionsReview)}
      <div class="exam-review-questions-list">
        ${renderAdminReviewQuestionsList(filtered)}
      </div>
    `;
  }

  zone.innerHTML = `
    <div class="review-page-header">
      <h2>📊 Kết quả bài làm</h2>
      <p>${escHtml(exam.title || '')}</p>
    </div>

    <div class="exam-result-layout">
      <div class="exam-result-sidebar">${sidebarHtml}</div>
      <div class="exam-result-main">${mainHtml}</div>
    </div>
  `;
}
