'use strict';

// ============================================================
//  ADMIN CONFIG
//  Trỏ vào Supabase project Production (zlblylqosqwnhudeivpt).
// ============================================================
const ADMIN_CONFIG = {
  supabaseUrl: "https://zlblylqosqwnhudeivpt.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsYmx5bHFvc3F3bmh1ZGVpdnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mzk0NjUsImV4cCI6MjA5ODExNTQ2NX0.Xa8FblRuypm_eHMGz8GrCpwloKnzjgjTu8z_1ivS8_4",
  vocabTable: "vocabulary",
  profilesTable: "profiles",
  // Bảng lưu tiến độ SRS theo từng học viên: unique(user_id, vocab_id),
  // có cột due_date để tính "Cần ôn hôm nay" (due_date <= hôm nay)
  srsProgressTable: "vocab_srs_progress"
};

// Chỉ 1 tài khoản admin cụ thể được phép vào — kiểm tra khớp email sau khi
// đăng nhập thành công. Đổi giá trị này cho đúng email admin thật của bạn.
const ADMIN_EMAIL = "chuquynhmai91@gmail.com";

// window.supabase là global do CDN supabase-js@2 tạo ra (chứa hàm createClient).
// Đặt tên biến instance là supabaseClient để tránh nhầm với global đó.
const supabaseClient = window.supabase.createClient(
  ADMIN_CONFIG.supabaseUrl,
  ADMIN_CONFIG.supabaseAnonKey
);

// Lưu tạm thông tin admin đã đăng nhập vào biến JS (không dùng localStorage/
// sessionStorage) — session thật sự do supabase-js tự quản lý nội bộ.
let currentAdmin = null;

