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

const QUESTION_PAGE_SIZE = 50;
const PASSAGE_PAGE_SIZE = 50;

const questionsAdminState = {
  currentRows: [],   // danh sách câu hỏi đang hiển thị (theo filter kỹ năng hiện tại)
  currentPage: 1,     // trang hiện tại của bảng câu hỏi (50 items/trang)
  selectedIds: new Set(), // id các câu hỏi đang được tick chọn (bulk actions)
  skills: [],         // cache danh sách skills, tránh gọi lại Supabase nhiều lần
  skillsLoaded: false,
  passages: [],        // cache danh sách passages cho dropdown "Thuộc đoạn văn/hội thoại"
  passagesLoaded: false,
  passageTableRows: [], // dữ liệu bảng danh sách passage (kèm số câu hỏi đang dùng)
  passageCurrentPage: 1  // trang hiện tại của bảng passage (50 items/trang)
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

// Dropdown "Tất cả đề thi" ở toolbar — dùng lại fetchExamsList() đã có sẵn
// (cache chung với dropdown "Thêm vào đề thi" ở form câu hỏi/bulk).
async function populateQuestionExamFilter() {
  const select = document.getElementById('filter-question-exam');
  if (!select) return;

  try {
    const exams = await fetchExamsList();
    const currentValue = select.value;

    select.innerHTML = '<option value="">Tất cả đề thi</option>'
      + '<option value="__unassigned__">— Chưa gắn vào đề nào —</option>'
      + exams.map(ex => `<option value="${ex.id}">${escHtml(ex.title)}${ex.is_published ? '' : ' (nháp)'}</option>`).join('');

    if (currentValue) select.value = currentValue;
  } catch (err) {
    console.error('Lỗi nạp dropdown lọc theo đề thi:', err);
  }
}

// ============================================================
//  PASSAGES — dùng cho dropdown "Thuộc đoạn văn/hội thoại" trong form câu hỏi
// ============================================================
async function fetchPassagesList(forceReload = false) {
  if (questionsAdminState.passagesLoaded && !forceReload) return questionsAdminState.passages;

  // Bảng passages cho phép đọc công khai (RLS select using(true)).
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages?select=id,title&order=created_at.desc`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Lỗi tải danh sách đoạn văn/hội thoại: ${res.status}`);

  questionsAdminState.passages = await res.json();
  questionsAdminState.passagesLoaded = true;
  return questionsAdminState.passages;
}

// selectedId: nếu truyền vào (vd sau khi vừa tạo đoạn mới), tự chọn sẵn
// đoạn đó trong dropdown sau khi refresh.
async function populateQuestionFormPassageDropdown(selectedId = '') {
  const select = document.getElementById('question-form-passage-id');
  if (!select) return;

  try {
    const passages = await fetchPassagesList(true); // luôn lấy mới nhất khi hàm này được gọi
    const keepValue = selectedId || select.value;

    select.innerHTML = '<option value="">— Không thuộc đoạn nào —</option>' +
      passages.map(p => `<option value="${p.id}">${escHtml(p.title || '(Chưa đặt tiêu đề)')}</option>`).join('');

    if (keepValue) select.value = keepValue;
  } catch (err) {
    console.error('Lỗi nạp dropdown đoạn văn/hội thoại:', err);
  }
}

// Ẩn/hiện khối chọn passage theo Kỹ năng hiện tại — chỉ có ý nghĩa với
// Đọc hiểu (reading) / Nghe hiểu (listening).
function toggleQuestionPassageField() {
  const group = document.getElementById('question-passage-group');
  const skillId = document.getElementById('question-skill')?.value;
  if (!group) return;

  const skill = questionsAdminState.skills.find(sk => String(sk.id) === String(skillId));
  const shouldShow = !!skill && (skill.code === 'reading' || skill.code === 'listening' || skill.code === 'grammar');

  group.style.display = shouldShow ? 'block' : 'none';
  if (!shouldShow) {
    const select = document.getElementById('question-form-passage-id');
    if (select) select.value = '';
  }
}

// ============================================================
//  DANH SÁCH CÂU HỎI
// ============================================================

// Lọc theo kỹ năng + đề thi thực hiện phía server (giống pattern filter
// Unit/Part của vocab); tìm theo nội dung thực hiện phía client (không gọi
// lại API mỗi lần gõ phím) — đúng yêu cầu "search-side client".
// `matchedIds` = danh sách id câu hỏi đã lọc sẵn theo Đề thi (null = không
// lọc theo đề thi) — được tính trước ở loadQuestionAdminList() vì việc lọc
// theo đề thi cần đi xuyên qua exam_sections/exam_subsections/exam_questions,
// không nhét gọn vào 1 URL PostgREST đơn giản như filter kỹ năng được.
function buildQuestionListUrl(matchedIds, excludeIds) {
  const skillFilter = document.getElementById('filter-question-skill')?.value || '';
  const sortDir = document.getElementById('sort-question-created')?.value === 'asc' ? 'asc' : 'desc';

  // Lấy đủ field cần cho form Sửa/Nhân bản (choices, correct_answer, audio_url,
  // difficulty) — không chỉ mấy cột hiển thị ở bảng như trước, để click vào
  // dòng là có đủ dữ liệu đổ vào form ngay, không phải gọi thêm 1 API riêng.
  let url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank`
    + `?select=id,skill_id,question_type,question_text,choices,correct_answer,`
    + `audio_url,explanation,difficulty,passage_id,created_at,skills(name)`
    + `&order=created_at.${sortDir}`;

  if (skillFilter) url += `&skill_id=eq.${encodeURIComponent(skillFilter)}`;
  if (Array.isArray(matchedIds)) url += `&id=in.(${matchedIds.join(',')})`;
  // excludeIds: dùng cho filter "Chưa gắn vào đề nào" — loại các câu ĐÃ có
  // mặt trong exam_questions (bất kể đề nào). Rỗng nghĩa là chưa câu nào
  // được gắn -> khỏi thêm điều kiện gì (giữ nguyên toàn bộ danh sách).
  if (Array.isArray(excludeIds) && excludeIds.length > 0) url += `&id=not.in.(${excludeIds.join(',')})`;
  return url;
}

// Lọc theo Đề thi: question_bank không có exam_id trực tiếp (chỉ liên kết
// qua exam_questions -> exam_subsections -> exam_sections -> exam_id), nên
// đi 3 bước tuần tự (mỗi bước dùng id của bước trước) thay vì embed lồng
// nhau qua PostgREST cho dễ đọc/dễ sửa — số bảng trung gian ít (3 bảng),
// không đáng lo hiệu năng ở quy mô 1 trường/trung tâm.
async function fetchQuestionIdsForExam(examId) {
  const headers = await sbAuthedHeaders();

  const sectionsRes = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?exam_id=eq.${encodeURIComponent(examId)}&select=id`,
    { headers }
  );
  if (!sectionsRes.ok) throw new Error(`Lỗi lọc theo đề thi (bước 1): ${sectionsRes.status}`);
  const sections = await sectionsRes.json();
  if (sections.length === 0) return [];

  const sectionIds = sections.map(s => s.id).join(',');
  const subsectionsRes = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?exam_section_id=in.(${sectionIds})&select=id`,
    { headers }
  );
  if (!subsectionsRes.ok) throw new Error(`Lỗi lọc theo đề thi (bước 2): ${subsectionsRes.status}`);
  const subsections = await subsectionsRes.json();
  if (subsections.length === 0) return [];

  const subsectionIds = subsections.map(s => s.id).join(',');
  const examQuestionsRes = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=in.(${subsectionIds})&select=question_id`,
    { headers }
  );
  if (!examQuestionsRes.ok) throw new Error(`Lỗi lọc theo đề thi (bước 3): ${examQuestionsRes.status}`);
  const examQuestions = await examQuestionsRes.json();

  // Loại trùng vì 1 câu có thể xuất hiện ở nhiều dạng bài khác nhau trong
  // cùng 1 đề (hiếm nhưng không cấm ở schema).
  return Array.from(new Set(examQuestions.map(eq => eq.question_id)));
}

// Lọc "Chưa gắn vào đề nào": lấy TOÀN BỘ question_id đã xuất hiện ở
// exam_questions (không phân biệt đề nào), rồi loại trừ (not.in) khỏi
// question_bank ở buildQuestionListUrl(). Đơn giản hơn đi 3 bước như
// fetchQuestionIdsForExam() vì không cần biết câu đó thuộc đề nào, chỉ cần
// biết "đã gắn hay chưa".
async function fetchAllAssignedQuestionIds() {
  const res = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?select=question_id`,
    { headers: await sbAuthedHeaders() }
  );
  if (!res.ok) throw new Error(`Lỗi tải danh sách câu đã gắn đề thi: ${res.status}`);
  const rows = await res.json();
  return Array.from(new Set(rows.map(r => r.question_id)));
}

async function loadQuestionAdminList() {
  const tbody = document.getElementById('question-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>`;
  }

  try {
    const examFilter = document.getElementById('filter-question-exam')?.value || '';
    let matchedIds = null;
    let excludeIds = null;

    if (examFilter === '__unassigned__') {
      excludeIds = await fetchAllAssignedQuestionIds();
    } else if (examFilter) {
      matchedIds = await fetchQuestionIdsForExam(examFilter);
      if (matchedIds.length === 0) {
        // Đề thi chưa có câu hỏi nào -> khỏi cần gọi question_bank nữa
        questionsAdminState.currentRows = [];
        questionsAdminState.currentPage = 1;
        questionsAdminState.selectedIds.clear();
        renderQuestionAdminTable();
        return;
      }
    }

    const res = await fetch(buildQuestionListUrl(matchedIds, excludeIds), { headers: await sbAuthedHeaders() });
    if (!res.ok) throw new Error(`Lỗi tải danh sách câu hỏi: ${res.status}`);

    questionsAdminState.currentRows = await res.json();
    questionsAdminState.currentPage = 1; // reset về trang 1 mỗi khi tải lại (đổi filter/sort...)
    questionsAdminState.selectedIds.clear(); // dữ liệu mới -> bỏ chọn cũ cho an toàn
    renderQuestionAdminTable();
  } catch (err) {
    console.error('Lỗi tải danh sách câu hỏi:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">❌ Không tải được danh sách câu hỏi.</div></td></tr>`;
    }
  }
}

// Áp thêm tìm kiếm theo nội dung (client-side) lên questionsAdminState.currentRows
// rồi render — gọi lại mỗi khi gõ ô search, KHÔNG gọi lại Supabase.
function renderQuestionAdminTable() {
  const tbody = document.getElementById('question-table-body');
  const pagEl = document.getElementById('question-pagination');
  if (!tbody) return;

  const keyword = (document.getElementById('question-search-input')?.value || '').trim().toLowerCase();
  const rows = questionsAdminState.currentRows;
  const filtered = keyword
    ? rows.filter(r => stripHtml(r.question_text).toLowerCase().includes(keyword))
    : rows;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Không có câu hỏi nào khớp bộ lọc.</div></td></tr>`;
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / QUESTION_PAGE_SIZE));
  if (questionsAdminState.currentPage > totalPages) questionsAdminState.currentPage = totalPages;
  if (questionsAdminState.currentPage < 1) questionsAdminState.currentPage = 1;

  const startIdx = (questionsAdminState.currentPage - 1) * QUESTION_PAGE_SIZE;
  const pageRows = filtered.slice(startIdx, startIdx + QUESTION_PAGE_SIZE);

  tbody.innerHTML = pageRows.map((r, idx) => {
    const skillName = r.skills?.name || '—';
    const typeLabel = QUESTION_TYPE_LABELS[r.question_type] || r.question_type || '—';
    const hasFeedback = !!(r.explanation && r.explanation.trim());
    const stt = startIdx + idx + 1;
    const isChecked = questionsAdminState.selectedIds.has(String(r.id));

    // Click vào cả dòng -> mở form Sửa. Các nút thao tác/checkbox dùng
    // event.stopPropagation() để không kích hoạt luôn việc mở form Sửa.
    return `
      <tr onclick="editQuestionRow('${r.id}')" style="cursor:pointer;">
        <td onclick="event.stopPropagation();" style="text-align:center;">
          <input type="checkbox" class="question-row-checkbox" data-id="${r.id}" ${isChecked ? 'checked' : ''} onchange="toggleQuestionRowSelect('${r.id}', this.checked)" />
        </td>
        <td style="text-align:center;">${stt}</td>
        <td>${escHtml(skillName)}</td>
        <td>${escHtml(typeLabel)}</td>
        <td>${escHtml(truncateText(stripHtml(r.question_text), 50)) || '<span style="color:var(--ink-soft);">[Hình ảnh]</span>'}</td>
        <td style="text-align:center;">${hasFeedback ? '✓' : '—'}</td>
        <td>${escHtml(formatDateVN(r.created_at))}</td>
        <td onclick="event.stopPropagation();" style="text-align:center;">
          <div class="admin-row-actions">
            <button class="admin-row-action-btn" onclick="editQuestionRow('${r.id}')" title="Sửa">
              <i class="ti ti-edit"></i>
            </button>
            <button class="admin-row-action-btn" onclick="duplicateQuestionRow('${r.id}')" title="Nhân bản">
              <i class="ti ti-copy"></i>
            </button>
            <button class="admin-row-action-btn danger" onclick="deleteQuestionRow('${r.id}')" title="Xóa">
              <i class="ti ti-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  syncQuestionSelectAllCheckbox();
  updateQuestionBulkBar();

  renderQuestionPagination(filtered.length, totalPages);
}

// ============================================================
//  BULK ACTIONS (chọn nhiều dòng câu hỏi cùng lúc)
// ============================================================

function toggleQuestionRowSelect(id, checked) {
  const key = String(id);
  if (checked) questionsAdminState.selectedIds.add(key);
  else questionsAdminState.selectedIds.delete(key);

  syncQuestionSelectAllCheckbox();
  updateQuestionBulkBar();
}

