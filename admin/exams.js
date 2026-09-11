'use strict';

// ============================================================
//  ADMIN — QUẢN LÝ ĐỀ THI (bảng exams)
//  Nạp sau admin.js và questions.js (dùng chung supabaseClient,
//  ADMIN_CONFIG, sbAuthedHeaders, escHtml, formatDateVN, currentAdmin).
//
//  BƯỚC HIỆN TẠI: chỉ danh sách đề thi + form tạo/sửa thông tin exams
//  (title, exam_type, pass_threshold_pct, is_published).
//  CHƯA làm: quản lý exam_sections / exam_subsections / exam_questions
//  (màn chi tiết đề — sẽ làm ở bước sau, openExamDetail() hiện là stub).
// ============================================================

let examsFragmentLoaded = false;
const examAdminState = {
  rows: [],              // toàn bộ đề thi (chưa lọc) — load 1 lần từ loadExamAdminList()
  skillIdByExam: {},      // { exam_id: skill_id } — chỉ có với đề loại "skill" (1 section duy nhất)
  sectionCountByExam: {}, // { exam_id: số section } — dùng lại cho cột "Số section"
  filters: {
    search: '',
    examType: '',   // '' | 'full' | 'skill'
    skillId: '',     // '' | '<skill_id>'
    status: '',      // '' | 'published' | 'draft'
    sortField: 'created_at', // 'created_at' | 'available_from' | 'title'
    sortDirection: 'desc'    // 'asc' | 'desc'
  }
};

// Rule mặc định toàn hệ thống trong exam_retry_rules (exam_id IS NULL) —
// sửa được qua UI ở màn danh sách đề thi (không gắn với 1 đề cụ thể nào).
// Mặc định thu gọn (expanded=false) — bấm vào mới mở ra xem/sửa, để không
// chiếm chỗ ngay trên đầu bảng danh sách đề thi.
const defaultRetryRulesState = { rows: [], expanded: false, formOpen: false, editingId: null };

// skills.code của kỹ năng Nghe hiểu — xác nhận từ DB thực tế, KHÔNG đoán.
// Dùng để quyết định có hiện ô upload audio ở form "Thêm dạng bài" hay không.
const LISTENING_SKILL_CODE = 'listening';

// admin/exams.html chỉ là fragment (không phải trang đứng riêng) — fetch
// và inject 1 lần duy nhất vào #exams-fragment-mount (đặt sẵn trong
// index.html, bên trong <section data-section="exams">).
async function ensureExamsFragmentLoaded() {
  if (examsFragmentLoaded) return;
  const mount = document.getElementById('exams-fragment-mount');
  if (!mount) {
    console.error('Không tìm thấy #exams-fragment-mount trong index.html');
    return;
  }

  try {
    const res = await fetch('/admin/exams.html');
    if (!res.ok) throw new Error(`Không tải được admin/exams.html (HTTP ${res.status})`);
    mount.innerHTML = await res.text();
    examsFragmentLoaded = true;
    initExamFormControls();
  } catch (err) {
    console.error('Lỗi nạp giao diện quản lý đề thi:', err);
    mount.innerHTML = '<div class="empty-state">Không tải được giao diện quản lý đề thi. Thử tải lại trang.</div>';
  }
}

// Gọi từ switchAdminSection() trong admin.js khi vào section 'exams'.
async function loadExamsSection() {
  await ensureExamsFragmentLoaded();
  if (examsFragmentLoaded) {
    await loadExamAdminList();
    await loadDefaultRetryRules();
  }
}

// ── Danh sách đề thi ─────────────────────────────────────────────────
async function loadExamAdminList() {
  const tbody = document.getElementById('exam-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>';

  try {
    const headers = await sbAuthedHeaders();

    // Query song song: danh sách đề thi + toàn bộ exam_id trong exam_sections
    // để đếm "Số section" theo từng đề ở phía client (số lượng đề thi ở quy
    // mô 1 giáo viên quản lý là nhỏ, chưa cần RPC/aggregate riêng).
    const [examsRes, sectionsRes] = await Promise.all([
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams?select=id,title,exam_type,pass_threshold_pct,retry_disabled,is_published,available_from,created_at&order=created_at.desc`, { headers }),
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?select=exam_id,skill_id`, { headers })
    ]);

    if (!examsRes.ok) throw new Error(`Lỗi tải danh sách đề thi (HTTP ${examsRes.status})`);
    if (!sectionsRes.ok) throw new Error(`Lỗi tải số section (HTTP ${sectionsRes.status})`);

    const exams = await examsRes.json();
    const sections = await sectionsRes.json();

    const sectionCountByExam = {};
    // Đề loại "skill" chỉ có đúng 1 section (ràng buộc nghiệp vụ) -> skill_id
    // của section đó chính là "skill của cả đề", dùng cho filter Kỹ năng.
    // Đề loại "full" không set (giữ undefined) vì không có 1 skill duy nhất.
    const skillIdByExam = {};
    sections.forEach(s => {
      sectionCountByExam[s.exam_id] = (sectionCountByExam[s.exam_id] || 0) + 1;
      if (s.skill_id != null) skillIdByExam[s.exam_id] = s.skill_id;
    });

    examAdminState.rows = exams;
    examAdminState.skillIdByExam = skillIdByExam;
    examAdminState.sectionCountByExam = sectionCountByExam;
    await populateExamFilterSkillOptions();
    applyExamListFilters();
  } catch (err) {
    console.error('Lỗi tải danh sách đề thi:', err);
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Có lỗi khi tải danh sách đề thi.</div></td></tr>';
  }
}

// Đổ options cho dropdown "Kỹ năng" từ skills đã cache (fetchSkillsList()
// trong questions.js) — gọi lại mỗi lần loadExamAdminList() để chắc chắn
// list skill mới nhất, nhưng giữ nguyên lựa chọn hiện tại nếu còn hợp lệ.
async function populateExamFilterSkillOptions() {
  const select = document.getElementById('exam-filter-skill');
  if (!select) return;

  const skills = await fetchSkillsList();
  const currentValue = examAdminState.filters.skillId;

  select.innerHTML = '<option value="">Tất cả kỹ năng</option>' +
    skills.map(sk => `<option value="${sk.id}">${escHtml(sk.name)}</option>`).join('');

  select.value = skills.some(sk => String(sk.id) === currentValue) ? currentValue : '';
  if (select.value !== currentValue) examAdminState.filters.skillId = select.value;

  toggleExamSkillFilterEnabled();
}

// Dropdown Kỹ năng chỉ có ý nghĩa khi Loại đề = 'skill' (đề 'full' không
// có 1 skill_id duy nhất đại diện cho cả đề) — disable + reset về "Tất cả"
// khi Loại đề khác 'skill', tránh admin tưởng filter đang áp dụng mà thực
// ra bị bỏ qua ở applyExamListFilters().
function toggleExamSkillFilterEnabled() {
  const select = document.getElementById('exam-filter-skill');
  if (!select) return;

  const isSkillType = examAdminState.filters.examType === 'skill';
  select.disabled = !isSkillType;
  if (!isSkillType && examAdminState.filters.skillId) {
    examAdminState.filters.skillId = '';
    select.value = '';
  }
}

// Đảo chiều sort — đổi icon mũi tên cho khớp trạng thái, rồi apply lại.
function toggleExamSortDirection() {
  examAdminState.filters.sortDirection = examAdminState.filters.sortDirection === 'asc' ? 'desc' : 'asc';

  const icon = document.getElementById('exam-sort-direction-icon');
  if (icon) {
    icon.className = examAdminState.filters.sortDirection === 'asc'
      ? 'ti ti-sort-ascending'
      : 'ti ti-sort-descending';
  }

  applyExamListFilters();
}

// Đọc toàn bộ giá trị filter/sort hiện tại từ UI -> lưu vào
// examAdminState.filters -> lọc + sort examAdminState.rows (giữ nguyên,
// không sửa) -> render lại bảng. Lọc/sort hoàn toàn phía client vì
// examAdminState.rows đã tải đủ 1 lần từ loadExamAdminList(), không cần
// query lại Supabase mỗi lần đổi filter.
function applyExamListFilters() {
  const f = examAdminState.filters;
  f.search = document.getElementById('exam-search-input')?.value.trim().toLowerCase() || '';
  f.examType = document.getElementById('exam-filter-type')?.value || '';
  f.status = document.getElementById('exam-filter-status')?.value || '';
  f.sortField = document.getElementById('exam-sort-field')?.value || 'created_at';

  toggleExamSkillFilterEnabled();
  f.skillId = document.getElementById('exam-filter-skill')?.value || '';

  let rows = examAdminState.rows.slice();

  if (f.search) {
    rows = rows.filter(exam => (exam.title || '').toLowerCase().includes(f.search));
  }
  if (f.examType) {
    rows = rows.filter(exam => exam.exam_type === f.examType);
  }
  if (f.status) {
    const wantPublished = f.status === 'published';
    rows = rows.filter(exam => !!exam.is_published === wantPublished);
  }
  // Chỉ áp dụng khi Loại đề = 'skill' (khớp toggleExamSkillFilterEnabled()) —
  // dùng skillIdByExam đã tính sẵn từ exam_sections lúc load danh sách.
  if (f.examType === 'skill' && f.skillId) {
    rows = rows.filter(exam => String(examAdminState.skillIdByExam[exam.id]) === f.skillId);
  }

  const dir = f.sortDirection === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (f.sortField === 'title') {
      return a.title.localeCompare(b.title, 'vi') * dir;
    }
    // created_at / available_from — đề trống available_from (null, "hiện
    // ngay") coi như giá trị nhỏ nhất, luôn xếp trước khi sort desc (mới
    // nhất trước) hoặc sau cùng khi sort asc, tránh null xen giữa list.
    const valA = a[f.sortField] || '';
    const valB = b[f.sortField] || '';
    if (valA === valB) return 0;
    return (valA > valB ? 1 : -1) * dir;
  });

  renderExamAdminTable(rows, examAdminState.sectionCountByExam);
}


// Hiển thị ở màn DANH SÁCH đề thi (không thuộc về 1 đề cụ thể nào) —
// tự chèn container ngay trước bảng danh sách đề thi, idempotent.

function ensureDefaultRetryRulesContainer() {
  if (document.getElementById('default-retry-rules-card')) return;
  const tbody = document.getElementById('exam-table-body');
  const table = tbody ? tbody.closest('table') : null;
  if (!table) {
    console.error('Không tìm thấy bảng danh sách đề thi để chèn khu vực rule mặc định');
    return;
  }
  table.insertAdjacentHTML(
    'beforebegin',
    '<div id="default-retry-rules-card" class="admin-panel-card" style="margin-bottom:16px; padding:14px 18px;"></div>'
  );
}