// Header dùng chung cho mọi request REST tới Supabase (GET/POST/PATCH/DELETE)
function sbHeaders(extra = {}) {
  return {
    'apikey': ADMIN_CONFIG.supabaseAnonKey,
    'Authorization': `Bearer ${ADMIN_CONFIG.supabaseAnonKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

// Escape text trước khi chèn vào innerHTML — tránh vỡ layout nếu dữ liệu
// có ký tự đặc biệt (&, <, >, ")
function escHtml(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
//  1. SUPABASE AUTH — đăng nhập / đăng xuất / kiểm tra session
// ============================================================

// Kiểm tra phiên đăng nhập hiện có (vd sau khi F5 lại trang admin).
async function initAdminAuth() {
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    if (session && session.user && session.user.email === ADMIN_EMAIL) {
      currentAdmin = session.user;
      showAdminShell();
      return;
    }

    // Có session nhưng không phải đúng email admin -> đăng xuất luôn, về màn login
    if (session && session.user && session.user.email !== ADMIN_EMAIL) {
      await supabaseClient.auth.signOut();
    }
    showAdminLogin();
  } catch (err) {
    console.error('Lỗi kiểm tra phiên đăng nhập admin:', err);
    showAdminLogin();
  }
}

// Lắng nghe thay đổi trạng thái đăng nhập (vd: token hết hạn, đăng xuất ở tab khác)
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    currentAdmin = null;
    showAdminLogin();
  }
});

function showAdminLogin() {
  const loginScreen = document.getElementById('admin-login-screen');
  const shell = document.getElementById('admin-shell');
  if (loginScreen) loginScreen.style.display = 'flex';
  if (shell) shell.style.display = 'none';
}

function showAdminShell() {
  const loginScreen = document.getElementById('admin-login-screen');
  const shell = document.getElementById('admin-shell');
  if (loginScreen) loginScreen.style.display = 'none';
  if (shell) shell.style.display = 'flex';

  // Vào thẳng section Tổng quan mỗi lần đăng nhập/tải lại trang thành công
  switchAdminSection('overview');
  loadDashboardOverview();
  loadRecentActivity();
}

// Gắn sự kiện submit cho form đăng nhập (#admin-login-form trong index.html)
function initAdminLoginForm() {
  const form = document.getElementById('admin-login-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const errorEl = document.getElementById('admin-login-error');
    const submitBtn = form.querySelector('button[type="submit"]');

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    errorEl.textContent = '';
    submitBtn.disabled = true;
    const originalBtnHtml = submitBtn.innerHTML;
    submitBtn.innerHTML = 'Đang đăng nhập...';

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

      if (error) {
        console.error('Lỗi đăng nhập:', error.message);
        errorEl.textContent = 'Email hoặc mật khẩu không đúng.';
        return;
      }

      const user = data.user;

      if (!user || user.email !== ADMIN_EMAIL) {
        await supabaseClient.auth.signOut();
        errorEl.textContent = 'Tài khoản này không có quyền truy cập trang Admin.';
        return;
      }

      currentAdmin = user;
      form.reset();
      showAdminShell();
    } catch (err) {
      console.error('Lỗi không xác định khi đăng nhập:', err);
      errorEl.textContent = 'Có lỗi xảy ra, vui lòng thử lại.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHtml;
    }
  });
}

// Gọi từ nút "Đăng xuất" trong sidebar (#admin-logout-btn)
async function logoutAdmin() {
  try {
    await supabaseClient.auth.signOut();
  } catch (err) {
    console.error('Lỗi khi đăng xuất:', err);
  } finally {
    currentAdmin = null;
    showAdminLogin();
  }
}

function initAdminLogoutButton() {
  const btn = document.getElementById('admin-logout-btn');
  if (btn) btn.addEventListener('click', logoutAdmin);
}

// Toggle hiện/ẩn mật khẩu ở form đăng nhập — chỉ đổi type input + icon,
// không lưu trạng thái vào đâu cả (không cần thiết, chỉ là UI tạm thời).
function initLoginPasswordToggle() {
  const toggleBtn = document.getElementById('login-password-toggle');
  const passwordInput = document.getElementById('login-password');
  if (!toggleBtn || !passwordInput) return;

  toggleBtn.addEventListener('click', () => {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    toggleBtn.innerHTML = isHidden ? '<i class="ti ti-eye-off"></i>' : '<i class="ti ti-eye"></i>';
    toggleBtn.setAttribute('aria-label', isHidden ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  });
}

// ============================================================
//  2. ĐIỀU HƯỚNG SIDEBAR — chuyển đổi giữa 3 section
// ============================================================

const ADMIN_SECTION_META = {
  overview:  { title: 'Tổng quan', sub: 'Số liệu chung của toàn bộ hệ thống' },
  vocab:     { title: 'Vocab',     sub: 'Quản lý từ vựng' },
  students:  { title: 'Học viên',  sub: 'Danh sách học viên đã đăng ký' }
};

function switchAdminSection(sectionKey) {
  document.querySelectorAll('.admin-section').forEach(sec => {
    sec.classList.toggle('active', sec.dataset.section === sectionKey);
  });

  document.querySelectorAll('.admin-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.target === sectionKey);
  });

  const meta = ADMIN_SECTION_META[sectionKey];
  const titleEl = document.getElementById('admin-topbar-title');
  const subEl = document.getElementById('admin-topbar-sub');
  if (meta && titleEl) titleEl.textContent = meta.title;
  if (meta && subEl) subEl.textContent = meta.sub;

  // Lazy-load dữ liệu khi vào từng section (tránh gọi Supabase thừa lúc chưa cần)
  if (sectionKey === 'overview') {
    loadDashboardOverview();
    loadRecentActivity();
  } else if (sectionKey === 'vocab') {
    populateVocabFilterDropdowns().then(loadVocabAdminList);
  } else if (sectionKey === 'students') {
    loadStudentAdminList();
  }
}

function initAdminNav() {
  document.querySelectorAll('.admin-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      switchAdminSection(item.dataset.target);
    });
  });
}

// ============================================================
//  3. TỔNG QUAN — đếm tổng từ vựng + tổng học viên
// ============================================================

async function fetchTableCount(tableName) {
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/${tableName}?select=id&limit=1`;
  const res = await fetch(url, {
    headers: {
      'apikey': ADMIN_CONFIG.supabaseAnonKey,
      'Authorization': `Bearer ${ADMIN_CONFIG.supabaseAnonKey}`,
      'Prefer': 'count=exact'
    }
  });

  if (!res.ok) throw new Error(`Lỗi đếm bảng ${tableName}: ${res.status}`);

  const contentRange = res.headers.get('content-range');
  if (contentRange && contentRange.includes('/')) {
    const total = contentRange.split('/')[1];
    return total === '*' ? null : parseInt(total, 10);
  }
  return null;
}

async function loadDashboardOverview() {
  const vocabEl = document.getElementById('stat-total-vocab');
  const studentsEl = document.getElementById('stat-total-students');

  try {
    const vocabCount = await fetchTableCount(ADMIN_CONFIG.vocabTable);
    if (vocabEl) vocabEl.textContent = vocabCount !== null ? vocabCount.toLocaleString('vi-VN') : '—';
  } catch (err) {
    console.error('Lỗi tải tổng từ vựng:', err);
    if (vocabEl) vocabEl.textContent = '❌';
  }

  try {
    const studentsCount = await fetchTableCount(ADMIN_CONFIG.profilesTable);
    if (studentsEl) studentsEl.textContent = studentsCount !== null ? studentsCount.toLocaleString('vi-VN') : '—';
  } catch (err) {
    console.error('Lỗi tải tổng học viên:', err);
    if (studentsEl) studentsEl.textContent = '❌';
  }
}

// ============================================================
//  4. HOẠT ĐỘNG GẦN ĐÂY — 10 từ vựng mới nhất theo created_at
// ============================================================

function formatRelativeTime(isoString) {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return 'vài giây trước';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} giờ trước`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} ngày trước`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} tháng trước`;
  const diffYear = Math.floor(diffMonth / 12);
  return `${diffYear} năm trước`;
}

async function loadRecentActivity() {
  const listEl = document.getElementById('recent-activity-list');
  if (!listEl) return;

  listEl.innerHTML = `<div class="empty-state" style="padding:24px 0;">Đang tải...</div>`;

  try {
    const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}?select=kanji,kana,created_at&order=created_at.desc&limit=10`;
    const res = await fetch(url, {
      headers: {
        'apikey': ADMIN_CONFIG.supabaseAnonKey,
        'Authorization': `Bearer ${ADMIN_CONFIG.supabaseAnonKey}`
      }
    });

    if (!res.ok) throw new Error(`Lỗi tải hoạt động gần đây: ${res.status}`);

    const rows = await res.json();

    if (rows.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:24px 0;">Chưa có dữ liệu hoạt động.</div>`;
      return;
    }

    listEl.innerHTML = rows.map(row => {
      const displayWord = (row.kanji && row.kanji !== '—') ? row.kanji : (row.kana || '(không rõ)');
      return `
        <div class="admin-activity-row">
          <span class="admin-activity-text">Đã thêm từ mới — <strong>${displayWord}</strong></span>
          <span class="admin-activity-time">${formatRelativeTime(row.created_at)}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Lỗi tải hoạt động gần đây:', err);
    listEl.innerHTML = `<div class="empty-state" style="padding:24px 0;">❌ Không tải được hoạt động gần đây.</div>`;
  }
}

// ============================================================
//  5. VOCAB — DANH SÁCH + FILTER (Prompt 2.2a)
//  loadVocabAdminList() luôn fetch trực tiếp từ Supabase với filter
//  unit/part (nếu có chọn) áp dụng ngay trên query (?unit=eq....),
//  KHÔNG lọc client-side — mỗi lần đổi dropdown sẽ gọi lại API.
//  populateVocabFilterDropdowns() fetch riêng 1 lần (chỉ cột unit,part)
//  để có đủ danh sách option cho 2 dropdown, độc lập với filter hiện tại.
//  Các hàm CRUD thật (thêm/sửa/xóa/CSV import) sẽ hoàn thiện ở
//  Prompt 2.2b. Ở bước này editVocab()/deleteVocab()/openVocabForm()
//  chỉ là stub để nút bấm không báo lỗi Console, chưa có tác dụng thật.
// ============================================================

const VOCAB_PAGE_SIZE = 50;

const vocabAdminState = {
  currentRows: [],  // kết quả fetch mới nhất theo filter hiện tại — dùng để render bảng + tra cứu khi sửa/xóa
  currentPage: 1     // trang hiện tại (bắt đầu từ 1) — reset về 1 mỗi khi filter/list đổi
};

// ── DANH MỤC UNIT/PART (bảng units/parts riêng, xem units_parts_schema.sql) ──
// Dùng chung cho: dropdown filter, dropdown trong form Thêm mới, và panel
// "Quản lý Unit/Part". Không đổi schema vocabulary — vocabulary.unit/part
// vẫn là text, categoriesState chỉ là nguồn "gợi ý chuẩn hóa".
const categoriesState = {
  units: [],  // [{id, name}]
  parts: []   // [{id, unit_id, name}]
};

function _naturalSort(list, keyFn = (x) => x) {
  return [...list].sort((a, b) =>
    String(keyFn(a)).localeCompare(String(keyFn(b)), undefined, { numeric: true, sensitivity: 'base' })
  );
}

async function loadCategories() {
  const [unitsRes, partsRes] = await Promise.all([
    fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/units?select=id,name`, { headers: sbHeaders() }),
    fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/parts?select=id,unit_id,name`, { headers: sbHeaders() })
  ]);
  if (!unitsRes.ok) throw new Error(`Lỗi tải danh mục units: ${unitsRes.status}`);
  if (!partsRes.ok) throw new Error(`Lỗi tải danh mục parts: ${partsRes.status}`);

  categoriesState.units = await unitsRes.json();
  categoriesState.parts = await partsRes.json();
}

// Fetch lại danh mục rồi đổ vào 2 dropdown filter — độc lập với việc bảng
// đang hiển thị đang lọc theo gì.
async function populateVocabFilterDropdowns() {
  try {
    await loadCategories();
  } catch (err) {
    console.error('Lỗi tải danh mục cho filter:', err);
  }

  const unitSelect = document.getElementById('filter-unit');
  if (!unitSelect) return;

  const currentUnitVal = unitSelect.value;
  const sortedUnits = _naturalSort(categoriesState.units, u => u.name);

  unitSelect.innerHTML = `<option value="">Tất cả Unit</option>` +
    sortedUnits.map(u => `<option value="${escHtml(u.name)}">${escHtml(u.name)}</option>`).join('');

  // Giữ lại lựa chọn cũ nếu vẫn còn hợp lệ sau khi refresh danh mục
  unitSelect.value = sortedUnits.some(u => u.name === currentUnitVal) ? currentUnitVal : '';

  updateVocabPartFilterOptions();
}

// Part chỉ hiện các giá trị thuộc đúng Unit đang chọn ở dropdown Unit (nếu
// chưa chọn Unit thì hiện toàn bộ Part có trong danh mục, loại trùng tên)
function updateVocabPartFilterOptions() {
  const unitSelect = document.getElementById('filter-unit');
  const partSelect = document.getElementById('filter-part');
  if (!unitSelect || !partSelect) return;

  const unitFilter = unitSelect.value;
  const currentPartVal = partSelect.value;

  let scopedParts;
  if (unitFilter) {
    const unitObj = categoriesState.units.find(u => u.name === unitFilter);
    scopedParts = unitObj ? categoriesState.parts.filter(p => p.unit_id === unitObj.id) : [];
  } else {
    scopedParts = categoriesState.parts;
  }

  const uniqueNames = [...new Set(scopedParts.map(p => p.name))];
  const sortedNames = uniqueNames.sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  );

  partSelect.innerHTML = `<option value="">Tất cả Part</option>` +
    sortedNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');

  partSelect.value = sortedNames.includes(currentPartVal) ? currentPartVal : '';
}

// Dựng URL fetch có áp filter unit/part hiện tại (nếu có chọn) — filter
// thật sự nằm ở query Supabase, không lọc lại ở client.
function buildVocabListUrl() {
  const unitFilter = document.getElementById('filter-unit')?.value || '';
  const partFilter = document.getElementById('filter-part')?.value || '';

  let url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}?select=*&order=word_index.asc`;
  if (unitFilter) url += `&unit=eq.${encodeURIComponent(unitFilter)}`;
  if (partFilter) url += `&part=eq.${encodeURIComponent(partFilter)}`;
  return url;
}

