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
const examAdminState = { rows: [] };

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
  tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>';

  try {
    const headers = await sbAuthedHeaders();

    // Query song song: danh sách đề thi + toàn bộ exam_id trong exam_sections
    // để đếm "Số section" theo từng đề ở phía client (số lượng đề thi ở quy
    // mô 1 giáo viên quản lý là nhỏ, chưa cần RPC/aggregate riêng).
    const [examsRes, sectionsRes] = await Promise.all([
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams?select=id,title,exam_type,pass_threshold_pct,retry_disabled,is_published,available_from,created_at&order=created_at.desc`, { headers }),
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections?select=exam_id`, { headers })
    ]);

    if (!examsRes.ok) throw new Error(`Lỗi tải danh sách đề thi (HTTP ${examsRes.status})`);
    if (!sectionsRes.ok) throw new Error(`Lỗi tải số section (HTTP ${sectionsRes.status})`);

    const exams = await examsRes.json();
    const sections = await sectionsRes.json();

    const sectionCountByExam = {};
    sections.forEach(s => {
      sectionCountByExam[s.exam_id] = (sectionCountByExam[s.exam_id] || 0) + 1;
    });

    examAdminState.rows = exams;
    renderExamAdminTable(exams, sectionCountByExam);
  } catch (err) {
    console.error('Lỗi tải danh sách đề thi:', err);
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Có lỗi khi tải danh sách đề thi.</div></td></tr>';
  }
}

// ── Rule mặc định toàn hệ thống (exam_retry_rules, exam_id IS NULL) ────
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
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Chưa có đề thi nào. Bấm "Tạo đề mới" để bắt đầu.</div></td></tr>';
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
      <td style="text-align:right;">
        <button type="button" class="admin-row-action-btn" title="Sửa đề thi"
          onclick="event.stopPropagation(); openExamForm(examAdminState.rows.find(r => r.id === '${escHtml(exam.id)}'))">
          <i class="ti ti-pencil"></i>
        </button>
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
    // Khóa đổi kỹ năng khi sửa — đổi skill_id của 1 section đã có
    // subsection/câu hỏi bên trong sẽ làm sai lệch dữ liệu đã chọn theo
    // đúng kỹ năng cũ (modal chọn câu hỏi lọc theo skill_id của section).
    skillSelect.disabled = true;
    if (lockHint) lockHint.style.display = 'block';

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
          // Sửa chỉ đổi title/thời gian, KHÔNG đổi skill_id (đã khóa ở UI)
          // và KHÔNG đổi order_index (giữ nguyên vị trí hiện tại).
          body: JSON.stringify({ title: title || null, time_limit_seconds: minutes * 60 })
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