async function loadDefaultRetryRules() {
  ensureDefaultRetryRulesContainer();
  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules?exam_id=is.null` +
      `&select=id,min_score_pct,max_score_pct,retry_after_days&order=min_score_pct.asc`,
      { headers }
    );
    if (!res.ok) throw new Error(`Lỗi tải rule mặc định (HTTP ${res.status})`);
    defaultRetryRulesState.rows = await res.json();
  } catch (err) {
    console.error('Lỗi tải rule mặc định exam_retry_rules:', err);
    defaultRetryRulesState.rows = [];
  }
  renderDefaultRetryRulesCard();
}

// Bấm vào tiêu đề card để mở/thu gọn — mặc định đóng, chỉ hiện 1 dòng tóm
// tắt (số khoảng điểm đã cấu hình) cho tới khi admin chủ động bấm vào xem.
function toggleDefaultRetryRulesExpanded() {
  defaultRetryRulesState.expanded = !defaultRetryRulesState.expanded;
  // Thu gọn lại thì đóng luôn form đang mở (nếu có), tránh trạng thái lửng lơ.
  if (!defaultRetryRulesState.expanded) {
    defaultRetryRulesState.formOpen = false;
    defaultRetryRulesState.editingId = null;
  }
  renderDefaultRetryRulesCard();
}

function renderDefaultRetryRulesCard() {
  const card = document.getElementById('default-retry-rules-card');
  if (!card) return;

  const rules = defaultRetryRulesState.rows || [];
  const expanded = defaultRetryRulesState.expanded;

  const summaryText = rules.length
    ? `${rules.length} khoảng điểm đã cấu hình`
    : 'Chưa cấu hình — các đề chưa có rule riêng sẽ không có gợi ý ngày làm lại';

  // ── Header luôn hiện, bấm vào để mở/thu gọn (giống 1 tab) ──
  const headerHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;"
      onclick="toggleDefaultRetryRulesExpanded()">
      <div style="font-weight:600;">
        <i class="ti ti-chevron-${expanded ? 'down' : 'right'}" style="vertical-align:middle;"></i>
        ⚙️ Rule nhắc làm lại mặc định
        <span style="font-weight:400; color:var(--ink-soft); font-size:12px;">— ${summaryText}</span>
      </div>
    </div>
  `;

  if (!expanded) {
    card.innerHTML = headerHtml;
    return;
  }

  // ── Nội dung chỉ render khi đã mở ──
  const rowsHtml = rules.length
    ? rules.map(r => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border:1px solid var(--border-md); border-radius:8px; margin-bottom:6px;">
        <div style="font-size:13px;">
          <strong>${r.min_score_pct}% – ${r.max_score_pct}%</strong>
          <span style="color:var(--ink-soft);"> → ${r.retry_after_days == null ? 'Không cần làm lại' : `chờ ${r.retry_after_days} ngày`}</span>
        </div>
        <div style="display:flex; gap:4px;">
          <button type="button" class="admin-row-action-btn" title="Sửa khoảng điểm này"
            onclick="event.stopPropagation(); openDefaultRetryRuleForm('${escHtml(r.id)}')">
            <i class="ti ti-pencil"></i>
          </button>
          <button type="button" class="admin-row-action-btn" title="Xóa khoảng điểm này"
            onclick="event.stopPropagation(); deleteDefaultRetryRule('${escHtml(r.id)}')" style="color:var(--vermillion);">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </div>
    `).join('')
    : `<div class="empty-state" style="padding:8px 0;">Chưa có rule mặc định nào — các đề chưa cấu hình riêng sẽ không có gợi ý ngày làm lại.</div>`;

  const formHtml = defaultRetryRulesState.formOpen ? renderDefaultRetryRuleFormHtml() : '';

  card.innerHTML = `
    ${headerHtml}
    <div style="margin-top:10px;">
      <div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
        <button type="button" class="btn btn-outline" style="padding:4px 10px; font-size:12px;"
          onclick="event.stopPropagation(); openDefaultRetryRuleForm(null)">
          <i class="ti ti-plus"></i> Thêm khoảng điểm
        </button>
      </div>
      ${rowsHtml}
      ${formHtml}
    </div>
  `;
}

// Sinh HTML form dùng chung cho "Thêm mới" và "Sửa" rule mặc định — đọc
// defaultRetryRulesState.editingId để biết đang sửa dòng nào, tự điền
// sẵn giá trị cũ nếu có (giống pattern renderExamRetryRuleFormHtml()
// ở rule riêng theo đề).
function renderDefaultRetryRuleFormHtml() {
  const editingId = defaultRetryRulesState.editingId;
  const editingRule = editingId ? (defaultRetryRulesState.rows || []).find(r => r.id === editingId) : null;
  const isEdit = !!editingRule;

  return `
    <form id="default-retry-rule-form" onsubmit="submitDefaultRetryRuleForm(event)"
      style="margin-top:6px; padding:12px; border:1px dashed var(--border-md); border-radius:8px;"
      onclick="event.stopPropagation();">
      <div id="default-retry-rule-form-error" style="color:var(--vermillion); font-size:12px; margin-bottom:8px;"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div>
          <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:4px;">Từ % điểm</label>
          <input type="number" id="default-retry-rule-min" min="0" max="100" step="1" required style="width:80px;"
            value="${isEdit ? editingRule.min_score_pct : ''}" />
        </div>
        <div>
          <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:4px;">Đến % điểm</label>
          <input type="number" id="default-retry-rule-max" min="0" max="100" step="1" required style="width:80px;"
            value="${isEdit ? editingRule.max_score_pct : ''}" />
        </div>
        <div>
          <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:4px;">Số ngày chờ</label>
          <input type="number" id="default-retry-rule-days" min="1" step="1" style="width:120px;"
            placeholder="Để trống = ko cần"
            value="${isEdit && editingRule.retry_after_days != null ? editingRule.retry_after_days : ''}" />
        </div>
        <button type="submit" class="btn btn-outline" id="default-retry-rule-submit-btn">${isEdit ? 'Cập nhật' : 'Lưu'}</button>
        <button type="button" class="btn btn-outline" onclick="closeDefaultRetryRuleForm()">Hủy</button>
      </div>
    </form>
  `;
}

function openDefaultRetryRuleForm(ruleId) {
  defaultRetryRulesState.formOpen = true;
  defaultRetryRulesState.editingId = ruleId; // null = thêm mới, có id = sửa dòng đó
  renderDefaultRetryRulesCard();
}

function closeDefaultRetryRuleForm() {
  defaultRetryRulesState.formOpen = false;
  defaultRetryRulesState.editingId = null;
  renderDefaultRetryRulesCard();
}

async function submitDefaultRetryRuleForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('default-retry-rule-form-error');
  const submitBtn = document.getElementById('default-retry-rule-submit-btn');
  errorEl.textContent = '';

  const min = parseInt(document.getElementById('default-retry-rule-min').value, 10);
  const max = parseInt(document.getElementById('default-retry-rule-max').value, 10);
  const daysRaw = document.getElementById('default-retry-rule-days').value.trim();
  // Để trống ô "Số ngày chờ" -> retry_after_days = null, nghĩa là band điểm
  // này KHÔNG CẦN LÀM LẠI (khác với việc không có rule nào khớp).
  const days = daysRaw === '' ? null : parseInt(daysRaw, 10);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    errorEl.textContent = 'Vui lòng nhập đầy đủ khoảng % điểm.';
    return;
  }
  if (min < 0 || max > 100 || min > max) {
    errorEl.textContent = 'Khoảng % điểm không hợp lệ (0-100, "Từ" phải ≤ "Đến").';
    return;
  }
  if (days !== null && (!Number.isFinite(days) || days <= 0)) {
    errorEl.textContent = 'Số ngày chờ phải là số lớn hơn 0, hoặc để trống nếu không cần làm lại.';
    return;
  }

  const isEdit = !!defaultRetryRulesState.editingId;

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = isEdit ? 'Đang cập nhật...' : 'Đang lưu...';

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });
    const res = isEdit
      ? await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules?id=eq.${defaultRetryRulesState.editingId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ min_score_pct: min, max_score_pct: max, retry_after_days: days })
        })
      : await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules`, {
          method: 'POST', headers,
          body: JSON.stringify({
            exam_id: null, // rule mặc định toàn hệ thống
            min_score_pct: min,
            max_score_pct: max,
            retry_after_days: days
          })
        });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi lưu rule mặc định (HTTP ${res.status})`);
    }

    defaultRetryRulesState.formOpen = false;
    defaultRetryRulesState.editingId = null;
    await loadDefaultRetryRules();
    defaultRetryRulesState.expanded = true; // giữ mở sau khi lưu để thấy kết quả ngay
    renderDefaultRetryRulesCard();
  } catch (err) {
    console.error('Lỗi lưu rule mặc định exam_retry_rules:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu. Vui lòng thử lại.';
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

async function deleteDefaultRetryRule(ruleId) {
  if (!confirm('Xóa khoảng điểm này khỏi rule mặc định? Các đề chưa cấu hình riêng sẽ mất gợi ý ngày làm lại cho khoảng điểm này.')) return;

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules?id=eq.${ruleId}`, {
      method: 'DELETE', headers
    });
    if (!res.ok) throw new Error(`Lỗi xóa rule mặc định (HTTP ${res.status})`);
    await loadDefaultRetryRules();
  } catch (err) {
    console.error('Lỗi xóa rule mặc định exam_retry_rules:', err);
    alert(err?.message || 'Có lỗi khi xóa. Vui lòng thử lại.');
  }
}

function renderExamAdminTable(exams, sectionCountByExam) {
  const tbody = document.getElementById('exam-table-body');
  if (!tbody) return;

  if (!exams.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Chưa có đề thi nào. Bấm "Tạo đề mới" để bắt đầu.</div></td></tr>';
    return;
  }

  tbody.innerHTML = exams.map(exam => `
    <tr class="admin-clickable-row" data-exam-id="${escHtml(exam.id)}" onclick="openExamDetail('${escHtml(exam.id)}')">
      <td>${escHtml(exam.title)}</td>
      <td>${escHtml(exam.exam_type || '—')}</td>
      <td>
        <span class="exam-status-badge ${exam.is_published ? 'is-published' : 'is-draft'}">
          ${exam.is_published ? 'Published' : 'Draft'}
        </span>
      </td>
      <td style="text-align:center;">${sectionCountByExam[exam.id] || 0}</td>
      <td>${formatDateVN(exam.created_at)}</td>
      <td>${exam.available_from ? formatDateVN(exam.available_from) : 'Ngay khi Publish'}</td>
      <td style="text-align:right;">
        <div style="display:flex; gap:6px; justify-content:flex-end;">
          <button type="button" class="admin-row-action-btn" title="Sửa đề thi"
            onclick="event.stopPropagation(); openExamForm(examAdminState.rows.find(r => r.id === '${escHtml(exam.id)}'))">
            <i class="ti ti-pencil"></i>
          </button>
          <button type="button" class="admin-row-action-btn danger" title="Xóa đề thi"
            onclick="event.stopPropagation(); deleteExam('${escHtml(exam.id)}', '${escHtml(exam.title).replace(/'/g, "\\'")}')">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ── Chi tiết đề thi (view 2) — quản lý section ─────────────────────────
// CHƯA làm subsection / chọn câu hỏi (bước sau).
const examDetailState = {
  examId: null,
  exam: null,
  sections: [],
  subsectionsBySection: {}, // { [sectionId]: [{id, instruction_text, order_index, questionCount}] }
  retryRules: [],           // rule riêng của đề này trong exam_retry_rules (exam_id = examId)
  retryRuleFormOpen: false, // trạng thái mở/đóng form "Thêm khoảng điểm" (chỉ ở phía client)
  retryRuleEditingId: null, // id rule đang sửa, null nếu đang ở chế độ "Thêm mới"
  retryRulesExpanded: false // thu gọn/mở rộng card "Cấu hình nhắc làm lại" — mặc định đóng
};

// Sinh chuỗi ghi chú "Đề này dùng rule mặc định: ..." từ dữ liệu THẬT trong
// defaultRetryRulesState.rows (đã load ở màn danh sách đề thi trước đó) —
// không hardcode, để luôn khớp với rule mặc định admin đang cấu hình.
function defaultRetryRuleHintText() {
  const rows = defaultRetryRulesState.rows || [];
  if (!rows.length) return 'Hệ thống chưa có rule mặc định nào được cấu hình.';
  return rows
    .slice()
    .sort((a, b) => a.min_score_pct - b.min_score_pct)
    .map(r => `${r.min_score_pct}–${r.max_score_pct}% → ${r.retry_after_days == null ? 'Không cần làm lại' : r.retry_after_days + ' ngày'}`)
    .join(', ');
}

function showExamListView() {
  document.getElementById('exam-list-view').style.display = 'block';
  document.getElementById('exam-detail-view').style.display = 'none';
}

function showExamDetailView() {
  document.getElementById('exam-list-view').style.display = 'none';
  document.getElementById('exam-detail-view').style.display = 'block';
}

// Xóa đề thi — dùng chung cho icon xóa ở bảng danh sách và nút xóa ở màn
// chi tiết. exam_sections/exam_attempts đều FK tới exams(id) không có
// CASCADE (theo schema đã cho) -> nếu đề đã có section hoặc học viên đã
// làm bài, Postgres trả lỗi 23503 (foreign_key_violation); bắt riêng mã
// lỗi này để báo rõ nguyên nhân thay vì hiện lỗi kỹ thuật khó hiểu.
async function deleteExam(examId, examTitle) {
  const confirmed = confirm(`Xóa đề thi "${examTitle}"? Hành động này không thể hoàn tác.`);
  if (!confirmed) return;

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams?id=eq.${examId}`, {
      method: 'DELETE',
      headers
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      if (errBody?.code === '23503') {
        alert('Không thể xóa đề này vì đã có phần thi hoặc lượt làm bài của học viên liên quan. Hãy xóa hết các phần thi (section) trong đề trước, hoặc chuyển đề về Draft thay vì xóa.');
      } else {
        alert(errBody?.message || `Lỗi xóa đề thi (HTTP ${res.status})`);
      }
      return;
    }

    // Dropdown "Chọn đề thi" bên tab Câu hỏi cache riêng, cần invalidate
    // giống hệt sau khi tạo/sửa đề (xem submitExamForm()).
    if (typeof examLinkState !== 'undefined') {
      examLinkState.examsLoaded = false;
    }

    // Đang xóa ngay tại màn chi tiết của chính đề đó -> quay lại danh sách,
    // không load lại header với dữ liệu đề đã không còn tồn tại.
    if (examDetailState.examId === examId) {
      showExamListView();
    }

    await loadExamAdminList();
  } catch (err) {
    console.error('Lỗi xóa đề thi:', err);
    alert('Có lỗi khi xóa đề thi. Vui lòng thử lại.');
  }
}

async function openExamDetail(examId) {
  examDetailState.examId = examId;
  showExamDetailView();

  // Đề thi đã có sẵn trong examAdminState.rows (vừa load ở danh sách) ->
  // không cần fetch lại riêng, chỉ fetch phần sections.
  const exam = examAdminState.rows.find(r => r.id === examId) || null;
  examDetailState.exam = exam;
  renderExamDetailHeader();

  // Đảm bảo rule mặc định đã có dữ liệu để build ghi chú "dùng rule mặc
  // định: ..." — bình thường đã load sẵn từ loadExamsSection() ở màn danh
  // sách, chỉ fetch lại nếu vì lý do gì đó chưa có (an toàn, tránh ghi
  // chú trống).
  if (!defaultRetryRulesState.rows.length) await loadDefaultRetryRules();

  await loadExamSections();
  await loadExamRetryRules();
}