// Checkbox "chọn tất cả" chỉ áp dụng cho các dòng ĐANG HIỂN THỊ ở trang hiện
// tại (đúng hành vi phổ biến — không âm thầm chọn cả những dòng chưa nhìn
// thấy ở trang khác).
function toggleQuestionSelectAll(checked) {
  document.querySelectorAll('#question-table-body .question-row-checkbox').forEach(cb => {
    cb.checked = checked;
    const id = cb.getAttribute('data-id');
    if (checked) questionsAdminState.selectedIds.add(String(id));
    else questionsAdminState.selectedIds.delete(String(id));
  });
  updateQuestionBulkBar();
}

// Tick "chọn tất cả" tự bật nếu mọi dòng ở trang hiện tại đều đã được chọn,
// tự tắt nếu có ít nhất 1 dòng chưa chọn (kể cả khi không có dòng nào).
function syncQuestionSelectAllCheckbox() {
  const selectAllCb = document.getElementById('question-select-all');
  if (!selectAllCb) return;
  const rowCbs = document.querySelectorAll('#question-table-body .question-row-checkbox');
  if (rowCbs.length === 0) { selectAllCb.checked = false; return; }
  selectAllCb.checked = Array.from(rowCbs).every(cb => cb.checked);
}

function updateQuestionBulkBar() {
  const bar = document.getElementById('question-bulk-bar');
  const countEl = document.getElementById('question-bulk-count');
  const count = questionsAdminState.selectedIds.size;

  if (bar) bar.style.display = count > 0 ? 'flex' : 'none';
  if (countEl) countEl.textContent = `Đã chọn ${count} câu hỏi`;
}

// Xóa lựa chọn ở CẢ state lẫn DOM — trước đây chỉ clear() Set nội bộ nên
// sau khi bulk-add vào đề thi xong, checkbox từng dòng (đã render sẵn
// "checked" từ trước) vẫn hiện tick dù state đã trống, gây hiểu nhầm là
// chưa thêm được. Không gọi lại loadQuestionAdminList()/render lại toàn
// bảng vì tốn 1 lượt gọi API không cần thiết — chỉ cần bỏ tick DOM.
function clearQuestionSelection() {
  questionsAdminState.selectedIds.clear();

  document.querySelectorAll('#question-table-body .question-row-checkbox').forEach(cb => {
    cb.checked = false;
  });

  const selectAllCb = document.getElementById('question-select-all');
  if (selectAllCb) selectAllCb.checked = false;

  updateQuestionBulkBar();
}

// ── Xóa hàng loạt ─────────────────────────────────────────────────────────
async function bulkDeleteSelectedQuestions() {
  const ids = Array.from(questionsAdminState.selectedIds);
  if (ids.length === 0) return;

  try {
    const headers = await sbAuthedHeaders();

    // Kiểm tra từng câu đang thuộc bao nhiêu đề thi, để liệt kê rõ trong
    // confirm dialog (vd "3/5 câu đang thuộc đề thi").
    const usageChecks = await Promise.all(ids.map(async id => {
      const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?question_id=eq.${id}&select=id`, { headers });
      if (!res.ok) throw new Error(`Lỗi kiểm tra câu hỏi ${id} đang dùng ở đề thi nào: ${res.status}`);
      const rows = await res.json();
      return rows.length > 0;
    }));
    const usedCount = usageChecks.filter(Boolean).length;

    const confirmMsg = usedCount > 0
      ? `${usedCount}/${ids.length} câu đang thuộc đề thi, xóa sẽ ảnh hưởng đến các đề đó. Vẫn xóa tất cả ${ids.length} câu đã chọn?`
      : `Bạn có chắc muốn xóa ${ids.length} câu hỏi đã chọn?`;
    if (!confirm(confirmMsg)) return;

    const idsFilter = ids.join(',');
    const deleteRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?id=in.(${idsFilter})`,
      { method: 'DELETE', headers: await sbAuthedHeaders() }
    );
    if (!deleteRes.ok) throw new Error(`Lỗi xóa hàng loạt câu hỏi: ${deleteRes.status}`);

    clearQuestionSelection();
    await loadQuestionAdminList();
  } catch (err) {
    console.error('Lỗi xóa hàng loạt câu hỏi:', err);
    alert('Có lỗi khi xóa các câu hỏi đã chọn. Vui lòng thử lại.');
  }
}

// ── Đổi độ khó hàng loạt ──────────────────────────────────────────────────
async function bulkApplyDifficulty() {
  const ids = Array.from(questionsAdminState.selectedIds);
  if (ids.length === 0) return;

  const select = document.getElementById('question-bulk-difficulty');
  const value = select?.value || '';
  if (!value) {
    alert('Vui lòng chọn độ khó muốn áp dụng.');
    return;
  }

  try {
    const idsFilter = ids.join(',');
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?id=in.(${idsFilter})`,
      {
        method: 'PATCH',
        headers: await sbAuthedHeaders(),
        body: JSON.stringify({ difficulty: value, updated_at: new Date().toISOString() })
      }
    );
    if (!res.ok) throw new Error(`Lỗi đổi độ khó hàng loạt: ${res.status}`);

    if (select) select.value = '';
    clearQuestionSelection();
    await loadQuestionAdminList();
  } catch (err) {
    console.error('Lỗi đổi độ khó hàng loạt:', err);
    alert('Có lỗi khi đổi độ khó hàng loạt. Vui lòng thử lại.');
  }
}

// ── Đổi kỹ năng hàng loạt ─────────────────────────────────────────────────
async function bulkApplySkill() {
  const ids = Array.from(questionsAdminState.selectedIds);
  if (ids.length === 0) return;

  const select = document.getElementById('question-bulk-skill');
  const value = select?.value || '';
  if (!value) {
    alert('Vui lòng chọn kỹ năng muốn áp dụng.');
    return;
  }

  try {
    const idsFilter = ids.join(',');
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?id=in.(${idsFilter})`,
      {
        method: 'PATCH',
        headers: await sbAuthedHeaders(),
        body: JSON.stringify({ skill_id: Number(value), updated_at: new Date().toISOString() })
      }
    );
    if (!res.ok) throw new Error(`Lỗi đổi kỹ năng hàng loạt: ${res.status}`);

    if (select) select.value = '';
    clearQuestionSelection();
    await loadQuestionAdminList();
  } catch (err) {
    console.error('Lỗi đổi kỹ năng hàng loạt:', err);
    alert('Có lỗi khi đổi kỹ năng hàng loạt. Vui lòng thử lại.');
  }
}

// Nạp dropdown "Đổi kỹ năng thành" trong thanh bulk — dùng chung cache skills
async function populateQuestionBulkSkillDropdown() {
  const select = document.getElementById('question-bulk-skill');
  if (!select) return;
  try {
    const skills = await fetchSkillsList();
    select.innerHTML = '<option value="">— Đổi kỹ năng thành —</option>' +
      skills.map(sk => `<option value="${sk.id}">${escHtml(sk.name)}</option>`).join('');
  } catch (err) {
    console.error('Lỗi nạp dropdown đổi kỹ năng hàng loạt:', err);
  }
}

function initQuestionBulkControls() {
  document.getElementById('question-select-all')?.addEventListener('change', (e) => toggleQuestionSelectAll(e.target.checked));
  document.getElementById('question-bulk-delete-btn')?.addEventListener('click', bulkDeleteSelectedQuestions);
  document.getElementById('question-bulk-apply-difficulty-btn')?.addEventListener('click', bulkApplyDifficulty);
  document.getElementById('question-bulk-apply-skill-btn')?.addEventListener('click', bulkApplySkill);
  document.getElementById('question-bulk-add-to-exam-btn')?.addEventListener('click', openBulkExamModal);
  document.getElementById('question-bulk-exam-select')?.addEventListener('change', onBulkExamSelectChange);
  document.getElementById('question-bulk-exam-close-btn')?.addEventListener('click', closeBulkExamModal);
  document.getElementById('question-bulk-exam-cancel-btn')?.addEventListener('click', closeBulkExamModal);
  document.getElementById('question-bulk-exam-overlay')?.addEventListener('click', closeBulkExamModal);
  document.getElementById('question-bulk-exam-confirm-btn')?.addEventListener('click', handleBulkExamConfirm);
  document.getElementById('question-bulk-exam-create-confirm-btn')?.addEventListener('click', handleBulkExamCreateConfirm);
  document.getElementById('question-bulk-exam-create-cancel-btn')?.addEventListener('click', handleBulkExamCreateCancel);
}

// ============================================================
//  BULK: THÊM TẤT CẢ CÂU ĐÃ CHỌN VÀO 1 ĐỀ THI
//  Các câu đã chọn có thể thuộc nhiều Kỹ năng khác nhau (đã thống nhất với
//  giáo viên) -> sau khi chọn Đề, hiện 1 khối "Chọn phần" + "Chọn dạng bài"
//  RIÊNG cho MỖI Kỹ năng có mặt trong danh sách đã chọn. Dùng lại
//  fetchExamsList/fetchExamSections/fetchExamSubsections đã có sẵn từ khối
//  gắn-đề-thi-cho-1-câu ở form Tạo/Sửa câu hỏi, chỉ khác là lặp theo nhóm.
//  Bắt buộc chọn đủ dạng bài cho MỌI kỹ năng có mặt mới cho xác nhận, vì
//  mục đích của chức năng là gắn HẾT các câu đã chọn, tránh âm thầm bỏ sót.
// ============================================================
const bulkExamState = {
  skillGroups: [] // [{ skillId, skillName, questionIds: [], sectionId, subsectionId }]
};

function openBulkExamModal() {
  const ids = Array.from(questionsAdminState.selectedIds);
  if (ids.length === 0) return;

  // Gom câu đã chọn theo skill_id, dựa vào dữ liệu đã có sẵn ở currentRows
  // (không cần gọi lại API để biết skill của từng câu).
  const groupMap = new Map(); // skillId -> { skillId, skillName, questionIds }
  ids.forEach(id => {
    const row = questionsAdminState.currentRows.find(r => String(r.id) === String(id));
    if (!row) return; // an toàn: id chọn từ dữ liệu cũ đã bị loadQuestionAdminList() làm mới
    const skillId = String(row.skill_id);
    if (!groupMap.has(skillId)) {
      groupMap.set(skillId, { skillId, skillName: row.skills?.name || `Kỹ năng #${skillId}`, questionIds: [] });
    }
    groupMap.get(skillId).questionIds.push(row.id);
  });

  bulkExamState.skillGroups = Array.from(groupMap.values()).map(g => ({ ...g, sectionId: '', subsectionId: '' }));

  const summaryEl = document.getElementById('question-bulk-exam-summary');
  if (summaryEl) {
    const skillsText = bulkExamState.skillGroups.map(g => `${g.skillName} (${g.questionIds.length})`).join(', ');
    summaryEl.textContent = `Đang thêm ${ids.length} câu hỏi — gồm: ${skillsText}`;
  }

  const errorEl = document.getElementById('question-bulk-exam-error');
  if (errorEl) errorEl.textContent = '';

  const groupsWrap = document.getElementById('question-bulk-exam-skill-groups');
  if (groupsWrap) groupsWrap.innerHTML = '';

  const examSelect = document.getElementById('question-bulk-exam-select');
  if (examSelect) examSelect.value = '';

  const createWrap = document.getElementById('question-bulk-exam-create-wrap');
  const createError = document.getElementById('question-bulk-exam-create-error');
  const createTitle = document.getElementById('question-bulk-exam-create-title');
  const createType = document.getElementById('question-bulk-exam-create-type');
  const createThreshold = document.getElementById('question-bulk-exam-create-threshold');
  if (createWrap) createWrap.style.display = 'none';
  if (createError) createError.textContent = '';
  if (createTitle) createTitle.value = '';
  if (createType) createType.value = 'full';
  if (createThreshold) createThreshold.value = '70';

  populateBulkExamDropdown();

  const overlay = document.getElementById('question-bulk-exam-overlay');
  const panel = document.getElementById('question-bulk-exam-panel');
  if (overlay) overlay.style.display = 'block';
  if (panel) panel.style.display = 'flex';
}

function closeBulkExamModal() {
  const overlay = document.getElementById('question-bulk-exam-overlay');
  const panel = document.getElementById('question-bulk-exam-panel');
  if (overlay) overlay.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

async function populateBulkExamDropdown() {
  const select = document.getElementById('question-bulk-exam-select');
  if (!select) return;
  try {
    const exams = await fetchExamsList();
    const keepValue = select.value;
    select.innerHTML = '<option value="">— Chọn đề thi —</option>'
      + '<option value="__create_new__">+ Tạo đề thi mới…</option>'
      + exams.map(ex => `<option value="${ex.id}">${escHtml(ex.title)}${ex.is_published ? '' : ' (nháp)'}</option>`).join('');
    if (keepValue) select.value = keepValue;
  } catch (err) {
    console.error('Lỗi nạp dropdown đề thi (bulk):', err);
  }
}

// Chọn Đề -> với MỖI kỹ năng có mặt trong danh sách đã chọn, render 1 khối
// "Chọn phần" (filter theo skill_id của nhóm đó) + "Chọn dạng bài" riêng.
// Chọn "+ Tạo đề thi mới…" -> hiện mini-form tạo đề ngay trong modal, chưa
// đụng tới khối theo-kỹ-năng cho tới khi có đề thật để chọn.
async function onBulkExamSelectChange() {
  const examId = document.getElementById('question-bulk-exam-select')?.value;
  const groupsWrap = document.getElementById('question-bulk-exam-skill-groups');
  const createWrap = document.getElementById('question-bulk-exam-create-wrap');
  if (!groupsWrap) return;

  bulkExamState.skillGroups.forEach(g => { g.sectionId = ''; g.subsectionId = ''; });

  if (examId === '__create_new__') {
    groupsWrap.innerHTML = '';
    if (createWrap) createWrap.style.display = 'block';
    document.getElementById('question-bulk-exam-create-title')?.focus();
    return;
  }

  if (createWrap) createWrap.style.display = 'none';

  if (!examId) {
    groupsWrap.innerHTML = '';
    return;
  }

  groupsWrap.innerHTML = bulkExamState.skillGroups.map(g => `
    <div class="admin-form-group bulk-exam-skill-group" data-skill-id="${g.skillId}"
         style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--border-md, #ddd);">
      <label>Phần dành cho ${escHtml(g.skillName)} (${g.questionIds.length} câu)</label>
      <select class="admin-input bulk-exam-section-select" data-skill-id="${g.skillId}">
        <option value="">— Chọn phần —</option>
      </select>
      <div class="admin-hint bulk-exam-section-empty-msg" data-skill-id="${g.skillId}" style="display:none; margin-top:4px;"></div>

      <!-- Mini-form tạo phần (exam_sections) + dạng bài (exam_subsections) mới
           ngay tại chỗ — hiện khi chọn option "+ Tạo phần mới…" ở trên. -->
      <div class="bulk-exam-section-create-wrap" data-skill-id="${g.skillId}"
           style="display:none; margin-top:8px; padding:10px; border:1px dashed var(--border-md, #ccc); border-radius:8px;">
        <div class="admin-form-group" style="margin-bottom:6px;">
          <label>Tên phần</label>
          <input type="text" class="admin-input bulk-exam-section-create-title" data-skill-id="${g.skillId}"
                 placeholder="Ví dụ: ${escHtml(g.skillName)}" />
        </div>
        <div class="admin-form-group" style="margin-bottom:6px;">
          <label>Thời gian làm bài (phút)</label>
          <input type="number" class="admin-input bulk-exam-section-create-time" data-skill-id="${g.skillId}" value="10" min="1" />
        </div>
        <div class="admin-form-group" style="margin-bottom:6px;">
          <label>Hướng dẫn đề bài (dạng bài)</label>
          <textarea class="admin-input bulk-exam-section-create-instruction" data-skill-id="${g.skillId}" rows="2"
                     placeholder="Ví dụ: 問題1：（　）に なにを いれますか。A・B・C・D から いちばん いい ものを ひとつ えらんで ください。"></textarea>
        </div>
        <div class="admin-login-error bulk-exam-section-create-error" data-skill-id="${g.skillId}" style="margin-bottom:6px;"></div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-outline bulk-exam-section-create-cancel" data-skill-id="${g.skillId}">Hủy</button>
          <button type="button" class="btn btn-primary bulk-exam-section-create-confirm" data-skill-id="${g.skillId}">Tạo phần</button>
        </div>
      </div>

      <select class="admin-input bulk-exam-subsection-select" data-skill-id="${g.skillId}" style="display:none; margin-top:8px;">
        <option value="">— Chọn dạng bài —</option>
      </select>
    </div>
  `).join('');

  // Dùng event delegation trên groupsWrap (container tĩnh, không bị thay
  // thế khi re-render) thay vì gắn listener riêng từng phần tử mỗi lần
  // render — tránh phải gỡ listener cũ và dễ mở rộng thêm nút mới.
  bindBulkExamGroupsDelegationOnce();

  // Nạp danh sách phần cho từng kỹ năng song song (mỗi kỹ năng độc lập nhau)
  await Promise.all(bulkExamState.skillGroups.map(g => loadBulkExamSectionsForSkill(examId, g.skillId)));
}

// Gắn 1 lần duy nhất — groupsWrap.innerHTML đổi liên tục nhưng bản thân
// groupsWrap (element cha) không bị thay thế nên listener delegation vẫn
// sống xuyên suốt các lần re-render.
let bulkExamGroupsDelegationBound = false;
function bindBulkExamGroupsDelegationOnce() {
  if (bulkExamGroupsDelegationBound) return;
  const groupsWrap = document.getElementById('question-bulk-exam-skill-groups');
  if (!groupsWrap) return;

  groupsWrap.addEventListener('change', (e) => {
    if (e.target.matches('.bulk-exam-section-select')) {
      onBulkExamSectionChange(e.target.dataset.skillId, e.target.value);
    }
  });

  groupsWrap.addEventListener('click', (e) => {
    const confirmBtn = e.target.closest('.bulk-exam-section-create-confirm');
    if (confirmBtn) { handleBulkExamSectionCreateConfirm(confirmBtn.dataset.skillId); return; }

    const cancelBtn = e.target.closest('.bulk-exam-section-create-cancel');
    if (cancelBtn) { handleBulkExamSectionCreateCancel(cancelBtn.dataset.skillId); return; }
  });

  bulkExamGroupsDelegationBound = true;
}

// Tạo đề thi mới ngay trong modal bulk — cùng logic với handleExamCreateConfirm
// ở form câu hỏi đơn lẻ, chỉ khác id phần tử và nơi trả kết quả về (dropdown
// bulk thay vì dropdown trong form 1 câu).
async function handleBulkExamCreateConfirm() {
  const titleInput = document.getElementById('question-bulk-exam-create-title');
  const typeSelect = document.getElementById('question-bulk-exam-create-type');
  const thresholdInput = document.getElementById('question-bulk-exam-create-threshold');
  const errorEl = document.getElementById('question-bulk-exam-create-error');
  const confirmBtn = document.getElementById('question-bulk-exam-create-confirm-btn');

  const title = titleInput?.value.trim();
  const examType = typeSelect?.value;
  const threshold = Number(thresholdInput?.value);

  if (errorEl) errorEl.textContent = '';

  if (!title) {
    if (errorEl) errorEl.textContent = 'Vui lòng nhập tên đề thi.';
    titleInput?.focus();
    return;
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    if (errorEl) errorEl.textContent = 'Ngưỡng đạt phải là số từ 0 đến 100.';
    thresholdInput?.focus();
    return;
  }

  const originalText = confirmBtn.textContent;
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Đang tạo...';

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams`, {
      method: 'POST',
      headers: await sbAuthedHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({
        title,
        exam_type: examType,
        pass_threshold_pct: threshold,
        is_published: false
      })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi tạo đề thi mới (HTTP ${res.status})`);
    }
    const [newExam] = await res.json();

    // Thêm vào cache local (không fetch lại toàn bộ) rồi chọn sẵn đề vừa tạo
    examLinkState.exams.unshift(newExam);
    await populateBulkExamDropdown();

    const select = document.getElementById('question-bulk-exam-select');
    if (select) select.value = newExam.id;

    if (titleInput) titleInput.value = '';
    if (thresholdInput) thresholdInput.value = '70';
    if (typeSelect) typeSelect.value = 'full';

    const createWrap = document.getElementById('question-bulk-exam-create-wrap');
    if (createWrap) createWrap.style.display = 'none';

    // Đề mới chưa có section nào -> khối theo-kỹ-năng sẽ tự hiện "Đề này
    // chưa có phần [skill]" cho từng nhóm (đúng hành vi đã thống nhất).
    await onBulkExamSelectChange();
  } catch (err) {
    console.error('Lỗi tạo đề thi mới (bulk):', err);
    if (errorEl) errorEl.textContent = err?.message || 'Có lỗi khi tạo đề thi. Vui lòng thử lại.';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalText;
  }
}