// Fetch bảng vocabulary theo đúng filter unit/part hiện tại (nếu có chọn),
// render trực tiếp kết quả trả về vào bảng. Gọi lại hàm này mỗi khi đổi
// filter (xem initVocabFilters()) hoặc sau khi thêm/sửa/xóa ở Prompt 2.2b.
async function loadVocabAdminList() {
  const tbody = document.getElementById('vocab-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>`;
  }

  try {
    const res = await fetch(buildVocabListUrl(), { headers: sbHeaders() });
    if (!res.ok) throw new Error(`Lỗi tải danh sách từ vựng: ${res.status}`);

    const rows = await res.json();
    vocabAdminState.currentRows = rows;
    vocabAdminState.currentPage = 1; // reset về trang 1 mỗi khi tải lại danh sách (đổi filter, thêm/sửa/xóa...)
    renderVocabAdminTable();
  } catch (err) {
    console.error('Lỗi tải danh sách từ vựng:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">❌ Không tải được danh sách từ vựng.</div></td></tr>`;
    }
    const pagEl = document.getElementById('vocab-pagination');
    if (pagEl) pagEl.style.display = 'none';
  }
}

// Render đúng 1 trang (VOCAB_PAGE_SIZE dòng) của vocabAdminState.currentRows,
// dựa theo vocabAdminState.currentPage. STT hiển thị = word_index của từ đó
// (không phải số thứ tự trang), theo đúng yêu cầu.
function renderVocabAdminTable() {
  const tbody = document.getElementById('vocab-table-body');
  const pagEl = document.getElementById('vocab-pagination');
  if (!tbody) return;

  const allRows = vocabAdminState.currentRows;

  if (allRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Không có từ vựng nào khớp bộ lọc.</div></td></tr>`;
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(allRows.length / VOCAB_PAGE_SIZE));
  if (vocabAdminState.currentPage > totalPages) vocabAdminState.currentPage = totalPages;
  if (vocabAdminState.currentPage < 1) vocabAdminState.currentPage = 1;

  const startIdx = (vocabAdminState.currentPage - 1) * VOCAB_PAGE_SIZE;
  const pageRows = allRows.slice(startIdx, startIdx + VOCAB_PAGE_SIZE);

  tbody.innerHTML = pageRows.map(r => `
    <tr>
      <td>${escHtml(r.word_index)}</td>
      <td class="cell-kanji">${escHtml(r.kanji || '—')}</td>
      <td class="cell-kana">${escHtml(r.kana || '—')}</td>
      <td>${escHtml(r.meaning || '—')}</td>
      <td>${escHtml(r.unit)}</td>
      <td>${escHtml(r.part)}</td>
      <td>
        <div class="admin-row-actions">
          <button class="admin-row-action-btn" onclick="editVocab(${r.id})" title="Sửa">
            <i class="ti ti-edit"></i>
          </button>
          <button class="admin-row-action-btn danger" onclick="deleteVocab(${r.id})" title="Xóa">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');

  renderVocabPagination(allRows.length, totalPages);
}

function renderVocabPagination(totalRows, totalPages) {
  const pagEl = document.getElementById('vocab-pagination');
  const infoEl = document.getElementById('vocab-pagination-info');
  const currentEl = document.getElementById('vocab-pagination-current');
  const prevBtn = document.getElementById('vocab-page-prev');
  const nextBtn = document.getElementById('vocab-page-next');
  if (!pagEl) return;

  if (totalPages <= 1) {
    pagEl.style.display = 'none';
    return;
  }

  const page = vocabAdminState.currentPage;
  const startIdx = (page - 1) * VOCAB_PAGE_SIZE + 1;
  const endIdx = Math.min(page * VOCAB_PAGE_SIZE, totalRows);

  pagEl.style.display = 'flex';
  if (infoEl) infoEl.textContent = `Hiển thị ${startIdx}–${endIdx} / ${totalRows} từ`;
  if (currentEl) currentEl.textContent = `Trang ${page} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
}

function goToVocabPage(delta) {
  vocabAdminState.currentPage += delta;
  renderVocabAdminTable();
  const tableCard = document.querySelector('.admin-table-card');
  if (tableCard) tableCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initVocabPaginationControls() {
  document.getElementById('vocab-page-prev')?.addEventListener('click', () => goToVocabPage(-1));
  document.getElementById('vocab-page-next')?.addEventListener('click', () => goToVocabPage(1));
}

// Gắn sự kiện onchange cho 2 dropdown filter — mỗi lần đổi giá trị đều gọi
// lại loadVocabAdminList() để fetch lại đúng data đã lọc từ Supabase.
function initVocabFilters() {
  const unitSelect = document.getElementById('filter-unit');
  const partSelect = document.getElementById('filter-part');
  if (!unitSelect || !partSelect) return;

  unitSelect.addEventListener('change', () => {
    updateVocabPartFilterOptions(); // Unit đổi -> Part phải tính lại option theo đúng Unit mới
    loadVocabAdminList();
  });

  partSelect.addEventListener('change', () => {
    loadVocabAdminList();
  });
}

// ── FORM "THÊM TỪ MỚI" — panel trượt ──────────────────────────

const vocabFormState = {
  computedWordIndex: null,  // word_index kế tiếp (khi thêm mới) hoặc word_index cố định (khi sửa, không đổi)
  mode: 'create',           // 'create' | 'edit'
  editingId: null           // id của từ đang sửa (chỉ có giá trị khi mode === 'edit')
};

// Trích số từ chuỗi kiểu "Unit 3" -> "3", dùng để dựng tên file audio
// đúng convention u{unit}_p{part}_word-{index}.mp3 giống app.js
function _adminDigits(str) {
  const m = String(str || '').match(/\d+/);
  return m ? m[0] : '0';
}

function buildAudioFilenamePreview(unit, part, index) {
  const u = unit ? _adminDigits(unit) : '—';
  const p = part ? _adminDigits(part) : '—';
  const idx = (index !== null && index !== undefined) ? index : '—';
  return `u${u}_p${p}_word-${idx}.mp3`;
}

// Tính word_index kế tiếp — TĂNG DẦN TOÀN CỤC trên toàn bảng vocabulary,
// KHÔNG tính riêng theo từng unit/part.
async function computeNextWordIndex() {
  const url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}?select=word_index&order=word_index.desc&limit=1`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Lỗi tính word_index kế tiếp: ${res.status}`);

  const rows = await res.json();
  return rows.length ? rows[0].word_index + 1 : 1;
}

// Đổ option Unit cho form từ danh mục thật (bảng units), thêm option
// "+ Thêm Unit mới..." để tạo Unit hoàn toàn mới nếu cần.
function populateVocabFormUnitOptions() {
  const select = document.getElementById('vocab-unit');
  if (!select) return;

  const sortedUnits = _naturalSort(categoriesState.units, u => u.name);

  select.innerHTML = `<option value="">— Chọn Unit —</option>` +
    sortedUnits.map(u => `<option value="${escHtml(u.name)}">${escHtml(u.name)}</option>`).join('') +
    `<option value="__new__">+ Thêm Unit mới...</option>`;
}

// Part chỉ hiện các giá trị thuộc đúng Unit đang chọn trong form (tra theo
// unit_id trong danh mục, không suy ra từ data vocabulary như trước)
function populateVocabFormPartOptions(scopeUnitName) {
  const select = document.getElementById('vocab-part');
  if (!select) return;

  const unitObj = categoriesState.units.find(u => u.name === scopeUnitName);
  const scopedParts = unitObj ? categoriesState.parts.filter(p => p.unit_id === unitObj.id) : [];
  const sortedParts = _naturalSort(scopedParts, p => p.name);

  select.innerHTML = `<option value="">— Chọn Part —</option>` +
    sortedParts.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('') +
    `<option value="__new__">+ Thêm Part mới...</option>`;
}

// Tạo 1 Unit mới trong bảng units (INSERT thật, không chỉ thêm option tạm
// ở client). unique(name) ở DB sẽ chặn trùng tên.
async function createUnitCategory(name) {
  const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/units`, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify({ name })
  });

  if (!res.ok) {
    if (res.status === 409) throw new Error(`Unit "${name}" đã tồn tại.`);
    throw new Error(`Lỗi tạo Unit: ${res.status}`);
  }

  const rows = await res.json();
  const newUnit = rows[0];
  categoriesState.units.push(newUnit);
  return newUnit;
}