function renderExamDetailHeader() {
  const exam = examDetailState.exam;
  const titleEl = document.getElementById('exam-detail-title');
  const subEl = document.getElementById('exam-detail-sub');
  const editBtn = document.getElementById('exam-detail-edit-btn');
  if (titleEl) titleEl.textContent = exam ? exam.title : 'Đề thi';
  if (subEl) {
    subEl.innerHTML = exam ? `
      Loại: ${escHtml(exam.exam_type || '—')} · Ngưỡng đạt: ${exam.pass_threshold_pct}% ·
      <span class="exam-status-badge ${exam.is_published ? 'is-published' : 'is-draft'}">
        ${exam.is_published ? 'Published' : 'Draft'}
      </span>
      ${exam.retry_disabled ? '<span class="exam-status-badge" style="background:var(--ink-soft); color:#fff;">Không cần retry</span>' : ''}
    ` : '';
  }
  if (editBtn) editBtn.onclick = () => openExamForm(exam);

  const deleteBtn = document.getElementById('exam-detail-delete-btn');
  if (deleteBtn) deleteBtn.onclick = () => deleteExam(exam.id, exam.title);

  // Nút "Xem trước" — admin/exams.html chưa có sẵn markup cho nút này nên
  // tự tạo bằng JS nếu chưa tồn tại (idempotent, renderExamDetailHeader()
  // có thể được gọi lại nhiều lần). Chèn cạnh nút Sửa/Xóa, cùng parent.
  let previewBtn = document.getElementById('exam-detail-preview-btn');
  if (!previewBtn && editBtn && editBtn.parentElement) {
    previewBtn = document.createElement('button');
    previewBtn.id = 'exam-detail-preview-btn';
    previewBtn.type = 'button';
    previewBtn.className = 'btn btn-outline';
    previewBtn.textContent = '👁️ Xem trước';
    editBtn.parentElement.insertBefore(previewBtn, editBtn);
  }
  if (previewBtn) previewBtn.onclick = () => openExamPreview(exam);
}

// ── Modal "Xem trước đề thi" — khung rỗng ───────────────────────────────
// admin/exams.html chưa có sẵn markup cho modal này nên dựng DOM bằng JS
// (giống cách tạo nút previewBtn ở trên), CHỈ dùng lại class CSS đã có
// trong admin.css (.admin-overlay, .admin-slide-panel, .admin-modal-centered,
// .admin-slide-panel-header, .admin-slide-close-btn, .admin-slide-panel-body,
// .exam-status-badge) — không viết CSS mới. Tạo 1 lần duy nhất, các lần mở
// sau chỉ toggle display + đổi lại nội dung header.
function ensureExamPreviewModalDom() {
  if (document.getElementById('exam-preview-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'exam-preview-overlay';
  overlay.className = 'admin-overlay';
  overlay.style.display = 'none';
  overlay.onclick = closeExamPreviewModal;

  const panel = document.createElement('div');
  panel.id = 'exam-preview-panel';
  panel.className = 'admin-slide-panel admin-modal-centered';
  panel.style.display = 'none';
  // Chặn click bên trong panel nổi bọt lên overlay (tránh đóng nhầm khi
  // click vào nội dung modal) — cùng pattern các slide-panel khác thường
  // đặt onclick đóng ở overlay riêng, không đặt trên panel.
  panel.onclick = (e) => e.stopPropagation();

  panel.innerHTML = `
    <div class="admin-slide-panel-header">
      <div>
        <h3 id="exam-preview-title" style="margin-bottom:6px;">Đề thi</h3>
        <div id="exam-preview-badges" style="display:flex; gap:6px;"></div>
      </div>
      <button type="button" class="admin-slide-close-btn" id="exam-preview-close-btn">✕</button>
    </div>
    <div class="admin-slide-panel-body" id="exam-preview-body">
      <!-- Chưa render nội dung — sẽ thêm ở bước sau -->
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  document.getElementById('exam-preview-close-btn').onclick = closeExamPreviewModal;
}

function closeExamPreviewModal() {
  const overlay = document.getElementById('exam-preview-overlay');
  const panel = document.getElementById('exam-preview-panel');
  if (overlay) overlay.style.display = 'none';
  if (panel) panel.style.display = 'none';
}

// Điền header (tên đề + badge Draft/Published + badge Full/Skill) rồi mở
// modal. Tái dùng class .exam-status-badge sẵn có cho cả 2 badge — badge
// Full/Skill không có màu is-published/is-draft riêng nên set inline style
// trung tính (đúng tiền lệ đã có sẵn trong file này ở dòng badge "Không
// cần retry" tại renderExamDetailHeader(), không phải CSS mới).
function openExamPreviewModal(exam) {
  ensureExamPreviewModalDom();

  const titleEl = document.getElementById('exam-preview-title');
  const badgesEl = document.getElementById('exam-preview-badges');
  if (titleEl) titleEl.textContent = exam.title || 'Đề thi';
  if (badgesEl) {
    badgesEl.innerHTML = `
      <span class="exam-status-badge ${exam.is_published ? 'is-published' : 'is-draft'}">
        ${exam.is_published ? 'Published' : 'Draft'}
      </span>
      <span class="exam-status-badge" style="background:var(--paper-warm); color:var(--ink-soft);">
        ${exam.exam_type === 'full' ? 'Full' : 'Skill'}
      </span>
    `;
  }

  document.getElementById('exam-preview-overlay').style.display = 'block';
  document.getElementById('exam-preview-panel').style.display = 'flex';
}

// ── Xem trước đề thi — query dữ liệu ─────────────────────────────────────
// Query lồng đúng thứ tự exam_sections -> exam_subsections -> exam_questions
// (join question_bank), sort order_index ở cả 3 cấp. Mở modal (khung rỗng,
// chưa render nội dung bên trong) song song với việc gọi API; tạm thời chỉ
// console.log(data) để kiểm tra dữ liệu trước khi dựng UI modal ở bước sau.
const examPreviewState = {
  tree: [], // [{ ...section, subsections: [{ ...subsection, questions: [] }] }]
  passagesMap: {} // { [passage_id]: { id, title, content, audio_url } }
};

async function openExamPreview(exam) {
  openExamPreviewModal(exam);

  const body = document.getElementById('exam-preview-body');
  if (body) body.innerHTML = '<div class="empty-state">Đang tải...</div>';

  const examId = exam.id;
  try {
    const headers = await sbAuthedHeaders();

    const sectionsRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?exam_id=eq.${examId}` +
      `&select=id,exam_id,skill_id,title,time_limit_seconds,order_index&order=order_index.asc`,
      { headers }
    );
    const sections = await sectionsRes.json();

    const sectionIds = sections.map(s => s.id);
    let subsections = [];
    if (sectionIds.length) {
      const subsRes = await fetch(
        `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?exam_section_id=in.(${sectionIds.join(',')})` +
        `&select=id,exam_section_id,instruction_text,audio_url,order_index&order=order_index.asc`,
        { headers }
      );
      subsections = await subsRes.json();
    }

    const subsectionIds = subsections.map(s => s.id);
    let questions = [];
    if (subsectionIds.length) {
      // PostgREST embed question_bank(...) trong 1 request duy nhất, giống
      // pattern đã dùng ở openSubsectionQuestionList().
      const questionsRes = await fetch(
        `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=in.(${subsectionIds.join(',')})` +
        `&select=id,exam_subsection_id,order_index,points,question_id,question_bank(id,question_text,question_type,choices,correct_answer,explanation,audio_url,passage_id)` +
        `&order=order_index.asc`,
        { headers }
      );
      questions = await questionsRes.json();
    }

    // Ráp lại thành cây section -> subsections -> questions để dễ kiểm tra
    // bằng mắt trong console, đồng thời vẫn console.log riêng từng mảng gốc.
    const tree = sections.map(sec => ({
      ...sec,
      subsections: subsections
        .filter(sub => sub.exam_section_id === sec.id)
        .map(sub => ({
          ...sub,
          questions: questions.filter(q => q.exam_subsection_id === sub.id)
        }))
    }));

    console.log('[openExamPreview] sections:', sections);
    console.log('[openExamPreview] subsections:', subsections);
    console.log('[openExamPreview] questions (join question_bank):', questions);
    console.log('[openExamPreview] tree:', tree);

    examPreviewState.tree = tree;
    await ensureExamPreviewAssetsLoaded();

    // Tải nội dung passage (reading/grammar dùng đoạn văn chung cho nhiều
    // câu) — TÁI DÙNG nguyên loadPassagesByIds() từ exam.js, không viết
    // lại query. Gom passage_id duy nhất từ toàn bộ câu hỏi trong đề.
    const passageIds = [...new Set(
      questions.map(q => q.question_bank && q.question_bank.passage_id).filter(Boolean)
    )];
    examPreviewState.passagesMap = await loadPassagesByIds(passageIds);

    renderExamPreviewBody();
  } catch (err) {
    console.error('Lỗi khi tải dữ liệu xem trước đề thi:', err);
    const body = document.getElementById('exam-preview-body');
    if (body) body.innerHTML = '<div class="empty-state">Có lỗi khi tải dữ liệu đề thi.</div>';
  }
}

// ── Render nội dung modal: section -> subsection -> câu hỏi ─────────────
// Tái dùng skillNameById()/escHtml() và class .admin-panel-card/.empty-state
// sẵn có — không viết CSS mới cho khung ngoài, không có nút hành động (chỉ
// xem, không sửa/xóa/di chuyển như renderExamSectionsList()).
function renderExamPreviewBody() {
  const body = document.getElementById('exam-preview-body');
  if (!body) return;

  const tree = examPreviewState.tree;
  if (!tree.length) {
    body.innerHTML = '<div class="empty-state">Đề thi này chưa có phần thi nào.</div>';
    return;
  }

  // lastPassageId dùng CHUNG xuyên suốt cả đề (không reset theo section/
  // subsection) để gộp đúng passage liền kề kể cả khi 1 passage lỡ vắt
  // qua ranh giới subsection — cùng nguyên tắc "liền kề" renderResultQuestionsReview()
  // đang dùng ở màn Đáp án phía học viên.
  const passageTracker = { lastPassageId: null };

  body.innerHTML = tree.map(sec => `
    <div class="admin-panel-card" style="margin-bottom:10px; padding:12px 16px;">
      <div style="font-weight:600;">${escHtml(sec.title || skillNameById(sec.skill_id))}</div>
      <div style="font-size:12px; color:var(--ink-soft); margin-bottom:10px;">
        ${escHtml(skillNameById(sec.skill_id))} · ${Math.round((sec.time_limit_seconds || 0) / 60)} phút
      </div>
      ${renderExamPreviewSubsections(sec.subsections, passageTracker)}
    </div>
  `).join('');

  markCorrectAnswersInPreviewBody();
}

function renderExamPreviewSubsections(subs, passageTracker) {
  if (!subs || !subs.length) {
    return '<div class="empty-state" style="padding:10px 0;">Chưa có dạng bài nào trong phần này.</div>';
  }

  return subs.map((sub, idx) => `
    <div style="padding:8px 0; ${idx > 0 ? 'border-top:1px solid var(--border-md);' : ''}">
      <div style="font-size:13px;">${escHtml(sub.instruction_text || '—')}</div>
      <div style="font-size:12px; color:var(--ink-soft); margin-bottom:6px;">
        ${sub.questions.length} câu hỏi${sub.audio_url ? ' · <i class="ti ti-volume" title="Đã có audio"></i> Có audio' : ''}
      </div>
      ${renderExamPreviewQuestions(sub.questions, passageTracker)}
    </div>
  `).join('');
}