function handleBulkExamCreateCancel() {
  const select = document.getElementById('question-bulk-exam-select');
  const createWrap = document.getElementById('question-bulk-exam-create-wrap');
  const errorEl = document.getElementById('question-bulk-exam-create-error');

  if (select) select.value = '';
  if (createWrap) createWrap.style.display = 'none';
  if (errorEl) errorEl.textContent = '';
  const titleInput = document.getElementById('question-bulk-exam-create-title');
  if (titleInput) titleInput.value = '';
}

async function loadBulkExamSectionsForSkill(examId, skillId) {
  const sectionSelect = document.querySelector(`.bulk-exam-section-select[data-skill-id="${skillId}"]`);
  const emptyMsg = document.querySelector(`.bulk-exam-section-empty-msg[data-skill-id="${skillId}"]`);
  if (!sectionSelect) return;

  try {
    const sections = await fetchExamSections(examId);
    const matched = sections.filter(s => String(s.skill_id) === String(skillId));

    // Luôn có option "+ Tạo phần mới…" dù đề đã có phần khớp skill hay chưa
    // — giáo viên có thể muốn tạo thêm 1 phần Kanji khác thay vì dùng phần
    // có sẵn.
    sectionSelect.innerHTML = '<option value="">— Chọn phần —</option>'
      + '<option value="__create_new__">+ Tạo phần mới…</option>'
      + matched.map(s => `<option value="${s.id}">${escHtml(s.title || '(Chưa đặt tên phần)')}</option>`).join('');
    sectionSelect.style.display = '';

    if (matched.length === 0) {
      const group = bulkExamState.skillGroups.find(g => g.skillId === skillId);
      if (emptyMsg) {
        emptyMsg.textContent = `Đề này chưa có phần ${group?.skillName || 'kỹ năng này'} — chọn "+ Tạo phần mới…" để tạo ngay.`;
        emptyMsg.style.display = 'block';
      }
    } else if (emptyMsg) {
      emptyMsg.style.display = 'none';
    }
  } catch (err) {
    console.error(`Lỗi nạp danh sách phần thi cho kỹ năng ${skillId} (bulk):`, err);
    sectionSelect.style.display = 'none';
    if (emptyMsg) {
      emptyMsg.textContent = 'Có lỗi khi tải danh sách phần thi. Vui lòng thử lại.';
      emptyMsg.style.display = 'block';
    }
  }
}

async function onBulkExamSectionChange(skillId, sectionId) {
  const group = bulkExamState.skillGroups.find(g => g.skillId === skillId);
  const createWrap = document.querySelector(`.bulk-exam-section-create-wrap[data-skill-id="${skillId}"]`);
  const subsectionSelect = document.querySelector(`.bulk-exam-subsection-select[data-skill-id="${skillId}"]`);

  if (sectionId === '__create_new__') {
    if (group) { group.sectionId = ''; group.subsectionId = ''; }
    if (createWrap) createWrap.style.display = 'block';
    if (subsectionSelect) {
      subsectionSelect.style.display = 'none';
      subsectionSelect.innerHTML = '<option value="">— Chọn dạng bài —</option>';
    }
    document.querySelector(`.bulk-exam-section-create-title[data-skill-id="${skillId}"]`)?.focus();
    return;
  }

  if (createWrap) createWrap.style.display = 'none';
  if (group) { group.sectionId = sectionId; group.subsectionId = ''; }
  if (!subsectionSelect) return;

  if (!sectionId) {
    subsectionSelect.style.display = 'none';
    subsectionSelect.innerHTML = '<option value="">— Chọn dạng bài —</option>';
    return;
  }

  try {
    const subsections = await fetchExamSubsections(sectionId);
    subsectionSelect.style.display = '';
    subsectionSelect.innerHTML = '<option value="">— Chọn dạng bài —</option>' +
      subsections.map(sub =>
        `<option value="${sub.id}">${escHtml(truncateText(stripHtml(sub.instruction_text), 60))}</option>`
      ).join('');
    subsectionSelect.onchange = () => {
      if (group) group.subsectionId = subsectionSelect.value;
    };
  } catch (err) {
    console.error(`Lỗi nạp danh sách dạng bài cho kỹ năng ${skillId} (bulk):`, err);
  }
}

// Tạo 1 exam_section (đúng skill_id của nhóm) + 1 exam_subsection cho nhóm
// kỹ năng này ngay trong modal bulk, rồi tự chọn sẵn cả 2 — không phải rời
// trang sang màn Quản lý đề thi.
async function handleBulkExamSectionCreateConfirm(skillId) {
  const examId = document.getElementById('question-bulk-exam-select')?.value;
  const group = bulkExamState.skillGroups.find(g => g.skillId === skillId);

  const titleInput = document.querySelector(`.bulk-exam-section-create-title[data-skill-id="${skillId}"]`);
  const timeInput = document.querySelector(`.bulk-exam-section-create-time[data-skill-id="${skillId}"]`);
  const instructionInput = document.querySelector(`.bulk-exam-section-create-instruction[data-skill-id="${skillId}"]`);
  const errorEl = document.querySelector(`.bulk-exam-section-create-error[data-skill-id="${skillId}"]`);
  const confirmBtn = document.querySelector(`.bulk-exam-section-create-confirm[data-skill-id="${skillId}"]`);

  if (!examId || !group) return;

  const title = titleInput?.value.trim();
  const timeMinutes = Number(timeInput?.value);
  const instructionText = instructionInput?.value.trim();

  if (errorEl) errorEl.textContent = '';

  if (!title) {
    if (errorEl) errorEl.textContent = 'Vui lòng nhập tên phần.';
    titleInput?.focus();
    return;
  }
  if (!Number.isFinite(timeMinutes) || timeMinutes <= 0) {
    if (errorEl) errorEl.textContent = 'Thời gian làm bài phải là số phút lớn hơn 0.';
    timeInput?.focus();
    return;
  }
  if (!instructionText) {
    if (errorEl) errorEl.textContent = 'Vui lòng nhập hướng dẫn đề bài.';
    instructionInput?.focus();
    return;
  }

  const originalText = confirmBtn.textContent;
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Đang tạo...';

  try {
    // order_index của section mới = số section hiện có trong đề (không phân
    // biệt skill, giống thứ tự hiển thị chung của cả đề).
    const existingSections = await fetchExamSections(examId);

    const sectionRes = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections`, {
      method: 'POST',
      headers: await sbAuthedHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({
        exam_id: examId,
        skill_id: Number(skillId),
        title,
        time_limit_seconds: Math.round(timeMinutes * 60),
        order_index: existingSections.length
      })
    });
    if (!sectionRes.ok) {
      const errBody = await sectionRes.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi tạo phần mới (HTTP ${sectionRes.status})`);
    }
    const [newSection] = await sectionRes.json();

    const subsectionRes = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections`, {
      method: 'POST',
      headers: await sbAuthedHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({
        exam_section_id: newSection.id,
        instruction_text: instructionText,
        order_index: 0
      })
    });
    if (!subsectionRes.ok) {
      const errBody = await subsectionRes.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi tạo dạng bài mới (HTTP ${subsectionRes.status})`);
    }
    const [newSubsection] = await subsectionRes.json();

    // Chọn sẵn phần + dạng bài vừa tạo cho nhóm kỹ năng này
    group.sectionId = newSection.id;
    group.subsectionId = newSubsection.id;

    const sectionSelect = document.querySelector(`.bulk-exam-section-select[data-skill-id="${skillId}"]`);
    if (sectionSelect) {
      const opt = document.createElement('option');
      opt.value = newSection.id;
      opt.textContent = newSection.title;
      sectionSelect.appendChild(opt);
      sectionSelect.value = newSection.id;
    }

    const subsectionSelect = document.querySelector(`.bulk-exam-subsection-select[data-skill-id="${skillId}"]`);
    if (subsectionSelect) {
      subsectionSelect.innerHTML = `<option value="${newSubsection.id}">${escHtml(truncateText(stripHtml(newSubsection.instruction_text), 60))}</option>`;
      subsectionSelect.value = newSubsection.id;
      subsectionSelect.style.display = '';
      subsectionSelect.onchange = () => { group.subsectionId = subsectionSelect.value; };
    }

    const emptyMsg = document.querySelector(`.bulk-exam-section-empty-msg[data-skill-id="${skillId}"]`);
    if (emptyMsg) emptyMsg.style.display = 'none';

    const createWrap = document.querySelector(`.bulk-exam-section-create-wrap[data-skill-id="${skillId}"]`);
    if (createWrap) createWrap.style.display = 'none';
    if (titleInput) titleInput.value = '';
    if (timeInput) timeInput.value = '10';
    if (instructionInput) instructionInput.value = '';
  } catch (err) {
    console.error(`Lỗi tạo phần/dạng bài mới cho kỹ năng ${skillId} (bulk):`, err);
    if (errorEl) errorEl.textContent = err?.message || 'Có lỗi khi tạo phần mới. Vui lòng thử lại.';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalText;
  }
}