// Tạo 1 Part mới trong bảng parts, gắn với unit_id cho trước.
async function createPartCategory(unitId, name) {
  const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/parts`, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify({ unit_id: unitId, name })
  });

  if (!res.ok) {
    if (res.status === 409) throw new Error(`Part "${name}" đã tồn tại trong Unit này.`);
    throw new Error(`Lỗi tạo Part: ${res.status}`);
  }

  const rows = await res.json();
  const newPart = rows[0];
  categoriesState.parts.push(newPart);
  return newPart;
}

// Cập nhật lại dòng preview tên file audio dựa trên Unit/Part đang chọn +
// word_index đã tính sẵn lúc mở form (KHÔNG tính lại word_index ở đây).
function refreshAudioFilenamePreview() {
  const filenameInput = document.getElementById('vocab-audio-filename');
  if (!filenameInput) return;

  const unit = document.getElementById('vocab-unit').value;
  const part = document.getElementById('vocab-part').value;
  const validUnit = unit && unit !== '__new__' ? unit : null;
  const validPart = part && part !== '__new__' ? part : null;

  filenameInput.value = buildAudioFilenamePreview(validUnit, validPart, vocabFormState.computedWordIndex);
}

async function onVocabUnitChange() {
  const select = document.getElementById('vocab-unit');

  if (select.value === '__new__') {
    const newUnitName = (prompt('Nhập tên Unit mới (vd: "Unit 10"):') || '').trim();

    if (newUnitName) {
      try {
        const existing = categoriesState.units.find(u => u.name === newUnitName);
        const unitObj = existing || await createUnitCategory(newUnitName);
        populateVocabFormUnitOptions();
        select.value = unitObj.name;
      } catch (err) {
        console.error('Lỗi tạo Unit mới:', err);
        alert(`❌ ${err.message}`);
        select.value = '';
      }
    } else {
      select.value = '';
    }
  }

  populateVocabFormPartOptions(select.value === '__new__' ? '' : select.value);
  document.getElementById('vocab-part').value = '';
  refreshAudioFilenamePreview();
}

async function onVocabPartChange() {
  const partSelect = document.getElementById('vocab-part');
  const unitSelect = document.getElementById('vocab-unit');

  if (partSelect.value === '__new__') {
    const unitName = unitSelect.value;
    const unitObj = categoriesState.units.find(u => u.name === unitName);

    if (!unitObj) {
      alert('Vui lòng chọn Unit hợp lệ trước khi thêm Part mới.');
      partSelect.value = '';
      refreshAudioFilenamePreview();
      return;
    }

    const newPartName = (prompt('Nhập tên Part mới (vd: "Part 3"):') || '').trim();

    if (newPartName) {
      try {
        const existing = categoriesState.parts.find(p => p.unit_id === unitObj.id && p.name === newPartName);
        const partObj = existing || await createPartCategory(unitObj.id, newPartName);
        populateVocabFormPartOptions(unitName);
        partSelect.value = partObj.name;
      } catch (err) {
        console.error('Lỗi tạo Part mới:', err);
        alert(`❌ ${err.message}`);
        partSelect.value = '';
      }
    } else {
      partSelect.value = '';
    }
  }

  refreshAudioFilenamePreview();
}

// Mở panel trượt "Thêm từ mới". Tính word_index kế tiếp NGAY KHI MỞ FORM,
// độc lập với Unit/Part đang chọn (đúng yêu cầu: tăng dần toàn cục).
async function openVocabForm() {
  const panel = document.getElementById('vocab-form-panel');
  const overlay = document.getElementById('vocab-form-overlay');
  const title = document.getElementById('vocab-form-title');
  const errorEl = document.getElementById('vocab-form-error');
  const form = document.getElementById('vocab-form');
  const filenameInput = document.getElementById('vocab-audio-filename');

  form.reset();
  errorEl.textContent = '';
  title.textContent = 'Thêm từ mới';
  document.getElementById('vocab-form-id').value = '';

  vocabFormState.mode = 'create';
  vocabFormState.editingId = null;

  try {
    await loadCategories();
  } catch (err) {
    console.error('Lỗi tải danh mục Unit/Part:', err);
    errorEl.textContent = 'Không tải được danh mục Unit/Part.';
  }

  populateVocabFormUnitOptions();
  populateVocabFormPartOptions('');

  vocabFormState.computedWordIndex = null;
  filenameInput.readOnly = false;
  filenameInput.value = 'Đang tính word_index...';

  overlay.style.display = 'block';
  panel.style.display = 'flex';

  try {
    vocabFormState.computedWordIndex = await computeNextWordIndex();
  } catch (err) {
    console.error('Lỗi tính word_index kế tiếp:', err);
    errorEl.textContent = 'Không tính được word_index kế tiếp. Đóng và mở lại form để thử lại.';
  }

  refreshAudioFilenamePreview();
}

// Mở panel trượt để SỬA 1 từ đã có (id lấy từ nút "Sửa" trong bảng, tra
// trực tiếp trong vocabAdminState.currentRows — không fetch lại). Khác
// openVocabForm(): word_index KHÔNG được tính lại/không cho sửa, vì tên
// file audio đã cố định theo word_index cũ (giữ nguyên convention u{unit}
// _p{part}_word-{word_index}.mp3 — đổi word_index sẽ làm audio cũ bị lệch).
async function editVocab(id) {
  const row = vocabAdminState.currentRows.find(r => r.id === id);
  if (!row) {
    alert('Không tìm thấy từ vựng này trong danh sách hiện tại — thử tải lại bảng.');
    return;
  }

  const panel = document.getElementById('vocab-form-panel');
  const overlay = document.getElementById('vocab-form-overlay');
  const title = document.getElementById('vocab-form-title');
  const errorEl = document.getElementById('vocab-form-error');
  const form = document.getElementById('vocab-form');
  const filenameInput = document.getElementById('vocab-audio-filename');

  form.reset();
  errorEl.textContent = '';
  title.textContent = 'Sửa từ vựng';
  document.getElementById('vocab-form-id').value = row.id;

  vocabFormState.mode = 'edit';
  vocabFormState.editingId = row.id;
  vocabFormState.computedWordIndex = row.word_index; // giữ nguyên, KHÔNG tính lại

  try {
    await loadCategories();
  } catch (err) {
    console.error('Lỗi tải danh mục Unit/Part:', err);
    errorEl.textContent = 'Không tải được danh mục Unit/Part.';
  }

  populateVocabFormUnitOptions();
  populateVocabFormPartOptions(row.unit);

  overlay.style.display = 'block';
  panel.style.display = 'flex';

  // Đổ dữ liệu có sẵn vào form sau khi các dropdown Unit/Part đã dựng xong
  document.getElementById('vocab-unit').value = row.unit;
  document.getElementById('vocab-part').value = row.part;
  document.getElementById('vocab-kanji').value = row.kanji && row.kanji !== '—' ? row.kanji : '';
  document.getElementById('vocab-kana').value = row.kana || '';
  document.getElementById('vocab-romaji').value = row.romaji || '';
  document.getElementById('vocab-hanviet').value = row.hanviet || '';
  document.getElementById('vocab-meaning').value = row.meaning || '';
  document.getElementById('vocab-example').value = row.example || '';

  // Khóa word_index gián tiếp: người dùng không nhập trực tiếp word_index ở
  // form này (nó chỉ được suy ra qua tên file audio), nên chỉ cần đảm bảo
  // filenameInput luôn hiển thị đúng word_index CŨ, không cho tính lại.
  filenameInput.readOnly = true;

  refreshAudioFilenamePreview();
}

function closeVocabForm() {
  document.getElementById('vocab-form-overlay').style.display = 'none';
  document.getElementById('vocab-form-panel').style.display = 'none';
  vocabFormState.computedWordIndex = null;
  vocabFormState.mode = 'create';
  vocabFormState.editingId = null;
}

// Insert (mode 'create') hoặc update (mode 'edit') từ vựng vào Supabase.
// Ở mode 'edit', word_index KHÔNG được gửi lên/không đổi — giữ nguyên giá
// trị cũ vì tên file audio đã cố định theo word_index đó.
async function submitVocabForm(e) {
  e.preventDefault();

  const errorEl = document.getElementById('vocab-form-error');
  const submitBtn = document.getElementById('vocab-form-submit-btn');
  errorEl.textContent = '';

  const unit = document.getElementById('vocab-unit').value;
  const part = document.getElementById('vocab-part').value;
  const kanji = document.getElementById('vocab-kanji').value.trim();
  const kana = document.getElementById('vocab-kana').value.trim();
  const romaji = document.getElementById('vocab-romaji').value.trim();
  const hanviet = document.getElementById('vocab-hanviet').value.trim();
  const meaning = document.getElementById('vocab-meaning').value.trim();
  const example = document.getElementById('vocab-example').value.trim();

  if (!unit || unit === '__new__' || !part || part === '__new__') {
    errorEl.textContent = 'Vui lòng chọn đầy đủ Unit và Part.';
    return;
  }
  if (!kana || !meaning) {
    errorEl.textContent = 'Vui lòng nhập đủ Kana và Meaning.';
    return;
  }

  const isEdit = vocabFormState.mode === 'edit' && vocabFormState.editingId !== null;

  if (!isEdit && vocabFormState.computedWordIndex === null) {
    errorEl.textContent = 'Chưa tính được word_index kế tiếp — đóng và mở lại form rồi thử lại.';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    if (isEdit) {
      // Update: KHÔNG gửi word_index — giữ nguyên giá trị đã có trong Supabase.
      const payload = {
        unit,
        part,
        kanji: kanji || null,
        kana,
        romaji: romaji || null,
        hanviet: hanviet || null,
        meaning,
        example: example || null
      };

      const res = await fetch(
        `${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}?id=eq.${vocabFormState.editingId}`,
        {
          method: 'PATCH',
          headers: sbHeaders({ 'Prefer': 'return=representation' }),
          body: JSON.stringify(payload)
        }
      );

      if (!res.ok) throw new Error(`Lỗi cập nhật từ vựng: ${res.status}`);
    } else {
      // Create: word_index = giá trị đã tính sẵn ở openVocabForm() (tăng dần toàn cục).
      const payload = {
        unit,
        part,
        word_index: vocabFormState.computedWordIndex,
        kanji: kanji || null,
        kana,
        romaji: romaji || null,
        hanviet: hanviet || null,
        meaning,
        example: example || null
      };

      const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}`, {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`Lỗi thêm từ vựng: ${res.status}`);
    }

    closeVocabForm();
    document.getElementById('vocab-form').reset();
    await loadVocabAdminList();
  } catch (err) {
    console.error('Lỗi lưu từ vựng:', err);
    errorEl.textContent = isEdit ? 'Có lỗi khi cập nhật từ vựng. Vui lòng thử lại.' : 'Có lỗi khi lưu từ vựng. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

function initVocabFormControls() {
  document.getElementById('vocab-form-close-btn')?.addEventListener('click', closeVocabForm);
  document.getElementById('vocab-form-cancel-btn')?.addEventListener('click', closeVocabForm);
  document.getElementById('vocab-form-overlay')?.addEventListener('click', closeVocabForm);
  document.getElementById('vocab-unit')?.addEventListener('change', onVocabUnitChange);
  document.getElementById('vocab-part')?.addEventListener('change', onVocabPartChange);
  document.getElementById('vocab-form')?.addEventListener('submit', submitVocabForm);
}

// ============================================================
//  7. QUẢN LÝ UNIT/PART (mức tối thiểu)
//  Panel trượt riêng, liệt kê toàn bộ Unit kèm Part con, cho phép
//  đổi tên/xóa. Đây là category riêng biệt (bảng units/parts), KHÔNG
//  đụng vào vocabulary.unit/part hiện có — đổi tên/xóa category không
//  tự động cập nhật các từ vựng đã dùng tên cũ, cảnh báo rõ khi thao tác.
// ============================================================

async function openCategoryManager() {
  const overlay = document.getElementById('category-manager-overlay');
  const panel = document.getElementById('category-manager-panel');
  const listEl = document.getElementById('category-list');

  overlay.style.display = 'block';
  panel.style.display = 'flex';
  listEl.innerHTML = `<div class="empty-state" style="padding:20px 0;">Đang tải...</div>`;

  try {
    await loadCategories();
    renderCategoryManager();
  } catch (err) {
    console.error('Lỗi tải danh mục:', err);
    listEl.innerHTML = `<div class="empty-state">❌ Không tải được danh mục Unit/Part.</div>`;
  }
}

function closeCategoryManager() {
  document.getElementById('category-manager-overlay').style.display = 'none';
  document.getElementById('category-manager-panel').style.display = 'none';
}

function renderCategoryManager() {
  const wrap = document.getElementById('category-list');
  if (!wrap) return;

  const sortedUnits = _naturalSort(categoriesState.units, u => u.name);

  if (sortedUnits.length === 0) {
    wrap.innerHTML = `<div class="empty-state" style="padding:20px 0;">Chưa có Unit nào. Thêm Unit đầu tiên ở trên.</div>`;
    return;
  }

  wrap.innerHTML = sortedUnits.map(u => {
    const parts = _naturalSort(categoriesState.parts.filter(p => p.unit_id === u.id), p => p.name);

    const partsHtml = parts.length > 0
      ? parts.map(p => `
          <div class="admin-category-part-row">
            <span>${escHtml(p.name)}</span>
            <div class="admin-row-actions">
              <button class="admin-row-action-btn" onclick="renamePartCategory(${p.id})" title="Đổi tên">
                <i class="ti ti-edit"></i>
              </button>
              <button class="admin-row-action-btn danger" onclick="deletePartCategory(${p.id})" title="Xóa">
                <i class="ti ti-trash"></i>
              </button>
            </div>
          </div>
        `).join('')
      : `<div class="admin-hint-text" style="padding:4px 0 8px;">Chưa có Part nào.</div>`;

    return `
      <div class="admin-category-unit-block">
        <div class="admin-category-unit-header">
          <span class="admin-category-unit-name">${escHtml(u.name)}</span>
          <div class="admin-row-actions">
            <button class="admin-row-action-btn" onclick="renameUnitCategory(${u.id})" title="Đổi tên">
              <i class="ti ti-edit"></i>
            </button>
            <button class="admin-row-action-btn danger" onclick="deleteUnitCategory(${u.id})" title="Xóa">
              <i class="ti ti-trash"></i>
            </button>
          </div>
        </div>
        <div class="admin-category-part-list">
          ${partsHtml}
          <div class="admin-category-add-row admin-category-add-row-part">
            <input type="text" placeholder="Tên Part mới..." id="new-part-input-${u.id}" />
            <button class="btn btn-outline" onclick="addPartCategoryFromPanel(${u.id})">
              <i class="ti ti-plus"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function addUnitCategoryFromPanel() {
  const input = document.getElementById('new-unit-input');
  const name = input.value.trim();
  if (!name) return;

  try {
    await createUnitCategory(name);
    input.value = '';
    renderCategoryManager();
  } catch (err) {
    console.error(err);
    alert(`❌ ${err.message}`);
  }
}

async function addPartCategoryFromPanel(unitId) {
  const input = document.getElementById(`new-part-input-${unitId}`);
  const name = input.value.trim();
  if (!name) return;

  try {
    await createPartCategory(unitId, name);
    renderCategoryManager();
  } catch (err) {
    console.error(err);
    alert(`❌ ${err.message}`);
  }
}

// Đếm nhanh số từ vựng đang dùng 1 cặp unit(/part) — dùng header
// Prefer: count=exact, không cần tải data thật.
async function countVocabUsage(unitName, partName = null) {
  let url = `${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}?select=id&limit=1&unit=eq.${encodeURIComponent(unitName)}`;
  if (partName !== null) url += `&part=eq.${encodeURIComponent(partName)}`;

  const res = await fetch(url, { headers: sbHeaders({ 'Prefer': 'count=exact' }) });
  if (!res.ok) throw new Error(`Lỗi kiểm tra usage: ${res.status}`);

  const contentRange = res.headers.get('content-range');
  if (contentRange && contentRange.includes('/')) {
    const total = contentRange.split('/')[1];
    return total === '*' ? 0 : parseInt(total, 10);
  }
  return 0;
}

async function renameUnitCategory(unitId) {
  const unit = categoriesState.units.find(u => u.id === unitId);
  if (!unit) return;

  const newName = (prompt('Đổi tên Unit:', unit.name) || '').trim();
  if (!newName || newName === unit.name) return;

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/units?id=eq.${unitId}`, {
      method: 'PATCH',
      headers: sbHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ name: newName })
    });
    if (!res.ok) throw new Error(`Lỗi đổi tên Unit: ${res.status}`);

    unit.name = newName;
    renderCategoryManager();
    alert('⚠️ Lưu ý: các từ vựng đang dùng tên Unit cũ trong bảng vocabulary sẽ KHÔNG tự động đổi theo — cần cập nhật tay từng dòng nếu muốn đồng bộ.');
  } catch (err) {
    console.error('Lỗi đổi tên Unit:', err);
    alert('❌ Lỗi khi đổi tên Unit.');
  }
}

