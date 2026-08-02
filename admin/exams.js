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
  if (examsFragmentLoaded) await loadExamAdminList();
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
      fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exams?select=id,title,exam_type,pass_threshold_pct,is_published,created_at&order=created_at.desc`, { headers }),
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
  subsectionsBySection: {} // { [sectionId]: [{id, instruction_text, order_index, questionCount}] }
};

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

  await loadExamSections();
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
    ` : '';
  }
  if (editBtn) editBtn.onclick = () => openExamForm(exam);
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
}

function populateExamFormFromRow(row) {
  document.getElementById('exam-title').value = row.title || '';
  document.getElementById('exam-type').value = row.exam_type || 'full';
  document.getElementById('exam-pass-threshold').value = row.pass_threshold_pct ?? 70;
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
      is_published: isPublished,
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