function handleBulkExamSectionCreateCancel(skillId) {
  const group = bulkExamState.skillGroups.find(g => g.skillId === skillId);
  if (group) { group.sectionId = ''; group.subsectionId = ''; }

  const sectionSelect = document.querySelector(`.bulk-exam-section-select[data-skill-id="${skillId}"]`);
  if (sectionSelect) sectionSelect.value = '';

  const createWrap = document.querySelector(`.bulk-exam-section-create-wrap[data-skill-id="${skillId}"]`);
  if (createWrap) createWrap.style.display = 'none';

  const errorEl = document.querySelector(`.bulk-exam-section-create-error[data-skill-id="${skillId}"]`);
  if (errorEl) errorEl.textContent = '';
}

// Xác nhận: mỗi nhóm kỹ năng insert riêng 1 batch vào exam_questions, tự
// tính order_index tiếp theo trong đúng dạng bài của nhóm đó.
async function handleBulkExamConfirm() {
  const examId = document.getElementById('question-bulk-exam-select')?.value;
  const errorEl = document.getElementById('question-bulk-exam-error');
  const confirmBtn = document.getElementById('question-bulk-exam-confirm-btn');

  if (errorEl) errorEl.textContent = '';

  if (!examId || examId === '__create_new__') {
    if (errorEl) errorEl.textContent = 'Vui lòng chọn đề thi (hoặc bấm "Tạo đề" để tạo đề mới trước).';
    return;
  }

  const missing = bulkExamState.skillGroups.filter(g => !g.subsectionId);
  if (missing.length > 0) {
    if (errorEl) errorEl.textContent = `Vui lòng chọn dạng bài cho: ${missing.map(g => g.skillName).join(', ')}.`;
    return;
  }

  const originalText = confirmBtn.textContent;
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Đang thêm...';

  try {
    for (const group of bulkExamState.skillGroups) {
      // Đếm số câu hiện có trong dạng bài này để tính order_index bắt đầu
      const countRes = await fetch(
        `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=eq.${group.subsectionId}&select=id`,
        { headers: await sbAuthedHeaders() }
      );
      if (!countRes.ok) throw new Error(`Lỗi đếm số câu hiện có (${group.skillName}): ${countRes.status}`);
      const existingRows = await countRes.json();
      let nextOrderIndex = existingRows.length + 1;

      const payload = group.questionIds.map(qid => ({
        exam_subsection_id: group.subsectionId,
        question_id: qid,
        order_index: nextOrderIndex++,
        points: 1
      }));

      const insertRes = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions`, {
        method: 'POST',
        headers: await sbAuthedHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify(payload)
      });
      if (!insertRes.ok) {
        const errBody = await insertRes.json().catch(() => null);
        throw new Error(errBody?.message || `Lỗi thêm câu vào đề (${group.skillName}, HTTP ${insertRes.status})`);
      }
    }

    closeBulkExamModal();
    clearQuestionSelection();
    alert('Đã thêm các câu hỏi đã chọn vào đề thi.');
  } catch (err) {
    console.error('Lỗi thêm hàng loạt câu hỏi vào đề thi:', err);
    if (errorEl) errorEl.textContent = err?.message || 'Có lỗi khi thêm vào đề thi. Vui lòng thử lại.';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalText;
  }
}


function renderQuestionPagination(totalRows, totalPages) {
  const pagEl = document.getElementById('question-pagination');
  const infoEl = document.getElementById('question-pagination-info');
  const currentEl = document.getElementById('question-pagination-current');
  const prevBtn = document.getElementById('question-page-prev');
  const nextBtn = document.getElementById('question-page-next');
  if (!pagEl) return;

  if (totalPages <= 1) {
    pagEl.style.display = 'none';
    return;
  }

  const page = questionsAdminState.currentPage;
  const startIdx = (page - 1) * QUESTION_PAGE_SIZE + 1;
  const endIdx = Math.min(page * QUESTION_PAGE_SIZE, totalRows);

  pagEl.style.display = 'flex';
  if (infoEl) infoEl.textContent = `Hiển thị ${startIdx}–${endIdx} / ${totalRows} câu hỏi`;
  if (currentEl) currentEl.textContent = `Trang ${page} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
}

function goToQuestionPage(delta) {
  questionsAdminState.currentPage += delta;
  renderQuestionAdminTable();
  document.getElementById('questions-subview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initQuestionPaginationControls() {
  document.getElementById('question-page-prev')?.addEventListener('click', () => goToQuestionPage(-1));
  document.getElementById('question-page-next')?.addEventListener('click', () => goToQuestionPage(1));
}

// ── Gắn sự kiện ──────────────────────────────────────────────────────────
function initQuestionSearch() {
  const input = document.getElementById('question-search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    questionsAdminState.currentPage = 1; // đổi từ khóa search -> luôn quay về trang 1
    renderQuestionAdminTable();
  });
}

function initQuestionSkillFilter() {
  const select = document.getElementById('filter-question-skill');
  if (!select) return;
  select.addEventListener('change', () => loadQuestionAdminList());
}

function initQuestionExamFilter() {
  const select = document.getElementById('filter-question-exam');
  if (!select) return;
  select.addEventListener('change', () => loadQuestionAdminList());
}

function initQuestionSortControl() {
  const select = document.getElementById('sort-question-created');
  if (!select) return;
  select.addEventListener('change', () => loadQuestionAdminList());
}

// Gọi bởi switchAdminSection() (admin.js) khi vào tab "Câu hỏi" —
// lazy-load giống pattern vocab/students, tránh gọi Supabase thừa.
async function loadQuestionsSection() {
  await populateQuestionSkillFilter();
  await populateQuestionExamFilter();
  await populateQuestionFormSkillDropdown();
  await populateQuestionFormPassageDropdown();
  await populateQuestionBulkSkillDropdown();
  await loadPassagesAdminList();
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
  audioUploading: false, // true trong lúc file audio đang upload dở — chặn submit để tránh lưu thiếu audio_url
  choiceImages: ['', '', '', ''] // public URL ảnh (nếu có) cho từng đáp án 0-3, rỗng = đáp án đang dùng chữ
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

// ── Ảnh thay chữ cho từng đáp án (hữu ích với Nghe hiểu, vd chọn tranh) ──
// Ẩn ô text + hiện khung preview ảnh (hoặc ngược lại) cho đáp án ở vị trí index.
function toggleChoiceImageMode(index, useImage) {
  const textInput = document.getElementById(`question-choice-${index}`);
  const wrap = document.getElementById(`question-choice-${index}-image-wrap`);
  if (!textInput || !wrap) return;

  if (useImage) {
    textInput.style.display = 'none';
    wrap.style.display = 'flex';
  } else {
    textInput.style.display = '';
    wrap.style.display = 'none';
  }
}

async function uploadChoiceImage(index, file) {
  const preview = document.getElementById(`question-choice-${index}-image-preview`);

  try {
    const safeFileName = file.name.replace(/[^\w.\-]/g, '_');
    const path = `${crypto.randomUUID()}-${safeFileName}`;

    // Dùng chung bucket "passage-images" (bucket ảnh dùng chung cho nội
    // dung, không chỉ riêng passages) — tránh phải tạo thêm bucket mới.
    const { error: uploadError } = await supabaseClient
      .storage
      .from('passage-images')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient.storage.from('passage-images').getPublicUrl(path);
    const publicUrl = publicUrlData?.publicUrl;
    if (!publicUrl) throw new Error('Không lấy được public URL sau khi upload ảnh.');

    questionFormState.choiceImages[index] = publicUrl;
    if (preview) preview.src = publicUrl;
    toggleChoiceImageMode(index, true);
  } catch (err) {
    console.error(`Lỗi upload ảnh đáp án ${index}:`, err);
    alert(`Có lỗi khi tải ảnh cho đáp án lên: ${err?.message || 'Lỗi không xác định'}`);
  }
}

function removeChoiceImage(index) {
  questionFormState.choiceImages[index] = '';
  const preview = document.getElementById(`question-choice-${index}-image-preview`);
  if (preview) preview.removeAttribute('src');
  toggleChoiceImageMode(index, false);
}

// ── Kéo-thả đổi vị trí 4 đáp án ──────────────────────────────────────────
// 4 hàng đáp án luôn nằm cố định ở đúng 4 vị trí DOM (id cố định
// question-choice-0..3) — kéo thả KHÔNG di chuyển DOM node, mà HOÁN ĐỔI dữ
// liệu (chữ, ảnh, và trạng thái "đáp án đúng") giữa 2 vị trí. Cách này đơn
// giản, không phải sinh lại id động, và đảm bảo đáp án đúng luôn đi theo
// đúng nội dung sau khi đổi chỗ.
let draggedChoiceIndex = null;

function swapChoiceRows(i, j) {
  if (i === j) return;

  // Hoán đổi nội dung chữ
  const textI = document.getElementById(`question-choice-${i}`);
  const textJ = document.getElementById(`question-choice-${j}`);
  const tmpText = textI.value;
  textI.value = textJ.value;
  textJ.value = tmpText;

  // Hoán đổi ảnh (nếu có)
  const tmpImg = questionFormState.choiceImages[i];
  questionFormState.choiceImages[i] = questionFormState.choiceImages[j];
  questionFormState.choiceImages[j] = tmpImg;

  [i, j].forEach(idx => {
    const imgUrl = questionFormState.choiceImages[idx];
    const preview = document.getElementById(`question-choice-${idx}-image-preview`);
    if (imgUrl) {
      if (preview) preview.src = imgUrl;
      toggleChoiceImageMode(idx, true);
    } else {
      if (preview) preview.removeAttribute('src');
      toggleChoiceImageMode(idx, false);
    }
  });

  // Hoán đổi trạng thái "đáp án đúng" -> đáp án đúng đi theo đúng nội dung
  const radioI = document.getElementById(`question-choice-radio-${i}`);
  const radioJ = document.getElementById(`question-choice-radio-${j}`);
  const wasICorrect = radioI.checked;
  const wasJCorrect = radioJ.checked;
  radioI.checked = wasJCorrect;
  radioJ.checked = wasICorrect;
}

function initChoiceDragDrop() {
  const rows = document.querySelectorAll('#question-mc-block .admin-choice-row');

  rows.forEach(row => {
    const handle = row.querySelector('.admin-choice-drag-handle');

    // Chỉ bắt đầu kéo từ handle (⋮⋮) — tránh xung đột khi giáo viên bôi đen
    // chọn text trong ô input (bôi đen bằng chuột cũng là 1 dạng "drag").
    handle?.addEventListener('dragstart', (e) => {
      draggedChoiceIndex = Number(row.getAttribute('data-choice-index'));
      row.classList.add('admin-choice-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    handle?.addEventListener('dragend', () => {
      row.classList.remove('admin-choice-dragging');
      rows.forEach(r => r.classList.remove('admin-choice-drag-over'));
      draggedChoiceIndex = null;
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault(); // bắt buộc để cho phép drop
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('admin-choice-drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('admin-choice-drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('admin-choice-drag-over');
      const targetIndex = Number(row.getAttribute('data-choice-index'));
      if (draggedChoiceIndex !== null) {
        swapChoiceRows(draggedChoiceIndex, targetIndex);
      }
    });
  });
}

// Reset toàn bộ form về trạng thái trống — dùng cả khi mở form tạo mới
// lẫn sau khi sửa xong (đóng form)
function resetQuestionForm() {
  const form = document.getElementById('question-form');
  if (form) form.reset();

  document.getElementById('question-form-id').value = '';
  document.getElementById('question-form-passage-id').value = '';
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

  // dọn ảnh đáp án (nếu có) — quay về chế độ nhập chữ cho cả 4 ô
  questionFormState.choiceImages = ['', '', '', ''];
  [0, 1, 2, 3].forEach(i => {
    const fileInput = document.getElementById(`question-choice-${i}-image-file`);
    if (fileInput) fileInput.value = '';
    toggleChoiceImageMode(i, false);
  });

  toggleQuestionTypeFields();
  toggleQuestionPassageField();
  resetExamLinkBlock();

  const usageInfo = document.getElementById('question-exam-usage-info');
  if (usageInfo) { usageInfo.style.display = 'none'; usageInfo.innerHTML = ''; }
}

// Đổ dữ liệu 1 câu hỏi (row từ question_bank) vào các field trên form.
// includeAudio=false dùng cho Nhân bản: KHÔNG copy audio_url, để giáo viên
// tự upload file mới, tránh 2 câu hỏi vô tình dùng chung 1 file audio.
function populateQuestionFormFromRow(row, includeAudio) {
  document.getElementById('question-skill').value = row.skill_id ?? '';
  document.getElementById('question-type').value = row.question_type ?? 'multiple_choice';
  document.getElementById('question-text').innerHTML = row.question_text || '';
  document.getElementById('question-form-passage-id').value = row.passage_id ?? '';
  document.getElementById('question-explanation').value = row.explanation || '';
  document.getElementById('question-difficulty').value = row.difficulty || '';

  if (row.question_type === 'fill_blank') {
    document.getElementById('question-fillblank-answer').value = row.correct_answer || '';
  } else {
    // multiple_choice: đổ từng đáp án vào ô tương ứng, ô nào không có dữ
    // liệu (câu gốc chỉ có 2-3 đáp án) thì để trống. Đáp án dạng ảnh được
    // lưu dưới dạng chuỗi HTML "<img src=...>" — nhận diện bằng regex để
    // bật lại chế độ ảnh + preview đúng ảnh gốc thay vì hiện nguyên thẻ HTML
    // vào ô nhập chữ.
    const choices = Array.isArray(row.choices) ? row.choices : [];
    questionFormState.choiceImages = ['', '', '', ''];
    [0, 1, 2, 3].forEach(i => {
      const raw = choices[i] || '';
      const imgMatch = raw.match(/^<img\s+[^>]*src="([^"]+)"/i);
      if (imgMatch) {
        questionFormState.choiceImages[i] = imgMatch[1];
        const preview = document.getElementById(`question-choice-${i}-image-preview`);
        if (preview) preview.src = imgMatch[1];
        document.getElementById(`question-choice-${i}`).value = '';
        toggleChoiceImageMode(i, true);
      } else {
        document.getElementById(`question-choice-${i}`).value = raw;
        toggleChoiceImageMode(i, false);
      }
    });
    // Tích đúng radio ứng với vị trí của correct_answer trong choices
    const correctIdx = choices.findIndex(c => c === row.correct_answer);
    const radio = document.getElementById(`question-choice-radio-${correctIdx >= 0 ? correctIdx : 0}`);
    if (radio) radio.checked = true;
  }

  toggleQuestionTypeFields(); // select.value gán tay không tự bắn 'change'
  toggleQuestionPassageField();

  if (includeAudio && row.audio_url) {
    document.getElementById('question-audio-url').value = row.audio_url;
    const preview = document.getElementById('question-audio-preview');
    if (preview) {
      preview.src = row.audio_url;
      preview.style.display = 'block';
    }
    const statusEl = document.getElementById('question-audio-status');
    if (statusEl) {
      statusEl.textContent = 'Audio hiện có của câu hỏi này — chọn file khác nếu muốn thay.';
      statusEl.style.color = '';
    }
  }
  // includeAudio=false: không làm gì thêm — resetQuestionForm() (gọi trước
  // đó trong openQuestionForm) đã dọn sạch field audio sẵn rồi.
}

// ============================================================
//  GẮN CÂU HỎI VÀO ĐỀ THI (exams / exam_sections / exam_subsections)
//  — Bước này CHỈ làm UI liên động 3 dropdown (đề → phần → dạng bài).
//  CHƯA xử lý lưu (sẽ nối vào submitQuestionForm ở bước sau, khi đó mới
//  insert vào bảng exam_questions).
//  Khối HTML được CHÈN BẰNG JS (không sửa admin/index.html) vì file HTML
//  không có trong phạm vi sửa lần này — chèn ngay trước khu vực chứa nút
//  Lưu, idempotent (kiểm tra đã tồn tại thì bỏ qua) để an toàn nếu
//  openQuestionForm() được gọi nhiều lần.
// ============================================================
const examLinkState = {
  exams: [],
  examsLoaded: false,
  sections: [],       // exam_sections của đề đang chọn (chưa filter theo skill)
  subsections: []      // exam_subsections của phần đang chọn
};

async function fetchExamsList() {
  if (examLinkState.examsLoaded) return examLinkState.exams;

  // Lấy cả nháp lẫn published — admin cần thấy hết để gắn câu hỏi vào đề
  // đang soạn dở. RLS bảng exams yêu cầu auth (giống question_bank) nên
  // dùng sbAuthedHeaders() thay vì sbHeaders().
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams?select=id,title,is_published&order=created_at.desc`;
  const res = await fetch(url, { headers: await sbAuthedHeaders() });
  if (!res.ok) throw new Error(`Lỗi tải danh sách đề thi: ${res.status}`);

  examLinkState.exams = await res.json();
  examLinkState.examsLoaded = true;
  return examLinkState.exams;
}

async function fetchExamSections(examId) {
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections`
    + `?exam_id=eq.${encodeURIComponent(examId)}`
    + `&select=id,skill_id,title,order_index&order=order_index.asc`;
  const res = await fetch(url, { headers: await sbAuthedHeaders() });
  if (!res.ok) throw new Error(`Lỗi tải danh sách phần thi: ${res.status}`);
  return res.json();
}

async function fetchExamSubsections(sectionId) {
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections`
    + `?exam_section_id=eq.${encodeURIComponent(sectionId)}`
    + `&select=id,instruction_text,order_index&order=order_index.asc`;
  const res = await fetch(url, { headers: await sbAuthedHeaders() });
  if (!res.ok) throw new Error(`Lỗi tải danh sách dạng bài (mondai): ${res.status}`);
  return res.json();
}

// Chèn khối 3 dropdown vào DOM ngay trước khu vực nút Lưu — chỉ chèn 1
// lần (kiểm tra bằng id của khối cha).
function injectExamLinkBlockIfNeeded() {
  if (document.getElementById('question-exam-link-group')) return;

  const submitBtn = document.getElementById('question-form-submit-btn');
  if (!submitBtn) return; // form chưa render trong DOM (an toàn, không throw)

  // Nếu nút Lưu nằm trong 1 khối actions riêng (hàng nút bấm) thì chèn
  // trước cả khối đó, để 3 dropdown mới nằm thành 1 nhóm field độc lập
  // ngay phía trên hàng nút — đúng yêu cầu "trước nút Lưu".
  const actionsWrap = submitBtn.closest('.admin-form-actions') || submitBtn.parentElement;

  const html = `
    <div id="question-exam-usage-info" class="admin-hint" style="display:none; margin-bottom:8px;"></div>
    <div class="admin-form-group" id="question-exam-link-group">
      <label for="question-exam-select">Thêm vào đề thi (tùy chọn)</label>
      <select id="question-exam-select" class="admin-input">
        <option value="">— Không thêm vào đề nào —</option>
        <option value="__create_new__">+ Tạo đề thi mới…</option>
      </select>

      <div id="question-exam-create-wrap" style="display:none; margin-top:8px; padding:12px; border:1px dashed var(--border-md, #ccc); border-radius:8px;">
        <div class="admin-form-group" style="margin-bottom:8px;">
          <label for="question-exam-create-title">Tên đề thi mới</label>
          <input type="text" id="question-exam-create-title" class="admin-input" placeholder="Ví dụ: JLPT N4 - Đề thi thử số 1" />
        </div>
        <div class="admin-form-row" style="display:flex; gap:8px; margin-bottom:8px;">
          <div class="admin-form-group" style="flex:1;">
            <label for="question-exam-create-type">Loại đề</label>
            <select id="question-exam-create-type" class="admin-input">
              <option value="full">Toàn phần (full)</option>
              <option value="skill">Theo kỹ năng (skill)</option>
            </select>
          </div>
          <div class="admin-form-group" style="flex:1;">
            <label for="question-exam-create-threshold">Ngưỡng đạt (%)</label>
            <input type="number" id="question-exam-create-threshold" class="admin-input" value="70" min="0" max="100" />
          </div>
        </div>
        <div id="question-exam-create-error" class="admin-login-error" style="margin-bottom:8px;"></div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-outline" id="question-exam-create-cancel-btn">Hủy</button>
          <button type="button" class="btn btn-primary" id="question-exam-create-confirm-btn">Tạo đề</button>
        </div>
      </div>

      <div id="question-exam-section-wrap" style="display:none; margin-top:8px;">
        <label for="question-exam-section-select">Chọn phần (dạng bài)</label>
        <select id="question-exam-section-select" class="admin-input">
          <option value="">— Chọn phần —</option>
        </select>
        <div id="question-exam-section-empty-msg" class="admin-hint"
             style="display:none; margin-top:4px;"></div>
      </div>

      <div id="question-exam-subsection-wrap" style="display:none; margin-top:8px;">
        <label for="question-exam-subsection-select">Chọn dạng bài (mondai)</label>
        <select id="question-exam-subsection-select" class="admin-input">
          <option value="">— Chọn dạng bài —</option>
        </select>
      </div>
    </div>
  `;

  actionsWrap.insertAdjacentHTML('beforebegin', html);

  document.getElementById('question-exam-select')
    ?.addEventListener('change', onExamLinkExamChange);
  document.getElementById('question-exam-section-select')
    ?.addEventListener('change', onExamLinkSectionChange);
  document.getElementById('question-exam-create-confirm-btn')
    ?.addEventListener('click', handleExamCreateConfirm);
  document.getElementById('question-exam-create-cancel-btn')
    ?.addEventListener('click', handleExamCreateCancel);

  // Đổi Kỹ năng ở đầu form trong lúc đang chọn dở đề/phần -> lọc lại phần
  // theo skill mới (không bắt phải chọn lại đề từ đầu).
  document.getElementById('question-skill')?.addEventListener('change', () => {
    const examId = document.getElementById('question-exam-select')?.value;
    if (examId && examId !== '__create_new__') loadExamLinkSections(examId);
  });
}

async function populateExamLinkExamDropdown() {
  const select = document.getElementById('question-exam-select');
  if (!select) return;

  try {
    const exams = await fetchExamsList();
    const keepValue = select.value;
    select.innerHTML = '<option value="">— Không thêm vào đề nào —</option>'
      + '<option value="__create_new__">+ Tạo đề thi mới…</option>'
      + exams.map(ex => `<option value="${ex.id}">${escHtml(ex.title)}${ex.is_published ? '' : ' (nháp)'}</option>`).join('');
    if (keepValue) select.value = keepValue;
  } catch (err) {
    console.error('Lỗi nạp dropdown đề thi:', err);
  }
}

async function onExamLinkExamChange() {
  const select = document.getElementById('question-exam-select');
  const examId = select?.value;
  const sectionWrap = document.getElementById('question-exam-section-wrap');
  const subsectionWrap = document.getElementById('question-exam-subsection-wrap');
  const createWrap = document.getElementById('question-exam-create-wrap');

  resetExamLinkSectionAndSubsection();

  if (examId === '__create_new__') {
    if (sectionWrap) sectionWrap.style.display = 'none';
    if (subsectionWrap) subsectionWrap.style.display = 'none';
    if (createWrap) createWrap.style.display = 'block';
    document.getElementById('question-exam-create-title')?.focus();
    return;
  }

  if (createWrap) createWrap.style.display = 'none';

  if (!examId) {
    if (sectionWrap) sectionWrap.style.display = 'none';
    if (subsectionWrap) subsectionWrap.style.display = 'none';
    return;
  }

  if (sectionWrap) sectionWrap.style.display = 'block';
  if (subsectionWrap) subsectionWrap.style.display = 'none';
  await loadExamLinkSections(examId);
}

// Tạo đề thi mới ngay từ form câu hỏi (không rời trang). Đề mới luôn tạo ở
// trạng thái nháp (is_published:false) — publish là việc của màn Quản lý
// đề thi riêng, ngoài phạm vi form này.
async function handleExamCreateConfirm() {
  const titleInput = document.getElementById('question-exam-create-title');
  const typeSelect = document.getElementById('question-exam-create-type');
  const thresholdInput = document.getElementById('question-exam-create-threshold');
  const errorEl = document.getElementById('question-exam-create-error');
  const confirmBtn = document.getElementById('question-exam-create-confirm-btn');

  const title = titleInput?.value.trim();
  const examType = typeSelect?.value;
  const threshold = Number(thresholdInput?.value);

  if (errorEl) errorEl.textContent = '';

  if (!title) {
    if (errorEl) errorEl.textContent = 'Vui lòng nhập tên đề thi.';
    titleInput?.focus();
    return;
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    if (errorEl) errorEl.textContent = 'Ngưỡng đạt phải là số từ 0 đến 100.';
    thresholdInput?.focus();
    return;
  }

  const originalText = confirmBtn.textContent;
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Đang tạo...';

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams`, {
      method: 'POST',
      headers: await sbAuthedHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({
        title,
        exam_type: examType,
        pass_threshold_pct: threshold,
        is_published: false
      })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi tạo đề thi mới (HTTP ${res.status})`);
    }
    const [newExam] = await res.json();

    // Thêm vào cache local (không fetch lại toàn bộ) rồi chọn sẵn đề vừa tạo
    examLinkState.exams.unshift(newExam);
    await populateExamLinkExamDropdown();

    const select = document.getElementById('question-exam-select');
    if (select) select.value = newExam.id;

    const createWrap = document.getElementById('question-exam-create-wrap');
    if (createWrap) createWrap.style.display = 'none';
    if (titleInput) titleInput.value = '';
    if (thresholdInput) thresholdInput.value = '70';
    if (typeSelect) typeSelect.value = 'full';

    // Đề mới chưa có section nào -> loadExamLinkSections sẽ tự hiện thông
    // báo "Đề này chưa có phần [skill]" (đúng hành vi đã thống nhất trước đó).
    const sectionWrap = document.getElementById('question-exam-section-wrap');
    if (sectionWrap) sectionWrap.style.display = 'block';
    await loadExamLinkSections(newExam.id);
  } catch (err) {
    console.error('Lỗi tạo đề thi mới:', err);
    if (errorEl) errorEl.textContent = err?.message || 'Có lỗi khi tạo đề thi. Vui lòng thử lại.';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalText;
  }
}

function handleExamCreateCancel() {
  const select = document.getElementById('question-exam-select');
  const createWrap = document.getElementById('question-exam-create-wrap');
  const errorEl = document.getElementById('question-exam-create-error');

  if (select) select.value = '';
  if (createWrap) createWrap.style.display = 'none';
  if (errorEl) errorEl.textContent = '';
  document.getElementById('question-exam-create-title').value = '';
}

// Nạp exam_sections của đề đang chọn, LỌC theo skill_id đang chọn ở đầu
// form câu hỏi (#question-skill). Không có phần khớp -> hiện thông báo nhẹ
// thay vì dropdown rỗng.
async function loadExamLinkSections(examId) {
  const sectionSelect = document.getElementById('question-exam-section-select');
  const emptyMsg = document.getElementById('question-exam-section-empty-msg');
  const currentSkillId = document.getElementById('question-skill')?.value;

  if (!currentSkillId) {
    if (sectionSelect) {
      sectionSelect.innerHTML = '<option value="">— Chọn phần —</option>';
      sectionSelect.style.display = 'none';
    }
    if (emptyMsg) {
      emptyMsg.textContent = 'Vui lòng chọn Kỹ năng ở trên trước khi chọn phần thi.';
      emptyMsg.style.display = 'block';
    }
    return;
  }

  try {
    const sections = await fetchExamSections(examId);
    examLinkState.sections = sections;

    const matched = sections.filter(s => String(s.skill_id) === String(currentSkillId));

    if (matched.length === 0) {
      const skillName = questionsAdminState.skills.find(sk => String(sk.id) === String(currentSkillId))?.name
        || 'kỹ năng này';
      if (sectionSelect) {
        sectionSelect.innerHTML = '<option value="">— Chọn phần —</option>';
        sectionSelect.style.display = 'none';
      }
      if (emptyMsg) {
        emptyMsg.textContent = `Đề này chưa có phần ${skillName}`;
        emptyMsg.style.display = 'block';
      }
      return;
    }

    if (emptyMsg) emptyMsg.style.display = 'none';
    if (sectionSelect) {
      sectionSelect.style.display = '';
      sectionSelect.innerHTML = '<option value="">— Chọn phần —</option>' +
        matched.map(s => `<option value="${s.id}">${escHtml(s.title || '(Chưa đặt tên phần)')}</option>`).join('');
    }
  } catch (err) {
    console.error('Lỗi nạp danh sách phần thi:', err);
    if (sectionSelect) sectionSelect.style.display = 'none';
    if (emptyMsg) {
      emptyMsg.textContent = 'Có lỗi khi tải danh sách phần thi. Vui lòng thử lại.';
      emptyMsg.style.display = 'block';
    }
  }
}

// Nạp exam_subsections của phần đang chọn — label rút gọn từ instruction_text
// (bỏ thẻ HTML nếu có, giới hạn độ dài để không vỡ layout dropdown).
async function onExamLinkSectionChange() {
  const sectionId = document.getElementById('question-exam-section-select')?.value;
  const subsectionWrap = document.getElementById('question-exam-subsection-wrap');
  const subsectionSelect = document.getElementById('question-exam-subsection-select');

  if (subsectionSelect) subsectionSelect.innerHTML = '<option value="">— Chọn dạng bài —</option>';

  if (!sectionId) {
    if (subsectionWrap) subsectionWrap.style.display = 'none';
    return;
  }

  try {
    const subsections = await fetchExamSubsections(sectionId);
    examLinkState.subsections = subsections;

    if (subsectionWrap) subsectionWrap.style.display = 'block';
    if (subsectionSelect) {
      subsectionSelect.innerHTML = '<option value="">— Chọn dạng bài —</option>' +
        subsections.map(sub =>
          `<option value="${sub.id}">${escHtml(truncateText(stripHtml(sub.instruction_text), 60))}</option>`
        ).join('');
    }
  } catch (err) {
    console.error('Lỗi nạp danh sách dạng bài (mondai):', err);
  }
}

function resetExamLinkSectionAndSubsection() {
  const sectionSelect = document.getElementById('question-exam-section-select');
  const subsectionSelect = document.getElementById('question-exam-subsection-select');
  const emptyMsg = document.getElementById('question-exam-section-empty-msg');

  if (sectionSelect) {
    sectionSelect.innerHTML = '<option value="">— Chọn phần —</option>';
    sectionSelect.style.display = '';
  }
  if (subsectionSelect) subsectionSelect.innerHTML = '<option value="">— Chọn dạng bài —</option>';
  if (emptyMsg) emptyMsg.style.display = 'none';
}

// Đưa khối 3 dropdown về trạng thái ban đầu — gọi từ resetQuestionForm()
// mỗi khi mở form tạo mới / sửa / đóng form.
function resetExamLinkBlock() {
  const examSelect = document.getElementById('question-exam-select');
  if (examSelect) examSelect.value = '';

  resetExamLinkSectionAndSubsection();

  const sectionWrap = document.getElementById('question-exam-section-wrap');
  const subsectionWrap = document.getElementById('question-exam-subsection-wrap');
  if (sectionWrap) sectionWrap.style.display = 'none';
  if (subsectionWrap) subsectionWrap.style.display = 'none';

  const createWrap = document.getElementById('question-exam-create-wrap');
  const createError = document.getElementById('question-exam-create-error');
  const createTitle = document.getElementById('question-exam-create-title');
  const createType = document.getElementById('question-exam-create-type');
  const createThreshold = document.getElementById('question-exam-create-threshold');
  if (createWrap) createWrap.style.display = 'none';
  if (createError) createError.textContent = '';
  if (createTitle) createTitle.value = '';
  if (createType) createType.value = 'full';
  if (createThreshold) createThreshold.value = '70';
}

// Câu hỏi đang sửa (mode edit) có thể đã được gắn vào 1 hay nhiều đề thi từ
// trước (qua exam_questions) — join 3 tầng để lấy đủ tên đề/phần/dạng bài
// bằng cú pháp embed resource của PostgREST, KHÔNG gỡ khỏi đề cũ, chỉ hiển
// thị thông tin để giáo viên biết. Nếu giáo viên chọn thêm ở 3 dropdown bên
// dưới và bấm Lưu -> linkQuestionToExamIfSelected() sẽ INSERT MỚI một dòng
// exam_questions khác, không đụng tới các dòng cũ này.
async function fetchQuestionExamUsage(questionId) {
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions`
    + `?question_id=eq.${encodeURIComponent(questionId)}`
    + `&select=id,exam_subsections(instruction_text,exam_sections(title,exams(title)))`;
  const res = await fetch(url, { headers: await sbAuthedHeaders() });
  if (!res.ok) throw new Error(`Lỗi kiểm tra câu hỏi đang thuộc đề thi nào: ${res.status}`);
  return res.json();
}

async function loadAndRenderQuestionExamUsage(questionId) {
  const container = document.getElementById('question-exam-usage-info');
  if (!container) return;

  if (!questionId) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  try {
    const rows = await fetchQuestionExamUsage(questionId);
    if (!rows.length) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    const items = rows.map(r => {
      const examTitle = r.exam_subsections?.exam_sections?.exams?.title || '(Không rõ đề)';
      const sectionTitle = r.exam_subsections?.exam_sections?.title || '(Không rõ phần)';
      const subInstruction = truncateText(stripHtml(r.exam_subsections?.instruction_text || ''), 60);
      return `<li>${escHtml(examTitle)} - ${escHtml(sectionTitle)} - ${escHtml(subInstruction)}</li>`;
    }).join('');

    container.innerHTML = `
      <div>Câu hỏi này đang thuộc:</div>
      <ul style="margin: 2px 0 0 18px; padding: 0;">${items}</ul>
    `;
    container.style.display = 'block';
  } catch (err) {
    console.error('Lỗi tải danh sách đề đang dùng câu hỏi này:', err);
    // Lỗi phụ (không chặn sửa câu hỏi) -> chỉ log, ẩn khối đi thay vì báo lỗi to
    container.style.display = 'none';
    container.innerHTML = '';
  }
}

// Mở form. `row` = dữ liệu câu hỏi gốc (null nếu tạo mới thuần túy).
// `mode`: 'create' | 'edit' | 'duplicate'.
//   - 'edit': sửa đúng câu đang có (giữ nguyên audio, PATCH khi lưu).
//   - 'duplicate': mở form ở chế độ TẠO MỚI nhưng pre-fill dữ liệu câu gốc,
//     bỏ qua audio_url. Lưu sẽ INSERT thành câu hỏi mới, không đụng câu gốc.
function openQuestionForm(row = null, mode = 'create') {
  injectExamLinkBlockIfNeeded(); // chèn 1 lần, trước nút Lưu
  resetQuestionForm();
  populateExamLinkExamDropdown(); // nạp lại danh sách đề (không cache stale nếu vừa có đề mới)

  const overlay = document.getElementById('question-form-overlay');
  const panel = document.getElementById('question-form-panel');
  const title = document.getElementById('question-form-title');
  const submitBtn = document.getElementById('question-form-submit-btn');
  const saveContinueBtn = document.getElementById('question-form-save-continue-btn');

  if (row && mode === 'edit') {
    questionFormState.mode = 'edit';
    questionFormState.editingId = row.id;
    if (title) title.textContent = 'Sửa câu hỏi';
    if (submitBtn) submitBtn.textContent = 'Cập nhật câu hỏi';
    if (saveContinueBtn) saveContinueBtn.style.display = 'none'; // chỉ có ở mode tạo mới
    populateQuestionFormFromRow(row, /* includeAudio */ true);
    loadAndRenderQuestionExamUsage(row.id); // hiển thị đề/phần/dạng bài đang chứa câu hỏi này (nếu có)
  } else if (row && mode === 'duplicate') {
    questionFormState.mode = 'create';
    questionFormState.editingId = null;
    if (title) title.textContent = 'Thêm câu hỏi mới (nhân bản)';
    if (submitBtn) submitBtn.textContent = 'Lưu câu hỏi';
    if (saveContinueBtn) saveContinueBtn.style.display = 'inline-flex';
    populateQuestionFormFromRow(row, /* includeAudio */ false);
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

// ── Hành động trên từng dòng bảng: Sửa / Nhân bản / Xóa ──────────────────
function editQuestionRow(id) {
  const row = questionsAdminState.currentRows.find(r => String(r.id) === String(id));
  if (!row) return;
  openQuestionForm(row, 'edit');
}

function duplicateQuestionRow(id) {
  const row = questionsAdminState.currentRows.find(r => String(r.id) === String(id));
  if (!row) return;
  openQuestionForm(row, 'duplicate');
}

async function deleteQuestionRow(id) {
  try {
    // Đếm số đề thi đang dùng câu hỏi này (exam_questions.question_id) để
    // cảnh báo — KHÔNG chặn cứng, giáo viên tự quyết định.
    const headers = await sbAuthedHeaders();
    const countRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?question_id=eq.${id}&select=id`,
      { headers }
    );
    if (!countRes.ok) throw new Error(`Lỗi kiểm tra câu hỏi đang dùng ở đề thi nào: ${countRes.status}`);
    const usageRows = await countRes.json();
    const usageCount = usageRows.length;

    const confirmMsg = usageCount > 0
      ? `Câu hỏi này đang thuộc ${usageCount} đề thi, xóa sẽ ảnh hưởng đến các đề đó. Bạn vẫn muốn xóa?`
      : 'Bạn có chắc muốn xóa câu hỏi này?';
    if (!confirm(confirmMsg)) return;

    const deleteRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?id=eq.${id}`,
      { method: 'DELETE', headers: await sbAuthedHeaders() }
    );
    if (!deleteRes.ok) throw new Error(`Lỗi xóa câu hỏi: ${deleteRes.status}`);

    await loadQuestionAdminList();
  } catch (err) {
    console.error('Lỗi xóa câu hỏi:', err);
    alert('Có lỗi khi xóa câu hỏi. Vui lòng thử lại.');
  }
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
  // Coi là "có nội dung" nếu còn chữ HOẶC có ít nhất 1 ảnh đã chèn (trường
  // hợp dùng ảnh thay hoàn toàn cho văn bản — vd hình minh họa Nghe hiểu).
  // Không dùng questionTextPlain đơn thuần vì stripHtml() xóa luôn thẻ
  // <img>, sẽ chặn nhầm câu hỏi chỉ có ảnh không có chữ.
  const questionHasTextOrImage = !!questionTextPlain || /<img\b/i.test(questionTextHtml);
  const explanation = document.getElementById('question-explanation').value.trim();
  const difficulty = document.getElementById('question-difficulty').value;

  if (!skillId) {
    errorEl.textContent = 'Vui lòng chọn Kỹ năng.';
    return null;
  }
  if (!questionHasTextOrImage) {
    errorEl.textContent = 'Vui lòng nhập nội dung câu hỏi (hoặc chèn ảnh thay cho văn bản).';
    return null;
  }

  // Chuẩn bị choices/correct_answer tùy theo loại câu hỏi
  let choices = null;
  let correctAnswer = '';

  if (questionType === 'multiple_choice') {
    // Mỗi đáp án có thể là chữ (input text) HOẶC ảnh (đã upload, lưu URL
    // trong questionFormState.choiceImages) — ảnh được ưu tiên nếu đã chọn.
    // Ô nào không có cả 2 thì bỏ qua (đáp án không dùng đến).
    const choiceValues = [0, 1, 2, 3].map(i => {
      const imageUrl = questionFormState.choiceImages[i];
      if (imageUrl) return `<img src="${imageUrl}" alt="Đáp án ${['A', 'B', 'C', 'D'][i]}" style="max-width:140px;" />`;
      return document.getElementById(`question-choice-${i}`).value.trim();
    });

    // Cho phép 2-4 đáp án (không bắt buộc đủ 4) — ô nào bỏ trống sẽ không
    // đưa vào choices, miễn còn ít nhất 2 ô có nội dung.
    const filledIndices = [0, 1, 2, 3].filter(i => choiceValues[i]);
    const rawChoices = filledIndices.map(i => choiceValues[i]);

    if (rawChoices.length < 2) {
      errorEl.textContent = 'Vui lòng nhập/chọn ảnh cho ít nhất 2 đáp án.';
      return null;
    }

    const correctIdx = document.querySelector('input[name="question-correct-choice"]:checked')?.value;
    const correctValue = correctIdx !== undefined ? choiceValues[Number(correctIdx)] : '';

    if (!correctValue) {
      errorEl.textContent = 'Đáp án đúng đang được tích chọn ở 1 ô trống — vui lòng nhập chữ hoặc chọn ảnh cho ô đó, hoặc chọn lại đáp án đúng.';
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
    passage_id: document.getElementById('question-form-passage-id').value || null,
    choices: choices, // null với fill_blank
    correct_answer: correctAnswer,
    explanation: explanation || null,
    difficulty: difficulty || null
  };
}

// Gọi Supabase để insert (create) hoặc update (edit) — dùng chung cho cả
// 2 nút. Ném lỗi (throw) nếu request thất bại, để nơi gọi tự xử lý UI.
// Trả về { isEdit, questionId } — questionId cần cho bước gắn vào
// exam_questions ngay sau đó (POST trả representation nên lấy được id mới,
// PATCH thì id đã biết sẵn từ questionFormState.editingId).
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
    return { isEdit, questionId: questionFormState.editingId };
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
    const [saved] = await res.json();
    return { isEdit, questionId: saved?.id };
  }
}

// Nếu giáo viên đã chọn đủ 3 tầng Đề / Phần / Dạng bài ở khối "Thêm vào đề
// thi" -> gắn câu hỏi vừa lưu vào exam_questions, order_index = số câu hiện
// có trong dạng bài đó + 1, points mặc định = 1.
// Bỏ trống dropdown Đề (hoặc chưa chọn đủ 3 tầng) -> không làm gì cả, hành
// vi y hệt Tier 1 cũ (chỉ lưu vào question_bank).
async function linkQuestionToExamIfSelected(questionId) {
  const examId = document.getElementById('question-exam-select')?.value;
  const sectionId = document.getElementById('question-exam-section-select')?.value;
  const subsectionId = document.getElementById('question-exam-subsection-select')?.value;

  if (!examId || !sectionId || !subsectionId) return;

  // Đếm số câu hỏi hiện có trong dạng bài này để tính order_index tiếp theo
  // (đơn giản, đủ dùng ở quy mô 1 giáo viên soạn đề — không cần lock/transaction).
  const countRes = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=eq.${subsectionId}&select=id`,
    { headers: await sbAuthedHeaders() }
  );
  if (!countRes.ok) throw new Error(`Lỗi đếm số câu hỏi hiện có trong dạng bài: ${countRes.status}`);
  const existingRows = await countRes.json();
  const nextOrderIndex = existingRows.length + 1;

  const insertRes = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions`, {
    method: 'POST',
    headers: await sbAuthedHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify({
      exam_subsection_id: subsectionId,
      question_id: questionId,
      order_index: nextOrderIndex,
      points: 1
    })
  });
  if (!insertRes.ok) {
    const errBody = await insertRes.json().catch(() => null);
    throw new Error(errBody?.message || `Lỗi gắn câu hỏi vào đề thi (HTTP ${insertRes.status})`);
  }
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
    const { questionId } = await saveQuestionToSupabase(payload);
    await linkQuestionToExamIfSelected(questionId);
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
    const { questionId } = await saveQuestionToSupabase(payload);
    await linkQuestionToExamIfSelected(questionId); // đọc dropdown đề/phần/dạng bài trước khi bị reset bên dưới

    // Giữ nguyên Kỹ năng + Loại câu hỏi hiện tại (không reset 2 dropdown này)
    const keepSkillId = document.getElementById('question-skill').value;
    const keepType = document.getElementById('question-type').value;

    resetQuestionForm();

    document.getElementById('question-skill').value = keepSkillId;
    document.getElementById('question-type').value = keepType;
    toggleQuestionTypeFields();
    toggleQuestionPassageField();

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

// Chèn ảnh thay cho văn bản vào #question-text (dùng cho câu Nghe hiểu cần
// hình minh họa thay vì mô tả bằng chữ). Copy y hệt pattern
// uploadAndInsertPassageContentImage() — dùng chung bucket "passage-images"
// (bucket ảnh dùng chung của cả module, không tạo bucket riêng).
async function uploadAndInsertQuestionTextImage(file) {
  const statusEl = document.getElementById('question-text-image-status');
  const editor = document.getElementById('question-text');

  if (statusEl) { statusEl.textContent = '⏳ Đang tải ảnh lên...'; statusEl.style.color = ''; }

  try {
    const safeFileName = file.name.replace(/[^\w.\-]/g, '_');
    const path = `${crypto.randomUUID()}-${safeFileName}`;

    const { error: uploadError } = await supabaseClient
      .storage
      .from('passage-images')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient.storage.from('passage-images').getPublicUrl(path);
    const publicUrl = publicUrlData?.publicUrl;
    if (!publicUrl) throw new Error('Không lấy được public URL sau khi upload ảnh.');

    editor.focus();
    document.execCommand('insertHTML', false, `<img src="${publicUrl}" alt="" />`);

    if (statusEl) { statusEl.textContent = '✓ Đã chèn ảnh vào nội dung câu hỏi.'; statusEl.style.color = 'var(--success, #2e7d32)'; }
  } catch (err) {
    console.error('Lỗi upload ảnh cho nội dung câu hỏi:', err);
    if (statusEl) {
      statusEl.textContent = `❌ Chèn ảnh thất bại: ${err?.message || 'Lỗi không xác định'}`;
      statusEl.style.color = 'var(--vermillion)';
    }
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
  document.getElementById('question-skill')?.addEventListener('change', toggleQuestionPassageField);

  document.getElementById('question-text-bold-btn')?.addEventListener('click', () => applyQuestionTextFormat('bold'));
  document.getElementById('question-text-underline-btn')?.addEventListener('click', () => applyQuestionTextFormat('underline'));
  document.getElementById('question-text')?.addEventListener('keyup', syncRichTextToolbarState);
  document.getElementById('question-text')?.addEventListener('mouseup', syncRichTextToolbarState);

  document.getElementById('question-text-image-btn')?.addEventListener('click', () => {
    document.getElementById('question-text-image-file')?.click();
  });
  document.getElementById('question-text-image-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadAndInsertQuestionTextImage(file);
    e.target.value = ''; // cho phép chọn lại đúng file đó lần nữa nếu cần
  });

  document.getElementById('question-audio-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadQuestionAudioFile(file);
  });

  // Ảnh thay chữ cho từng đáp án (4 ô, dùng event delegation cho gọn thay
  // vì phải lặp addEventListener 4 lần cho 3 loại control khác nhau).
  [0, 1, 2, 3].forEach(i => {
    document.querySelector(`.admin-choice-image-btn[data-choice-index="${i}"]`)
      ?.addEventListener('click', () => document.getElementById(`question-choice-${i}-image-file`)?.click());

    document.getElementById(`question-choice-${i}-image-file`)?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) uploadChoiceImage(i, file);
    });

    document.querySelector(`.admin-choice-image-remove-btn[data-choice-index="${i}"]`)
      ?.addEventListener('click', () => removeChoiceImage(i));
  });

  document.getElementById('btn-open-passage-form')?.addEventListener('click', () => openPassageForm());
  document.getElementById('passage-type')?.addEventListener('change', (e) => {
    togglePassageContentVisibility(e.target.value);
  });
  document.getElementById('passage-form-close-btn')?.addEventListener('click', closePassageForm);
  document.getElementById('passage-form-cancel-btn')?.addEventListener('click', closePassageForm);
  document.getElementById('passage-form-overlay')?.addEventListener('click', closePassageForm);
  document.getElementById('passage-form')?.addEventListener('submit', submitPassageForm);
  document.getElementById('passage-audio-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadPassageAudioFile(file);
  });

  document.getElementById('passage-content-bold-btn')?.addEventListener('click', () => applyPassageContentFormat('bold'));
  document.getElementById('passage-content-underline-btn')?.addEventListener('click', () => applyPassageContentFormat('underline'));
  document.getElementById('passage-content-image-btn')?.addEventListener('click', () => {
    document.getElementById('passage-content-image-file')?.click();
  });
  document.getElementById('passage-content-image-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadAndInsertPassageContentImage(file);
    e.target.value = ''; // cho phép chọn lại đúng file đó lần nữa nếu cần
  });
}

