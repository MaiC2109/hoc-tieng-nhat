'use strict';

// ============================================================
//  ADMIN — NGÂN HÀNG CÂU HỎI (question_bank)
//  Tách riêng khỏi admin.js vì admin.js đã khá lớn.
//  Dùng chung supabaseClient/ADMIN_CONFIG/escHtml đã khai báo
//  trong admin.js (file này PHẢI được nạp SAU admin.js).
// ============================================================

// Nhãn hiển thị cho loại câu hỏi — dùng lại ở cả bảng danh sách và form (bước sau)
const QUESTION_TYPE_LABELS = {
  multiple_choice: 'Trắc nghiệm',
  fill_blank: 'Điền từ'
};

const questionsAdminState = {
  currentRows: [],   // danh sách câu hỏi đang hiển thị (theo filter kỹ năng hiện tại)
  skills: [],         // cache danh sách skills, tránh gọi lại Supabase nhiều lần
  skillsLoaded: false
};

// ── Header xác thực bằng access token THẬT của admin đang đăng nhập ────────
// Khác với sbHeaders() (dùng anon key) trong admin.js: các bảng mới ở Tier 0
// (question_bank, passages...) có RLS yêu cầu auth.uid() khớp profiles.role
// = 'admin', nên PHẢI gửi access_token thật thì Postgres mới nhận diện được
// đúng user đang gọi. Xem lại quyết định A đã thống nhất trước khi code.
async function sbAuthedHeaders(extra = {}) {
  let token = ADMIN_CONFIG.supabaseAnonKey;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session && session.access_token) token = session.access_token;
  } catch (e) {
    console.error('Lỗi lấy session admin để gọi API câu hỏi:', e);
  }

  return {
    'apikey': ADMIN_CONFIG.supabaseAnonKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

// ── Tiện ích hiển thị ────────────────────────────────────────────────────
function truncateText(str, maxLen = 50) {
  const s = String(str || '');
  return s.length > maxLen ? s.slice(0, maxLen).trim() + '…' : s;
}

function formatDateVN(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN'); // dd/mm/yyyy
}

// question_text giờ có thể chứa thẻ <b>/<u> (do rich text editor) —
// bỏ thẻ HTML khi cần hiển thị dạng chữ thường (search, rút gọn ở bảng).
function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html || '');
  return tmp.textContent || tmp.innerText || '';
}

// ============================================================
//  SKILLS — load 1 lần, dùng cho dropdown filter (và form ở bước sau)
// ============================================================
async function fetchSkillsList() {
  if (questionsAdminState.skillsLoaded) return questionsAdminState.skills;

  // Bảng skills cho phép đọc công khai (RLS select using(true)) -> dùng
  // sbHeaders() (anon key) như các dropdown khác trong admin.js là đủ.
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/skills?select=id,name,code&order=id.asc`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Lỗi tải danh sách kỹ năng: ${res.status}`);

  questionsAdminState.skills = await res.json();
  questionsAdminState.skillsLoaded = true;
  return questionsAdminState.skills;
}

async function populateQuestionSkillFilter() {
  const select = document.getElementById('filter-question-skill');
  if (!select) return;

  try {
    const skills = await fetchSkillsList();
    const currentValue = select.value;

    select.innerHTML = '<option value="">Tất cả kỹ năng</option>' +
      skills.map(sk => `<option value="${sk.id}">${escHtml(sk.name)}</option>`).join('');

    // Giữ lại lựa chọn cũ nếu còn hợp lệ (vd khi populate lại sau reload)
    if (currentValue) select.value = currentValue;
  } catch (err) {
    console.error('Lỗi nạp dropdown kỹ năng:', err);
  }
}

// ============================================================
//  DANH SÁCH CÂU HỎI
// ============================================================