// ── Tái dùng NGUYÊN hàm render câu hỏi của Tier 3 (exam.js, phía học
// viên) — renderMultipleChoiceAnswers()/renderFillBlankAnswer() — không
// viết lại UI câu hỏi mới. 2 hàm đó nhận sẵn tham số isLocked để disable
// input/click chọn đáp án -> readonly=true ở đây chính là isLocked=true.
//
// Passage: tái dùng markup/class y hệt renderResultPassageBox() (màn Đáp
// án của exam.js) — .exam-passage-box/-title/-content, nút audio + progress
// bar dùng chung toggleReviewQuestionAudio()/seekReviewAudio() (tái dùng
// nguyên, không viết cơ chế audio mới). Chỉ show 1 lần cho nhóm câu liền
// kề cùng passage_id, y hệt quy tắc renderResultQuestionsReview().
//
// Audio riêng của từng câu hỏi (qb.audio_url, khác với audio của passage):
// dùng chung 1 hàm toggleReviewQuestionAudio() nhưng với id = current.id,
// y hệt cách renderResultQuestionDetail() đang làm ở màn Đáp án.
function renderExamPreviewQuestions(questions, passageTracker) {
  if (!questions || !questions.length) return '';

  return questions.map((current, idx) => {
    const qb = current.question_bank || {};
    const normalizedType = (qb.question_type || '').trim().toLowerCase();

    let passageHtml = '';
    const passageId = qb.passage_id || null;
    if (passageId && passageId !== passageTracker.lastPassageId) {
      passageHtml = renderExamPreviewPassageBox(passageId);
    }
    passageTracker.lastPassageId = passageId;

    let answerHtml = '';
    if (normalizedType === 'multiple_choice') {
      if (Array.isArray(qb.choices) && qb.choices.length > 0) {
        answerHtml = renderMultipleChoiceAnswers(current, qb.choices, qb.correct_answer, /* isLocked = */ true);
      } else {
        answerHtml = `<div class="exam-question-warning">⚠️ Câu hỏi này chưa có đáp án (choices rỗng trong question_bank).</div>`;
      }
    } else if (normalizedType === 'fill_blank') {
      answerHtml = renderFillBlankAnswer(current, /* isLocked = */ true);
    } else {
      answerHtml = `<div class="exam-question-warning">⚠️ Không nhận diện được loại câu hỏi ("${escHtml(qb.question_type || '')}").</div>`;
    }

    // Nút nghe audio riêng của câu hỏi — TÁI DÙNG toggleReviewQuestionAudio()/
    // seekReviewAudio() (đã có icon play/pause đổi trạng thái + progress bar),
    // không phải playExamAudio() (chỉ phát 1 chiều, không toggle) vì ngữ cảnh
    // "xem lại, không phải đang làm bài thật" khớp với màn Đáp án hơn màn làm bài.
    const questionAudioHtml = qb.audio_url ? `
      <div class="exam-audio-controls">
        <button type="button" class="btn btn-outline exam-audio-btn" onclick="toggleReviewQuestionAudio('${current.id}', '${qb.audio_url}')">
          <i class="ti ti-player-play" id="review-audio-icon-${current.id}"></i> Nghe audio
        </button>
        <input type="range" class="exam-audio-progress" id="review-audio-progress-${current.id}"
          min="0" max="100" step="0.1" value="0"
          oninput="seekReviewAudio('${current.id}', this.value)" />
      </div>
    ` : '';

    return `
      ${passageHtml}
      <div class="exam-question-block" style="margin-top:10px;">
        <div class="exam-question-number">Câu ${idx + 1}</div>
        <div class="exam-question-content">${qb.question_text || ''}</div>
        ${questionAudioHtml}
        ${answerHtml}
      </div>
    `;
  }).join('');
}

// Passage box cho reading/grammar (đoạn văn dùng chung nhiều câu) — tái
// dùng đúng class .exam-passage-box/-title/-content của exam.js, dữ liệu
// lấy từ examPreviewState.passagesMap (đã tải qua loadPassagesByIds() tái
// dùng ở openExamPreview()).
function renderExamPreviewPassageBox(passageId) {
  const passage = examPreviewState.passagesMap[passageId];
  if (!passage) return '';

  const toggleId = `passage-${passageId}`;

  return `
    <div class="exam-passage-box">
      ${passage.title ? `<div class="exam-passage-title">${escHtml(passage.title)}</div>` : ''}
      ${passage.audio_url ? `
        <div class="exam-audio-controls">
          <button type="button" class="btn btn-outline exam-audio-btn" onclick="toggleReviewQuestionAudio('${toggleId}', '${passage.audio_url}')">
            <i class="ti ti-player-play" id="review-audio-icon-${toggleId}"></i> Nghe đoạn hội thoại
          </button>
          <input type="range" class="exam-audio-progress" id="review-audio-progress-${toggleId}"
            min="0" max="100" step="0.1" value="0"
            oninput="seekReviewAudio('${toggleId}', this.value)" />
        </div>
      ` : ''}
      ${passage.content ? `<div class="exam-passage-content">${passage.content}</div>` : ''}
    </div>
  `;
}

// ── Đánh dấu đáp án đúng (chỉ ở Xem trước, admin mới thấy) ──────────────
// Không sửa renderMultipleChoiceAnswers()/renderFillBlankAnswer() gốc (2
// hàm đó không có khái niệm "đáp án đúng hiển thị sẵn" vì phía học viên
// không được lộ đáp án) — thay vào đó post-process DOM SAU KHI đã render
// xong, dựa theo đúng thứ tự lồng nhau tree -> subsections -> questions
// (khớp 1:1 với thứ tự .exam-question-block xuất hiện trong DOM).
function flattenPreviewQuestions(tree) {
  const flat = [];
  (tree || []).forEach(sec => {
    (sec.subsections || []).forEach(sub => {
      (sub.questions || []).forEach(q => flat.push(q));
    });
  });
  return flat;
}

function markCorrectAnswersInPreviewBody() {
  const body = document.getElementById('exam-preview-body');
  if (!body) return;

  const flatQuestions = flattenPreviewQuestions(examPreviewState.tree);
  const blocks = body.querySelectorAll('.exam-question-block');

  blocks.forEach((block, i) => {
    const current = flatQuestions[i];
    if (!current) return;

    const qb = current.question_bank || {};
    const normalizedType = (qb.question_type || '').trim().toLowerCase();

    if (normalizedType === 'multiple_choice' && Array.isArray(qb.choices)) {
      // Khớp lại đúng nút bằng INDEX trong choices (cùng thứ tự
      // renderMultipleChoiceAnswers() dùng để render từng button), không
      // so khớp bằng giá trị để tránh lệch nếu choices chứa HTML trùng nhau.
      const correctIndex = qb.choices.indexOf(qb.correct_answer);
      const buttons = block.querySelectorAll('.exam-choice-btn');
      if (correctIndex >= 0 && buttons[correctIndex]) {
        buttons[correctIndex].classList.add('correct-answer');
      }
    } else if ((normalizedType === 'fill_blank' || normalizedType === 'type_answer') && qb.correct_answer != null) {
      const wrap = block.querySelector('.exam-fill-blank-wrap');
      const note = document.createElement('div');
      note.className = 'correct-answer';
      note.textContent = `Đáp án đúng: ${qb.correct_answer}`;
      if (wrap) {
        wrap.insertAdjacentElement('afterend', note);
      } else {
        // type_answer chưa có hàm render riêng (xem báo cáo Bước 1) nên
        // chưa có .exam-fill-blank-wrap để chèn cạnh -> gắn thẳng cuối block.
        block.appendChild(note);
      }
    }
  });
}

// Class .correct-answer — ĐÃ SỬA theo phản hồi: chữ trước dùng var(--sage)
// (#5a7a6a) tương phản yếu trên nền --sage-light nên bị "mờ". Đổi sang cặp
// màu #0f6e56/#e1f5ee — KHÔNG phải màu mới tự bịa, đây chính là cặp màu đã
// dùng sẵn cho .exam-status-badge.is-published trong admin.css (badge
// "Published", cũng mang nghĩa tích cực/thành công), chỉ tái dùng lại cho
// nhất quán + tăng font-weight cho rõ. Vẫn inject bằng JS, chỉ áp dụng
// trong khung Xem trước, không đụng style.css/admin.css.
function ensureCorrectAnswerStyleInjected() {
  if (document.getElementById('exam-preview-correct-answer-style')) return;
  const style = document.createElement('style');
  style.id = 'exam-preview-correct-answer-style';
  style.textContent = `
    #exam-preview-body .exam-choice-btn.correct-answer {
      border-color: #0f6e56 !important;
      background: #e1f5ee !important;
      color: #0f6e56 !important;
      font-weight: 700 !important;
    }
    #exam-preview-body .exam-choice-btn.correct-answer .exam-choice-label {
      background: #0f6e56 !important;
      color: #fff !important;
    }
    #exam-preview-body .exam-choice-btn.correct-answer::after {
      content: "✓ Đáp án đúng";
      margin-left: 8px;
      font-size: 12px;
      font-weight: 700;
      color: #0f6e56;
    }
    #exam-preview-body div.correct-answer {
      margin-top: 6px;
      display: inline-block;
      font-size: 13px;
      font-weight: 700;
      color: #0f6e56;
      background: #e1f5ee;
      padding: 4px 12px;
      border-radius: 20px;
    }
  `;
  document.head.appendChild(style);
}

// Nạp exam.js (chứa renderMultipleChoiceAnswers/renderFillBlankAnswer/
// toggleReviewQuestionAudio/loadPassagesByIds...) và style.css (chứa toàn
// bộ class .exam-*) bằng JS, vì admin/index.html không có sẵn 2 file này
// (Tier 3 là app riêng của học viên) — tránh phải sửa markup admin/index.html
// mà mình chưa có. Chỉ nạp 1 lần duy nhất.
//
// exam.js cần 2 biến global sau (bình thường do app.js khai báo — admin
// không load app.js vì app.js tự khai báo `const supabaseClient` riêng,
// SẼ ĐỤNG với `const supabaseClient` admin.js đã khai báo sẵn -> lỗi
// "already declared". Vì vậy KHÔNG load app.js, chỉ tự tạo 2 phần tối
// thiểu mà exam.js thực sự cần, RIÊNG cho admin, không đụng state/audio
// thật của học viên):
//   1) state.examState.selectedAnswers — renderMultipleChoiceAnswers()/
//      renderFillBlankAnswer() đọc kể cả khi locked.
//   2) stopCurrentAudio() — toggleReviewQuestionAudio()/playExamAudio()
//      gọi để dừng audio trước đó trước khi phát audio mới. Copy nguyên
//      logic từ app.js (hàm gốc rất nhỏ, thuần thao tác trên 1 thẻ
//      <audio>, không phải UI) vì không thể load cả app.js.
let examPreviewAssetsPromise = null;
function ensureExamPreviewAssetsLoaded() {
  if (examPreviewAssetsPromise) return examPreviewAssetsPromise;

  window.state = window.state || {};
  window.state.examState = window.state.examState || { selectedAnswers: {} };

  if (typeof window.stopCurrentAudio !== 'function') {
    window.stopCurrentAudio = function stopCurrentAudio() {
      if (window.state.currentAudio) {
        window.state.currentAudio.onended = null;
        window.state.currentAudio.onerror = null;
        window.state.currentAudio.pause();
        window.state.currentAudio.src = '';
        window.state.currentAudio = null;
      }
    };
  }

  ensureCorrectAnswerStyleInjected();

  if (!document.getElementById('exam-preview-student-css')) {
    const link = document.createElement('link');
    link.id = 'exam-preview-student-css';
    link.rel = 'stylesheet';
    link.href = '../style.css';
    document.head.appendChild(link);
  }

  examPreviewAssetsPromise = new Promise((resolve, reject) => {
    if (typeof renderMultipleChoiceAnswers === 'function' && typeof renderFillBlankAnswer === 'function') {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = '../exam.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Không tải được exam.js (../exam.js) để tái dùng UI câu hỏi.'));
    document.head.appendChild(script);
  });

  return examPreviewAssetsPromise;
}

// ── Cấu hình nhắc làm lại (exam_retry_rules riêng theo đề, tùy chọn) ────
// Container #exam-retry-rules-card đã có sẵn trong admin/exams.html, đặt
// cạnh phải card thông tin đề thi (trong #exam-detail-top-row) — không
// cần tự tạo DOM ở đây nữa như bản trước, chỉ cần xác nhận tồn tại.

function ensureExamRetryRulesContainer() {
  if (!document.getElementById('exam-retry-rules-card')) {
    console.error('Không tìm thấy #exam-retry-rules-card trong admin/exams.html');
  }
}