// ============================================================
//  BẢNG DANH SÁCH PASSAGES (đoạn văn/hội thoại)
// ============================================================

// Tải danh sách passage + đếm số câu hỏi đang thuộc mỗi passage. Đếm bằng
// cách lấy 1 lượt toàn bộ question_bank.passage_id (not null) rồi group ở
// client — tránh phải gọi N request đếm riêng cho từng passage.
async function loadPassagesAdminList() {
  const tbody = document.getElementById('passage-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>`;
  }

  try {
    const [passagesRes, usageRes] = await Promise.all([
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages?select=id,title,passage_type,content,audio_url,created_at&order=created_at.desc`, { headers: sbHeaders() }),
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?select=passage_id&passage_id=not.is.null`, { headers: await sbAuthedHeaders() })
    ]);

    if (!passagesRes.ok) throw new Error(`Lỗi tải danh sách đoạn văn/hội thoại: ${passagesRes.status}`);
    if (!usageRes.ok) throw new Error(`Lỗi đếm câu hỏi theo đoạn văn: ${usageRes.status}`);

    const passages = await passagesRes.json();
    const usageRows = await usageRes.json();

    const usageCountMap = {};
    usageRows.forEach(r => {
      usageCountMap[r.passage_id] = (usageCountMap[r.passage_id] || 0) + 1;
    });

    questionsAdminState.passageTableRows = passages.map(p => ({
      ...p,
      questionCount: usageCountMap[p.id] || 0
    }));
    questionsAdminState.passageCurrentPage = 1; // reset về trang 1 mỗi khi tải lại

    renderPassagesAdminTable();
  } catch (err) {
    console.error('Lỗi tải bảng đoạn văn/hội thoại:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">❌ Không tải được danh sách đoạn văn/hội thoại.</div></td></tr>`;
    }
  }
}