// Lọc theo kỹ năng thực hiện phía server (giống pattern filter Unit/Part
// của vocab); tìm theo nội dung thực hiện phía client (không gọi lại API
// mỗi lần gõ phím) — đúng yêu cầu "search-side client".
function buildQuestionListUrl() {
  const skillFilter = document.getElementById('filter-question-skill')?.value || '';

  // Embed tên kỹ năng qua quan hệ FK skill_id -> skills(id) để không phải
  // tự map id -> name thủ công ở client.
  let url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank`
    + `?select=id,skill_id,question_type,question_text,explanation,created_at,skills(name)`
    + `&order=created_at.desc`;

  if (skillFilter) url += `&skill_id=eq.${encodeURIComponent(skillFilter)}`;
  return url;
}

async function loadQuestionAdminList() {
  const tbody = document.getElementById('question-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>`;
  }

  try {
    const res = await fetch(buildQuestionListUrl(), { headers: await sbAuthedHeaders() });
    if (!res.ok) throw new Error(`Lỗi tải danh sách câu hỏi: ${res.status}`);

    questionsAdminState.currentRows = await res.json();
    renderQuestionAdminTable();
  } catch (err) {
    console.error('Lỗi tải danh sách câu hỏi:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">❌ Không tải được danh sách câu hỏi.</div></td></tr>`;
    }
  }
}

// Áp thêm tìm kiếm theo nội dung (client-side) lên questionsAdminState.currentRows
// rồi render — gọi lại mỗi khi gõ ô search, KHÔNG gọi lại Supabase.
function renderQuestionAdminTable() {
  const tbody = document.getElementById('question-table-body');
  if (!tbody) return;

  const keyword = (document.getElementById('question-search-input')?.value || '').trim().toLowerCase();
  const rows = questionsAdminState.currentRows;
  const filtered = keyword
    ? rows.filter(r => stripHtml(r.question_text).toLowerCase().includes(keyword))
    : rows;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Không có câu hỏi nào khớp bộ lọc.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const skillName = r.skills?.name || '—';
    const typeLabel = QUESTION_TYPE_LABELS[r.question_type] || r.question_type || '—';
    const hasFeedback = !!(r.explanation && r.explanation.trim());

    return `
      <tr>
        <td>${escHtml(skillName)}</td>
        <td>${escHtml(typeLabel)}</td>
        <td>${escHtml(truncateText(stripHtml(r.question_text), 50))}</td>
        <td style="text-align:center;">${hasFeedback ? '✓' : '—'}</td>
        <td>${escHtml(formatDateVN(r.created_at))}</td>
      </tr>
    `;
  }).join('');
}

// ── Gắn sự kiện ──────────────────────────────────────────────────────────
function initQuestionSearch() {
  const input = document.getElementById('question-search-input');
  if (!input) return;
  input.addEventListener('input', () => renderQuestionAdminTable());
}

function initQuestionSkillFilter() {
  const select = document.getElementById('filter-question-skill');
  if (!select) return;
  select.addEventListener('change', () => loadQuestionAdminList());
}

// Gọi bởi switchAdminSection() (admin.js) khi vào tab "Câu hỏi" —
// lazy-load giống pattern vocab/students, tránh gọi Supabase thừa.
async function loadQuestionsSection() {
  await populateQuestionSkillFilter();
  await populateQuestionFormSkillDropdown();
  await loadQuestionAdminList();
}

// ============================================================
//  FORM "THÊM / SỬA CÂU HỎI" — panel trượt, dùng chung 1 form
//  Lưu ý: bước này CHƯA nối nút "Sửa" từ bảng danh sách (sẽ làm ở bước
//  sau) nên questionFormState.mode thực tế luôn là 'create' khi form
//  được mở — nhưng submitQuestionForm() đã viết sẵn nhánh update để khi
//  nối nút Sửa vào (chỉ cần gọi openQuestionForm(row) ở bước sau) là
//  chạy được ngay, không phải sửa lại hàm submit.
// ============================================================

const questionFormState = {
  mode: 'create',    // 'create' | 'edit'
  editingId: null,   // id câu hỏi đang sửa (chỉ có giá trị khi mode === 'edit')
  audioUploading: false // true trong lúc file audio đang upload dở — chặn submit để tránh lưu thiếu audio_url
};