async function deleteUnitCategory(unitId) {
  const unit = categoriesState.units.find(u => u.id === unitId);
  if (!unit) return;

  let usageCount = 0;
  try {
    usageCount = await countVocabUsage(unit.name);
  } catch (err) {
    console.error('Lỗi kiểm tra usage trước khi xóa Unit:', err);
  }

  const warning = usageCount > 0
    ? `⚠️ Đang có ${usageCount} từ vựng dùng Unit "${unit.name}". Xóa danh mục KHÔNG xóa các từ vựng đó, nhưng Unit này sẽ không còn xuất hiện trong dropdown để chọn nữa. Vẫn xóa?`
    : `Xóa Unit "${unit.name}" (và toàn bộ Part con của nó trong danh mục)?`;

  if (!confirm(warning)) return;

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/units?id=eq.${unitId}`, {
      method: 'DELETE',
      headers: sbHeaders()
    });
    if (!res.ok) throw new Error(`Lỗi xóa Unit: ${res.status}`);

    await loadCategories();
    renderCategoryManager();
  } catch (err) {
    console.error('Lỗi xóa Unit:', err);
    alert('❌ Lỗi khi xóa Unit.');
  }
}

async function renamePartCategory(partId) {
  const part = categoriesState.parts.find(p => p.id === partId);
  if (!part) return;

  const newName = (prompt('Đổi tên Part:', part.name) || '').trim();
  if (!newName || newName === part.name) return;

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/parts?id=eq.${partId}`, {
      method: 'PATCH',
      headers: sbHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ name: newName })
    });
    if (!res.ok) throw new Error(`Lỗi đổi tên Part: ${res.status}`);

    part.name = newName;
    renderCategoryManager();
    alert('⚠️ Lưu ý: các từ vựng đang dùng tên Part cũ trong bảng vocabulary sẽ KHÔNG tự động đổi theo — cần cập nhật tay từng dòng nếu muốn đồng bộ.');
  } catch (err) {
    console.error('Lỗi đổi tên Part:', err);
    alert('❌ Lỗi khi đổi tên Part.');
  }
}