async function loadExamRetryRules() {
  ensureExamRetryRulesContainer();
  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules?exam_id=eq.${examDetailState.examId}` +
      `&select=id,min_score_pct,max_score_pct,retry_after_days&order=min_score_pct.asc`,
      { headers }
    );
    if (!res.ok) throw new Error(`Lỗi tải cấu hình nhắc làm lại (HTTP ${res.status})`);
    examDetailState.retryRules = await res.json();
  } catch (err) {
    console.error('Lỗi tải exam_retry_rules:', err);
    examDetailState.retryRules = [];
  }
  renderExamRetryRulesCard();
}

// Bấm vào tiêu đề card để mở/thu gọn — mặc định đóng, chỉ hiện 1 dòng
// tóm tắt cho tới khi admin chủ động bấm vào xem/sửa.
function toggleExamRetryRulesExpanded() {
  examDetailState.retryRulesExpanded = !examDetailState.retryRulesExpanded;
  // Thu gọn lại thì đóng luôn form đang mở (nếu có), tránh trạng thái lửng lơ.
  if (!examDetailState.retryRulesExpanded) {
    examDetailState.retryRuleFormOpen = false;
    examDetailState.retryRuleEditingId = null;
  }
  renderExamRetryRulesCard();
}

function renderExamRetryRulesCard() {
  const card = document.getElementById('exam-retry-rules-card');
  if (!card) return;

  const rules = examDetailState.retryRules || [];
  const expanded = examDetailState.retryRulesExpanded;
  const retryDisabled = examDetailState.exam && examDetailState.exam.retry_disabled === true;

  const summaryText = retryDisabled
    ? 'Đề này đã tắt — không bao giờ tính ngày làm lại'
    : rules.length
      ? `${rules.length} khoảng điểm riêng đã cấu hình`
      : `dùng rule mặc định: ${defaultRetryRuleHintText()}`;

  // ── Header luôn hiện, bấm vào để mở/thu gọn (giống card rule mặc định) ──
  const headerHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;"
      onclick="toggleExamRetryRulesExpanded()">
      <div style="font-weight:600; font-size:14px;">
        <i class="ti ti-chevron-${expanded ? 'down' : 'right'}" style="vertical-align:middle;"></i>
        🔁 Cấu hình nhắc làm lại
        <span style="font-weight:400; color:var(--ink-soft); font-size:12px;">(tùy chọn)</span>
      </div>
    </div>
    <div style="font-size:12px; color:var(--ink-soft); margin-top:4px; padding-left:22px;">${summaryText}</div>
  `;

  if (!expanded) {
    card.innerHTML = headerHtml;
    return;
  }

  // ── Nội dung chỉ render khi đã mở ──
  const rowsHtml = rules.length
    ? rules.map(r => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border:1px solid var(--border-md); border-radius:8px; margin-bottom:6px;">
        <div style="font-size:13px;">
          <strong>${r.min_score_pct}% – ${r.max_score_pct}%</strong>
          <span style="color:var(--ink-soft);"> → ${r.retry_after_days == null ? 'Không cần làm lại' : `chờ ${r.retry_after_days} ngày`}</span>
        </div>
        <div style="display:flex; gap:4px;">
          <button type="button" class="admin-row-action-btn" title="Sửa khoảng điểm này"
            onclick="event.stopPropagation(); openExamRetryRuleForm('${escHtml(r.id)}')">
            <i class="ti ti-pencil"></i>
          </button>
          <button type="button" class="admin-row-action-btn" title="Xóa khoảng điểm này"
            onclick="event.stopPropagation(); deleteExamRetryRule('${escHtml(r.id)}')" style="color:var(--vermillion);">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </div>
    `).join('')
    : `<div class="empty-state" style="padding:8px 0;">Đề này dùng rule mặc định: ${defaultRetryRuleHintText()}.</div>`;

  const formHtml = examDetailState.retryRuleFormOpen ? renderExamRetryRuleFormHtml() : '';

  card.innerHTML = `
    ${headerHtml}
    <div style="margin-top:10px;">
      <div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
        <button type="button" class="btn btn-outline" style="padding:4px 10px; font-size:12px;"
          onclick="event.stopPropagation(); openExamRetryRuleForm(null)">
          <i class="ti ti-plus"></i> Thêm khoảng điểm
        </button>
      </div>
      ${rowsHtml}
      ${formHtml}
    </div>
  `;
}

// Sinh HTML form (dùng chung cho cả "Thêm mới" và "Sửa") — đọc
// examDetailState.retryRuleEditingId để biết đang sửa dòng nào, tự
// điền sẵn giá trị cũ nếu có.
function renderExamRetryRuleFormHtml() {
  const editingId = examDetailState.retryRuleEditingId;
  const editingRule = editingId ? (examDetailState.retryRules || []).find(r => r.id === editingId) : null;
  const isEdit = !!editingRule;

  return `
    <form id="retry-rule-form" onsubmit="submitExamRetryRuleForm(event)"
      style="margin-top:10px; padding:12px; border:1px dashed var(--border-md); border-radius:8px;">
      <div id="retry-rule-form-error" style="color:var(--vermillion); font-size:12px; margin-bottom:8px;"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div>
          <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:4px;">Từ % điểm</label>
          <input type="number" id="retry-rule-min" min="0" max="100" step="1" required style="width:80px;"
            value="${isEdit ? editingRule.min_score_pct : ''}" />
        </div>
        <div>
          <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:4px;">Đến % điểm</label>
          <input type="number" id="retry-rule-max" min="0" max="100" step="1" required style="width:80px;"
            value="${isEdit ? editingRule.max_score_pct : ''}" />
        </div>
        <div>
          <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:4px;">Số ngày chờ</label>
          <input type="number" id="retry-rule-days" min="1" step="1" style="width:120px;"
            placeholder="Để trống = ko cần"
            value="${isEdit && editingRule.retry_after_days != null ? editingRule.retry_after_days : ''}" />
        </div>
        <button type="submit" class="btn btn-outline" id="retry-rule-submit-btn">${isEdit ? 'Cập nhật' : 'Lưu'}</button>
        <button type="button" class="btn btn-outline" onclick="closeExamRetryRuleForm()">Hủy</button>
      </div>
    </form>
  `;
}

function openExamRetryRuleForm(ruleId) {
  examDetailState.retryRuleFormOpen = true;
  examDetailState.retryRuleEditingId = ruleId; // null = thêm mới, có id = sửa dòng đó
  renderExamRetryRulesCard();
}

function closeExamRetryRuleForm() {
  examDetailState.retryRuleFormOpen = false;
  examDetailState.retryRuleEditingId = null;
  renderExamRetryRulesCard();
}

async function submitExamRetryRuleForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('retry-rule-form-error');
  const submitBtn = document.getElementById('retry-rule-submit-btn');
  errorEl.textContent = '';

  const min = parseInt(document.getElementById('retry-rule-min').value, 10);
  const max = parseInt(document.getElementById('retry-rule-max').value, 10);
  const daysRaw = document.getElementById('retry-rule-days').value.trim();
  // Để trống ô "Số ngày chờ" -> retry_after_days = null, nghĩa là band điểm
  // này KHÔNG CẦN LÀM LẠI (khác với việc không có rule nào khớp).
  const days = daysRaw === '' ? null : parseInt(daysRaw, 10);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    errorEl.textContent = 'Vui lòng nhập đầy đủ khoảng % điểm.';
    return;
  }
  if (min < 0 || max > 100 || min > max) {
    errorEl.textContent = 'Khoảng % điểm không hợp lệ (0-100, "Từ" phải ≤ "Đến").';
    return;
  }
  if (days !== null && (!Number.isFinite(days) || days <= 0)) {
    errorEl.textContent = 'Số ngày chờ phải là số lớn hơn 0, hoặc để trống nếu không cần làm lại.';
    return;
  }

  const isEdit = !!examDetailState.retryRuleEditingId;

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = isEdit ? 'Đang cập nhật...' : 'Đang lưu...';

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });
    const res = isEdit
      ? await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules?id=eq.${examDetailState.retryRuleEditingId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ min_score_pct: min, max_score_pct: max, retry_after_days: days })
        })
      : await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules`, {
          method: 'POST', headers,
          body: JSON.stringify({
            exam_id: examDetailState.examId,
            min_score_pct: min,
            max_score_pct: max,
            retry_after_days: days
          })
        });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi lưu khoảng điểm (HTTP ${res.status})`);
    }

    examDetailState.retryRuleFormOpen = false;
    examDetailState.retryRuleEditingId = null;
    await loadExamRetryRules();
  } catch (err) {
    console.error('Lỗi lưu exam_retry_rules:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu. Vui lòng thử lại.';
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

async function deleteExamRetryRule(ruleId) {
  if (!confirm('Xóa khoảng điểm này khỏi cấu hình nhắc làm lại của đề?')) return;

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_retry_rules?id=eq.${ruleId}`, {
      method: 'DELETE', headers
    });
    if (!res.ok) throw new Error(`Lỗi xóa khoảng điểm (HTTP ${res.status})`);
    await loadExamRetryRules();
  } catch (err) {
    console.error('Lỗi xóa exam_retry_rules:', err);
    alert(err?.message || 'Có lỗi khi xóa. Vui lòng thử lại.');
  }
}

async function loadExamSections() {
  const listEl = document.getElementById('exam-sections-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="empty-state">Đang tải danh sách phần thi...</div>';

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?exam_id=eq.${examDetailState.examId}&select=id,exam_id,skill_id,title,time_limit_seconds,order_index&order=order_index.asc`,
      { headers }
    );
    if (!res.ok) throw new Error(`Lỗi tải danh sách phần thi (HTTP ${res.status})`);

    examDetailState.sections = await res.json();
    await fetchSkillsList(); // đảm bảo cache tên kỹ năng sẵn có để hiển thị
    await loadSubsectionsForSections(headers);
    renderExamSectionsList();
    updateAddSectionButtonState();
  } catch (err) {
    console.error('Lỗi tải danh sách phần thi:', err);
    listEl.innerHTML = '<div class="empty-state">Có lỗi khi tải danh sách phần thi.</div>';
  }
}

// Nạp toàn bộ subsection của các section thuộc đề thi này (1 request, lọc
// theo exam_section_id=in.(...)), rồi đếm số câu hỏi mỗi subsection bằng
// 1 request phụ tới exam_questions (cùng cách đếm client-side như "Số
// section" ở bảng danh sách — đủ dùng ở quy mô admin thao tác thủ công).
async function loadSubsectionsForSections(headers) {
  examDetailState.subsectionsBySection = {};

  const sectionIds = examDetailState.sections.map(s => s.id);
  if (!sectionIds.length) return;

  const subsRes = await fetch(
    `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?exam_section_id=in.(${sectionIds.join(',')})&select=id,exam_section_id,instruction_text,audio_url,order_index&order=order_index.asc`,
    { headers }
  );
  if (!subsRes.ok) throw new Error(`Lỗi tải danh sách dạng bài (HTTP ${subsRes.status})`);
  const subsections = await subsRes.json();

  const subsectionIds = subsections.map(s => s.id);
  let questionCountBySubsection = {};
  if (subsectionIds.length) {
    const qRes = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=in.(${subsectionIds.join(',')})&select=exam_subsection_id`,
      { headers }
    );
    if (qRes.ok) {
      const rows = await qRes.json();
      rows.forEach(r => {
        questionCountBySubsection[r.exam_subsection_id] = (questionCountBySubsection[r.exam_subsection_id] || 0) + 1;
      });
    } else {
      console.error('Lỗi đếm câu hỏi theo dạng bài:', qRes.status);
    }
  }

  subsections.forEach(sub => {
    sub.questionCount = questionCountBySubsection[sub.id] || 0;
    if (!examDetailState.subsectionsBySection[sub.exam_section_id]) {
      examDetailState.subsectionsBySection[sub.exam_section_id] = [];
    }
    examDetailState.subsectionsBySection[sub.exam_section_id].push(sub);
  });
}

function skillNameById(skillId) {
  const sk = (questionsAdminState.skills || []).find(s => s.id === skillId);
  return sk ? sk.name : `Kỹ năng #${skillId}`;
}

function renderExamSectionsList() {
  const listEl = document.getElementById('exam-sections-list');
  if (!listEl) return;

  const sections = examDetailState.sections;
  if (!sections.length) {
    listEl.innerHTML = '<div class="empty-state">Chưa có phần thi nào. Bấm "Thêm phần" để bắt đầu.</div>';
    return;
  }

  listEl.innerHTML = sections.map((sec, idx) => `
    <div class="admin-panel-card" style="margin-bottom:10px; padding:12px 16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div>
          <div style="font-weight:600;">${escHtml(sec.title || skillNameById(sec.skill_id))}</div>
          <div style="font-size:12px; color:var(--ink-soft);">
            ${escHtml(skillNameById(sec.skill_id))} · ${Math.round(sec.time_limit_seconds / 60)} phút
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:4px;">
          <button type="button" class="admin-row-action-btn" title="Sửa phần thi"
            onclick="openSectionForm(examDetailState.sections.find(s => s.id === '${escHtml(sec.id)}'))">
            <i class="ti ti-pencil"></i>
          </button>
          <button type="button" class="admin-row-action-btn" title="Đưa lên trên"
            onclick="moveExamSection('${escHtml(sec.id)}', -1)" ${idx === 0 ? 'disabled' : ''}>
            <i class="ti ti-chevron-up"></i>
          </button>
          <button type="button" class="admin-row-action-btn" title="Đưa xuống dưới"
            onclick="moveExamSection('${escHtml(sec.id)}', 1)" ${idx === sections.length - 1 ? 'disabled' : ''}>
            <i class="ti ti-chevron-down"></i>
          </button>
          <button type="button" class="admin-row-action-btn" title="Xóa phần thi"
            onclick="deleteExamSection('${escHtml(sec.id)}')" style="color:var(--vermillion);">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </div>

      <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border-md);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-size:13px; font-weight:600; color:var(--ink-soft);">Dạng bài</span>
          <button type="button" class="btn btn-outline" style="padding:4px 10px; font-size:12px;"
            onclick="openSubsectionForm('${escHtml(sec.id)}')">
            <i class="ti ti-plus"></i> Thêm dạng bài
          </button>
        </div>
        ${renderSubsectionsForSection(sec.id)}
      </div>
    </div>
  `).join('');
}