function renderPassagesAdminTable() {
  const tbody = document.getElementById('passage-table-body');
  const pagEl = document.getElementById('passage-pagination');
  if (!tbody) return;

  const rows = questionsAdminState.passageTableRows || [];
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Chưa có đoạn văn/hội thoại nào.</div></td></tr>`;
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PASSAGE_PAGE_SIZE));
  if (questionsAdminState.passageCurrentPage > totalPages) questionsAdminState.passageCurrentPage = totalPages;
  if (questionsAdminState.passageCurrentPage < 1) questionsAdminState.passageCurrentPage = 1;

  const startIdx = (questionsAdminState.passageCurrentPage - 1) * PASSAGE_PAGE_SIZE;
  const pageRows = rows.slice(startIdx, startIdx + PASSAGE_PAGE_SIZE);

  const passageTypeLabel = (type) => {
    if (type === 'reading') return 'Đọc hiểu';
    if (type === 'listening') return 'Nghe hiểu';
    return '<span style="color:var(--ink-soft);">—</span>';
  };

  tbody.innerHTML = pageRows.map((p, idx) => `
    <tr onclick="editPassageRow('${p.id}')" style="cursor:pointer;">
      <td style="text-align:center;">${startIdx + idx + 1}</td>
      <td>${escHtml(p.title || '(Chưa đặt tiêu đề)')}</td>
      <td>${passageTypeLabel(p.passage_type)}</td>
      <td style="text-align:center;">${p.questionCount}</td>
      <td style="text-align:center;">${p.audio_url ? '✓' : '—'}</td>
      <td>${escHtml(formatDateVN(p.created_at))}</td>
      <td onclick="event.stopPropagation();" style="text-align:center;">
        <div class="admin-row-actions">
          <button class="admin-row-action-btn" onclick="editPassageRow('${p.id}')" title="Sửa">
            <i class="ti ti-edit"></i>
          </button>
          <button class="admin-row-action-btn danger" onclick="deletePassageRow('${p.id}')" title="Xóa">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');

  renderPassagePagination(rows.length, totalPages);
}