async function deletePartCategory(partId) {
  const part = categoriesState.parts.find(p => p.id === partId);
  if (!part) return;
  const unit = categoriesState.units.find(u => u.id === part.unit_id);

  let usageCount = 0;
  try {
    if (unit) usageCount = await countVocabUsage(unit.name, part.name);
  } catch (err) {
    console.error('Lỗi kiểm tra usage trước khi xóa Part:', err);
  }

  const warning = usageCount > 0
    ? `⚠️ Đang có ${usageCount} từ vựng dùng Part "${part.name}". Xóa danh mục KHÔNG xóa các từ vựng đó, nhưng Part này sẽ không còn xuất hiện trong dropdown để chọn nữa. Vẫn xóa?`
    : `Xóa Part "${part.name}"?`;

  if (!confirm(warning)) return;

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/parts?id=eq.${partId}`, {
      method: 'DELETE',
      headers: sbHeaders()
    });
    if (!res.ok) throw new Error(`Lỗi xóa Part: ${res.status}`);

    await loadCategories();
    renderCategoryManager();
  } catch (err) {
    console.error('Lỗi xóa Part:', err);
    alert('❌ Lỗi khi xóa Part.');
  }
}

function initCategoryManagerControls() {
  document.getElementById('btn-manage-categories')?.addEventListener('click', openCategoryManager);
  document.getElementById('category-manager-close-btn')?.addEventListener('click', closeCategoryManager);
  document.getElementById('category-manager-overlay')?.addEventListener('click', closeCategoryManager);
  document.getElementById('btn-add-unit-category')?.addEventListener('click', addUnitCategoryFromPanel);
}

// ============================================================
//  6. IMPORT CSV — parse client-side bằng PapaParse (CDN, xem thẻ
//  <script> trong index.html), validate rồi bulk insert vào Supabase.
//  Cột kỳ vọng trong CSV: unit, part, word_index, kanji, kana, romaji,
//  hanviet, meaning, example — KHÔNG được có cột "id" (id do Supabase
//  tự sinh, không nhận từ file ngoài).
// ============================================================

const csvImportState = {
  rows: []   // dữ liệu đã parse & validate — nguồn thật để bulk insert khi bấm nút Import
};

function resetCsvImportUI(message) {
  csvImportState.rows = [];
  const importBtn = document.getElementById('btn-csv-import');
  const previewWrap = document.getElementById('csv-preview-wrap');
  const previewBody = document.getElementById('csv-preview-body');
  if (importBtn) importBtn.disabled = true;
  if (previewWrap) previewWrap.style.display = 'none';
  if (previewBody) previewBody.innerHTML = '';
  if (message) alert(message);
}

// Validate toàn bộ rows đã parse từ CSV. Ném lỗi ngay ở dòng đầu tiên sai
// để người dùng biết chính xác cần sửa gì trong file trước khi thử lại.
function validateCsvRows(rawRows, fields) {
  // Không được có cột "id" trong CSV — id/word_index do hệ thống quản lý
  if (fields.some(f => f.trim().toLowerCase() === 'id')) {
    throw new Error('File CSV không được có cột "id".');
  }

  const cleanRows = [];
  rawRows.forEach((row, idx) => {
    const lineNo = idx + 2; // +1 vì có header, +1 vì idx bắt đầu từ 0

    const unit = (row.unit || '').trim();
    const part = (row.part || '').trim();
    const wordIndexRaw = (row.word_index ?? '').toString().trim();

    if (!unit || !part || !wordIndexRaw) {
      throw new Error(`Dòng ${lineNo}: thiếu unit/part/word_index.`);
    }

    const wordIndex = Number(wordIndexRaw);
    if (!Number.isFinite(wordIndex)) {
      throw new Error(`Dòng ${lineNo}: word_index "${wordIndexRaw}" không phải là số hợp lệ.`);
    }

    const kana = (row.kana || '').trim();
    const meaning = (row.meaning || '').trim();
    if (!kana) throw new Error(`Dòng ${lineNo}: thiếu Kana.`);
    if (!meaning) throw new Error(`Dòng ${lineNo}: thiếu Meaning.`);

    cleanRows.push({
      unit,
      part,
      word_index: wordIndex,
      kanji: (row.kanji || '').trim() || null,
      kana,
      romaji: (row.romaji || '').trim() || null,
      hanviet: (row.hanviet || '').trim() || null,
      meaning,
      example: (row.example || '').trim() || null
    });
  });

  return cleanRows;
}

function renderCsvPreview(rows) {
  const previewWrap = document.getElementById('csv-preview-wrap');
  const previewBody = document.getElementById('csv-preview-body');
  if (!previewWrap || !previewBody) return;

  previewBody.innerHTML = rows.map(r => `
    <tr>
      <td>${escHtml(r.unit)}</td>
      <td>${escHtml(r.part)}</td>
      <td>${escHtml(r.word_index)}</td>
      <td class="cell-kanji">${escHtml(r.kanji || '—')}</td>
      <td class="cell-kana">${escHtml(r.kana)}</td>
      <td>${escHtml(r.romaji || '—')}</td>
      <td>${escHtml(r.hanviet || '—')}</td>
      <td>${escHtml(r.meaning)}</td>
      <td>${escHtml(r.example || '—')}</td>
    </tr>
  `).join('');

  previewWrap.style.display = 'block';
}

// Nút "Xem trước" — parse file CSV đang chọn ở input, validate, hiện bảng preview.
// Import bị khóa (disabled) cho tới khi có ít nhất 1 lần preview hợp lệ.
function handleCsvPreviewClick() {
  const fileInput = document.getElementById('csv-file-input');
  const file = fileInput?.files?.[0];

  if (!file) {
    alert('Vui lòng chọn 1 file CSV trước.');
    return;
  }

  if (typeof Papa === 'undefined') {
    alert('❌ Chưa tải được thư viện PapaParse. Kiểm tra thẻ <script> CDN PapaParse trong index.html.');
    return;
  }

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      try {
        if (results.errors && results.errors.length > 0) {
          throw new Error(`Lỗi parse CSV: ${results.errors[0].message}`);
        }
        const cleanRows = validateCsvRows(results.data, results.meta.fields || []);
        if (cleanRows.length === 0) {
          throw new Error('File CSV không có dòng dữ liệu nào hợp lệ.');
        }
        csvImportState.rows = cleanRows;
        renderCsvPreview(cleanRows);
        const importBtn = document.getElementById('btn-csv-import');
        if (importBtn) importBtn.disabled = false;
      } catch (err) {
        console.error('Lỗi validate CSV:', err);
        resetCsvImportUI(`❌ ${err.message}`);
      }
    },
    error: (err) => {
      console.error('Lỗi đọc file CSV:', err);
      resetCsvImportUI('❌ Không đọc được file CSV.');
    }
  });
}

// Nút "Import vào Supabase" — bulk insert toàn bộ csvImportState.rows trong 1 request.
async function handleCsvImportClick() {
  const importBtn = document.getElementById('btn-csv-import');
  if (!importBtn) return;

  if (csvImportState.rows.length === 0) {
    alert('Chưa có dữ liệu hợp lệ để import — bấm "Xem trước" trước.');
    return;
  }

  if (!confirm(`Import ${csvImportState.rows.length} dòng từ vựng vào Supabase?`)) return;

  const originalText = importBtn.innerHTML;
  importBtn.disabled = true;
  importBtn.innerHTML = 'Đang import...';

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}`, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(csvImportState.rows)
    });

    if (!res.ok) throw new Error(`Lỗi import: ${res.status}`);

    alert(`✅ Đã import thành công ${csvImportState.rows.length} từ vựng.`);

    resetCsvImportUI();
    const fileInput = document.getElementById('csv-file-input');
    if (fileInput) fileInput.value = '';

    await loadVocabAdminList();
  } catch (err) {
    console.error('Lỗi import CSV vào Supabase:', err);
    alert('❌ Lỗi khi import dữ liệu vào Supabase. Vui lòng kiểm tra lại file rồi thử lại.');
  } finally {
    importBtn.disabled = false;
    importBtn.innerHTML = originalText;
  }
}