function renderSubsectionsForSection(sectionId) {
  const subs = examDetailState.subsectionsBySection[sectionId] || [];
  if (!subs.length) {
    return '<div class="empty-state" style="padding:10px 0;">Chưa có dạng bài nào trong phần này.</div>';
  }

  return subs.map((sub, idx) => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; ${idx > 0 ? 'border-top:1px solid var(--border-md);' : ''}">
      <div style="min-width:0;">
        <div style="font-size:13px;">${escHtml(truncateText(sub.instruction_text, 80))}</div>
        <div style="font-size:12px; color:var(--ink-soft);">
          ${sub.questionCount} câu hỏi đã chọn${sub.audio_url ? ' · <i class="ti ti-volume" title="Đã có audio"></i> Có audio' : ''}
        </div>
        <!-- TODO: sắp xếp thứ tự câu hỏi trong subsection, để bổ sung sau.
             Sẽ cần: (1) fetch exam_questions join question_bank theo
             order_index, (2) UI danh sách rút gọn từng câu, (3) nút ▲▼
             hoán đổi order_index — giống hệt pattern moveExamSubsection(). -->
      </div>
      <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
        <button type="button" class="admin-row-action-btn" title="Xem danh sách câu hỏi đã chọn"
          onclick="openSubsectionQuestionList('${escHtml(sub.id)}')" ${sub.questionCount === 0 ? 'disabled' : ''}>
          <i class="ti ti-list-details"></i>
        </button>
        <button type="button" class="admin-row-action-btn" title="Chọn câu hỏi"
          onclick="openQuestionPicker('${escHtml(sub.id)}')">
          <i class="ti ti-list-check"></i>
        </button>
        <button type="button" class="admin-row-action-btn" title="Sửa dạng bài"
          onclick="openSubsectionForm('${escHtml(sectionId)}', examDetailState.subsectionsBySection['${escHtml(sectionId)}'].find(s => s.id === '${escHtml(sub.id)}'))">
          <i class="ti ti-pencil"></i>
        </button>
        <button type="button" class="admin-row-action-btn" title="Đưa lên trên"
          onclick="moveExamSubsection('${escHtml(sub.id)}', -1)" ${idx === 0 ? 'disabled' : ''}>
          <i class="ti ti-chevron-up"></i>
        </button>
        <button type="button" class="admin-row-action-btn" title="Đưa xuống dưới"
          onclick="moveExamSubsection('${escHtml(sub.id)}', 1)" ${idx === subs.length - 1 ? 'disabled' : ''}>
          <i class="ti ti-chevron-down"></i>
        </button>
        <button type="button" class="admin-row-action-btn" title="Xóa dạng bài"
          onclick="deleteExamSubsection('${escHtml(sub.id)}')" style="color:var(--vermillion);">
          <i class="ti ti-trash"></i>
        </button>
      </div>
    </div>
  `).join('');
}

// exam_type = 'skill' -> chỉ được đúng 1 section. Disable nút "Thêm phần"
// (không ẩn hẳn, để admin vẫn thấy rõ vì sao không thêm được nữa).
function updateAddSectionButtonState() {
  const btn = document.getElementById('btn-add-section');
  const hint = document.getElementById('section-add-limit-hint');
  const isSkillExam = examDetailState.exam?.exam_type === 'skill';
  const reachedLimit = isSkillExam && examDetailState.sections.length >= 1;

  if (btn) btn.disabled = reachedLimit;
  if (hint) hint.style.display = reachedLimit ? 'block' : 'none';
}

// ── Đổi thứ tự section (▲▼) ─────────────────────────────────────────
// Đơn giản: hoán đổi order_index giữa 2 section liền kề trong mảng đã
// sắp xếp sẵn (không cần tính lại toàn bộ danh sách).
async function moveExamSection(sectionId, direction) {
  const sections = examDetailState.sections;
  const idx = sections.findIndex(s => s.id === sectionId);
  if (idx === -1) return;

  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= sections.length) return;

  const current = sections[idx];
  const target = sections[targetIdx];

  try {
    const headers = await sbAuthedHeaders();
    await Promise.all([
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?id=eq.${current.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ order_index: target.order_index })
      }),
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?id=eq.${target.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ order_index: current.order_index })
      })
    ]);
    await loadExamSections();
  } catch (err) {
    console.error('Lỗi đổi thứ tự phần thi:', err);
    alert('Có lỗi khi đổi thứ tự phần thi. Vui lòng thử lại.');
  }
}

// ── Xóa section — CASCADE xóa cả subsection + exam_questions bên trong ──
async function deleteExamSection(sectionId) {
  const confirmed = confirm(
    'Xóa phần thi này sẽ xóa CẢ các subsection và toàn bộ câu hỏi đã gắn bên trong (không thể khôi phục). Bạn có chắc chắn muốn xóa?'
  );
  if (!confirmed) return;

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?id=eq.${sectionId}`, {
      method: 'DELETE', headers
    });
    if (!res.ok) throw new Error(`Lỗi xóa phần thi (HTTP ${res.status})`);

    await loadExamSections();
    await loadExamAdminList(); // cập nhật lại cột "Số section" ở bảng danh sách
  } catch (err) {
    console.error('Lỗi xóa phần thi:', err);
    alert('Có lỗi khi xóa phần thi. Vui lòng thử lại.');
  }
}

// ── Form tạo phần thi (section) ─────────────────────────────────────
// Bước hiện tại: CHỈ tạo mới (chưa làm sửa section, chỉ xóa + đổi thứ tự).
let sectionTitleTouchedByUser = false;
const sectionFormState = { mode: 'create', editingId: null };

// row = null -> tạo mới. Truyền row (từ examDetailState.sections) -> sửa.
async function openSectionForm(row = null) {
  const form = document.getElementById('section-form');
  if (form) form.reset();
  document.getElementById('section-form-error').textContent = '';
  sectionTitleTouchedByUser = false;

  const skillSelect = document.getElementById('section-skill');
  const titleEl = document.getElementById('section-form-title');
  const submitBtn = document.getElementById('section-form-submit-btn');
  const lockHint = document.getElementById('section-skill-lock-hint');

  try {
    const skills = await fetchSkillsList();
    skillSelect.innerHTML = '<option value="">— Chọn kỹ năng —</option>' +
      skills.map(sk => `<option value="${sk.id}">${escHtml(sk.name)}</option>`).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách kỹ năng cho form phần thi:', err);
  }

  if (row) {
    sectionFormState.mode = 'edit';
    sectionFormState.editingId = row.id;
    if (titleEl) titleEl.textContent = 'Sửa phần thi';
    if (submitBtn) submitBtn.textContent = 'Cập nhật phần thi';
    sectionTitleTouchedByUser = true; // đã có tiêu đề cũ -> không tự điền đè khi sửa

    skillSelect.value = String(row.skill_id);
    skillSelect.disabled = false; // luôn cho sửa — xem lý do ở comment dưới

    // TRƯỚC ĐÂY: khóa cứng dropdown khi section đã có câu hỏi, với giả định
    // "section + câu hỏi bên trong đang khớp skill, đừng đổi kẻo lệch".
    // Giả định này chỉ đúng tại thời điểm CHỌN câu hỏi (modal lọc theo
    // đúng skill_id của section). Nhưng sau đó admin vẫn có thể tự đổi
    // question_bank.skill_id của từng câu ở tab Câu hỏi — lúc đó sai lệch
    // đã xảy ra RỒI, không liên quan gì đến việc section có bị khóa hay
    // không. Khóa cứng chỉ chặn nhầm chỗ: nó ngăn admin sửa LẠI cho khớp
    // từ phía section, trong khi bất lực trước nguồn gây lệch thật sự.
    // -> Đổi thành cảnh báo mềm (không chặn), để admin tự quyết định.
    const subsectionsOfSection = examDetailState.subsectionsBySection?.[row.id] || [];
    const totalQuestionsInSection = subsectionsOfSection.reduce((sum, sub) => sum + (sub.questionCount || 0), 0);

    if (totalQuestionsInSection > 0) {
      if (lockHint) {
        lockHint.textContent = `⚠️ Phần thi này đang có ${totalQuestionsInSection} câu hỏi bên trong. Đổi kỹ năng ở đây KHÔNG tự động cập nhật kỹ năng của từng câu hỏi đã chọn (2 dữ liệu độc lập) — hãy vào tab Câu hỏi kiểm tra/sửa lại kỹ năng từng câu cho khớp sau khi đổi, nếu cần.`;
        lockHint.style.display = 'block';
      }
    } else {
      skillSelect.disabled = false;
      if (lockHint) lockHint.style.display = 'none';
    }

    document.getElementById('section-title').value = row.title || '';
    document.getElementById('section-minutes').value = Math.round(row.time_limit_seconds / 60);
  } else {
    sectionFormState.mode = 'create';
    sectionFormState.editingId = null;
    if (titleEl) titleEl.textContent = 'Thêm phần thi';
    if (submitBtn) submitBtn.textContent = 'Lưu phần thi';
    skillSelect.disabled = false;
    if (lockHint) lockHint.style.display = 'none';
  }

  document.getElementById('section-form-overlay').style.display = 'block';
  document.getElementById('section-form-panel').style.display = 'flex';
}

function closeSectionForm() {
  document.getElementById('section-form-overlay').style.display = 'none';
  document.getElementById('section-form-panel').style.display = 'none';
}

async function submitSectionForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('section-form-error');
  const submitBtn = document.getElementById('section-form-submit-btn');
  errorEl.textContent = '';

  const isEdit = sectionFormState.mode === 'edit' && sectionFormState.editingId !== null;
  const skillId = document.getElementById('section-skill').value;
  const title = document.getElementById('section-title').value.trim();
  const minutesRaw = document.getElementById('section-minutes').value;
  const minutes = parseInt(minutesRaw, 10);

  if (!skillId) {
    errorEl.textContent = 'Vui lòng chọn kỹ năng cho phần thi này.';
    return;
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    errorEl.textContent = 'Vui lòng nhập thời gian làm bài hợp lệ (số phút > 0).';
    return;
  }
  // exam_type = 'skill' chỉ được 1 section — chỉ áp dụng khi TẠO MỚI, sửa
  // section đã có sẵn không tính là thêm section mới nên bỏ qua check này.
  if (!isEdit && examDetailState.exam?.exam_type === 'skill' && examDetailState.sections.length >= 1) {
    errorEl.textContent = 'Đề loại "skill" chỉ được có 1 phần thi duy nhất.';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });

    const res = isEdit
      ? await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?id=eq.${sectionFormState.editingId}`, {
          method: 'PATCH', headers,
          // skill_id giờ CÓ THỂ đổi khi sửa (đã bỏ khóa cứng UI — xem
          // openSectionForm()), chỉ còn KHÔNG đổi order_index (giữ nguyên
          // vị trí hiện tại trong danh sách section).
          body: JSON.stringify({ skill_id: parseInt(skillId, 10), title: title || null, time_limit_seconds: minutes * 60 })
        })
      : await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections`, {
          method: 'POST', headers,
          body: JSON.stringify({
            exam_id: examDetailState.examId,
            skill_id: parseInt(skillId, 10),
            title: title || null,
            time_limit_seconds: minutes * 60,
            order_index: examDetailState.sections.length // thêm vào cuối danh sách hiện có
          })
        });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi lưu phần thi (HTTP ${res.status})`);
    }

    await loadExamSections();
    await loadExamAdminList(); // cập nhật lại cột "Số section" ở bảng danh sách
    closeSectionForm();
  } catch (err) {
    console.error('Lỗi lưu phần thi:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu phần thi. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// Tự điền tiêu đề theo tên kỹ năng khi chọn dropdown — chỉ tự điền nếu
// admin chưa tự tay gõ gì vào ô tiêu đề (tránh ghi đè nội dung họ đã sửa).
function onSectionSkillChange() {
  if (sectionTitleTouchedByUser) return;
  const skillSelect = document.getElementById('section-skill');
  const titleInput = document.getElementById('section-title');
  const skill = (questionsAdminState.skills || []).find(s => String(s.id) === skillSelect.value);
  if (skill && titleInput) titleInput.value = skill.name;
}

// ── Đổi thứ tự dạng bài (▲▼) trong cùng 1 section ──────────────────
async function moveExamSubsection(subsectionId, direction) {
  // Tìm subsection đang thao tác thuộc section nào để lấy đúng mảng thứ tự.
  const sectionId = Object.keys(examDetailState.subsectionsBySection)
    .find(sid => examDetailState.subsectionsBySection[sid].some(s => s.id === subsectionId));
  if (!sectionId) return;

  const subs = examDetailState.subsectionsBySection[sectionId];
  const idx = subs.findIndex(s => s.id === subsectionId);
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= subs.length) return;

  const current = subs[idx];
  const target = subs[targetIdx];

  try {
    const headers = await sbAuthedHeaders();
    await Promise.all([
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?id=eq.${current.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ order_index: target.order_index })
      }),
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?id=eq.${target.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ order_index: current.order_index })
      })
    ]);
    await loadExamSections();
  } catch (err) {
    console.error('Lỗi đổi thứ tự dạng bài:', err);
    alert('Có lỗi khi đổi thứ tự dạng bài. Vui lòng thử lại.');
  }
}

// ── Xóa subsection — CASCADE xóa cả exam_questions bên trong ──────────
async function deleteExamSubsection(subsectionId) {
  const confirmed = confirm(
    'Xóa dạng bài này sẽ xóa CẢ các câu hỏi đã gắn bên trong (không thể khôi phục). Bạn có chắc chắn muốn xóa?'
  );
  if (!confirmed) return;

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?id=eq.${subsectionId}`, {
      method: 'DELETE', headers
    });
    if (!res.ok) throw new Error(`Lỗi xóa dạng bài (HTTP ${res.status})`);

    await loadExamSections();
  } catch (err) {
    console.error('Lỗi xóa dạng bài:', err);
    alert('Có lỗi khi xóa dạng bài. Vui lòng thử lại.');
  }
}

