'use strict';

// ============================================================
//  ADMIN CONFIG
//  ⚠️ FILE NÀY DÀNH CHO MÔI TRƯỜNG TEST/STAGING — trỏ vào Supabase
//  project Test (hzecdpnmegfwbximgqlv), KHÔNG PHẢI Production. Khi
//  deploy thật cho Admin, đổi lại supabaseUrl/supabaseAnonKey sang
//  project Production (zlblylqosqwnhudeivpt).
// ============================================================
const ADMIN_CONFIG = {
  supabaseUrl: "https://hzecdpnmegfwbximgqlv.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6ZWNkcG5tZWdmd2J4aW1ncWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMTEwNTEsImV4cCI6MjA5ODc4NzA1MX0.esdOJo7gvQXLJjG94PUQ_rghTfGCAAaYzdP3l-j3u-s",
  vocabTable: "vocabulary",
  profilesTable: "profiles"
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

const vocabAdminState = {
  currentRows: []   // kết quả fetch mới nhất theo filter hiện tại — dùng để render bảng + tra cứu khi sửa/xóa
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
    renderVocabAdminTable(rows);
  } catch (err) {
    console.error('Lỗi tải danh sách từ vựng:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">❌ Không tải được danh sách từ vựng.</div></td></tr>`;
    }
  }
}

function renderVocabAdminTable(rows) {
  const tbody = document.getElementById('vocab-table-body');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Không có từ vựng nào khớp bộ lọc.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
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
  computedWordIndex: null   // word_index kế tiếp, tính TOÀN CỤC ngay khi mở form
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

  try {
    await loadCategories();
  } catch (err) {
    console.error('Lỗi tải danh mục Unit/Part:', err);
    errorEl.textContent = 'Không tải được danh mục Unit/Part.';
  }

  populateVocabFormUnitOptions();
  populateVocabFormPartOptions('');

  vocabFormState.computedWordIndex = null;
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

function closeVocabForm() {
  document.getElementById('vocab-form-overlay').style.display = 'none';
  document.getElementById('vocab-form-panel').style.display = 'none';
  vocabFormState.computedWordIndex = null;
}

// Insert từ vựng mới vào Supabase với word_index = giá trị đã tính sẵn ở
// openVocabForm(). Thành công thì reset form + đóng panel + load lại bảng.
async function submitNewVocab(e) {
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
  if (vocabFormState.computedWordIndex === null) {
    errorEl.textContent = 'Chưa tính được word_index kế tiếp — đóng và mở lại form rồi thử lại.';
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = 'Đang lưu...';

  try {
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

    closeVocabForm();
    document.getElementById('vocab-form').reset();
    await loadVocabAdminList();
  } catch (err) {
    console.error('Lỗi thêm từ vựng:', err);
    errorEl.textContent = 'Có lỗi khi lưu từ vựng. Vui lòng thử lại.';
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
  document.getElementById('vocab-form')?.addEventListener('submit', submitNewVocab);
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

// ── STUB: sẽ triển khai đầy đủ ở prompt tiếp theo (sửa/xóa từ vựng) ──
function editVocab(id) {
  console.log('[stub] editVocab() sẽ mở panel trượt để sửa id =', id, '— hoàn thiện ở prompt sau');
}

function deleteVocab(id) {
  console.log('[stub] deleteVocab() sẽ xóa id =', id, '— hoàn thiện ở prompt sau');
}

// ============================================================
//  KHỞI TẠO
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initAdminLoginForm();
  initAdminLogoutButton();
  initAdminNav();
  initVocabFilters();
  initVocabFormControls();
  initCategoryManagerControls();
  initAdminAuth();
});