function initCsvImportControls() {
  document.getElementById('btn-csv-preview')?.addEventListener('click', handleCsvPreviewClick);
  document.getElementById('btn-csv-import')?.addEventListener('click', handleCsvImportClick);
  // Chọn file mới -> xóa preview/kết quả validate cũ, tránh import nhầm dữ liệu của file trước
  document.getElementById('csv-file-input')?.addEventListener('change', () => resetCsvImportUI());
}

// Xóa 1 từ vựng. Hỏi xác nhận trước vì thao tác không hoàn tác được và sẽ
// để lại "lỗ hổng" trong dãy word_index — CHẤP NHẬN ĐƯỢC theo yêu cầu, vì
// không dồn lại số thứ tự các từ còn lại (audio cũ đặt tên theo word_index
// cũ, dồn số sẽ làm sai lệch toàn bộ file audio đã có).
async function deleteVocab(id) {
  const row = vocabAdminState.currentRows.find(r => r.id === id);
  const label = row ? (row.kanji && row.kanji !== '—' ? row.kanji : row.kana) : `#${id}`;

  const confirmed = confirm(
    `Xóa từ vựng "${label}"?\n\nLưu ý: word_index của từ này sẽ để trống (không dồn lại số thứ tự các từ khác), vì file audio cũ đã đặt tên theo word_index này.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`${ADMIN_CONFIG.supabaseUrl}/rest/v1/${ADMIN_CONFIG.vocabTable}?id=eq.${id}`, {
      method: 'DELETE',
      headers: sbHeaders()
    });

    if (!res.ok) throw new Error(`Lỗi xóa từ vựng: ${res.status}`);

    await loadVocabAdminList();
  } catch (err) {
    console.error('Lỗi xóa từ vựng:', err);
    alert('❌ Lỗi khi xóa từ vựng. Vui lòng thử lại.');
  }
}

// ============================================================
//  8. HỌC VIÊN — danh sách + tìm kiếm + Chi tiết học viên (SRS)
//  loadStudentDetail(userId, isAdminView) tính % Vocab và số từ cần
//  ôn hôm nay trực tiếp từ vocab_srs_progress — hàm này viết để dùng
//  chung được với Dashboard học viên tự xem (Prompt 3.3), nên không
//  phụ thuộc gì vào state riêng của Admin ngoài tham số truyền vào.
// ============================================================

const studentAdminState = {
  currentRows: [],   // toàn bộ profiles fetch được, dùng để filter tìm kiếm + tra khi mở form/detail
  activeStudentId: null
};

async function loadStudentAdminList() {
  const tbody = document.getElementById('student-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Đang tải dữ liệu...</div></td></tr>`;
  }

  try {
    // profiles giờ đã gộp đủ cột: id, email, full_name, jlpt_level, is_active
    // — không cần join/merge với student_profiles nữa (bảng đó đã bị xóa).
    const { data: rows, error } = await supabaseClient
      .from(ADMIN_CONFIG.profilesTable)
      .select('id, email, full_name, jlpt_level')
      .order('full_name', { ascending: true });

    if (error) throw error;

    const flatRows = rows.map(r => ({
      id: r.id,
      email: r.email,
      full_name: r.full_name || '',
      jlpt_level: r.jlpt_level || ''
    }));

    studentAdminState.currentRows = flatRows;

    // Tổng số từ vựng — dùng làm mẫu số mặc định (định nghĩa "đã học" hiện
    // tại giống module Vocab: 1 dòng trong vocab_srs_progress = đã học/ôn
    // ít nhất 1 lần, không phân biệt theo cấp độ ở view danh sách này).
    const totalVocab = await fetchTableCount(ADMIN_CONFIG.vocabTable) || 0;
    await Promise.all(flatRows.map(async (r) => {
      try {
        r._learnedCount = await countStudentLearnedVocab(r.id);
      } catch (err) {
        console.error(`Lỗi đếm vocab đã học cho học viên ${r.id}:`, err);
        r._learnedCount = null;
      }
    }));
    studentAdminState._totalVocab = totalVocab;

    renderStudentAdminTable(flatRows);
  } catch (err) {
    console.error('Lỗi tải danh sách học viên:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">❌ Không tải được danh sách học viên.</div></td></tr>`;
    }
  }
}

// Đếm số từ vựng học viên đã có trong vocab_srs_progress (đã học/ôn ít
// nhất 1 lần — unique(user_id, vocab_id) nên không đếm trùng). Đây là
// định nghĩa "đã học" mà module Vocab hiện tại đang dùng (srMarkWordsAsLearned
// ghi 1 dòng ngay khi từ được đưa vào phiên Flashcard đầu tiên).
async function countStudentLearnedVocab(userId) {
  const { count, error } = await supabaseClient
    .from(ADMIN_CONFIG.srsProgressTable)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) throw error;
  return count || 0;
}