// ── Form tạo dạng bài (subsection) ─────────────────────────────────
// Bước hiện tại: CHỈ tạo mới (chưa làm sửa, chỉ xóa + đổi thứ tự) —
// giống đúng pattern của form section.
const subsectionFormState = { targetSectionId: null, audioUploading: false, mode: 'create', editingId: null };

// sectionId luôn cần (để biết audio hiện/ẩn theo skill), row (từ
// examDetailState.subsectionsBySection) truyền vào -> mode sửa.
function openSubsectionForm(sectionId, row = null) {
  subsectionFormState.targetSectionId = sectionId;

  const form = document.getElementById('subsection-form');
  if (form) form.reset();
  document.getElementById('subsection-form-error').textContent = '';
  resetSubsectionAudioState();

  const section = examDetailState.sections.find(s => s.id === sectionId);
  const skill = (questionsAdminState.skills || []).find(sk => sk.id === section?.skill_id);
  toggleSubsectionAudioVisibility(skill?.code === LISTENING_SKILL_CODE);

  const titleEl = document.getElementById('subsection-form-heading');
  const submitBtn = document.getElementById('subsection-form-submit-btn');

  if (row) {
    subsectionFormState.mode = 'edit';
    subsectionFormState.editingId = row.id;
    if (titleEl) titleEl.textContent = 'Sửa dạng bài';
    if (submitBtn) submitBtn.textContent = 'Cập nhật dạng bài';

    document.getElementById('subsection-instruction').value = row.instruction_text || '';
    if (row.audio_url) {
      document.getElementById('subsection-audio-url').value = row.audio_url;
      const preview = document.getElementById('subsection-audio-preview');
      if (preview) { preview.src = row.audio_url; preview.style.display = 'block'; }
      const statusEl = document.getElementById('subsection-audio-status');
      if (statusEl) { statusEl.textContent = 'Audio hiện có — chọn file khác nếu muốn thay.'; statusEl.style.color = ''; }
    }
  } else {
    subsectionFormState.mode = 'create';
    subsectionFormState.editingId = null;
    if (titleEl) titleEl.textContent = 'Thêm dạng bài';
    if (submitBtn) submitBtn.textContent = 'Lưu dạng bài';
  }

  document.getElementById('subsection-form-overlay').style.display = 'block';
  document.getElementById('subsection-form-panel').style.display = 'flex';
}

function toggleSubsectionAudioVisibility(shouldShow) {
  const group = document.getElementById('subsection-audio-group');
  if (group) group.style.display = shouldShow ? 'block' : 'none';
}

function resetSubsectionAudioState() {
  const fileInput = document.getElementById('subsection-audio-file');
  if (fileInput) fileInput.value = '';
  document.getElementById('subsection-audio-url').value = '';
  const statusEl = document.getElementById('subsection-audio-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }
  const preview = document.getElementById('subsection-audio-preview');
  if (preview) { preview.style.display = 'none'; preview.removeAttribute('src'); }
}

function closeSubsectionForm() {
  document.getElementById('subsection-form-overlay').style.display = 'none';
  document.getElementById('subsection-form-panel').style.display = 'none';
  subsectionFormState.targetSectionId = null;
}

async function submitSubsectionForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('subsection-form-error');
  const submitBtn = document.getElementById('subsection-form-submit-btn');
  errorEl.textContent = '';

  const isEdit = subsectionFormState.mode === 'edit' && subsectionFormState.editingId !== null;
  const instructionText = document.getElementById('subsection-instruction').value.trim();
  const audioUrl = document.getElementById('subsection-audio-url').value || null;

  if (subsectionFormState.audioUploading) {
    errorEl.textContent = 'File audio đang được tải lên, vui lòng đợi upload xong rồi mới bấm Lưu.';
    return;
  }
  if (!instructionText) {
    errorEl.textContent = 'Vui lòng nhập hướng dẫn làm bài cho dạng bài này.';
    return;
  }
  if (!subsectionFormState.targetSectionId) {
    errorEl.textContent = 'Không xác định được phần thi để thêm dạng bài. Vui lòng thử lại.';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });

    const res = isEdit
      ? await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections?id=eq.${subsectionFormState.editingId}`, {
          method: 'PATCH', headers,
          // Sửa chỉ đổi instruction/audio, KHÔNG đổi order_index (giữ nguyên vị trí).
          body: JSON.stringify({ instruction_text: instructionText, audio_url: audioUrl })
        })
      : await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_subsections`, {
          method: 'POST', headers,
          body: JSON.stringify({
            exam_section_id: subsectionFormState.targetSectionId,
            instruction_text: instructionText,
            audio_url: audioUrl,
            order_index: (examDetailState.subsectionsBySection[subsectionFormState.targetSectionId] || []).length
          })
        });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi lưu dạng bài (HTTP ${res.status})`);
    }

    await loadExamSections();
    closeSubsectionForm();
  } catch (err) {
    console.error('Lỗi lưu dạng bài:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu dạng bài. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// ── Form tạo / sửa thông tin đề thi ─────────────────────────────────
const examFormState = {
  mode: 'create',   // 'create' | 'edit'
  editingId: null
};

function resetExamForm() {
  const form = document.getElementById('exam-form');
  if (form) form.reset();
  document.getElementById('exam-form-error').textContent = '';
  document.getElementById('exam-pass-threshold').value = 70;
  document.getElementById('exam-retry-disabled').checked = false;
  const availableFromEl = document.getElementById('exam-available-from');
  if (availableFromEl) availableFromEl.value = '';
}

function populateExamFormFromRow(row) {
  document.getElementById('exam-title').value = row.title || '';
  document.getElementById('exam-type').value = row.exam_type || 'full';
  document.getElementById('exam-pass-threshold').value = row.pass_threshold_pct ?? 70;
  document.getElementById('exam-retry-disabled').checked = row.retry_disabled === true;
  // available_from là date (yyyy-mm-dd) từ Postgres -> khớp thẳng với input type="date",
  // không cần format lại. null/undefined -> để trống (hiện ngay).
  const availableFromEl = document.getElementById('exam-available-from');
  if (availableFromEl) availableFromEl.value = row.available_from || '';
}

// row = null -> mode TẠO MỚI. Truyền row (từ examAdminState.rows) -> mode SỬA.
function openExamForm(row = null) {
  resetExamForm();

  const titleEl = document.getElementById('exam-form-title');

  if (row) {
    examFormState.mode = 'edit';
    examFormState.editingId = row.id;
    if (titleEl) titleEl.textContent = 'Sửa đề thi';
    populateExamFormFromRow(row);
  } else {
    examFormState.mode = 'create';
    examFormState.editingId = null;
    if (titleEl) titleEl.textContent = 'Tạo đề thi';
  }

  document.getElementById('exam-form-overlay').style.display = 'block';
  document.getElementById('exam-form-panel').style.display = 'flex';
}

function closeExamForm() {
  document.getElementById('exam-form-overlay').style.display = 'none';
  document.getElementById('exam-form-panel').style.display = 'none';
  resetExamForm();
}

async function submitExamForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('exam-form-error');
  const draftBtn = document.getElementById('exam-form-draft-btn');
  const publishBtn = document.getElementById('exam-form-publish-btn');
  errorEl.textContent = '';

  // e.submitter cho biết nút nào (Draft hay Publish) được bấm để trigger
  // submit -> quyết định is_published, không cần checkbox/toggle riêng.
  const clickedId = e.submitter?.id;
  if (clickedId !== 'exam-form-draft-btn' && clickedId !== 'exam-form-publish-btn') return;
  const isPublished = clickedId === 'exam-form-publish-btn';

  const title = document.getElementById('exam-title').value.trim();
  const examType = document.getElementById('exam-type').value;
  const passThreshold = parseInt(document.getElementById('exam-pass-threshold').value, 10);
  const retryDisabled = document.getElementById('exam-retry-disabled').checked;
  // Input type="date" trả về '' khi để trống -> chuyển thành null để lưu
  // "hiện ngay" (không giới hạn ngày mở khóa) đúng theo yêu cầu.
  const availableFromRaw = document.getElementById('exam-available-from')?.value || '';
  const availableFrom = availableFromRaw || null;

  if (!title) {
    errorEl.textContent = 'Vui lòng nhập tên đề thi.';
    return;
  }
  if (examType !== 'full' && examType !== 'skill') {
    errorEl.textContent = 'Loại đề thi không hợp lệ.';
    return;
  }
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 100) {
    errorEl.textContent = 'Ngưỡng đạt phải là số nguyên từ 0 đến 100.';
    return;
  }

  draftBtn.disabled = true;
  publishBtn.disabled = true;
  const clickedBtn = e.submitter;
  const originalText = clickedBtn.innerHTML;
  clickedBtn.innerHTML = 'Đang lưu...';

  const isEdit = examFormState.mode === 'edit' && examFormState.editingId !== null;

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });

    const payload = {
      title,
      exam_type: examType,
      pass_threshold_pct: passThreshold,
      retry_disabled: retryDisabled,
      is_published: isPublished,
      available_from: availableFrom,
      updated_at: new Date().toISOString()
    };
    // created_by chỉ set lúc tạo mới — không đụng vào khi sửa đề đã có.
    if (!isEdit) payload.created_by = currentAdmin?.id || null;

    const body = JSON.stringify(payload);

    const res = isEdit
      ? await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams?id=eq.${examFormState.editingId}`, {
          method: 'PATCH', headers, body
        })
      : await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams`, {
          method: 'POST', headers, body
        });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.message || `Lỗi lưu đề thi (HTTP ${res.status})`);
    }

    await loadExamAdminList();

    // Dropdown "Chọn đề thi" bên tab Câu hỏi (fetchExamsList() trong
    // questions.js) cache danh sách đề vĩnh viễn trong session (examLinkState.
    // examsLoaded), không tự biết đề vừa được tạo/sửa ở đây. Cả 2 file cùng
    // load vào 1 window nên examLinkState là biến global — reset cờ để lần
    // mở dropdown tiếp theo tự fetch lại danh sách mới nhất.
    if (typeof examLinkState !== 'undefined') {
      examLinkState.examsLoaded = false;
    }

    closeExamForm();
  } catch (err) {
    console.error('Lỗi lưu đề thi:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu đề thi. Vui lòng thử lại.';
  } finally {
    draftBtn.disabled = false;
    publishBtn.disabled = false;
    clickedBtn.innerHTML = originalText;
  }
}

// Gắn sự kiện cho form — gọi 1 lần ngay sau khi fragment được inject
// (không thể addEventListener lúc DOMContentLoaded vì lúc đó form chưa tồn
// tại trong DOM, nó chỉ có sau khi ensureExamsFragmentLoaded() chạy xong).
// ── Modal chọn câu hỏi cho 1 dạng bài (exam_questions) ───────────────
const questionPickerState = {
  subsectionId: null,
  skillId: null,
  allQuestions: [],       // toàn bộ câu hỏi của đúng skill_id (question_bank)
  existingIds: new Set(), // question_id đã có sẵn trong exam_questions của subsection này (lúc mở modal)
  selectedIds: new Set()  // trạng thái tick hiện tại trên UI (thay đổi theo checkbox)
};

// Tìm section (id) đang chứa subsection này — dò qua subsectionsBySection,
// vì subsection không lưu trực tiếp thông tin section trong state hiển thị.
function findSectionIdForSubsection(subsectionId) {
  return Object.keys(examDetailState.subsectionsBySection)
    .find(sid => examDetailState.subsectionsBySection[sid].some(s => s.id === subsectionId));
}

async function openQuestionPicker(subsectionId) {
  const sectionId = findSectionIdForSubsection(subsectionId);
  const section = examDetailState.sections.find(s => s.id === sectionId);
  if (!section) {
    alert('Không xác định được kỹ năng của phần thi chứa dạng bài này.');
    return;
  }

  questionPickerState.subsectionId = subsectionId;
  questionPickerState.skillId = section.skill_id;
  questionPickerState.allQuestions = [];
  questionPickerState.existingIds = new Set();
  questionPickerState.selectedIds = new Set();

  document.getElementById('question-picker-search').value = '';
  document.getElementById('question-picker-error').textContent = '';
  document.getElementById('question-picker-skill-hint').textContent =
    `Chỉ hiện câu hỏi thuộc kỹ năng: ${skillNameById(section.skill_id)}`;
  document.getElementById('question-picker-list').innerHTML = '<div class="empty-state">Đang tải câu hỏi...</div>';

  document.getElementById('question-picker-overlay').style.display = 'block';
  document.getElementById('question-picker-panel').style.display = 'flex';

  try {
    const headers = await sbAuthedHeaders();

    const [questionsRes, existingRes] = await Promise.all([
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?skill_id=eq.${section.skill_id}&select=id,question_text,correct_answer,explanation,audio_url&order=created_at.desc`, { headers }),
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=eq.${subsectionId}&select=question_id`, { headers })
    ]);

    if (!questionsRes.ok) throw new Error(`Lỗi tải ngân hàng câu hỏi (HTTP ${questionsRes.status})`);
    if (!existingRes.ok) throw new Error(`Lỗi tải câu hỏi đã chọn (HTTP ${existingRes.status})`);

    questionPickerState.allQuestions = await questionsRes.json();
    const existingRows = await existingRes.json();
    questionPickerState.existingIds = new Set(existingRows.map(r => r.question_id));
    questionPickerState.selectedIds = new Set(questionPickerState.existingIds); // tick sẵn câu đã có

    renderQuestionPickerList('');
  } catch (err) {
    console.error('Lỗi mở modal chọn câu hỏi:', err);
    document.getElementById('question-picker-list').innerHTML =
      '<div class="empty-state">Có lỗi khi tải câu hỏi.</div>';
  }
}

function closeQuestionPicker() {
  document.getElementById('question-picker-overlay').style.display = 'none';
  document.getElementById('question-picker-panel').style.display = 'none';
}

function renderQuestionPickerList(keyword) {
  const listEl = document.getElementById('question-picker-list');
  if (!listEl) return;

  const kw = (keyword || '').trim().toLowerCase();
  const rows = kw
    ? questionPickerState.allQuestions.filter(q => stripHtml(q.question_text).toLowerCase().includes(kw))
    : questionPickerState.allQuestions;

  if (!rows.length) {
    listEl.innerHTML = '<div class="empty-state">Không tìm thấy câu hỏi phù hợp.</div>';
    return;
  }

  listEl.innerHTML = rows.map(q => `
    <label class="question-picker-row">
      <input type="checkbox" data-question-id="${escHtml(q.id)}"
        ${questionPickerState.selectedIds.has(q.id) ? 'checked' : ''}
        onchange="toggleQuestionPickerSelect('${escHtml(q.id)}', this.checked)" />
      <div style="min-width:0;">
        <div style="font-size:13px;">${escHtml(truncateText(stripHtml(q.question_text), 90))}</div>
        <div style="font-size:12px; color:var(--ink-soft); margin-top:2px;">
          Đáp án đúng: ${escHtml(truncateText(String(q.correct_answer || '—'), 40))}
        </div>
        <div class="question-picker-meta">
          <span class="question-picker-tag ${q.explanation ? 'has-feedback' : ''}">
            ${q.explanation ? 'Có feedback' : 'Không feedback'}
          </span>
          <span class="question-picker-tag ${q.audio_url ? 'has-audio' : ''}">
            ${q.audio_url ? 'Có audio' : 'Không audio'}
          </span>
        </div>
      </div>
    </label>
  `).join('');
}

function toggleQuestionPickerSelect(questionId, isChecked) {
  if (isChecked) questionPickerState.selectedIds.add(questionId);
  else questionPickerState.selectedIds.delete(questionId);
}

// So sánh selectedIds (trạng thái tick hiện tại) với existingIds (trạng
// thái lúc mở modal) -> chỉ INSERT câu mới tick, chỉ DELETE câu bị bỏ tick,
// câu không đổi thì bỏ qua hoàn toàn (không đụng vào order_index/points
// đã có của chúng).
async function submitQuestionPicker() {
  const errorEl = document.getElementById('question-picker-error');
  const submitBtn = document.getElementById('question-picker-submit-btn');
  errorEl.textContent = '';

  const toAdd = [...questionPickerState.selectedIds].filter(id => !questionPickerState.existingIds.has(id));
  const toRemove = [...questionPickerState.existingIds].filter(id => !questionPickerState.selectedIds.has(id));

  if (!toAdd.length && !toRemove.length) {
    closeQuestionPicker();
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });
    const subsectionId = questionPickerState.subsectionId;

    // order_index cho câu mới nối tiếp sau số câu đang có sẵn (giữ nguyên
    // câu cũ, không tính lại toàn bộ thứ tự).
    const existingCount = questionPickerState.existingIds.size;

    if (toAdd.length) {
      const insertBody = toAdd.map((qid, i) => ({
        exam_subsection_id: subsectionId,
        question_id: qid,
        order_index: existingCount + i,
        points: 1
      }));
      const insertRes = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions`, {
        method: 'POST', headers, body: JSON.stringify(insertBody)
      });
      if (!insertRes.ok) {
        const errBody = await insertRes.json().catch(() => null);
        throw new Error(errBody?.message || `Lỗi thêm câu hỏi (HTTP ${insertRes.status})`);
      }
    }

    if (toRemove.length) {
      const removeRes = await fetch(
        `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=eq.${subsectionId}&question_id=in.(${toRemove.join(',')})`,
        { method: 'DELETE', headers }
      );
      if (!removeRes.ok) {
        const errBody = await removeRes.json().catch(() => null);
        throw new Error(errBody?.message || `Lỗi bỏ câu hỏi (HTTP ${removeRes.status})`);
      }
    }

    closeQuestionPicker();
    await loadExamSections(); // nạp lại để cập nhật số đếm "N câu hỏi đã chọn"
  } catch (err) {
    console.error('Lỗi lưu danh sách câu hỏi:', err);
    errorEl.textContent = err?.message || 'Có lỗi khi lưu danh sách câu hỏi. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// Upload audio cho 1 dạng bài (Mondai) — cùng bucket exam-audio, cùng
// pattern {uuid}-{filename} như uploadPassageAudioFile() trong questions.js.
// Copy riêng (không import chung hàm) để không tạo phụ thuộc chéo giữa
// exams.js và questions.js ngoài các global helper đã thống nhất dùng chung.
async function uploadSubsectionAudioFile(file) {
  const statusEl = document.getElementById('subsection-audio-status');
  const previewEl = document.getElementById('subsection-audio-preview');
  const hiddenUrlInput = document.getElementById('subsection-audio-url');

  subsectionFormState.audioUploading = true;
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
    console.error('Lỗi upload audio cho dạng bài:', err);
    if (statusEl) {
      statusEl.textContent = `❌ Tải audio thất bại: ${err?.message || 'Lỗi không xác định'}`;
      statusEl.style.color = 'var(--vermillion)';
    }
    if (hiddenUrlInput) hiddenUrlInput.value = '';
  } finally {
    subsectionFormState.audioUploading = false;
  }
}

