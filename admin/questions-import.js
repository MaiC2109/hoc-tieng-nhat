'use strict';

// ============================================================
//  ADMIN — IMPORT CÂU HỎI TỪ CSV (question_bank, không passage)
//  Tách riêng khỏi admin/questions.js để dễ maintain (parser CSV +
//  UI preview khá dài, không muốn phình thêm file questions.js vốn
//  đã lớn). Nạp SAU admin/questions.js (dùng chung supabaseClient,
//  ADMIN_CONFIG, escHtml, sbAuthedHeaders, questionsAdminState,
//  QUESTION_TYPE_LABELS, saveQuestionToSupabase, loadQuestionAdminList
//  đã khai báo ở admin.js / admin/questions.js).
//
//  BƯỚC HIỆN TẠI: chỉ chọn file -> parse client-side -> hiển thị bảng
//  preview kèm lỗi validate từng dòng. CHƯA insert vào Supabase — nút
//  "Xác nhận nhập" ở bước này chỉ là placeholder, việc insert hàng loạt
//  sẽ nối vào ở bước sau (tái dùng saveQuestionToSupabase()).
// ============================================================

// Cột bắt buộc phải có trong header CSV (đúng thứ tự không quan trọng,
// chỉ cần có mặt tên cột — parser map theo tên, không theo vị trí).
const QUESTION_IMPORT_REQUIRED_COLUMNS = [
  'skill_code', 'question_type', 'question_text', 'audio_url',
  'choice_1', 'choice_2', 'choice_3', 'choice_4',
  'correct_answer', 'explanation', 'difficulty'
];

const QUESTION_IMPORT_VALID_TYPES = ['multiple_choice', 'fill_blank'];
const QUESTION_IMPORT_VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];

const questionImportState = {
  parsedRows: [],   // toàn bộ dòng đã parse, kèm { _rowNumber, _errors, ...payload sẵn sàng insert nếu hợp lệ }
  validCount: 0
};

// Cột bắt buộc cho TAB 2 — câu hỏi thuộc đoạn văn/hội thoại. Khác tab đơn lẻ:
// có thêm passage_title/passage_content/passage_audio_url, KHÔNG có cột
// question_type (mặc định coi là 'multiple_choice' vì có sẵn choice_1..4 —
// import CSV dạng đoạn văn hiện chỉ hỗ trợ trắc nghiệm, không hỗ trợ fill_blank).
const QUESTION_IMPORT_PASSAGE_REQUIRED_COLUMNS = [
  'passage_title', 'passage_content', 'passage_audio_url',
  'skill_code', 'question_text',
  'choice_1', 'choice_2', 'choice_3', 'choice_4',
  'correct_answer', 'explanation', 'difficulty'
];

const questionImportPassageState = {
  parsedRows: [],  // mảng phẳng từng dòng, giống questionImportState.parsedRows nhưng có thêm _passageTitle
  groups: [],      // gom theo passage_title, mỗi phần tử { title, rows: [...] , _groupErrors: [] }
  validCount: 0
};

// ============================================================
//  PARSER CSV — viết tay, không phụ thuộc thư viện ngoài.
//  Hỗ trợ: dấu phẩy phân cách, ô có dấu ngoặc kép (chứa dấu phẩy/xuống
//  dòng/ngoặc kép lồng "" bên trong), \r\n hoặc \n. Không hỗ trợ CSV
//  có dấu phân cách khác (; hay tab) — đủ dùng cho phạm vi yêu cầu.
// ============================================================
function parseCsvText(text) {
  // Bỏ BOM nếu Excel/Google Sheets xuất file có BOM ở đầu.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // "" -> "
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; } // bỏ qua, xử lý xuống dòng ở \n
    if (ch === '\n') { pushRow(); i++; continue; }

    field += ch; i++;
  }
  // Dòng cuối không có \n kết thúc
  if (field.length > 0 || row.length > 0) pushRow();

  // Bỏ các dòng trắng hoàn toàn (vd dòng trống cuối file)
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