// Dropdown Kỹ năng riêng cho form (khác dropdown filter ở toolbar)
async function populateQuestionFormSkillDropdown() {
  const select = document.getElementById('question-skill');
  if (!select) return;

  try {
    const skills = await fetchSkillsList();
    select.innerHTML = '<option value="">— Chọn kỹ năng —</option>' +
      skills.map(sk => `<option value="${sk.id}">${escHtml(sk.name)}</option>`).join('');
  } catch (err) {
    console.error('Lỗi nạp dropdown kỹ năng cho form câu hỏi:', err);
  }
}

// Ẩn/hiện khối multiple_choice hoặc fill_blank theo #question-type hiện tại
function toggleQuestionTypeFields() {
  const type = document.getElementById('question-type')?.value;
  const mcBlock = document.getElementById('question-mc-block');
  const fbBlock = document.getElementById('question-fb-block');
  if (!mcBlock || !fbBlock) return;

  if (type === 'fill_blank') {
    mcBlock.style.display = 'none';
    fbBlock.style.display = 'block';
  } else {
    mcBlock.style.display = 'block';
    fbBlock.style.display = 'none';
  }
}

// Reset toàn bộ form về trạng thái trống — dùng cả khi mở form tạo mới
// lẫn sau khi sửa xong (đóng form)
function resetQuestionForm() {
  const form = document.getElementById('question-form');
  if (form) form.reset();

  document.getElementById('question-form-id').value = '';
  document.getElementById('question-form-error').textContent = '';

  // form.reset() không tác dụng lên div contenteditable -> dọn tay
  const editor = document.getElementById('question-text');
  if (editor) editor.innerHTML = '';

  // dọn field audio (input file, hidden url, preview)
  const audioFileInput = document.getElementById('question-audio-file');
  if (audioFileInput) audioFileInput.value = '';
  document.getElementById('question-audio-url').value = '';
  const audioStatus = document.getElementById('question-audio-status');
  if (audioStatus) audioStatus.textContent = '';
  const audioPreview = document.getElementById('question-audio-preview');
  if (audioPreview) {
    audioPreview.style.display = 'none';
    audioPreview.removeAttribute('src');
  }

  // reset về đáp án đúng mặc định là ô đầu tiên
  const radio0 = document.getElementById('question-choice-radio-0');
  if (radio0) radio0.checked = true;

  toggleQuestionTypeFields();
}

// Mở form ở chế độ TẠO MỚI. Tham số `row` để dành cho bước "Sửa" sau này
// (truyền dữ liệu câu hỏi cũ vào) — hiện tại luôn gọi không kèm tham số.
function openQuestionForm(row = null) {
  resetQuestionForm();

  const overlay = document.getElementById('question-form-overlay');
  const panel = document.getElementById('question-form-panel');
  const title = document.getElementById('question-form-title');
  const submitBtn = document.getElementById('question-form-submit-btn');
  const saveContinueBtn = document.getElementById('question-form-save-continue-btn');

  if (row) {
    // Nhánh sửa — CHƯA nối nút gọi tới đây ở bước này, để sẵn cho bước sau.
    questionFormState.mode = 'edit';
    questionFormState.editingId = row.id;
    if (title) title.textContent = 'Sửa câu hỏi';
    if (submitBtn) submitBtn.textContent = 'Cập nhật câu hỏi';
    if (saveContinueBtn) saveContinueBtn.style.display = 'none'; // chỉ có ở mode tạo mới
    // TODO (bước sau): đổ dữ liệu row vào các field tương ứng.
  } else {
    questionFormState.mode = 'create';
    questionFormState.editingId = null;
    if (title) title.textContent = 'Thêm câu hỏi mới';
    if (submitBtn) submitBtn.textContent = 'Lưu câu hỏi';
    if (saveContinueBtn) saveContinueBtn.style.display = 'inline-flex';
  }

  if (overlay) overlay.style.display = 'block';
  if (panel) panel.style.display = 'flex';
}