// ── Panel xem danh sách câu hỏi đã chọn trong 1 subsection (chỉ xem) ──
async function openSubsectionQuestionList(subsectionId) {
  const bodyEl = document.getElementById('subsection-question-list-body');
  bodyEl.innerHTML = '<div class="empty-state">Đang tải...</div>';

  document.getElementById('subsection-question-list-overlay').style.display = 'block';
  document.getElementById('subsection-question-list-panel').style.display = 'flex';

  try {
    const headers = await sbAuthedHeaders();
    // Dùng PostgREST embed để lấy luôn question_text từ question_bank
    // trong 1 request, sắp theo đúng order_index đã lưu.
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_questions?exam_subsection_id=eq.${subsectionId}` +
      `&select=id,order_index,points,question_id,question_bank(question_text)&order=order_index.asc`,
      { headers }
    );
    if (!res.ok) throw new Error(`Lỗi tải danh sách câu hỏi (HTTP ${res.status})`);

    const rows = await res.json();
    if (!rows.length) {
      bodyEl.innerHTML = '<div class="empty-state">Dạng bài này chưa có câu hỏi nào.</div>';
      return;
    }

    bodyEl.innerHTML = rows.map((r, idx) => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 4px; ${idx > 0 ? 'border-top:1px solid var(--border-md);' : ''}">
        <div style="min-width:0;">
          <span style="color:var(--ink-soft); font-size:12px;">#${r.order_index + 1}</span>
          <span style="font-size:13px;">${escHtml(truncateText(stripHtml(r.question_bank?.question_text || ''), 90)) || '<span style="color:var(--ink-soft);">[Hình ảnh]</span>'}</span>
        </div>
        <button type="button" class="btn btn-outline" style="padding:4px 10px; font-size:12px; flex-shrink:0;"
          onclick="jumpToEditQuestion('${escHtml(r.question_id)}')">
          Sửa câu hỏi
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách câu hỏi đã chọn:', err);
    bodyEl.innerHTML = '<div class="empty-state">Có lỗi khi tải danh sách câu hỏi.</div>';
  }
}

function closeSubsectionQuestionList() {
  document.getElementById('subsection-question-list-overlay').style.display = 'none';
  document.getElementById('subsection-question-list-panel').style.display = 'none';
}

// Nhảy sang tab "Câu hỏi" và mở đúng câu hỏi ở mode sửa. Fetch lại row đầy
// đủ trực tiếp từ question_bank (không dựa vào questionsAdminState.currentRows
// đang cache, vì filter/tìm kiếm hiện tại ở tab Câu hỏi có thể không chứa
// đúng câu hỏi này -> tránh trường hợp editQuestionRow() tìm không thấy).
async function jumpToEditQuestion(questionId) {
  closeSubsectionQuestionList();
  closeQuestionPicker();

  try {
    const headers = await sbAuthedHeaders();
    const res = await fetch(
      `${ADMIN_CONFIG.supabaseUrl}/rest/v1/question_bank?id=eq.${questionId}` +
      `&select=id,skill_id,question_type,question_text,choices,correct_answer,audio_url,explanation,difficulty,passage_id,created_at,skills(name)`,
      { headers }
    );
    if (!res.ok) throw new Error(`Lỗi tải câu hỏi (HTTP ${res.status})`);
    const rows = await res.json();
    if (!rows.length) { alert('Không tìm thấy câu hỏi này (có thể đã bị xóa).'); return; }

    switchAdminSection('questions');
    // Đợi 1 nhịp để #question-form-panel (thuộc tab Câu hỏi) chắc chắn đã
    // sẵn sàng trong DOM trước khi mở, vì switchAdminSection có thể vẫn
    // đang nạp lại danh sách câu hỏi ở nền.
    setTimeout(() => openQuestionForm(rows[0], 'edit'), 50);
  } catch (err) {
    console.error('Lỗi mở câu hỏi để sửa từ màn đề thi:', err);
    alert('Có lỗi khi mở câu hỏi để sửa. Vui lòng thử lại.');
  }
}

function initExamFormControls() {
  document.getElementById('exam-form-close-btn')?.addEventListener('click', closeExamForm);
  document.getElementById('exam-form-cancel-btn')?.addEventListener('click', closeExamForm);
  document.getElementById('exam-form-overlay')?.addEventListener('click', closeExamForm);
  document.getElementById('exam-form')?.addEventListener('submit', submitExamForm);

  document.getElementById('exam-detail-back-btn')?.addEventListener('click', () => {
    showExamListView();
    loadExamAdminList();
  });

  document.getElementById('section-form-close-btn')?.addEventListener('click', closeSectionForm);
  document.getElementById('section-form-cancel-btn')?.addEventListener('click', closeSectionForm);
  document.getElementById('section-form-overlay')?.addEventListener('click', closeSectionForm);
  document.getElementById('section-form')?.addEventListener('submit', submitSectionForm);
  document.getElementById('section-skill')?.addEventListener('change', onSectionSkillChange);
  document.getElementById('section-title')?.addEventListener('input', () => { sectionTitleTouchedByUser = true; });

  document.getElementById('subsection-form-close-btn')?.addEventListener('click', closeSubsectionForm);
  document.getElementById('subsection-form-cancel-btn')?.addEventListener('click', closeSubsectionForm);
  document.getElementById('subsection-form-overlay')?.addEventListener('click', closeSubsectionForm);
  document.getElementById('subsection-form')?.addEventListener('submit', submitSubsectionForm);
  document.getElementById('subsection-audio-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadSubsectionAudioFile(file);
  });

  document.getElementById('question-picker-close-btn')?.addEventListener('click', closeQuestionPicker);
  document.getElementById('question-picker-cancel-btn')?.addEventListener('click', closeQuestionPicker);
  document.getElementById('question-picker-overlay')?.addEventListener('click', closeQuestionPicker);
  document.getElementById('question-picker-submit-btn')?.addEventListener('click', submitQuestionPicker);
  document.getElementById('question-picker-search')?.addEventListener('input', (e) => {
    renderQuestionPickerList(e.target.value);
  });

  document.getElementById('subsection-question-list-close-btn')?.addEventListener('click', closeSubsectionQuestionList);
  document.getElementById('subsection-question-list-overlay')?.addEventListener('click', closeSubsectionQuestionList);
}
