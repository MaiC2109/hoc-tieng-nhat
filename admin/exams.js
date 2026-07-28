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
  tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>';

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
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Có lỗi khi tải danh sách đề thi.</div></td></tr>';
  }
}

function renderExamAdminTable(exams, sectionCountByExam) {
  const tbody = document.getElementById('exam-table-body');
  if (!tbody) return;

  if (!exams.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Chưa có đề thi nào. Bấm "Tạo đề mới" để bắt đầu.</div></td></tr>';
    return;
  }

  tbody.innerHTML = exams.map(exam => `
    <tr class="admin-clickable-row" data-exam-id="${escHtml(exam.id)}" onclick="openExamDetail('${escHtml(exam.id)}')">
      <td>${escHtml(exam.title)}</td>
      <td>${escHtml(exam.exam_type || '—')}</td>
      <td>
        <span class="exam-status-badge ${exam.is_published ? 'is-published' : 'is-draft'}">
          ${exam.is_published ? 'Đã xuất bản' : 'Nháp'}
        </span>
      </td>
      <td style="text-align:center;">${sectionCountByExam[exam.id] || 0}</td>
      <td>${formatDateVN(exam.created_at)}</td>
    </tr>
  `).join('');
}

// ── Chi tiết đề thi (view 2) — quản lý section ─────────────────────────
// CHƯA làm subsection / chọn câu hỏi (bước sau).
const examDetailState = {
  examId: null,
  exam: null,
  sections: []
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

  const titleEl = document.getElementById('exam-detail-title');
  const subEl = document.getElementById('exam-detail-sub');
  if (titleEl) titleEl.textContent = exam ? exam.title : 'Đề thi';
  if (subEl) {
    subEl.textContent = exam
      ? `Loại: ${exam.exam_type || '—'} · Ngưỡng đạt: ${exam.pass_threshold_pct}% · ${exam.is_published ? 'Đã xuất bản' : 'Nháp'}`
      : '';
  }

  await loadExamSections();
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
    renderExamSectionsList();
    updateAddSectionButtonState();
  } catch (err) {
    console.error('Lỗi tải danh sách phần thi:', err);
    listEl.innerHTML = '<div class="empty-state">Có lỗi khi tải danh sách phần thi.</div>';
  }
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

async function openSectionForm() {
  const form = document.getElementById('section-form');
  if (form) form.reset();
  document.getElementById('section-form-error').textContent = '';
  sectionTitleTouchedByUser = false;

  const skillSelect = document.getElementById('section-skill');
  try {
    const skills = await fetchSkillsList();
    skillSelect.innerHTML = '<option value="">— Chọn kỹ năng —</option>' +
      skills.map(sk => `<option value="${sk.id}">${escHtml(sk.name)}</option>`).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách kỹ năng cho form phần thi:', err);
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
  // exam_type = 'skill' chỉ được 1 section — chặn double-check ở client
  // phòng trường hợp admin mở form trước khi nút bị disable kịp cập nhật.
  if (examDetailState.exam?.exam_type === 'skill' && examDetailState.sections.length >= 1) {
    errorEl.textContent = 'Đề loại "skill" chỉ được có 1 phần thi duy nhất.';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    const headers = await sbAuthedHeaders({ 'Prefer': 'return=representation' });
    const body = JSON.stringify({
      exam_id: examDetailState.examId,
      skill_id: parseInt(skillId, 10),
      title: title || null,
      time_limit_seconds: minutes * 60,
      order_index: examDetailState.sections.length // thêm vào cuối danh sách hiện có
    });

    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/exam_sections`, {
      method: 'POST', headers, body
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
  setExamPublishToggle(false);
}

function setExamPublishToggle(isPublished) {
  const btn = document.getElementById('exam-publish-toggle-btn');
  if (!btn) return;
  btn.dataset.published = String(isPublished);
  btn.classList.toggle('is-published', isPublished);
  btn.textContent = isPublished ? 'Đã xuất bản ✓' : 'Xuất bản';
}

function populateExamFormFromRow(row) {
  document.getElementById('exam-title').value = row.title || '';
  document.getElementById('exam-type').value = row.exam_type || 'full';
  document.getElementById('exam-pass-threshold').value = row.pass_threshold_pct ?? 70;
  setExamPublishToggle(!!row.is_published);
}

// row = null -> mode TẠO MỚI. Truyền row (từ examAdminState.rows) -> mode SỬA.
function openExamForm(row = null) {
  resetExamForm();

  const titleEl = document.getElementById('exam-form-title');
  const submitBtn = document.getElementById('exam-form-submit-btn');

  if (row) {
    examFormState.mode = 'edit';
    examFormState.editingId = row.id;
    if (titleEl) titleEl.textContent = 'Sửa đề thi';
    if (submitBtn) submitBtn.textContent = 'Cập nhật đề thi';
    populateExamFormFromRow(row);
  } else {
    examFormState.mode = 'create';
    examFormState.editingId = null;
    if (titleEl) titleEl.textContent = 'Tạo đề thi';
    if (submitBtn) submitBtn.textContent = 'Lưu đề thi';
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
  const submitBtn = document.getElementById('exam-form-submit-btn');
  errorEl.textContent = '';

  const title = document.getElementById('exam-title').value.trim();
  const examType = document.getElementById('exam-type').value;
  const passThreshold = parseInt(document.getElementById('exam-pass-threshold').value, 10);
  const isPublished = document.getElementById('exam-publish-toggle-btn').dataset.published === 'true';

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

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

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
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

// Gắn sự kiện cho form — gọi 1 lần ngay sau khi fragment được inject
// (không thể addEventListener lúc DOMContentLoaded vì lúc đó form chưa tồn
// tại trong DOM, nó chỉ có sau khi ensureExamsFragmentLoaded() chạy xong).
function initExamFormControls() {
  document.getElementById('exam-form-close-btn')?.addEventListener('click', closeExamForm);
  document.getElementById('exam-form-cancel-btn')?.addEventListener('click', closeExamForm);
  document.getElementById('exam-form-overlay')?.addEventListener('click', closeExamForm);
  document.getElementById('exam-form')?.addEventListener('submit', submitExamForm);
  document.getElementById('exam-publish-toggle-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('exam-publish-toggle-btn');
    setExamPublishToggle(btn.dataset.published !== 'true');
  });

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
}