// Đếm số từ đã đến hạn ôn hôm nay (due_date <= hôm nay) cho 1 học viên.
async function countStudentDueToday(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { count, error } = await supabaseClient
    .from(ADMIN_CONFIG.srsProgressTable)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .lte('due_date', today);

  if (error) throw error;
  return count || 0;
}

// Tổng số từ vựng theo đúng cấp độ (jlpt_level) học viên đang học — dùng
// làm mẫu số ở khu vực Chi tiết học viên, khác với tổng toàn bộ vocab dùng
// ở bảng danh sách. Nếu học viên chưa có level hoặc bảng vocabulary chưa có
// cột level, fallback về tổng toàn bộ vocab.
async function countVocabByLevel(jlptLevel) {
  if (!jlptLevel) return await fetchTableCount(ADMIN_CONFIG.vocabTable) || 0;

  try {
    const { count, error } = await supabaseClient
      .from(ADMIN_CONFIG.vocabTable)
      .select('id', { count: 'exact', head: true })
      .eq('level', jlptLevel);

    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.error('Lỗi đếm vocab theo level, dùng tổng toàn bộ thay thế:', err);
    return await fetchTableCount(ADMIN_CONFIG.vocabTable) || 0;
  }
}

function renderStudentAdminTable(rows) {
  const tbody = document.getElementById('student-table-body');
  if (!tbody) return;

  const keyword = (document.getElementById('student-search-input')?.value || '').trim().toLowerCase();
  const filtered = keyword
    ? rows.filter(r => (r.full_name || '').toLowerCase().includes(keyword))
    : rows;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Không tìm thấy học viên nào.</div></td></tr>`;
    return;
  }

  const total = studentAdminState._totalVocab || 0;

  tbody.innerHTML = filtered.map(r => {
    const learned = r._learnedCount;
    const pct = (learned !== null && total > 0) ? Math.round((learned / total) * 100) : 0;
    const pctLabel = learned !== null ? `${pct}%` : '—';
    const activeClass = r.id === studentAdminState.activeStudentId ? 'active-row' : '';

    return `
      <tr class="student-row ${activeClass}" onclick="selectStudentRow('${r.id}')">
        <td>${escHtml(r.full_name || '(chưa có tên)')}</td>
        <td>${escHtml(r.jlpt_level || '—')}</td>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="progress-bar-mini" style="width:70px;">
              <div class="progress-bar-mini-fill" style="width:${pct}%"></div>
            </div>
            <span style="font-size:12px; color:var(--ink-mute);">${pctLabel}</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function initStudentSearch() {
  const input = document.getElementById('student-search-input');
  if (!input) return;
  input.addEventListener('input', () => renderStudentAdminTable(studentAdminState.currentRows));
}

// Click 1 hàng trong bảng -> mở khu vực Chi tiết học viên bên dưới, cuộn tới đúng vị trí
async function selectStudentRow(userId) {
  studentAdminState.activeStudentId = userId;
  renderStudentAdminTable(studentAdminState.currentRows);

  const row = studentAdminState.currentRows.find(r => r.id === userId);
  if (!row) return;

  const view = document.getElementById('student-progress-view');
  if (view) view.style.display = 'block';

  document.getElementById('sp-student-name').textContent = row.full_name || '(chưa có tên)';
  document.getElementById('sp-student-level').textContent = row.jlpt_level ? `Level ${row.jlpt_level}` : 'Chưa có level';
  document.getElementById('sp-vocab-fraction').textContent = 'Đang tải...';
  document.getElementById('sp-vocab-progress-fill').style.width = '0%';
  document.getElementById('sp-due-today').textContent = '—';

  view.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    await loadStudentDetail(userId, true, row.jlpt_level);
  } catch (err) {
    console.error('Lỗi tải chi tiết học viên:', err);
    document.getElementById('sp-vocab-fraction').textContent = '❌ Lỗi tải dữ liệu';
  }
}

// Dùng chung cho Admin xem (isAdminView=true mặc định, ghi vào #sp-*) và
// Dashboard học viên tự xem (Prompt 3.3 gọi loadStudentDetail(userId) với
// isAdminView=false hoặc bỏ qua render DOM #sp-*, tự xử lý UI riêng).
async function loadStudentDetail(userId, isAdminView = true, jlptLevel = null) {
  const totalVocab = await countVocabByLevel(jlptLevel);

  const [learnedCount, dueToday] = await Promise.all([
    countStudentLearnedVocab(userId),
    countStudentDueToday(userId)
  ]);

  if (isAdminView) {
    const pct = totalVocab > 0 ? Math.round((learnedCount / totalVocab) * 100) : 0;
    document.getElementById('sp-vocab-fraction').textContent = `${learnedCount}/${totalVocab}`;
    document.getElementById('sp-vocab-progress-fill').style.width = `${pct}%`;
    document.getElementById('sp-due-today').textContent = dueToday;
  }

  return { totalVocab, learnedCount, dueToday };
}

// ── FORM "CẬP NHẬT THÔNG TIN HỌC VIÊN" ──────────────────────

function openStudentForm() {
  const panel = document.getElementById('student-form-panel');
  const overlay = document.getElementById('student-form-overlay');
  const form = document.getElementById('student-form');
  const errorEl = document.getElementById('student-form-error');

  form.reset();
  errorEl.textContent = '';

  overlay.style.display = 'block';
  panel.style.display = 'flex';
}

function closeStudentForm() {
  document.getElementById('student-form-overlay').style.display = 'none';
  document.getElementById('student-form-panel').style.display = 'none';
}

// Update trực tiếp vào bảng profiles theo email nhập trong form — KHÔNG
// tạo tài khoản mới. Nếu không tìm thấy dòng nào khớp email (tài khoản
// chưa tồn tại) -> báo lỗi rõ ràng, không âm thầm tạo mới.
async function submitStudentInfo(e) {
  e.preventDefault();

  const errorEl = document.getElementById('student-form-error');
  const submitBtn = document.getElementById('student-form-submit-btn');
  errorEl.textContent = '';

  const email = document.getElementById('student-email').value.trim();
  const fullName = document.getElementById('student-fullname').value.trim();
  const jlptLevel = document.getElementById('student-level').value;

  if (!email || !fullName || !jlptLevel) {
    errorEl.textContent = 'Vui lòng nhập đầy đủ Email, Họ tên và Level.';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
    // profiles giờ đã gộp đủ cột — update trực tiếp theo email, không cần
    // tìm id rồi upsert sang bảng khác nữa (student_profiles đã bị xóa).
    const { data, error } = await supabaseClient
      .from(ADMIN_CONFIG.profilesTable)
      .update({ full_name: fullName, jlpt_level: jlptLevel })
      .eq('email', email)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      errorEl.textContent = 'Không tìm thấy tài khoản với email này — hãy tạo tài khoản trước trong Supabase Dashboard (Authentication → Users).';
      return;
    }

    closeStudentForm();
    await loadStudentAdminList();
  } catch (err) {
    console.error('Lỗi lưu thông tin học viên:', err);
    errorEl.textContent = 'Có lỗi khi lưu thông tin học viên. Vui lòng thử lại.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
}

function initStudentFormControls() {
  document.getElementById('student-form-close-btn')?.addEventListener('click', closeStudentForm);
  document.getElementById('student-form-cancel-btn')?.addEventListener('click', closeStudentForm);
  document.getElementById('student-form-overlay')?.addEventListener('click', closeStudentForm);
  document.getElementById('student-form')?.addEventListener('submit', submitStudentInfo);
}

// ============================================================
//  KHỞI TẠO
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initAdminLoginForm();
  initLoginPasswordToggle();
  initAdminLogoutButton();
  initAdminNav();
  initVocabFilters();
  initVocabFormControls();
  initVocabPaginationControls();
  initCategoryManagerControls();
  initCsvImportControls();
  initStudentSearch();
  initStudentFormControls();
  initAdminAuth();
});