function closeQuestionForm() {
  const overlay = document.getElementById('question-form-overlay');
  const panel = document.getElementById('question-form-panel');
  if (overlay) overlay.style.display = 'none';
  if (panel) panel.style.display = 'none';
  resetQuestionForm();
}

// Đọc + validate toàn bộ field trên form, trả về payload hợp lệ hoặc null
// (khi null, đã tự ghi message lỗi vào #question-form-error).
// Dùng chung cho cả 2 nút "Lưu" và "Lưu & Tạo tiếp".
function validateAndBuildQuestionPayload() {
  const errorEl = document.getElementById('question-form-error');
  errorEl.textContent = '';

  // Nếu file audio đang upload dở mà bấm Lưu ngay -> audio_url sẽ trống dù
  // giáo viên đã chọn file. Chặn lại và báo rõ thay vì lưu thiếu audio.
  if (questionFormState.audioUploading) {
    errorEl.textContent = 'File audio đang được tải lên, vui lòng đợi upload xong rồi mới bấm Lưu.';
    return null;
  }

  const skillId = document.getElementById('question-skill').value;
  const questionType = document.getElementById('question-type').value;
  // Nội dung câu hỏi lấy từ div contenteditable -> lưu nguyên HTML (giữ
  // định dạng bold/underline giáo viên đã chọn) vào question_text.
  const questionTextEditor = document.getElementById('question-text');
  const questionTextHtml = (questionTextEditor?.innerHTML || '').trim();
  const questionTextPlain = stripHtml(questionTextHtml).trim();
  const explanation = document.getElementById('question-explanation').value.trim();
  const difficulty = document.getElementById('question-difficulty').value;

  if (!skillId) {
    errorEl.textContent = 'Vui lòng chọn Kỹ năng.';
    return null;
  }
  if (!questionTextPlain) {
    errorEl.textContent = 'Vui lòng nhập nội dung câu hỏi.';
    return null;
  }

  // Chuẩn bị choices/correct_answer tùy theo loại câu hỏi
  let choices = null;
  let correctAnswer = '';

  if (questionType === 'multiple_choice') {
    // Cho phép 2-4 đáp án (không bắt buộc đủ 4) — ô nào bỏ trống sẽ không
    // đưa vào choices, miễn còn ít nhất 2 ô có nội dung.
    const rawChoices = [0, 1, 2, 3]
      .map(i => document.getElementById(`question-choice-${i}`).value.trim())
      .filter(c => c);

    if (rawChoices.length < 2) {
      errorEl.textContent = 'Vui lòng nhập ít nhất 2 đáp án.';
      return null;
    }

    const correctIdx = document.querySelector('input[name="question-correct-choice"]:checked')?.value;
    const correctValue = correctIdx !== undefined
      ? document.getElementById(`question-choice-${correctIdx}`).value.trim()
      : '';

    if (!correctValue) {
      errorEl.textContent = 'Đáp án đúng đang được tích chọn ở 1 ô trống — vui lòng nhập nội dung cho ô đó hoặc chọn lại đáp án đúng.';
      return null;
    }

    choices = rawChoices;
    correctAnswer = correctValue;
  } else if (questionType === 'fill_blank') {
    const fbAnswer = document.getElementById('question-fillblank-answer').value.trim();
    if (!fbAnswer) {
      errorEl.textContent = 'Vui lòng nhập đáp án đúng (dạng thứ tự, vd "2314").';
      return null;
    }
    correctAnswer = fbAnswer;
  } else {
    errorEl.textContent = 'Loại câu hỏi không hợp lệ.';
    return null;
  }

  // Cảnh báo mềm (không chặn submit) nếu Kỹ năng = "Nghe hiểu" mà chưa có audio.
  const audioUrl = document.getElementById('question-audio-url').value || null;
  const selectedSkill = questionsAdminState.skills.find(sk => String(sk.id) === String(skillId));
  if (selectedSkill?.code === 'listening' && !audioUrl) {
    const proceed = confirm('Kỹ năng này là "Nghe hiểu" nhưng bạn chưa upload file audio. Vẫn muốn lưu câu hỏi mà không có audio?');
    if (!proceed) return null;
  }

  return {
    skill_id: Number(skillId),
    question_type: questionType,
    question_text: questionTextHtml,
    audio_url: audioUrl,
    choices: choices, // null với fill_blank
    correct_answer: correctAnswer,
    explanation: explanation || null,
    difficulty: difficulty || null
    // passage_id: chưa làm ở bước này, để NULL/bỏ trống theo default cột
  };
}