// Chuyển mảng rows (mảng mảng ô) thành mảng object theo header, dựa trên
// tên cột chứ không phải vị trí -> thứ tự cột trong file CSV có thể tùy ý.
function csvRowsToObjects(rows) {
  if (rows.length === 0) return { header: [], records: [] };

  const header = rows[0].map(h => h.trim().toLowerCase());
  const records = rows.slice(1).map(r => {
    const obj = {};
    header.forEach((colName, idx) => { obj[colName] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { header, records };
}

// ============================================================
//  VALIDATE 1 DÒNG — trả về { payload, errors[] }.
//  payload chỉ có ý nghĩa dùng để insert khi errors rỗng.
//  Cố tình tách riêng khỏi validateAndBuildQuestionPayload() (dùng cho
//  form single) vì nguồn dữ liệu khác nhau (DOM form vs object CSV) và
//  quy tắc bắt buộc cũng khác đôi chút (CSV không có DOM/audioUploading).
// ============================================================
function validateQuestionImportRow(record, skillsByCode) {
  const errors = [];
  const warnings = []; // cảnh báo mềm — hiển thị riêng, KHÔNG chặn import dòng này

  const skillCode = (record.skill_code || '').trim();
  const skill = skillsByCode.get(skillCode);
  if (!skillCode) {
    errors.push('Thiếu skill_code.');
  } else if (!skill) {
    errors.push(`skill_code "${skillCode}" không khớp kỹ năng nào trong hệ thống.`);
  }

  const questionType = (record.question_type || '').trim();
  if (!questionType) {
    errors.push('Thiếu question_type.');
  } else if (!QUESTION_IMPORT_VALID_TYPES.includes(questionType)) {
    errors.push(`question_type "${questionType}" không hợp lệ (chỉ nhận multiple_choice hoặc fill_blank).`);
  }

  const questionText = (record.question_text || '').trim();
  if (!questionText) errors.push('Thiếu question_text.');

  const audioUrl = (record.audio_url || '').trim() || null;

  // Cảnh báo mềm — cùng rule với form câu hỏi đơn lẻ ở Tier 1 (dòng ~1426
  // trong admin/questions.js: skill "Nghe hiểu" thiếu audio_url thì hỏi
  // confirm() chứ không chặn hẳn). Với import hàng loạt không thể hỏi
  // confirm() từng dòng, nên đổi thành cảnh báo hiển thị trong preview,
  // giáo viên tự quyết định có sửa CSV trước khi import hay chấp nhận.
  if (skill && skill.code === 'listening' && !audioUrl) {
    warnings.push('Kỹ năng "Nghe hiểu" nhưng thiếu audio_url — vẫn nhập được, kiểm tra lại nếu cần.');
  }

  const explanation = (record.explanation || '').trim() || null;

  const difficultyRaw = (record.difficulty || '').trim();
  let difficulty = null;
  if (difficultyRaw) {
    if (!QUESTION_IMPORT_VALID_DIFFICULTIES.includes(difficultyRaw)) {
      errors.push(`difficulty "${difficultyRaw}" không hợp lệ (chỉ nhận easy/medium/hard, hoặc để trống).`);
    } else {
      difficulty = difficultyRaw;
    }
  }

  let choices = null;
  let correctAnswer = (record.correct_answer || '').trim();

  if (questionType === 'multiple_choice') {
    const rawChoices = [record.choice_1, record.choice_2, record.choice_3, record.choice_4]
      .map(c => (c || '').trim())
      .filter(c => c.length > 0);

    if (rawChoices.length < 2) {
      errors.push('Cần ít nhất 2 đáp án (choice_1..choice_4) cho câu trắc nghiệm.');
    }

    if (!correctAnswer) {
      errors.push('Thiếu correct_answer.');
    } else if (rawChoices.length >= 2 && !rawChoices.includes(correctAnswer)) {
      errors.push('correct_answer phải trùng khớp nguyên văn với một trong các choice_1..choice_4.');
    }

    choices = rawChoices.length >= 2 ? rawChoices : null;
  } else if (questionType === 'fill_blank') {
    if (!correctAnswer) {
      errors.push('Thiếu correct_answer (đáp án dạng thứ tự, ví dụ "2314").');
    }
    choices = null;
  }
  // Nếu question_type không hợp lệ, đã báo lỗi ở trên — không validate thêm
  // choices/correct_answer để tránh lỗi trùng lặp gây rối preview.

  const payload = {
    skill_id: skill ? skill.id : null,
    question_type: QUESTION_IMPORT_VALID_TYPES.includes(questionType) ? questionType : null,
    question_text: questionText, // CSV không hỗ trợ rich text -> lưu plain text nguyên văn
    audio_url: audioUrl,
    passage_id: null, // yêu cầu: import CSV chỉ dành cho câu hỏi đơn lẻ, không gắn đoạn văn
    choices,
    correct_answer: correctAnswer,
    explanation,
    difficulty
  };

  return { payload, errors, warnings };
}

// ============================================================
//  ĐỌC FILE + PARSE + VALIDATE TOÀN BỘ + RENDER PREVIEW
// ============================================================
async function handleQuestionImportFileSelected(file) {
  const statusEl = document.getElementById('question-import-status');
  const errorEl = document.getElementById('question-import-error');
  errorEl.textContent = '';
  questionImportState.parsedRows = [];
  questionImportState.validCount = 0;

  if (!file) return;

  if (!/\.csv$/i.test(file.name) && file.type && !/csv/i.test(file.type)) {
    errorEl.textContent = 'Vui lòng chọn file .csv.';
    return;
  }

  statusEl.textContent = '⏳ Đang đọc và xử lý file...';
  statusEl.style.color = '';

  try {
    const text = await file.text();
    const rows = parseCsvText(text);

    if (rows.length === 0) {
      throw new Error('File CSV rỗng.');
    }

    const { header, records } = csvRowsToObjects(rows);

    const missingCols = QUESTION_IMPORT_REQUIRED_COLUMNS.filter(c => !header.includes(c));
    if (missingCols.length > 0) {
      throw new Error(`File CSV thiếu cột bắt buộc: ${missingCols.join(', ')}.`);
    }

    if (records.length === 0) {
      throw new Error('File CSV chỉ có dòng header, không có dữ liệu.');
    }

    // Cần danh sách skills (mã code) để đối chiếu skill_code trong CSV.
    const skills = await fetchSkillsList();
    const skillsByCode = new Map(skills.map(sk => [sk.code, sk]));

    questionImportState.parsedRows = records.map((record, idx) => {
      const { payload, errors, warnings } = validateQuestionImportRow(record, skillsByCode);
      return {
        _rowNumber: idx + 2, // +2: dòng 1 là header, dữ liệu bắt đầu từ dòng 2 trong file gốc
        _errors: errors,
        _warnings: warnings,
        _skillCode: (record.skill_code || '').trim(),
        payload
      };
    });

    questionImportState.validCount = questionImportState.parsedRows.filter(r => r._errors.length === 0).length;

    renderQuestionImportPreview();

    statusEl.textContent = `✓ Đã đọc ${records.length} dòng dữ liệu.`;
    statusEl.style.color = 'var(--success, #2e7d32)';
  } catch (err) {
    console.error('Lỗi đọc/parse file CSV câu hỏi:', err);
    statusEl.textContent = '';
    errorEl.textContent = err?.message || 'Có lỗi khi đọc file CSV. Vui lòng kiểm tra lại định dạng file.';
    document.getElementById('question-import-preview-wrap').style.display = 'none';
    document.getElementById('question-import-confirm-btn').disabled = true;
    document.getElementById('question-import-confirm-count').textContent = '';
  }
}

function renderQuestionImportPreview() {
  const wrap = document.getElementById('question-import-preview-wrap');
  const tbody = document.getElementById('question-import-preview-body');
  const summaryEl = document.getElementById('question-import-summary');
  const confirmBtn = document.getElementById('question-import-confirm-btn');
  const confirmCountEl = document.getElementById('question-import-confirm-count');

  const rows = questionImportState.parsedRows;
  const total = rows.length;
  const validCount = questionImportState.validCount;
  const invalidCount = total - validCount;
  const warningCount = rows.filter(r => r._errors.length === 0 && r._warnings.length > 0).length;

  wrap.style.display = 'block';

  summaryEl.textContent = `Tổng ${total} dòng — hợp lệ: ${validCount}${warningCount > 0 ? ` (${warningCount} có cảnh báo)` : ''}, lỗi (bị bỏ qua): ${invalidCount}`;
  summaryEl.style.color = invalidCount > 0 ? 'var(--vermillion)' : 'var(--success, #2e7d32)';

  tbody.innerHTML = rows.map(r => {
    const hasError = r._errors.length > 0;
    const hasWarning = !hasError && r._warnings.length > 0;
    const p = r.payload;
    const typeLabel = p.question_type ? (QUESTION_TYPE_LABELS[p.question_type] || p.question_type) : '—';
    const answerPreview = p.question_type === 'multiple_choice'
      ? truncateText((p.choices || []).join(' | '), 60)
      : truncateText(p.correct_answer, 60);

    let rowBg = '';
    let statusCell = '<span style="color:var(--success, #2e7d32);">✓ Hợp lệ</span>';
    if (hasError) {
      rowBg = 'background:rgba(217,48,37,0.06);';
      statusCell = `<span style="color:var(--vermillion);">✕ ${escHtml(r._errors.join(' '))}</span>`;
    } else if (hasWarning) {
      rowBg = 'background:rgba(255,152,0,0.08);';
      statusCell = `<span style="color:#b26a00;">⚠ ${escHtml(r._warnings.join(' '))}</span>`;
    }

    return `
      <tr style="${rowBg}">
        <td>${r._rowNumber}</td>
        <td>${escHtml(r._skillCode || '—')}</td>
        <td>${escHtml(typeLabel)}</td>
        <td>${escHtml(truncateText(p.question_text, 70))}</td>
        <td>${escHtml(answerPreview || '—')}</td>
        <td>${escHtml(p.difficulty || '—')}</td>
        <td style="font-size:12px;">${statusCell}</td>
      </tr>
    `;
  }).join('');

  confirmCountEl.textContent = validCount > 0 ? `(${validCount})` : '';
  // Cho phép bấm "Xác nhận nhập" nếu có ít nhất 1 dòng hợp lệ — các dòng lỗi
  // validate (client-side) sẽ tự động bị bỏ qua khi insert, không cần sửa
  // hết file mới cho import được. Dòng có cảnh báo (warning) vẫn tính là
  // hợp lệ và được import bình thường.
  confirmBtn.disabled = validCount === 0;
}

// ============================================================
//  INSERT HÀNG LOẠT — Lựa chọn A: insert tuần tự từng dòng, tái dùng
//  saveQuestionToSupabase() (đã có ở admin/questions.js) cho từng dòng.
//  KHÔNG dừng khi 1 dòng lỗi — chạy hết toàn bộ dòng hợp lệ, gom lỗi lại
//  báo cáo ở cuối để giáo viên biết sửa CSV rồi import lại riêng các dòng
//  đó (không cần transaction, phù hợp quy mô 1 giáo viên quản lý).
//
//  Lưu ý: saveQuestionToSupabase() đọc questionFormState.mode/editingId để
//  quyết định POST hay PATCH (định nghĩa trong admin/questions.js, dùng
//  chung cho form single). Với import CSV luôn là tạo mới (POST) — nên ép
//  tạm questionFormState.mode = 'create' trước khi gọi, và khôi phục lại
//  nguyên trạng sau khi import xong để không ảnh hưởng tới form câu hỏi
//  đơn lẻ nếu giáo viên có form đang mở dở ở tab khác/state cũ.
// ============================================================
async function runQuestionImportBatch() {
  const progressWrap = document.getElementById('question-import-progress-wrap');
  const progressBar = document.getElementById('question-import-progress-bar');
  const progressText = document.getElementById('question-import-progress-text');
  const resultWrap = document.getElementById('question-import-result-wrap');
  const resultSummaryEl = document.getElementById('question-import-result-summary');
  const failedWrap = document.getElementById('question-import-result-failed-wrap');
  const failedBody = document.getElementById('question-import-result-failed-body');
  const confirmBtn = document.getElementById('question-import-confirm-btn');
  const cancelBtn = document.getElementById('question-import-cancel-btn');
  const closeBtn = document.getElementById('question-import-close-btn');
  const fileInput = document.getElementById('question-import-file');
  const errorEl = document.getElementById('question-import-error');

  const allRows = questionImportState.parsedRows;
  const totalRows = allRows.length; // M — tổng số dòng dữ liệu trong file CSV (không tính header)

  // Dòng bị bỏ qua ngay từ đầu vì không qua được validate ở Bước 2 —
  // không hề gửi request insert cho các dòng này.
  const skippedByValidation = allRows
    .filter(r => r._errors.length > 0)
    .map(r => ({ ...r, _skipReason: `Bỏ qua khi validate: ${r._errors.join(' ')}` }));

  const rowsToImport = allRows.filter(r => r._errors.length === 0);
  if (rowsToImport.length === 0) return;

  errorEl.textContent = '';
  resultWrap.style.display = 'none';
  failedWrap.style.display = 'none';
  failedBody.innerHTML = '';

  // Khóa toàn bộ control trong lúc import để tránh đóng panel/chọn file mới
  // giữa chừng khi các request đang chạy tuần tự.
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  closeBtn.disabled = true;
  fileInput.disabled = true;

  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = `Đang nhập 0/${rowsToImport.length}...`;

  // Ép mode 'create' cho saveQuestionToSupabase() (hàm dùng chung với form
  // single, tái dùng nguyên logic insert của Tier 1 — không viết lại) —
  // lưu lại state cũ để khôi phục sau khi import xong.
  const previousFormState = { mode: questionFormState.mode, editingId: questionFormState.editingId };
  questionFormState.mode = 'create';
  questionFormState.editingId = null;

  let successCount = 0;
  // Dòng bị bỏ qua vì lưu thất bại lúc gọi Supabase thật (khác với bị bỏ
  // qua do validate — dòng này ĐÃ được thử insert nhưng DB từ chối).
  const failedOnSave = [];

  for (let i = 0; i < rowsToImport.length; i++) {
    const row = rowsToImport[i];
    try {
      await saveQuestionToSupabase(row.payload);
      successCount++;
    } catch (err) {
      console.error(`Lỗi insert dòng CSV #${row._rowNumber}:`, err);
      failedOnSave.push({ ...row, _skipReason: `Lỗi khi lưu vào hệ thống: ${err?.message || 'Lỗi không xác định.'}` });
    }

    const done = i + 1;
    const pct = Math.round((done / rowsToImport.length) * 100);
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `Đang nhập ${done}/${rowsToImport.length}...`;
  }

  // Khôi phục lại state form câu hỏi đơn lẻ như trước khi import.
  questionFormState.mode = previousFormState.mode;
  questionFormState.editingId = previousFormState.editingId;

  // Mở khóa control trở lại
  cancelBtn.disabled = false;
  closeBtn.disabled = false;
  fileInput.disabled = false;
  progressWrap.style.display = 'none';

  // Gộp chung 2 loại "dòng bị bỏ qua" (validate lỗi từ đầu + lưu thất bại)
  // thành 1 danh sách duy nhất, sắp theo đúng số thứ tự dòng trong file gốc
  // để giáo viên dễ đối chiếu lại CSV.
  const skippedRows = [...skippedByValidation, ...failedOnSave]
    .sort((a, b) => a._rowNumber - b._rowNumber);

  // ── Hiển thị báo cáo cuối cùng — đúng mẫu "Đã import thành công N/M câu hỏi" ──
  resultWrap.style.display = 'block';

  if (skippedRows.length === 0) {
    resultSummaryEl.textContent = `✓ Đã import thành công ${successCount}/${totalRows} câu hỏi.`;
    resultSummaryEl.style.color = 'var(--success, #2e7d32)';
  } else {
    resultSummaryEl.textContent = `Đã import thành công ${successCount}/${totalRows} câu hỏi. ${skippedRows.length} dòng bị bỏ qua (xem chi tiết bên dưới) — sửa lại trong CSV rồi import lại riêng các dòng này.`;
    resultSummaryEl.style.color = 'var(--vermillion)';

    failedWrap.style.display = 'block';
    failedBody.innerHTML = skippedRows.map(r => `
      <tr>
        <td>${r._rowNumber}</td>
        <td>${escHtml(r._skillCode || '—')}</td>
        <td>${escHtml(truncateText(r.payload.question_text, 60))}</td>
        <td style="color:var(--vermillion); font-size:12px;">${escHtml(r._skipReason)}</td>
      </tr>
    `).join('');
  }

  // Đã import xong ít nhất 1 phần -> refresh lại bảng danh sách câu hỏi
  // chính (Tier 1) đằng sau panel để giáo viên thấy ngay dữ liệu mới, không
  // cần tự tay bấm F5 hay đóng/mở lại trang.
  if (successCount > 0 && typeof loadQuestionAdminList === 'function') {
    loadQuestionAdminList();
  }

  // Không cho import lại đúng lô này thêm lần nữa bằng cách bấm nhầm nút
  // Xác nhận — phải chọn lại file (hoặc sửa & chọn lại) mới import tiếp.
  confirmBtn.disabled = true;
}

// ============================================================
//  TAB 2 — CÂU THUỘC ĐOẠN VĂN/HỘI THOẠI
//  Validate tương tự tab đơn lẻ (skill_code khớp bảng skills, thiếu
//  correct_answer, cảnh báo mềm thiếu audio khi listening), CỘNG THÊM:
//  - Bắt buộc có passage_title, passage_content (lỗi chặn nếu thiếu)
//  - Các dòng cùng passage_title phải khớp passage_content/passage_audio_url/
//    skill_code với nhau — nếu lệch, coi là lỗi dữ liệu (khả năng cao do
//    gõ nhầm/copy sai dòng trong Google Sheet) và chặn toàn bộ nhóm đó.
// ============================================================

// Validate 1 dòng CSV của tab đoạn văn — trả về { payload, errors, warnings }.
// payload.passage_id CHƯA có giá trị ở bước preview này (việc match/tạo mới
// passage theo title sẽ làm ở bước insert thật, chưa triển khai lượt này).
function validateQuestionImportPassageRow(record, skillsByCode) {
  const errors = [];
  const warnings = [];

  const passageTitle = (record.passage_title || '').trim();
  if (!passageTitle) errors.push('Thiếu passage_title.');

  const passageContent = (record.passage_content || '').trim();
  if (!passageContent) errors.push('Thiếu passage_content.');

  const passageAudioUrl = (record.passage_audio_url || '').trim() || null;

  const skillCode = (record.skill_code || '').trim();
  const skill = skillsByCode.get(skillCode);
  if (!skillCode) {
    errors.push('Thiếu skill_code.');
  } else if (!skill) {
    errors.push(`skill_code "${skillCode}" không khớp kỹ năng nào trong hệ thống.`);
  }

  const questionText = (record.question_text || '').trim();
  if (!questionText) errors.push('Thiếu question_text.');

  const explanation = (record.explanation || '').trim() || null;

  const difficultyRaw = (record.difficulty || '').trim();
  let difficulty = null;
  if (difficultyRaw) {
    if (!QUESTION_IMPORT_VALID_DIFFICULTIES.includes(difficultyRaw)) {
      errors.push(`difficulty "${difficultyRaw}" không hợp lệ (chỉ nhận easy/medium/hard, hoặc để trống).`);
    } else {
      difficulty = difficultyRaw;
    }
  }

  // Câu hỏi thuộc đoạn văn qua import CSV chỉ hỗ trợ trắc nghiệm (đã có sẵn
  // choice_1..4 trong cột, không có cột question_type để chọn fill_blank).
  const rawChoices = [record.choice_1, record.choice_2, record.choice_3, record.choice_4]
    .map(c => (c || '').trim())
    .filter(c => c.length > 0);

  let correctAnswer = (record.correct_answer || '').trim();
  if (rawChoices.length < 2) {
    errors.push('Cần ít nhất 2 đáp án (choice_1..choice_4).');
  }
  if (!correctAnswer) {
    errors.push('Thiếu correct_answer.');
  } else if (rawChoices.length >= 2 && !rawChoices.includes(correctAnswer)) {
    errors.push('correct_answer phải trùng khớp nguyên văn với một trong các choice_1..choice_4.');
  }

  // Cảnh báo mềm — cùng rule với tab đơn lẻ: skill "Nghe hiểu" nhưng đoạn
  // văn chưa có audio thì cảnh báo, không chặn.
  if (skill && skill.code === 'listening' && !passageAudioUrl) {
    warnings.push('Kỹ năng "Nghe hiểu" nhưng đoạn văn thiếu passage_audio_url — vẫn nhập được, kiểm tra lại nếu cần.');
  }

  const payload = {
    skill_id: skill ? skill.id : null,
    question_type: 'multiple_choice',
    question_text: questionText,
    audio_url: null, // câu hỏi thuộc đoạn văn dùng audio ở cấp đoạn văn (passage_audio_url), không phải audio riêng từng câu
    passage_id: null, // sẽ gán ở bước insert thật (match theo title hoặc tạo passage mới)
    choices: rawChoices.length >= 2 ? rawChoices : null,
    correct_answer: correctAnswer,
    explanation,
    difficulty
  };

  const passageInfo = {
    title: passageTitle,
    content: passageContent,
    audio_url: passageAudioUrl,
    // Suy ra passage_type từ skill_code (bảng passages có cột passage_type
    // reading/listening, cột CSV không có sẵn thông tin này) — giả định
    // hợp lý dựa trên cách Tier 1 đang liên kết skill với loại đoạn văn.
    passage_type: (skillCode === 'listening' || skillCode === 'reading') ? skillCode : null
  };

  return { payload, passageInfo, errors, warnings };
}

// Đọc + parse + validate từng dòng, sau đó gom nhóm theo passage_title và
// kiểm tra tính nhất quán giữa các dòng cùng nhóm (content/audio/skill phải
// khớp nhau — nếu không, khả năng cao là lỗi gõ CSV).
async function handleQuestionImportPassageFileSelected(file) {
  const statusEl = document.getElementById('question-import-passage-status');
  const errorEl = document.getElementById('question-import-passage-error');
  const confirmBtn = document.getElementById('question-import-passage-confirm-btn');
  errorEl.textContent = '';
  confirmBtn.disabled = true;
  document.getElementById('question-import-passage-confirm-count').textContent = '';
  questionImportPassageState.parsedRows = [];
  questionImportPassageState.groups = [];
  questionImportPassageState.validCount = 0;

  if (!file) return;

  if (!/\.csv$/i.test(file.name) && file.type && !/csv/i.test(file.type)) {
    errorEl.textContent = 'Vui lòng chọn file .csv.';
    return;
  }

  statusEl.textContent = '⏳ Đang đọc và xử lý file...';
  statusEl.style.color = '';

  try {
    const text = await file.text();
    const rows = parseCsvText(text);
    if (rows.length === 0) throw new Error('File CSV rỗng.');

    const { header, records } = csvRowsToObjects(rows);

    const missingCols = QUESTION_IMPORT_PASSAGE_REQUIRED_COLUMNS.filter(c => !header.includes(c));
    if (missingCols.length > 0) {
      throw new Error(`File CSV thiếu cột bắt buộc: ${missingCols.join(', ')}.`);
    }
    if (records.length === 0) throw new Error('File CSV chỉ có dòng header, không có dữ liệu.');

    const skills = await fetchSkillsList();
    const skillsByCode = new Map(skills.map(sk => [sk.code, sk]));

    const parsedRows = records.map((record, idx) => {
      const { payload, passageInfo, errors, warnings } = validateQuestionImportPassageRow(record, skillsByCode);
      return {
        _rowNumber: idx + 2,
        _errors: errors,
        _warnings: warnings,
        _skillCode: (record.skill_code || '').trim(),
        _passageTitle: passageInfo.title || '(thiếu tiêu đề)',
        passageInfo,
        payload
      };
    });

    // ── Gom nhóm theo passage_title (dòng thiếu title cũng gom chung 1 nhóm
    // "(thiếu tiêu đề)" để giáo viên vẫn thấy được, dù nhóm này luôn lỗi) ──
    const groupsByTitle = new Map();
    parsedRows.forEach(row => {
      const key = row._passageTitle;
      if (!groupsByTitle.has(key)) groupsByTitle.set(key, { title: key, rows: [], _groupErrors: [] });
      groupsByTitle.get(key).rows.push(row);
    });

    // ── Kiểm tra nhất quán trong từng nhóm: content/audio/skill phải khớp
    // nhau giữa các dòng cùng title. Nếu lệch -> gắn lỗi cho TẤT CẢ dòng
    // trong nhóm (không đoán dòng nào đúng dòng nào sai). ──
    groupsByTitle.forEach(group => {
      if (group.rows.length <= 1) return; // 1 dòng thì không có gì để so khớp

      const firstValid = group.rows.find(r => r._errors.length === 0) || group.rows[0];
      const refContent = firstValid.passageInfo.content;
      const refAudio = firstValid.passageInfo.audio_url;
      const refSkill = firstValid._skillCode;

      const mismatch = group.rows.some(r =>
        r.passageInfo.content !== refContent ||
        r.passageInfo.audio_url !== refAudio ||
        r._skillCode !== refSkill
      );

      if (mismatch) {
        const msg = `Các dòng cùng passage_title "${group.title}" có passage_content/passage_audio_url/skill_code không khớp nhau — kiểm tra lại CSV.`;
        group._groupErrors.push(msg);
        group.rows.forEach(r => r._errors.push(msg));
      }
    });

    questionImportPassageState.parsedRows = parsedRows;
    questionImportPassageState.groups = Array.from(groupsByTitle.values());
    questionImportPassageState.validCount = parsedRows.filter(r => r._errors.length === 0).length;

    renderQuestionImportPassagePreview();

    statusEl.textContent = `✓ Đã đọc ${records.length} dòng dữ liệu, gom thành ${questionImportPassageState.groups.length} đoạn văn/hội thoại.`;
    statusEl.style.color = 'var(--success, #2e7d32)';
  } catch (err) {
    console.error('Lỗi đọc/parse file CSV câu hỏi thuộc đoạn văn:', err);
    statusEl.textContent = '';
    errorEl.textContent = err?.message || 'Có lỗi khi đọc file CSV. Vui lòng kiểm tra lại định dạng file.';
    document.getElementById('question-import-passage-preview-wrap').style.display = 'none';
  }
}

function renderQuestionImportPassagePreview() {
  const wrap = document.getElementById('question-import-passage-preview-wrap');
  const groupsContainer = document.getElementById('question-import-passage-groups');
  const summaryEl = document.getElementById('question-import-passage-summary');
  const confirmBtn = document.getElementById('question-import-passage-confirm-btn');
  const confirmCountEl = document.getElementById('question-import-passage-confirm-count');

  const rows = questionImportPassageState.parsedRows;
  const groups = questionImportPassageState.groups;
  const total = rows.length;
  const validCount = questionImportPassageState.validCount;
  const invalidCount = total - validCount;
  const warningCount = rows.filter(r => r._errors.length === 0 && r._warnings.length > 0).length;

  wrap.style.display = 'block';

  summaryEl.textContent = `Tổng ${total} câu hỏi trong ${groups.length} đoạn văn/hội thoại — hợp lệ: ${validCount}${warningCount > 0 ? ` (${warningCount} có cảnh báo)` : ''}, lỗi (bị bỏ qua): ${invalidCount}`;
  summaryEl.style.color = invalidCount > 0 ? 'var(--vermillion)' : 'var(--success, #2e7d32)';

  confirmCountEl.textContent = validCount > 0 ? `(${validCount})` : '';
  confirmBtn.disabled = validCount === 0;

  groupsContainer.innerHTML = groups.map(group => {
    const groupHasError = group._groupErrors.length > 0;
    const validInGroup = group.rows.filter(r => r._errors.length === 0).length;
    const refRow = group.rows[0];

    const rowsHtml = group.rows.map(r => {
      const hasError = r._errors.length > 0;
      const hasWarning = !hasError && r._warnings.length > 0;
      const p = r.payload;
      const answerPreview = truncateText((p.choices || []).join(' | '), 55);

      let rowBg = '';
      let statusCell = '<span style="color:var(--success, #2e7d32);">✓ Hợp lệ</span>';
      if (hasError) {
        rowBg = 'background:rgba(217,48,37,0.06);';
        statusCell = `<span style="color:var(--vermillion);">✕ ${escHtml(r._errors.join(' '))}</span>`;
      } else if (hasWarning) {
        rowBg = 'background:rgba(255,152,0,0.08);';
        statusCell = `<span style="color:#b26a00;">⚠ ${escHtml(r._warnings.join(' '))}</span>`;
      }

      return `
        <tr style="${rowBg}">
          <td style="width:44px;">${r._rowNumber}</td>
          <td style="width:90px;">${escHtml(r._skillCode || '—')}</td>
          <td>${escHtml(truncateText(p.question_text, 60))}</td>
          <td style="width:160px;">${escHtml(answerPreview || '—')}</td>
          <td style="width:90px;">${escHtml(p.difficulty || '—')}</td>
          <td style="width:220px; font-size:12px;">${statusCell}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="admin-panel-card" style="margin-bottom:16px; border:1px solid ${groupHasError ? 'var(--vermillion)' : 'var(--line, #e5e0d8)'};">
        <div style="padding:10px 14px; border-bottom:1px solid var(--line, #e5e0d8); background:var(--paper-alt, #faf8f4);">
          <div style="font-weight:700; font-size:14px;">${escHtml(group.title)}</div>
          <div style="font-size:12px; color:var(--ink-soft, #777); margin-top:2px;">
            ${escHtml(truncateText(refRow.passageInfo.content, 120))}
            ${refRow.passageInfo.audio_url ? ' · 🔊 có audio' : ' · không có audio'}
            · ${validInGroup}/${group.rows.length} câu hợp lệ
          </div>
          ${groupHasError ? `<div style="font-size:12px; color:var(--vermillion); margin-top:4px;">✕ ${escHtml(group._groupErrors.join(' '))}</div>` : ''}
        </div>
        <div class="admin-table-scroll" style="max-height:260px;">
          <table class="admin-vocab-table">
            <thead>
              <tr>
                <th style="width:44px;">Dòng</th>
                <th style="width:90px;">Kỹ năng</th>
                <th>Câu hỏi</th>
                <th style="width:160px;">Đáp án</th>
                <th style="width:90px;">Độ khó</th>
                <th style="width:220px;">Lỗi</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
//  MATCH-OR-CREATE PASSAGE THEO TITLE
//  Query passages theo title (khớp CHÍNH XÁC, phân biệt hoa/thường —
//  đúng với cách cột passages.title đang được so sánh ở chỗ khác trong
//  Tier 1, ví dụ dropdown chọn passage theo title). Nếu có nhiều passage
//  trùng title (dữ liệu cũ có thể trùng do title không unique ở schema),
//  lấy bản ghi tạo sớm nhất (order created_at.asc, limit 1) để ổn định.
// ============================================================
async function findOrCreatePassageByTitle(passageInfo) {
  const headers = await sbAuthedHeaders();
  const encodedTitle = encodeURIComponent(passageInfo.title);

  const findRes = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages?title=eq.${encodedTitle}&select=id,title&order=created_at.asc&limit=1`,
    { headers }
  );
  if (!findRes.ok) {
    throw new Error(`Lỗi tra cứu đoạn văn "${passageInfo.title}" (HTTP ${findRes.status})`);
  }
  const found = await findRes.json();
  if (found.length > 0) {
    return { id: found[0].id, created: false };
  }

  // Chưa có -> tạo mới, dùng đúng field mà submitPassageForm() dùng
  // (title, content, audio_url, passage_type) để nhất quán với Tier 1.
  const createHeaders = await sbAuthedHeaders({ 'Prefer': 'return=representation' });
  const createRes = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages`, {
    method: 'POST',
    headers: createHeaders,
    body: JSON.stringify({
      title: passageInfo.title,
      content: passageInfo.content,
      audio_url: passageInfo.audio_url,
      passage_type: passageInfo.passage_type
    })
  });
  if (!createRes.ok) {
    const errBody = await createRes.json().catch(() => null);
    throw new Error(errBody?.message || `Lỗi tạo đoạn văn mới "${passageInfo.title}" (HTTP ${createRes.status})`);
  }
  const [created] = await createRes.json();
  return { id: created.id, created: true };
}

// ============================================================
//  INSERT HÀNG LOẠT CHO TAB 2 — theo từng nhóm passage_title:
//  1) match-or-create passage (1 lần / nhóm, không lặp lại cho từng câu)
//  2) insert lần lượt các câu hỏi hợp lệ trong nhóm, gắn passage_id vừa có
//  Tiếp tục chạy hết các nhóm dù có nhóm lỗi (không dừng toàn bộ), giống
//  nguyên tắc đã áp dụng ở tab đơn lẻ.
// ============================================================
async function runQuestionImportPassageBatch() {
  const progressWrap = document.getElementById('question-import-passage-progress-wrap');
  const progressBar = document.getElementById('question-import-passage-progress-bar');
  const progressText = document.getElementById('question-import-passage-progress-text');
  const resultWrap = document.getElementById('question-import-passage-result-wrap');
  const resultSummaryEl = document.getElementById('question-import-passage-result-summary');
  const failedWrap = document.getElementById('question-import-passage-result-failed-wrap');
  const failedBody = document.getElementById('question-import-passage-result-failed-body');
  const confirmBtn = document.getElementById('question-import-passage-confirm-btn');
  const cancelBtn = document.getElementById('question-import-passage-cancel-btn');
  const closeBtn = document.getElementById('question-import-close-btn');
  const fileInput = document.getElementById('question-import-passage-file');
  const errorEl = document.getElementById('question-import-passage-error');

  const allRows = questionImportPassageState.parsedRows;
  const totalRows = allRows.length; // M — tổng số câu hỏi trong file (mọi nhóm)

  // Chỉ những nhóm KHÔNG có lỗi cấp nhóm mới match/tạo passage — nếu nhóm
  // bị lỗi nhất quán (content/audio/skill lệch nhau) thì toàn bộ câu trong
  // nhóm đó đã bị đánh dấu lỗi ở bước validate, tự động bị loại dưới đây.
  const skippedByValidation = allRows
    .filter(r => r._errors.length > 0)
    .map(r => ({ ...r, _skipReason: `Bỏ qua khi validate: ${r._errors.join(' ')}` }));

  const importableGroups = questionImportPassageState.groups
    .map(g => ({ ...g, validRows: g.rows.filter(r => r._errors.length === 0) }))
    .filter(g => g.validRows.length > 0);

  if (importableGroups.length === 0) return;

  errorEl.textContent = '';
  resultWrap.style.display = 'none';
  failedWrap.style.display = 'none';
  failedBody.innerHTML = '';

  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  closeBtn.disabled = true;
  fileInput.disabled = true;

  const totalToImport = importableGroups.reduce((sum, g) => sum + g.validRows.length, 0);
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = `Đang xử lý đoạn văn 0/${importableGroups.length}...`;

  const previousFormState = { mode: questionFormState.mode, editingId: questionFormState.editingId };
  questionFormState.mode = 'create';
  questionFormState.editingId = null;

  let successCount = 0;
  let createdPassageCount = 0;
  let reusedPassageCount = 0;
  const failedOnSave = [];
  let doneQuestions = 0;

  for (let gi = 0; gi < importableGroups.length; gi++) {
    const group = importableGroups[gi];
    progressText.textContent = `Đang xử lý đoạn văn ${gi + 1}/${importableGroups.length}: "${group.title}"...`;

    let passageId = null;
    try {
      const { id, created } = await findOrCreatePassageByTitle(group.validRows[0].passageInfo);
      passageId = id;
      if (created) createdPassageCount++; else reusedPassageCount++;
    } catch (err) {
      // Cả nhóm không có passage_id -> toàn bộ câu trong nhóm coi như lỗi lưu.
      console.error(`Lỗi match/tạo đoạn văn "${group.title}":`, err);
      group.validRows.forEach(r => {
        failedOnSave.push({ ...r, _skipReason: `Lỗi khi lưu đoạn văn: ${err?.message || 'Lỗi không xác định.'}` });
      });
      doneQuestions += group.validRows.length;
      const pct = Math.round((doneQuestions / totalToImport) * 100);
      progressBar.style.width = `${pct}%`;
      continue;
    }

    for (const row of group.validRows) {
      const payload = { ...row.payload, passage_id: passageId };
      try {
        await saveQuestionToSupabase(payload);
        successCount++;
      } catch (err) {
        console.error(`Lỗi insert dòng CSV #${row._rowNumber}:`, err);
        failedOnSave.push({ ...row, _skipReason: `Lỗi khi lưu câu hỏi: ${err?.message || 'Lỗi không xác định.'}` });
      }

      doneQuestions++;
      const pct = Math.round((doneQuestions / totalToImport) * 100);
      progressBar.style.width = `${pct}%`;
      progressText.textContent = `Đang nhập câu hỏi ${doneQuestions}/${totalToImport}...`;
    }
  }

  questionFormState.mode = previousFormState.mode;
  questionFormState.editingId = previousFormState.editingId;

  cancelBtn.disabled = false;
  closeBtn.disabled = false;
  fileInput.disabled = false;
  progressWrap.style.display = 'none';

  const skippedRows = [...skippedByValidation, ...failedOnSave].sort((a, b) => a._rowNumber - b._rowNumber);

  resultWrap.style.display = 'block';
  const passageSummary = `tạo mới ${createdPassageCount} passage, dùng lại ${reusedPassageCount} passage có sẵn`;

  if (skippedRows.length === 0) {
    resultSummaryEl.textContent = `✓ Đã import ${successCount} câu hỏi, ${passageSummary}.`;
    resultSummaryEl.style.color = 'var(--success, #2e7d32)';
  } else {
    resultSummaryEl.textContent = `Đã import ${successCount} câu hỏi, ${passageSummary}. ${skippedRows.length}/${totalRows} dòng bị bỏ qua (xem chi tiết bên dưới) — sửa lại trong CSV rồi import lại riêng các dòng này.`;
    resultSummaryEl.style.color = 'var(--vermillion)';

    failedWrap.style.display = 'block';
    failedBody.innerHTML = skippedRows.map(r => `
      <tr>
        <td>${r._rowNumber}</td>
        <td>${escHtml(truncateText(r._passageTitle, 30))}</td>
        <td>${escHtml(truncateText(r.payload.question_text, 55))}</td>
        <td style="color:var(--vermillion); font-size:12px;">${escHtml(r._skipReason)}</td>
      </tr>
    `).join('');
  }

  if (successCount > 0 && typeof loadQuestionAdminList === 'function') {
    loadQuestionAdminList();
  }
  if ((createdPassageCount > 0) && typeof fetchPassagesList === 'function') {
    // Danh sách passage đã có thay đổi (thêm mới) -> làm mới cache dropdown
    // chọn đoạn văn ở form câu hỏi đơn lẻ để giáo viên thấy ngay đoạn mới.
    fetchPassagesList(true);
  }

  confirmBtn.disabled = true;
}


function switchQuestionImportTab(tab) {
  const simpleTab = document.getElementById('question-import-tab-simple');
  const passageTab = document.getElementById('question-import-tab-passage');
  const btnSimple = document.getElementById('question-import-tabbtn-simple');
  const btnPassage = document.getElementById('question-import-tabbtn-passage');

  const isSimple = tab === 'simple';
  simpleTab.style.display = isSimple ? 'block' : 'none';
  passageTab.style.display = isSimple ? 'none' : 'block';

  btnSimple.style.borderBottomColor = isSimple ? 'var(--vermillion)' : 'transparent';
  btnSimple.style.color = isSimple ? 'var(--ink)' : 'var(--ink-soft, #777)';
  btnPassage.style.borderBottomColor = isSimple ? 'transparent' : 'var(--vermillion)';
  btnPassage.style.color = isSimple ? 'var(--ink-soft, #777)' : 'var(--ink)';
}


function openQuestionImportPanel() {
  const overlay = document.getElementById('question-import-overlay');
  const panel = document.getElementById('question-import-panel');

  // Reset state mỗi lần mở lại — cả 2 tab
  switchQuestionImportTab('simple');

  questionImportState.parsedRows = [];
  questionImportState.validCount = 0;
  document.getElementById('question-import-file').value = '';
  document.getElementById('question-import-file').disabled = false;
  document.getElementById('question-import-status').textContent = '';
  document.getElementById('question-import-error').textContent = '';
  document.getElementById('question-import-preview-wrap').style.display = 'none';
  document.getElementById('question-import-preview-body').innerHTML = '';
  document.getElementById('question-import-progress-wrap').style.display = 'none';
  document.getElementById('question-import-result-wrap').style.display = 'none';
  document.getElementById('question-import-result-failed-wrap').style.display = 'none';
  document.getElementById('question-import-result-failed-body').innerHTML = '';
  document.getElementById('question-import-confirm-btn').disabled = true;
  document.getElementById('question-import-confirm-count').textContent = '';
  document.getElementById('question-import-cancel-btn').disabled = false;
  document.getElementById('question-import-close-btn').disabled = false;

  questionImportPassageState.parsedRows = [];
  questionImportPassageState.groups = [];
  questionImportPassageState.validCount = 0;
  document.getElementById('question-import-passage-file').value = '';
  document.getElementById('question-import-passage-file').disabled = false;
  document.getElementById('question-import-passage-status').textContent = '';
  document.getElementById('question-import-passage-error').textContent = '';
  document.getElementById('question-import-passage-preview-wrap').style.display = 'none';
  document.getElementById('question-import-passage-groups').innerHTML = '';
  document.getElementById('question-import-passage-progress-wrap').style.display = 'none';
  document.getElementById('question-import-passage-result-wrap').style.display = 'none';
  document.getElementById('question-import-passage-result-failed-wrap').style.display = 'none';
  document.getElementById('question-import-passage-result-failed-body').innerHTML = '';
  document.getElementById('question-import-passage-confirm-btn').disabled = true;
  document.getElementById('question-import-passage-confirm-count').textContent = '';
  document.getElementById('question-import-passage-cancel-btn').disabled = false;

  if (overlay) overlay.style.display = 'block';
  if (panel) panel.style.display = 'flex';
}

function closeQuestionImportPanel() {
  const overlay = document.getElementById('question-import-overlay');
  const panel = document.getElementById('question-import-panel');
  if (overlay) overlay.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

// ============================================================
//  KHỞI TẠO
// ============================================================
function initQuestionImportControls() {
  document.getElementById('question-import-close-btn')?.addEventListener('click', closeQuestionImportPanel);
  document.getElementById('question-import-cancel-btn')?.addEventListener('click', closeQuestionImportPanel);
  document.getElementById('question-import-overlay')?.addEventListener('click', closeQuestionImportPanel);

  document.getElementById('question-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    handleQuestionImportFileSelected(file);
  });

  document.getElementById('question-import-confirm-btn')?.addEventListener('click', runQuestionImportBatch);

  document.getElementById('question-import-passage-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    handleQuestionImportPassageFileSelected(file);
  });
  document.getElementById('question-import-passage-cancel-btn')?.addEventListener('click', closeQuestionImportPanel);
  document.getElementById('question-import-passage-confirm-btn')?.addEventListener('click', runQuestionImportPassageBatch);
}

document.addEventListener('DOMContentLoaded', () => {
  initQuestionImportControls();
});
