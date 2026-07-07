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
const ADMIN_EMAIL = "admin@example.com";

// window.supabase là global do CDN supabase-js@2 tạo ra (chứa hàm createClient).
// Đặt tên biến instance là supabaseClient để tránh nhầm với global đó.
const supabaseClient = window.supabase.createClient(
  ADMIN_CONFIG.supabaseUrl,
  ADMIN_CONFIG.supabaseAnonKey
);

// Lưu tạm thông tin admin đã đăng nhập vào biến JS (không dùng localStorage/
// sessionStorage) — session thật sự do supabase-js tự quản lý nội bộ.
let currentAdmin = null;

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
        // Thông báo lỗi chung chung — không tiết lộ email có tồn tại hay không
        console.error('Lỗi đăng nhập:', error.message);
        errorEl.textContent = 'Email hoặc mật khẩu không đúng.';
        return;
      }

      const user = data.user;

      // Chỉ 1 tài khoản admin cụ thể được phép vào — sai email thì đăng xuất
      // ngay lập tức, không cho vào layout chính dù đăng nhập Supabase thành công.
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
  // Toggle nội dung section
  document.querySelectorAll('.admin-section').forEach(sec => {
    sec.classList.toggle('active', sec.dataset.section === sectionKey);
  });

  // Toggle trạng thái active của nav item tương ứng
  document.querySelectorAll('.admin-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.target === sectionKey);
  });

  // Cập nhật tiêu đề topbar
  const meta = ADMIN_SECTION_META[sectionKey];
  const titleEl = document.getElementById('admin-topbar-title');
  const subEl = document.getElementById('admin-topbar-sub');
  if (meta && titleEl) titleEl.textContent = meta.title;
  if (meta && subEl) subEl.textContent = meta.sub;

  // Lazy-load dữ liệu khi vào từng section (tránh gọi Supabase thừa lúc chưa cần)
  if (sectionKey === 'overview') {
    loadDashboardOverview();
    loadRecentActivity();
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

// Dùng Supabase REST "count" qua header Prefer: count=exact, chỉ lấy số
// lượng (không tải data thật) để nhẹ và nhanh.
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

  // Supabase trả tổng số dòng thật (không giới hạn bởi limit) trong header
  // Content-Range, dạng "0-0/123" -> lấy phần sau dấu "/"
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

// Định dạng thời gian tương đối kiểu "2 giờ trước", "vài giây trước"...
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
//  KHỞI TẠO
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initAdminLoginForm();
  initAdminLogoutButton();
  initAdminNav();
  initAdminAuth();
});