// Gọi Supabase để insert (create) hoặc update (edit) — dùng chung cho cả
// 2 nút. Ném lỗi (throw) nếu request thất bại, để nơi gọi tự xử lý UI.
async function saveQuestionToSupabase(payload) {
  const isEdit = questionFormState.mode === 'edit' && questionFormState.editingId !== null;
  const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });

  if (isEdit) {
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?id=eq.${questionFormState.editingId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }) }
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi cập nhật câu hỏi (HTTP ${res.status})`);
    }
  } else {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi thêm câu hỏi (HTTP ${res.status})`);
    }
  }

  return { isEdit };
}

// Nút "Lưu câu hỏi" / "Cập nhật câu hỏi" (submit form mặc định) — lưu xong
// thì đóng form, quay về danh sách.
async function submitQuestionForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('question-form-error');
  const submitBtn = document.getElementById('question-form-submit-btn');

  const payload = validateAndBuildQuestionPayload();
  if (!payload) return;

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    await saveQuestionToSupabase(payload);
    closeQuestionForm();
    await loadQuestionAdminList();
  } catch (err) {
    console.error('Lỗi lưu câu hỏi:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu câu hỏi. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// Nút "Lưu & Tạo tiếp" — chỉ xuất hiện ở mode tạo mới. Lưu xong KHÔNG đóng
// form: giữ nguyên Kỹ năng + Loại câu hỏi, xóa các field còn lại (nội dung,
// đáp án, feedback, difficulty, audio), rồi focus lại vào ô nội dung để
// giáo viên nhập ngay câu tiếp theo.
async function handleSaveAndContinue() {
  const errorEl = document.getElementById('question-form-error');
  const btn = document.getElementById('question-form-save-continue-btn');

  const payload = validateAndBuildQuestionPayload();
  if (!payload) return;

  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = 'Đang lưu...';

  try {
    await saveQuestionToSupabase(payload);

    // Giữ nguyên Kỹ năng + Loại câu hỏi hiện tại (không reset 2 dropdown này)
    const keepSkillId = document.getElementById('question-skill').value;
    const keepType = document.getElementById('question-type').value;

    resetQuestionForm();

    document.getElementById('question-skill').value = keepSkillId;
    document.getElementById('question-type').value = keepType;
    toggleQuestionTypeFields();

    document.getElementById('question-text')?.focus();

    await loadQuestionAdminList(); // cập nhật bảng nền, không đóng form
  } catch (err) {
    console.error('Lỗi lưu câu hỏi (Lưu & Tạo tiếp):', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu câu hỏi. Vui lòng thử lại.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ── Toolbar định dạng chữ (bold/underline) cho nội dung câu hỏi ──────────
// Dùng document.execCommand: đơn giản, đủ dùng cho nhu cầu bold/underline
// cơ bản, không cần thêm thư viện rich-text ngoài (giữ đúng chủ trương
// vanilla JS, không thêm framework/dependency mới).
function applyQuestionTextFormat(command) {
  const editor = document.getElementById('question-text');
  if (!editor) return;
  editor.focus();
  document.execCommand(command, false, null);
  syncRichTextToolbarState();
}

// Bật highlight (.active) cho nút bold/underline nếu vị trí con trỏ hiện
// tại đang nằm trong đoạn chữ có định dạng tương ứng.
function syncRichTextToolbarState() {
  const boldBtn = document.getElementById('question-text-bold-btn');
  const underlineBtn = document.getElementById('question-text-underline-btn');
  try {
    if (boldBtn) boldBtn.classList.toggle('active', document.queryCommandState('bold'));
    if (underlineBtn) underlineBtn.classList.toggle('active', document.queryCommandState('underline'));
  } catch (e) {
    // một số trình duyệt cũ có thể không hỗ trợ queryCommandState — bỏ qua an toàn
  }
}

// ── Upload audio lên Supabase Storage (bucket exam-audio) ────────────────
// Dùng thẳng supabaseClient.storage (client đã khởi tạo sẵn trong
// admin.js) thay vì tự gọi fetch REST — đây là cách chuẩn của supabase-js
// cho việc upload file, không cần tự build request.
async function uploadQuestionAudioFile(file) {
  const statusEl = document.getElementById('question-audio-status');
  const previewEl = document.getElementById('question-audio-preview');
  const hiddenUrlInput = document.getElementById('question-audio-url');

  questionFormState.audioUploading = true;
  if (statusEl) {
    statusEl.textContent = '⏳ Đang tải file audio lên...';
    statusEl.style.color = '';
  }

  try {
    const safeFileName = file.name.replace(/[^\w.\-]/g, '_'); // tránh ký tự lạ trong path
    const path = `${crypto.randomUUID()}-${safeFileName}`;

    const { error: uploadError } = await supabaseClient
      .storage
      .from('exam-audio')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient
      .storage
      .from('exam-audio')
      .getPublicUrl(path);

    const publicUrl = publicUrlData?.publicUrl;
    if (!publicUrl) throw new Error('Không lấy được public URL sau khi upload.');

    if (hiddenUrlInput) hiddenUrlInput.value = publicUrl;

    if (previewEl) {
      previewEl.src = publicUrl;
      previewEl.style.display = 'block';
    }
    if (statusEl) statusEl.textContent = '✓ Đã tải audio lên thành công.';
  } catch (err) {
    // In lỗi đầy đủ ra console để debug (vd lỗi RLS/permission từ Storage
    // sẽ có message rõ ràng ở đây), đồng thời hiện luôn message cho giáo
    // viên thấy thay vì chỉ 1 dòng chung chung.
    console.error('Lỗi upload audio câu hỏi:', err);
    if (statusEl) {
      statusEl.textContent = `❌ Tải audio thất bại: ${err?.message || 'Lỗi không xác định'}`;
      statusEl.style.color = 'var(--vermillion)';
    }
    if (hiddenUrlInput) hiddenUrlInput.value = '';
  } finally {
    questionFormState.audioUploading = false;
  }
}

function initQuestionFormControls() {
  document.getElementById('question-form-close-btn')?.addEventListener('click', closeQuestionForm);
  document.getElementById('question-form-cancel-btn')?.addEventListener('click', closeQuestionForm);
  document.getElementById('question-form-overlay')?.addEventListener('click', closeQuestionForm);
  document.getElementById('question-form')?.addEventListener('submit', submitQuestionForm);
  document.getElementById('question-form-save-continue-btn')?.addEventListener('click', handleSaveAndContinue);
  document.getElementById('question-type')?.addEventListener('change', toggleQuestionTypeFields);

  document.getElementById('question-text-bold-btn')?.addEventListener('click', () => applyQuestionTextFormat('bold'));
  document.getElementById('question-text-underline-btn')?.addEventListener('click', () => applyQuestionTextFormat('underline'));
  document.getElementById('question-text')?.addEventListener('keyup', syncRichTextToolbarState);
  document.getElementById('question-text')?.addEventListener('mouseup', syncRichTextToolbarState);

  document.getElementById('question-audio-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadQuestionAudioFile(file);
  });
}

// ============================================================
//  KHỞI TẠO (chạy song song với DOMContentLoaded của admin.js)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initQuestionSearch();
  initQuestionSkillFilter();
  initQuestionFormControls();
});