function renderPassagePagination(totalRows, totalPages) {
  const pagEl = document.getElementById('passage-pagination');
  const infoEl = document.getElementById('passage-pagination-info');
  const currentEl = document.getElementById('passage-pagination-current');
  const prevBtn = document.getElementById('passage-page-prev');
  const nextBtn = document.getElementById('passage-page-next');
  if (!pagEl) return;

  if (totalPages <= 1) {
    pagEl.style.display = 'none';
    return;
  }

  const page = questionsAdminState.passageCurrentPage;
  const startIdx = (page - 1) * PASSAGE_PAGE_SIZE + 1;
  const endIdx = Math.min(page * PASSAGE_PAGE_SIZE, totalRows);

  pagEl.style.display = 'flex';
  if (infoEl) infoEl.textContent = `Hiển thị ${startIdx}–${endIdx} / ${totalRows} đoạn văn`;
  if (currentEl) currentEl.textContent = `Trang ${page} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
}

function goToPassagePage(delta) {
  questionsAdminState.passageCurrentPage += delta;
  renderPassagesAdminTable();
  document.getElementById('passages-subview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initPassagePaginationControls() {
  document.getElementById('passage-page-prev')?.addEventListener('click', () => goToPassagePage(-1));
  document.getElementById('passage-page-next')?.addEventListener('click', () => goToPassagePage(1));
}

function editPassageRow(id) {
  const row = (questionsAdminState.passageTableRows || []).find(p => String(p.id) === String(id));
  if (!row) return;
  openPassageForm(row);
}

async function deletePassageRow(id) {
  try {
    const headers = await sbAuthedHeaders();
    const countRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?passage_id=eq.${id}&select=id`,
      { headers }
    );
    if (!countRes.ok) throw new Error(`Lỗi kiểm tra câu hỏi đang dùng đoạn văn này: ${countRes.status}`);
    const usageRows = await countRes.json();
    const usageCount = usageRows.length;

    const confirmMsg = usageCount > 0
      ? `Passage này đang có ${usageCount} câu hỏi sử dụng, xóa sẽ ảnh hưởng. Bạn vẫn muốn xóa?`
      : 'Bạn có chắc muốn xóa đoạn văn/hội thoại này?';
    if (!confirm(confirmMsg)) return;

    const deleteRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages?id=eq.${id}`,
      { method: 'DELETE', headers: await sbAuthedHeaders() }
    );
    if (!deleteRes.ok) throw new Error(`Lỗi xóa đoạn văn/hội thoại: ${deleteRes.status}`);

    await loadPassagesAdminList();
    await populateQuestionFormPassageDropdown();
  } catch (err) {
    console.error('Lỗi xóa đoạn văn/hội thoại:', err);
    alert('Có lỗi khi xóa đoạn văn/hội thoại. Vui lòng thử lại.');
  }
}

// ============================================================
//  MODAL "TẠO ĐOẠN VĂN/HỘI THOẠI" (passages)
//  Mở chồng lên trên panel form câu hỏi (dùng đúng pattern
//  admin-overlay/admin-slide-panel có sẵn). Lưu xong sẽ refresh dropdown
//  passage_id ở form câu hỏi và tự chọn sẵn đoạn vừa tạo.
// ============================================================

const passageFormState = {
  mode: 'create',   // 'create' | 'edit'
  editingId: null,  // id passage đang sửa (chỉ có giá trị khi mode === 'edit')
  audioUploading: false
};

function resetPassageForm() {
  const form = document.getElementById('passage-form');
  if (form) form.reset();

  document.getElementById('passage-form-error').textContent = '';
  document.getElementById('passage-type').value = '';
  togglePassageContentVisibility(''); // reset -> hiện lại content group mặc định

  // form.reset() không tác dụng lên div contenteditable -> dọn tay
  const contentEditor = document.getElementById('passage-content');
  if (contentEditor) contentEditor.innerHTML = '';
  const imageStatusEl = document.getElementById('passage-content-image-status');
  if (imageStatusEl) { imageStatusEl.textContent = ''; imageStatusEl.style.color = ''; }

  const audioFileInput = document.getElementById('passage-audio-file');
  if (audioFileInput) audioFileInput.value = '';
  document.getElementById('passage-audio-url').value = '';
  const statusEl = document.getElementById('passage-audio-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }
  const preview = document.getElementById('passage-audio-preview');
  if (preview) { preview.style.display = 'none'; preview.removeAttribute('src'); }
}

// Ẩn hẳn khối "Nội dung văn bản" khi chọn Nghe hiểu (không cần content) —
// chỉ ẩn UI, KHÔNG xóa nội dung đã gõ (phòng trường hợp admin đổi qua đổi
// lại loại, tránh mất dữ liệu đang nhập dở).
function togglePassageContentVisibility(passageType) {
  const group = document.getElementById('passage-content-group');
  if (group) group.style.display = passageType === 'listening' ? 'none' : 'block';
}

// Đổ dữ liệu 1 passage vào form — dùng khi mở mode edit
function populatePassageFormFromRow(row) {
  document.getElementById('passage-title').value = row.title || '';
  document.getElementById('passage-content').innerHTML = row.content || '';
  document.getElementById('passage-type').value = row.passage_type || '';
  togglePassageContentVisibility(row.passage_type || '');

  if (row.audio_url) {
    document.getElementById('passage-audio-url').value = row.audio_url;
    const preview = document.getElementById('passage-audio-preview');
    if (preview) { preview.src = row.audio_url; preview.style.display = 'block'; }
    const statusEl = document.getElementById('passage-audio-status');
    if (statusEl) { statusEl.textContent = 'Audio hiện có của đoạn này — chọn file khác nếu muốn thay.'; statusEl.style.color = ''; }
  }
}

// row = null -> mở form ở mode TẠO MỚI. Truyền row -> mode SỬA, pre-fill dữ liệu cũ.
function openPassageForm(row = null) {
  resetPassageForm();

  const title = document.getElementById('passage-form-title');
  const submitBtn = document.getElementById('passage-form-submit-btn');

  if (row) {
    passageFormState.mode = 'edit';
    passageFormState.editingId = row.id;
    if (title) title.textContent = 'Sửa đoạn văn/hội thoại';
    if (submitBtn) submitBtn.textContent = 'Cập nhật đoạn văn';
    populatePassageFormFromRow(row);
  } else {
    passageFormState.mode = 'create';
    passageFormState.editingId = null;
    if (title) title.textContent = 'Tạo đoạn văn/hội thoại';
    if (submitBtn) submitBtn.textContent = 'Lưu đoạn văn';
  }

  document.getElementById('passage-form-overlay').style.display = 'block';
  document.getElementById('passage-form-panel').style.display = 'flex';
}

function closePassageForm() {
  document.getElementById('passage-form-overlay').style.display = 'none';
  document.getElementById('passage-form-panel').style.display = 'none';
  resetPassageForm();
}

// Upload audio chung cho passage — cùng bucket exam-audio, cùng path
// pattern {uuid}-{filename} như audio của câu hỏi (chỉ khác thư mục field
// lưu kết quả). Không gộp chung hàm với uploadQuestionAudioFile để tránh
// phải truyền quá nhiều tham số DOM id qua lại — chấp nhận trùng lặp nhỏ
// để dễ đọc, đúng phong cách các hàm khác trong file này.
async function uploadPassageAudioFile(file) {
  const statusEl = document.getElementById('passage-audio-status');
  const previewEl = document.getElementById('passage-audio-preview');
  const hiddenUrlInput = document.getElementById('passage-audio-url');

  passageFormState.audioUploading = true;
  if (statusEl) { statusEl.textContent = '⏳ Đang tải file audio lên...'; statusEl.style.color = ''; }

  try {
    const safeFileName = file.name.replace(/[^\w.\-]/g, '_');
    const path = `${crypto.randomUUID()}-${safeFileName}`;

    const { error: uploadError } = await supabaseClient
      .storage
      .from('exam-audio')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient.storage.from('exam-audio').getPublicUrl(path);
    const publicUrl = publicUrlData?.publicUrl;
    if (!publicUrl) throw new Error('Không lấy được public URL sau khi upload.');

    if (hiddenUrlInput) hiddenUrlInput.value = publicUrl;
    if (previewEl) { previewEl.src = publicUrl; previewEl.style.display = 'block'; }
    if (statusEl) { statusEl.textContent = '✓ Đã tải audio lên thành công.'; statusEl.style.color = 'var(--success, #2e7d32)'; }
  } catch (err) {
    console.error('Lỗi upload audio đoạn văn/hội thoại:', err);
    if (statusEl) {
      statusEl.textContent = `❌ Tải audio thất bại: ${err?.message || 'Lỗi không xác định'}`;
      statusEl.style.color = 'var(--vermillion)';
    }
    if (hiddenUrlInput) hiddenUrlInput.value = '';
  } finally {
    passageFormState.audioUploading = false;
  }
}

// ── Toolbar định dạng chữ (bold/underline) cho nội dung đoạn văn ─────────
function applyPassageContentFormat(command) {
  const editor = document.getElementById('passage-content');
  if (!editor) return;
  editor.focus();
  document.execCommand(command, false, null);
}

// ── Chèn ảnh vào nội dung đoạn văn (dùng thay cho text, vd đề thi dạng
// ảnh chụp/biểu đồ) — upload lên bucket riêng "passage-images" (KHÁC bucket
// exam-audio vốn chỉ dành cho audio), rồi chèn thẻ <img> vào đúng vị trí
// con trỏ trong editor.
async function uploadAndInsertPassageContentImage(file) {
  const statusEl = document.getElementById('passage-content-image-status');
  const editor = document.getElementById('passage-content');

  if (statusEl) { statusEl.textContent = '⏳ Đang tải ảnh lên...'; statusEl.style.color = ''; }

  try {
    const safeFileName = file.name.replace(/[^\w.\-]/g, '_');
    const path = `${crypto.randomUUID()}-${safeFileName}`;

    const { error: uploadError } = await supabaseClient
      .storage
      .from('passage-images')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient.storage.from('passage-images').getPublicUrl(path);
    const publicUrl = publicUrlData?.publicUrl;
    if (!publicUrl) throw new Error('Không lấy được public URL sau khi upload ảnh.');

    editor.focus();
    document.execCommand('insertHTML', false, `<img src="${publicUrl}" alt="" />`);

    if (statusEl) { statusEl.textContent = '✓ Đã chèn ảnh vào nội dung.'; statusEl.style.color = 'var(--success, #2e7d32)'; }
  } catch (err) {
    console.error('Lỗi upload ảnh cho passage:', err);
    if (statusEl) {
      statusEl.textContent = `❌ Chèn ảnh thất bại: ${err?.message || 'Lỗi không xác định'}`;
      statusEl.style.color = 'var(--vermillion)';
    }
  }
}

async function submitPassageForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('passage-form-error');
  const submitBtn = document.getElementById('passage-form-submit-btn');
  errorEl.textContent = '';

  if (passageFormState.audioUploading) {
    errorEl.textContent = 'File audio đang được tải lên, vui lòng đợi upload xong rồi mới bấm Lưu.';
    return;
  }

  const title = document.getElementById('passage-title').value.trim();
  // Nội dung lấy từ div contenteditable -> lưu nguyên HTML (giữ bold/underline
  // và cả thẻ <img> nếu giáo viên chèn ảnh thay cho văn bản).
  const contentHtml = (document.getElementById('passage-content')?.innerHTML || '').trim();
  // Coi là "có nội dung" nếu còn chữ HOẶC có ít nhất 1 ảnh (trường hợp dùng
  // toàn ảnh thay text, không còn chữ nào).
  const hasTextOrImage = !!stripHtml(contentHtml).trim() || /<img\b/i.test(contentHtml);
  const audioUrl = document.getElementById('passage-audio-url').value || null;
  const passageType = document.getElementById('passage-type').value || null;

  if (!title) {
    errorEl.textContent = 'Vui lòng nhập tiêu đề cho đoạn văn/hội thoại (dùng để nhận diện trong dropdown).';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  const isEdit = passageFormState.mode === 'edit' && passageFormState.editingId !== null;

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });
    const body = JSON.stringify({ title, content: hasTextOrImage ? contentHtml : null, audio_url: audioUrl, passage_type: passageType });

    let res;
    if (isEdit) {
      res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages?id=eq.${passageFormState.editingId}`, {
        method: 'PATCH',
        headers,
        body
      });
    } else {
      res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/passages`, {
        method: 'POST',
        headers,
        body
      });
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi lưu đoạn văn/hội thoại (HTTP ${res.status})`);
    }

    const [saved] = await res.json();

    // Refresh dropdown passage_id ở form câu hỏi + bảng danh sách passage,
    // tự chọn sẵn đoạn vừa lưu trong dropdown.
    await populateQuestionFormPassageDropdown(saved?.id || passageFormState.editingId || '');
    await loadPassagesAdminList();

    closePassageForm();
  } catch (err) {
    console.error('Lỗi lưu đoạn văn/hội thoại:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu đoạn văn/hội thoại. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// ── Sub-tab: chuyển giữa bảng Câu hỏi và bảng Đoạn văn/hội thoại ─────────
// Cả 2 bảng đã được load sẵn cùng lúc ở loadQuestionsSection() (dữ liệu
// không quá lớn ở quy mô 1 giáo viên quản lý), nên hàm này chỉ đơn thuần
// ẩn/hiện, không cần fetch lại gì thêm.
function switchQuestionsSubtab(tab) {
  const questionsView = document.getElementById('questions-subview');
  const passagesView = document.getElementById('passages-subview');
  const questionsBtn = document.getElementById('subtab-questions-btn');
  const passagesBtn = document.getElementById('subtab-passages-btn');

  const showQuestions = tab === 'questions';
  if (questionsView) questionsView.style.display = showQuestions ? 'block' : 'none';
  if (passagesView) passagesView.style.display = showQuestions ? 'none' : 'block';
  if (questionsBtn) questionsBtn.classList.toggle('active', showQuestions);
  if (passagesBtn) passagesBtn.classList.toggle('active', !showQuestions);
}

// ============================================================
//  KHỞI TẠO (chạy song song với DOMContentLoaded của admin.js)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initQuestionSearch();
  initQuestionSkillFilter();
  initQuestionExamFilter();
  initQuestionSortControl();
  initQuestionFormControls();
  initQuestionPaginationControls();
  initPassagePaginationControls();
  initQuestionBulkControls();
  initChoiceDragDrop();
  injectExamLinkBlockIfNeeded(); // idempotent — openQuestionForm() cũng gọi lại khi mở form
});
