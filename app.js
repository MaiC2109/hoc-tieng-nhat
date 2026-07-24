'use strict';
console.log = function() {};
// 1. Khởi tạo trạng thái ứng dụng
const state = {
  activeUnit: null,
  activeAccordion: {},
  activeSubTab: {},
  quizState: {},
  flashcardState: {},
  currentAudio: null,
  reviewFlashcardState: null, // trạng thái riêng cho phiên Ôn tập (Spaced Repetition)
  currentUser: null, // { id, access_token } của học viên đã đăng nhập, set bởi getCurrentSession()
  sessionStartTimes: {} // { [partKey|'review']: ISOString } — thời điểm bắt đầu phiên Flashcard/Quiz/Review
};

// ============================================================
//  SPACED REPETITION MODULE (SM-2 rút gọn, lưu localStorage)
//  Key lưu: 'sr_vocab' -> { [wordId]: { interval, reps, dueDate } }
// ============================================================
const SR_STORAGE_KEY = 'sr_vocab';
const SR_STEPS_DAYS = [1, 3, 7]; // 3 lần ôn đầu cố định, sau đó nhân hệ số
const SR_GROWTH_FACTOR = 2.2;

function _srToday() {
  return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

function _srGetAll() {
  try {
    return JSON.parse(localStorage.getItem(SR_STORAGE_KEY) || '{}');
  } catch (e) {
    console.error('Lỗi đọc sr_vocab:', e);
    return {};
  }
}

function _srSaveAll(data) {
  localStorage.setItem(SR_STORAGE_KEY, JSON.stringify(data));
}

// Đánh dấu một danh sách từ (vd: cả 1 Part) là "đã học lần đầu",
// chỉ áp dụng cho những từ CHƯA có trong sr_vocab — không ghi đè từ đã có lịch sử ôn.
function srMarkWordsAsLearned(words) {
  const data = _srGetAll();
  let changed = false;
  const newlyLearned = [];
  words.forEach(w => {
    const id = String(w.id);
    if (!data[id]) {
      const due = new Date();
      due.setDate(due.getDate() + SR_STEPS_DAYS[0]); // ôn lại sau 1 ngày
      data[id] = { interval: SR_STEPS_DAYS[0], reps: 0, dueDate: due.toISOString().split('T')[0] };
      changed = true;
      newlyLearned.push(id);
    }
  });
  if (changed) {
    _srSaveAll(data);
    // Đồng bộ lên Supabase (best-effort, không chặn UI) — chỉ để Admin xem
    // được tiến độ; localStorage vẫn là nguồn đọc chính trên chính thiết bị
    // này (xem ghi chú tại srSyncWordToSupabase()).
    newlyLearned.forEach(id => srSyncWordToSupabase(id, data[id], { isFirstLearn: true }));
  }
}

// Cập nhật trạng thái ôn tập của 1 từ sau khi học viên trả lời (Đã thuộc / Chưa thuộc)
// Logic interval:
//   Lần học đầu tiên (srMarkWordsAsLearned): interval=1, reps=0, dueDate=ngày mai
//   Tick Remember lần 1 (reps=0 → 1): interval = SR_STEPS_DAYS[1] = 3 ngày
//   Tick Remember lần 2 (reps=1 → 2): interval = SR_STEPS_DAYS[2] = 7 ngày
//   Tick Remember lần 3+ (reps≥2)   : interval *= SR_GROWTH_FACTOR
//   Tick Not Yet bất kỳ lúc nào     : interval reset về 1 ngày
function srUpdateWordState(wordId, isCorrect) {
  const data = _srGetAll();
  const id = String(wordId);
  const st = data[id] || { interval: 0, reps: 0 };

  if (isCorrect) {
    // reps hiện tại đã là "số lần đã ôn đúng từ trước" — dùng làm chỉ số cho bước KẾ TIẾP
    // SR_STEPS_DAYS[0]=1 là interval của lần học đầu (set bởi srMarkWordsAsLearned),
    // nên lần đúng đầu tiên cần nhảy lên SR_STEPS_DAYS[1]=3, tức index = reps + 1
    const nextIndex = st.reps + 1;
    st.interval = nextIndex < SR_STEPS_DAYS.length
      ? SR_STEPS_DAYS[nextIndex]
      : Math.round(st.interval * SR_GROWTH_FACTOR);
    st.reps += 1;
  } else {
    st.interval = 1;
    st.reps = Math.max(0, st.reps - 1);
  }

  const due = new Date();
  due.setDate(due.getDate() + st.interval);
  st.dueDate = due.toISOString().split('T')[0];

  data[id] = st;
  _srSaveAll(data);

  // Đồng bộ lên Supabase (best-effort, không chặn UI) — ghi đè, vì đây là
  // tiến độ mới nhất vừa xảy ra trên chính thiết bị này.
  srSyncWordToSupabase(id, st, { isFirstLearn: false });
}

// ============================================================
//  SRS SYNC (write-through, best-effort) — Option A trong 2 phương án
//  đã thống nhất: localStorage VẪN LÀ NGUỒN ĐỌC CHÍNH trên chính thiết bị
//  (app không đọc lại vocab_srs_progress để chạy SRS). Việc ghi lên Supabase
//  ở đây CHỈ phục vụ mục đích: cho Admin xem được tiến độ học viên qua
//  countStudentLearnedVocab()/countStudentDueToday() (admin.js) — không đồng
//  bộ đa thiết bị, không khôi phục dữ liệu khi mất localStorage.
//
//  Điểm mở rộng cho Option B (khi số học viên tăng, cần đồng bộ đa thiết bị
//  thật sự): thay _srGetAll()/_srSaveAll() để đọc/ghi qua Supabase làm nguồn
//  chính (có thể giữ localStorage làm cache/fallback offline), và xóa cờ
//  SR_SYNCED_FLAG_KEY vì lúc đó không còn khái niệm "đồng bộ 1 lần" nữa.
// ============================================================
const SR_SYNCED_FLAG_KEY = 'sr_synced_v1';

// Ghi 1 dòng tiến độ SRS lên Supabase — không throw ra ngoài, chỉ log lỗi,
// vì đây là thao tác phụ (không được phép làm hỏng trải nghiệm Flashcard/Ôn
// tập chính nếu mất mạng hoặc Supabase lỗi).
//
// opts.isFirstLearn = true  -> dùng ignoreDuplicates: true (không ghi đè nếu
//   Supabase đã có dòng này từ trước, vd. từ thiết bị khác/lần backfill trước
//   — tránh reset nhầm tiến độ đã có về "học lần đầu").
// opts.isFirstLearn = false -> ghi đè bình thường, vì đây là tiến độ mới
//   nhất vừa xảy ra thật trên thiết bị này.
async function srSyncWordToSupabase(wordId, st, opts = {}) {
  if (!state.currentUser) return; // chưa đăng nhập -> không có user_id để ghi

  const row = {
    user_id: state.currentUser.id,
    vocab_id: Number(wordId),
    interval_days: st.interval,
    due_date: st.dueDate,
    ease_factor: 2.5, // logic SM-2 hiện tại dùng SR_GROWTH_FACTOR cố định, chưa
                       // tính ease_factor động theo từng từ -> ghi mặc định cột
    last_reviewed_at: opts.isFirstLearn ? null : new Date().toISOString()
  };

  try {
    const { error } = await supabaseClient
      .from('vocab_srs_progress')
      .upsert(row, { onConflict: 'user_id,vocab_id', ignoreDuplicates: !!opts.isFirstLearn });
    if (error) throw error;
  } catch (e) {
    console.error('Lỗi đồng bộ SRS lên Supabase:', e);
  }
}

// Đồng bộ 1 LẦN DUY NHẤT/thiết bị: đẩy toàn bộ tiến độ SRS đang có sẵn trong
// localStorage (từ trước khi có tính năng sync này) lên Supabase, để Admin
// nhìn thấy ngay cả những gì học viên đã học trước đó — không phải chỉ tính
// từ nay trở đi. Dùng ignoreDuplicates: true cho MỌI dòng (kể cả dòng có vẻ
// "mới" theo local) vì đây là dữ liệu quá khứ không chắc mới hơn dữ liệu đã
// có trên Supabase (nếu học viên từng dùng thiết bị khác đã sync trước đó).
// Đánh dấu bằng SR_SYNCED_FLAG_KEY để không chạy lại mỗi lần mở app.
async function srBackfillLocalToSupabase(userId) {
  if (localStorage.getItem(SR_SYNCED_FLAG_KEY) === 'true') return;

  const data = _srGetAll();
  const wordIds = Object.keys(data);

  if (wordIds.length === 0) {
    localStorage.setItem(SR_SYNCED_FLAG_KEY, 'true');
    return;
  }

  try {
    const rows = wordIds.map(id => ({
      user_id: userId,
      vocab_id: Number(id),
      interval_days: data[id].interval,
      due_date: data[id].dueDate,
      ease_factor: 2.5
      // last_reviewed_at: bỏ trống (null) — không có mốc thời gian chính xác
      // của lần ôn gần nhất trong dữ liệu localStorage cũ.
    }));

    const { error } = await supabaseClient
      .from('vocab_srs_progress')
      .upsert(rows, { onConflict: 'user_id,vocab_id', ignoreDuplicates: true });
    if (error) throw error;

    localStorage.setItem(SR_SYNCED_FLAG_KEY, 'true');
  } catch (e) {
    console.error('Lỗi đồng bộ SRS cũ (localStorage) lên Supabase:', e);
    // Không set flag khi lỗi -> tự thử lại ở lần mở app kế tiếp.
  }
}

// Lấy danh sách từ đến hạn ôn hôm nay, từ toàn bộ vocabularyData đã load
function srGetDueWords() {
  if (typeof window.vocabularyData === 'undefined') return [];
  const data = _srGetAll();
  const today = _srToday();

  return window.vocabularyData.filter(w => {
    const st = data[String(w.id)];
    if (!st || !st.dueDate) return false; // chưa từng học -> không tính vào "ôn tập"
    return st.dueDate <= today;
  });
}

// Đếm nhanh số từ đến hạn hôm nay (dùng để hiện badge trên nav)
function srCountDueWords() {
  return srGetDueWords().length;
}

// ============================================================
//  DEVICE LOGGING (âm thầm ghi nhận loại thiết bị học viên dùng)
//  Mục đích: quan sát hành vi đa thiết bị trước khi quyết định
//  có cần xây sync qua Supabase ở giai đoạn sau hay không.
// ============================================================
function logDeviceVisit() {
  try {
    const ua = navigator.userAgent || '';
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const deviceType = isMobile ? 'mobile' : 'desktop';

    const payload = {
      deviceType,
      platform: navigator.platform || '',
      screenWidth: window.screen ? window.screen.width : null,
      timestamp: new Date().toISOString()
    };

    // Lưu local tối đa 50 bản ghi gần nhất
    const log = JSON.parse(localStorage.getItem('device_log') || '[]');
    log.push(payload);
    if (log.length > 50) log.shift();
    localStorage.setItem('device_log', JSON.stringify(log));

    // Gửi lên Supabase nếu đã cấu hình URL
    if (STUDENT_CONFIG.deviceLogUrl) {
      fetch(STUDENT_CONFIG.deviceLogUrl, {
        method: 'POST',
        headers: {
          'apikey': STUDENT_CONFIG.supabaseAnonKey,
          'Authorization': `Bearer ${STUDENT_CONFIG.supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          device_type: payload.deviceType,
          platform: payload.platform,
          screen_width: payload.screenWidth,
          visited_at: payload.timestamp
        })
      }).catch(() => {});
    }
  } catch (e) {
    console.error('Lỗi log thiết bị:', e);
  }
}

// 2. Cấu hình — tập trung toàn bộ thông tin kết nối tại đây
const STUDENT_CONFIG = {
  // Supabase (Test)
  supabaseUrl: "https://zlblylqosqwnhudeivpt.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsYmx5bHFvc3F3bmh1ZGVpdnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mzk0NjUsImV4cCI6MjA5ODExNTQ2NX0.Xa8FblRuypm_eHMGz8GrCpwloKnzjgjTu8z_1ivS8_4",
  vocabUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/vocabulary?order=id.asc",
  deviceLogUrl: "https://zlblylqosqwnhudeivpt.supabase.co/rest/v1/device_logs"
};

// ============================================================
//  SUPABASE AUTH — lớp xác thực bao ngoài toàn bộ app
//  Dùng chung 1 Supabase client (supabaseClient) cho auth; các API call
//  REST khác (vocabulary, device_logs...) vẫn giữ nguyên cách gọi fetch()
//  trực tiếp với apikey/Authorization như code cũ, không đổi.
// ============================================================

// window.supabase là global do CDN supabase-js@2 tạo ra (chứa hàm createClient).
// Đặt tên biến instance là supabaseClient để tránh nhầm với global đó.
const supabaseClient = window.supabase.createClient(
  STUDENT_CONFIG.supabaseUrl,
  STUDENT_CONFIG.supabaseAnonKey
);

// Lưu tạm thông tin user đã đăng nhập vào biến JS (không dùng localStorage/
// sessionStorage) — session thật sự do supabase-js tự quản lý nội bộ.
let currentUser = null;

// Kiểm tra phiên đăng nhập hiện có (vd sau khi F5 lại trang).
// Nếu còn hợp lệ -> bỏ qua màn hình đăng nhập, vào thẳng app.
// Nếu không -> hiện màn hình đăng nhập.
async function initAuth() {
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    if (session) {
      currentUser = session.user;
      showAppRoot();
      initApp();
    } else {
      showLoginScreen();
    }
  } catch (err) {
    console.error('Lỗi kiểm tra phiên đăng nhập:', err);
    showLoginScreen();
  }
}

// Lắng nghe thay đổi trạng thái đăng nhập (vd: token hết hạn, đăng xuất ở tab khác)
// để đồng bộ lại giao diện mà không cần F5 thủ công.
//
// QUAN TRỌNG: supabaseClient tự động làm mới access_token ngầm khi hết hạn
// (mặc định sau 1 giờ), nhưng việc đó chỉ cập nhật bên TRONG supabaseClient —
// không tự động cập nhật state.currentUser.access_token mà sbAuthHeaders()
// đang dùng cho các lệnh fetch() thủ công (quiz_attempts, vocab_review_log,
// study_sessions). Nếu không lắng nghe TOKEN_REFRESHED ở đây, học viên giữ
// tab mở quá 1 giờ sẽ bị mọi lệnh ghi đó trả về 401 (token cũ đã hết hạn),
// dù supabaseClient.from(...) ở chỗ khác (vd vocab_srs_progress) vẫn hoạt
// động bình thường vì nó tự quản lý token đúng cách.
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    currentUser = null;
    showLoginScreen();
  } else if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
    if (session && session.user && state.currentUser) {
      state.currentUser.access_token = session.access_token;
    }
  }
});

function showLoginScreen() {
  const loginScreen = document.getElementById('login-screen');
  const appRoot = document.getElementById('app-root');
  if (loginScreen) loginScreen.style.display = 'flex';
  if (appRoot) appRoot.style.display = 'none';
}

function showAppRoot() {
  const loginScreen = document.getElementById('login-screen');
  const appRoot = document.getElementById('app-root');
  if (loginScreen) loginScreen.style.display = 'none';
  if (appRoot) appRoot.style.display = 'block';
}

// Gắn sự kiện submit cho form đăng nhập (#login-form trong index.html)
function initLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit-btn');

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Đang đăng nhập...';

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

      if (error) {
        // Thông báo lỗi chung chung — không tiết lộ email có tồn tại hay không,
        // tránh bị dò email (user enumeration). Supabase mặc định đã trả về
        // cùng 1 loại lỗi ("Invalid login credentials") cho cả 2 trường hợp
        // sai email lẫn sai mật khẩu, nên chỉ cần hiển thị thông báo chung.
        console.error('Lỗi đăng nhập:', error.message);
        errorEl.textContent = 'Email hoặc mật khẩu không đúng.';
        return;
      }

      // Đăng nhập thành công — supabase-js tự lưu session (không cần tự lưu tay).
      const { data: userData, error: userError } = await supabaseClient.auth.getUser();
      if (userError) throw userError;

      currentUser = userData.user;
      form.reset();
      showAppRoot();
      initApp();
    } catch (err) {
      console.error('Lỗi không xác định khi đăng nhập:', err);
      errorEl.textContent = 'Có lỗi xảy ra, vui lòng thử lại.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Đăng nhập';
    }
  });
}

// Gọi từ nút "Đăng xuất" trong header (xem index.html)
async function logoutUser() {
  try {
    await supabaseClient.auth.signOut();
  } catch (err) {
    console.error('Lỗi khi đăng xuất:', err);
  } finally {
    // Tải lại trang cho sạch toàn bộ state trong bộ nhớ (units, accordion,
    // quiz, flashcard...) — đơn giản và an toàn hơn là tự reset tay từng state.
    location.reload();
  }
}

// Tên cột Supabase phải khớp với: id, unit, part, kanji, kana, romaji, hanviet, meaning, example, audio

// Lấy session hiện tại (nếu học viên đã đăng nhập) và lưu tối giản vào state —
// chỉ giữ id + access_token, không lưu cả object session để tránh phình state.
// supabaseClient ở đây tái sử dụng client đã khởi tạo sẵn ở lớp SUPABASE AUTH
// phía trên (không tạo thêm client thứ 2).
async function getCurrentSession() {
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    if (session && session.user) {
      state.currentUser = {
        id: session.user.id,
        access_token: session.access_token
      };
    } else {
      state.currentUser = null;
    }
  } catch (e) {
    console.error('Lỗi lấy session hiện tại:', e);
    state.currentUser = null;
  }
}

// Header dùng chung cho các request REST tới Supabase cần xác thực người dùng
// (insert/upsert vào vocab_srs_progress, vocab_review_log, v.v. ở các bước sau).
// Nếu chưa có session (chưa đăng nhập), fallback về anon key cho Authorization.
function sbAuthHeaders() {
  const token = (state.currentUser && state.currentUser.access_token)
    ? state.currentUser.access_token
    : STUDENT_CONFIG.supabaseAnonKey;

  return {
    'apikey': STUDENT_CONFIG.supabaseAnonKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// 3. Nạp dữ liệu từ Supabase
async function initApp() {
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang tải dữ liệu...';

  // Kiểm tra cache — tránh gọi API mỗi lần load trang
  const cachedData = localStorage.getItem('vocab_cache');
  const cacheTime  = localStorage.getItem('vocab_cache_time');
  const ONE_HOUR   = 3600000;

  if (cachedData && cacheTime && (Date.now() - parseInt(cacheTime) < ONE_HOUR)) {
    window.vocabularyData = JSON.parse(cachedData);
    await getCurrentSession();
    startUI();
    return;
  }

  // Fetch từ Supabase REST API
  try {
    const response = await fetch(STUDENT_CONFIG.vocabUrl, {
      headers: {
        'apikey':        STUDENT_CONFIG.supabaseAnonKey,
        'Authorization': `Bearer ${STUDENT_CONFIG.supabaseAnonKey}`,
        'Content-Type':  'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Supabase trả về lỗi: ${response.status} ${response.statusText}`);
    }

    // Supabase trả về JSON array trực tiếp — không cần mapping như Google Sheet
    const rows = await response.json();
    window.vocabularyData = rows.filter(item => item.id);

    // Lưu cache
    localStorage.setItem('vocab_cache', JSON.stringify(window.vocabularyData));
    localStorage.setItem('vocab_cache_time', Date.now().toString());

    await getCurrentSession();
    startUI();
  } catch (err) {
    console.error("Lỗi tải:", err);
    // Fallback: nếu có cache cũ (dù hết hạn) thì vẫn dùng, tránh trang trắng
    if (cachedData) {
      window.vocabularyData = JSON.parse(cachedData);
      await getCurrentSession();
      startUI();
      if (progressEl) progressEl.textContent = '⚠️ Dùng dữ liệu cũ (offline)';
    } else {
      if (progressEl) progressEl.textContent = '❌ Lỗi kết nối!';
    }
  }
}

// Hàm này để tách biệt việc khởi tạo giao diện
// ============================================================
//  DEBUG PANEL — công cụ test Spaced Repetition NGAY TRONG APP
//  Kích hoạt: thêm ?debug=sr vào cuối URL, ví dụ:
//  https://your-site.vercel.app/?debug=sr
//  Học viên bình thường không thấy gì cả vì không ai gõ tham số này.
// ============================================================
function isDebugMode() {
  return new URLSearchParams(window.location.search).get('debug') === 'sr';
}

function renderDebugPanel() {
  if (!isDebugMode()) return; // không làm gì nếu không bật debug

  const panel = document.createElement('div');
  panel.id = 'sr-debug-panel';
  panel.style.cssText = `
    position: fixed; bottom: 16px; right: 16px; z-index: 9999;
    background: var(--paper-card, #fff); border: 1px solid var(--line, #ddd);
    border-radius: 12px; padding: 14px; width: 280px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.15); font-family: var(--font-ui, sans-serif);
    font-size: 12.5px; color: var(--ink, #222); max-height: 80vh; overflow-y: auto;
  `;
  panel.innerHTML = `
    <div style="font-weight:700; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      🧪 SR Debug Panel
      <button onclick="document.getElementById('sr-debug-panel').remove()" style="border:none;background:none;cursor:pointer;font-size:14px;">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:6px;">
      <button class="sr-debug-btn" onclick="srDebugForceAllDueToday()">⏩ Ép tất cả từ về "đến hạn hôm nay"</button>
      <button class="sr-debug-btn" onclick="srDebugSimulateDaysPassed()">📅 Giả lập trôi qua N ngày</button>
      <button class="sr-debug-btn" onclick="srDebugRunFullTest()">🧪 Chạy bộ test đầy đủ (xem Console)</button>
      <button class="sr-debug-btn" onclick="srDebugInspect()">🔍 Xem dữ liệu sr_vocab hiện tại</button>
      <button class="sr-debug-btn" style="color:#c0392b;" onclick="srDebugClearAll()">🗑️ Xóa toàn bộ sr_vocab (reset sạch)</button>
    </div>
    <div id="sr-debug-output" style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--line,#ddd); white-space:pre-wrap; max-height:240px; overflow-y:auto; font-family:monospace; font-size:11px;"></div>
  `;
  document.body.appendChild(panel);

  // Style nhanh cho nút trong panel, không cần đụng vào style.css chính
  const style = document.createElement('style');
  style.textContent = `
    .sr-debug-btn {
      padding: 7px 10px; border-radius: 7px; border: 1px solid var(--line, #ddd);
      background: var(--paper-soft, #f7f7f5); cursor: pointer; text-align: left; font-size: 12px;
    }
    .sr-debug-btn:hover { background: var(--paper-card, #fff); }
  `;
  document.head.appendChild(style);
}

function _srDebugLog(msg) {
  const out = document.getElementById('sr-debug-output');
  if (out) out.textContent = msg;
  console.log(msg);
}

// Nút 1: ép toàn bộ từ đã học về due = hôm nay, để vào "Ôn tập" thấy ngay
function srDebugForceAllDueToday() {
  const data = _srGetAll();
  const today = _srToday();
  const count = Object.keys(data).length;
  Object.keys(data).forEach(id => { data[id].dueDate = today; });
  _srSaveAll(data);
  updateReviewBadge();
  _srDebugLog(`✅ Đã ép ${count} từ về dueDate = ${today}.\nBấm "Ôn tập hôm nay" trên nav để kiểm tra.`);
}

// Nút 2: giả lập N ngày trôi qua (đẩy lùi dueDate của toàn bộ từ về quá khứ)
function srDebugSimulateDaysPassed() {
  const n = parseInt(prompt('Giả lập đã trôi qua bao nhiêu ngày?', '7'), 10);
  if (isNaN(n)) return;
  const data = _srGetAll();
  Object.keys(data).forEach(id => {
    const d = new Date(data[id].dueDate);
    d.setDate(d.getDate() - n);
    data[id].dueDate = d.toISOString().split('T')[0];
  });
  _srSaveAll(data);
  updateReviewBadge();
  _srDebugLog(`✅ Đã đẩy lùi dueDate của toàn bộ từ về sớm hơn ${n} ngày.\nSố từ đến hạn ngay bây giờ: ${srCountDueWords()}`);
}

// Nút 3: chạy bộ test logic đầy đủ — in kết quả ra Console (giữ chi tiết ở đó vì khá dài)
function srDebugRunFullTest() {
  if (typeof srRunFullTestSuite !== 'function') {
    _srDebugLog('⚠️ Chưa nạp bộ test đầy đủ. Hãy chắc rằng file sr_test_script.js đã được include, hoặc dùng 3 nút còn lại để test nhanh.');
    return;
  }
  _srDebugLog('🧪 Đang chạy... xem chi tiết trong tab Console (F12).');
  srRunFullTestSuite();
}

// Nút 4: xem nhanh dữ liệu hiện có, không cần mở Console
function srDebugInspect() {
  const data = _srGetAll();
  const today = _srToday();
  const lines = Object.entries(data).map(([id, st]) => {
    const isDue = st.dueDate <= today ? '🔴 ĐẾN HẠN' : '⚪ chưa';
    return `${id}: interval=${st.interval} reps=${st.reps} due=${st.dueDate} ${isDue}`;
  });
  _srDebugLog(lines.length ? lines.join('\n') : '(chưa có từ nào trong sr_vocab)');
}

// Nút 5: dọn sạch để test lại từ đầu
function srDebugClearAll() {
  if (!confirm('Xóa toàn bộ dữ liệu Spaced Repetition? (chỉ ảnh hưởng máy/trình duyệt này)')) return;
  localStorage.removeItem(SR_STORAGE_KEY);
  updateReviewBadge();
  _srDebugLog('🗑️ Đã xóa sạch sr_vocab.');
}


function startUI() {
  const units = getUnits();
  if (units.length > 0) {
    state.activeUnit = units[0];
    renderUnitTabs(units);
    renderUnitContent();
    updateGlobalProgress();
    updateReviewBadge(); // hiện số từ cần ôn hôm nay (Spaced Repetition), an toàn nếu badge chưa có trong HTML
    switchMainSection('vocab'); // panel mặc định khi mở app — thay cho class "active" viết cứng trong HTML
    renderDebugPanel(); // chỉ hiện khi URL có ?debug=sr, không ảnh hưởng học viên bình thường

    // Streak: chỉ tải khi đã đăng nhập, không chặn phần render UI phía trên
    if (state.currentUser) {
      loadStreakData(state.currentUser.id);
      // Đẩy 1 lần dữ liệu SRS cũ (đã có sẵn trong localStorage từ trước khi
      // có tính năng sync) lên Supabase — best-effort, không chặn UI, tự
      // đánh dấu đã chạy qua SR_SYNCED_FLAG_KEY nên chỉ thực sự gọi Supabase
      // ở lần mở app đầu tiên sau khi tính năng này được triển khai.
      srBackfillLocalToSupabase(state.currentUser.id);
    }

    // Ẩn loading nếu bạn có dùng overlay
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }
}

// ============================================================
//  STREAK (chuỗi ngày học liên tiếp)
// ============================================================

// computeStreakFromDates() và computeBestStreak() giờ nằm ở streak-utils.js
// (hàm thuần, dùng chung với admin.js) — file đó PHẢI được load TRƯỚC
// app.js trong index.html, xem thẻ <script src="streak-utils.js"> đặt
// trước <script src="app.js">.

// Fetch dữ liệu hoạt động của user từ 2 nguồn (Review flashcard + Quiz):
// - 90 ngày gần nhất -> streak hiện tại + heatmap 90 ô, 5 mức độ (Prompt 7.4).
// - Toàn bộ lịch sử (không giới hạn ngày) -> best streak (Prompt 7.1).
// - study_sessions 7 ngày gần nhất -> phút học, số phiên, số từ đã ôn tuần này (Prompt 7.2).
async function loadStreakData(userId) {
  const summaryEl = document.getElementById('streak-summary');
  const gridEl = document.getElementById('streak-grid');
  const currentStreakEl = document.getElementById('streak-current');
  const bestStreakEl = document.getElementById('streak-best');

  try {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const sinceStr = since.toISOString().split('T')[0];

    const reviewLogUrl = `${STUDENT_CONFIG.supabaseUrl}/rest/v1/vocab_review_log?user_id=eq.${userId}&reviewed_at=gte.${sinceStr}&select=reviewed_at`;
    const quizAttemptsUrl = `${STUDENT_CONFIG.supabaseUrl}/rest/v1/quiz_attempts?user_id=eq.${userId}&answered_at=gte.${sinceStr}&select=answered_at`;

    // Toàn bộ lịch sử, không có điều kiện gte -> dùng cho computeBestStreak()
    const reviewLogAllUrl = `${STUDENT_CONFIG.supabaseUrl}/rest/v1/vocab_review_log?user_id=eq.${userId}&select=reviewed_at`;
    const quizAttemptsAllUrl = `${STUDENT_CONFIG.supabaseUrl}/rest/v1/quiz_attempts?user_id=eq.${userId}&select=answered_at`;

    const [reviewRes, quizRes, reviewAllRes, quizAllRes] = await Promise.all([
      fetch(reviewLogUrl, { headers: sbAuthHeaders() }),
      fetch(quizAttemptsUrl, { headers: sbAuthHeaders() }),
      fetch(reviewLogAllUrl, { headers: sbAuthHeaders() }),
      fetch(quizAttemptsAllUrl, { headers: sbAuthHeaders() })
    ]);

    if (!reviewRes.ok) throw new Error(`Lỗi tải vocab_review_log: ${reviewRes.status}`);
    if (!quizRes.ok) throw new Error(`Lỗi tải quiz_attempts: ${quizRes.status}`);
    if (!reviewAllRes.ok) throw new Error(`Lỗi tải vocab_review_log (toàn bộ): ${reviewAllRes.status}`);
    if (!quizAllRes.ok) throw new Error(`Lỗi tải quiz_attempts (toàn bộ): ${quizAllRes.status}`);

    const reviewRows = await reviewRes.json();
    const quizRows = await quizRes.json();
    const reviewAllRows = await reviewAllRes.json();
    const quizAllRows = await quizAllRes.json();

    // reviewed_at đã là "YYYY-MM-DD" (date). answered_at là timestamptz -> cắt lấy phần ngày.
    const reviewDates = reviewRows.map(r => r.reviewed_at);
    const quizDates = quizRows.map(r => String(r.answered_at).split('T')[0]);
    const allDates = [...reviewDates, ...quizDates];

    // Đếm số dòng log/ngày (gộp cả 2 nguồn) -> dùng để tính mức độ đậm nhạt ô heatmap.
    const dateCountMap = new Map();
    allDates.forEach(d => {
      dateCountMap.set(d, (dateCountMap.get(d) || 0) + 1);
    });

    const { streak } = computeStreakFromDates(allDates);

    // Best streak — dùng toàn bộ lịch sử, không giới hạn 90 ngày
    const reviewDatesAll = reviewAllRows.map(r => r.reviewed_at);
    const quizDatesAll = quizAllRows.map(r => String(r.answered_at).split('T')[0]);
    const bestStreak = computeBestStreak([...reviewDatesAll, ...quizDatesAll]);

    if (summaryEl) {
      summaryEl.textContent = streak > 0
        ? `🔥 ${streak} ngày liên tục`
        : 'Bắt đầu chuỗi ngày học của bạn!';
    }

    if (currentStreakEl) currentStreakEl.textContent = streak;
    if (bestStreakEl) bestStreakEl.textContent = bestStreak;

    // Render heatmap 90 ô — mỗi ô là 1 ngày, từ 89 ngày trước đến hôm nay.
    // Mức độ (level-0 .. level-4) tính theo % so với count cao nhất trong tập dữ liệu.
    if (gridEl) {
      const maxCount = Math.max(0, ...dateCountMap.values());

      const getLevel = (count) => {
        if (count === 0 || maxCount === 0) return 0;
        const pct = count / maxCount;
        if (pct <= 0.25) return 1;
        if (pct <= 0.50) return 2;
        if (pct <= 0.75) return 3;
        return 4;
      };

      const cells = [];
      for (let i = 89; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dStr = d.toISOString().split('T')[0];
        const count = dateCountMap.get(dStr) || 0;
        const level = getLevel(count);
        cells.push(`<div class="streak-cell level-${level}" title="${dStr}: ${count} hoạt động"></div>`);
      }
      gridEl.innerHTML = cells.join('');
    }
  } catch (err) {
    console.error('Lỗi tải dữ liệu streak:', err);
    if (summaryEl) {
      summaryEl.textContent = '—';
    }
    if (currentStreakEl) currentStreakEl.textContent = '—';
    if (bestStreakEl) bestStreakEl.textContent = '—';
    if (gridEl) {
      gridEl.innerHTML = '';
    }
  }

  // study_sessions 7 ngày gần nhất — phút học, số phiên, số từ đã ôn tuần này.
  // Tách try/catch riêng để lỗi ở phần này không làm hỏng phần streak phía trên.
  try {
    const since7 = new Date();
    since7.setDate(since7.getDate() - 7);
    const since7Str = since7.toISOString();

    const sessionsUrl = `${STUDENT_CONFIG.supabaseUrl}/rest/v1/study_sessions?user_id=eq.${userId}&started_at=gte.${since7Str}&select=session_type,word_count,duration_seconds`;
    const res = await fetch(sessionsUrl, { headers: sbAuthHeaders() });
    if (!res.ok) throw new Error(`Lỗi tải study_sessions: ${res.status}`);

    const rows = await res.json();

    const totalMinutes = Math.round(
      rows.reduce((sum, r) => sum + (r.duration_seconds || 0), 0) / 60
    );
    const totalSessions = rows.length;
    const totalWords = rows.reduce((sum, r) => sum + (r.word_count || 0), 0);

    // #streak-week hiện số phút học tuần này (chỉ 1 ô theo HTML Prompt 7.3) —
    // số phiên/số từ vẫn tính sẵn ở đây, log ra console để dùng khi có thêm ô hiển thị.
    const weekEl = document.getElementById('streak-week');
    if (weekEl) weekEl.textContent = `${totalMinutes} phút`;

    console.log(`[study_sessions 7 ngày] phiên: ${totalSessions}, từ đã ôn: ${totalWords}, phút: ${totalMinutes}`);
  } catch (err) {
    console.error('Lỗi tải thống kê study_sessions 7 ngày:', err);
  }
}
// ============================================================
//  DASHBOARD HỌC VIÊN — tự xem tiến độ (% Vocab đã học, số từ cần
//  ôn hôm nay). Logic tính toán copy/refactor nguyên từ admin/admin.js
//  (loadStudentDetail, countStudentLearnedVocab, countStudentDueToday)
//  để đảm bảo cùng 1 định nghĩa "đã học"/"đến hạn" giữa Admin xem và
//  học viên tự xem. email/full_name/jlpt_level đều nằm chung trong
//  bảng profiles (đã gộp, không còn bảng student_profiles riêng).
//  Render vào #student-progress-view (dùng chung markup/CSS với Admin).
// ============================================================

async function countStudentLearnedVocab(userId) {
  const { count, error } = await supabaseClient
    .from('vocab_srs_progress')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) throw error;
  return count || 0;
}

async function countStudentDueToday(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { count, error } = await supabaseClient
    .from('vocab_srs_progress')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .lte('due_date', today);

  if (error) throw error;
  return count || 0;
}

// Tổng số từ vựng — dùng vocabularyData đã load sẵn trong state (initApp)
// thay vì gọi lại Supabase. Lọc theo level nếu vocabularyData có cột level,
// nếu không thì fallback về tổng toàn bộ.
function countVocabByLevelLocal(jlptLevel) {
  if (typeof window.vocabularyData === 'undefined') return 0;
  if (!jlptLevel) return window.vocabularyData.length;

  const hasLevelField = window.vocabularyData.some(w => w.level !== undefined);
  if (!hasLevelField) return window.vocabularyData.length;

  return window.vocabularyData.filter(w => w.level === jlptLevel).length;
}

// ════════════════════════════════════════════════════════════
// DASHBOARD HỌC VIÊN — tạm comment out toàn bộ khối này.
// Trang index.html hiện không còn menu/section Dashboard nào gọi tới
// openDashboard() nữa. Đồng thời learnedCount bên dưới phụ thuộc
// countStudentLearnedVocab() đọc từ bảng vocab_srs_progress, bảng này
// chưa được ghi ở bất kỳ đâu trong code (SRS thật đang lưu ở
// localStorage phía client) nên luôn ra 0. Giữ nguyên logic, chỉ
// comment out để tắt tính năng cho tới khi quyết định hướng sửa.
//
// // Dùng chung với Admin (admin/admin.js): isAdminView=false khi học viên tự
// // xem — giữ tham số này để chuẩn bị Phase 3.
// async function loadStudentDetail(userId, isAdminView = true, jlptLevel = null) {
//   const totalVocab = countVocabByLevelLocal(jlptLevel);
//
//   const [learnedCount, dueToday] = await Promise.all([
//     countStudentLearnedVocab(userId),
//     countStudentDueToday(userId)
//   ]);
//
//   const pct = totalVocab > 0 ? Math.round((learnedCount / totalVocab) * 100) : 0;
//   const fractionEl = document.getElementById('sp-vocab-fraction');
//   const fillEl = document.getElementById('sp-vocab-progress-fill');
//   const dueEl = document.getElementById('sp-due-today');
//   if (fractionEl) fractionEl.textContent = `${learnedCount}/${totalVocab}`;
//   if (fillEl) fillEl.style.width = `${pct}%`;
//   if (dueEl) dueEl.textContent = dueToday;
//
//   return { totalVocab, learnedCount, dueToday };
// }
//
// // Mở trang #dashboard — lấy userId từ session hiện tại rồi gọi loadStudentDetail(userId, false).
// async function openDashboard() {
//   switchMainSection('dashboard');
//
//   const nameEl = document.getElementById('sp-student-name');
//   const levelEl = document.getElementById('sp-student-level');
//   const fractionEl = document.getElementById('sp-vocab-fraction');
//   const dueEl = document.getElementById('sp-due-today');
//
//   if (fractionEl) fractionEl.textContent = 'Đang tải...';
//   if (dueEl) dueEl.textContent = '—';
//
//   try {
//     const { data: userData, error: userError } = await supabaseClient.auth.getUser();
//     if (userError) throw userError;
//
//     const userId = userData?.user?.id;
//     if (!userId) throw new Error('Không tìm thấy phiên đăng nhập hiện tại.');
//
//     // profiles đã gộp đủ cột — không cần bảng student_profiles riêng nữa.
//     const { data: profile, error: profileError } = await supabaseClient
//       .from('profiles')
//       .select('full_name, jlpt_level')
//       .eq('id', userId)
//       .maybeSingle();
//     if (profileError) throw profileError;
//
//     if (nameEl) nameEl.textContent = profile?.full_name || currentUser?.email || '(chưa có tên)';
//     if (levelEl) levelEl.textContent = profile?.jlpt_level ? `Level ${profile.jlpt_level}` : 'Chưa có level';
//
//     await loadStudentDetail(userId, false, profile?.jlpt_level || null);
//   } catch (err) {
//     console.error('Lỗi tải Dashboard:', err);
//     if (fractionEl) fractionEl.textContent = '❌ Lỗi tải dữ liệu';
//   }
// }


document.addEventListener('DOMContentLoaded', () => {
  logDeviceVisit(); // ghi nhận thiết bị mỗi lần học viên mở app — không chặn luồng chính
  initLoginForm();  // gắn sự kiện submit cho form đăng nhập
  initAuth();       // kiểm tra phiên đăng nhập -> tự vào app hoặc hiện màn hình đăng nhập
});

function switchMainSection(sectionId) {
  document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.main-nav-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('section-' + sectionId);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.main-nav-btn').forEach(b => {
    if (b.dataset.section === sectionId) b.classList.add('active');
  });
}

function s(v) { return (v !== undefined && v !== null && v !== '') ? String(v) : '—'; }

// Từ chỉ có Kana (không có Kanji) sẽ có w.kanji là null/undefined/'' hoặc '—'
// Dùng hàm này thay vì so sánh trực tiếp `w.kanji !== '—'` để tránh hiển thị "null".
function hasKanji(w) {
  return !!(w && w.kanji && w.kanji !== '—');
}
function displayKanjiOrKana(w) {
  return hasKanji(w) ? w.kanji : w.kana;
}

function escAttr(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function escId(str) {
  return encodeURIComponent(str).replace(/%/g, '_');
}

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _digits(str) {
  const m = String(str || '').match(/\d+/);
  return m ? m[0] : '0';
}

// Helper dùng chung cho mặt trước Flashcard (cả Vocab thường lẫn Ôn tập):
// Nếu từ có Kanji -> hiện Kanji như bình thường.
// Nếu từ KHÔNG có Kanji (chỉ tồn tại ở dạng kana, vd: けが) -> hiện
// chính chữ Kana đó thay vì hiển thị placeholder text "Kana Only".
function getFrontCardDisplay(word) {
  const hasKanji = word.kanji && word.kanji !== '—';
  if (hasKanji) {
    return `<div class="card-kanji">${word.kanji}</div>`;
  }
  // Không có kanji: dùng kana làm chữ chính, giữ cỡ chữ to như kanji
  // để bố cục card không bị lệch trọng tâm giữa các từ có/không có kanji.
  return `<div class="card-kanji">${s(word.kana)}</div>`;
}

function buildAudioPath(wordObj) {
  if (wordObj.audio) return `audio/${wordObj.audio}`;
  const u = _digits(wordObj.unit);
  const p = _digits(wordObj.part);
  // Dùng word_index (không phải id) để khớp đúng quy ước đặt tên file audio
  // mà admin.js đang hướng dẫn học viên/admin khi thu âm (buildAudioFilenamePreview).
  // id và word_index có thể lệch nhau sau khi xóa từ/import CSV, nên KHÔNG dùng id ở đây.
  return `audio/u${u}_p${p}_word-${wordObj.word_index}.mp3`;
}

function getUnits() {
  if (typeof window.vocabularyData === 'undefined') return [];
  
  // Lấy danh sách Unit, sau đó dùng .filter để loại bỏ những tên rác
  const units = [...new Set(window.vocabularyData.map(w => w.unit))];
  
  return units
    .filter(u => u && u !== "unit" && u !== "Unit") // Dòng này sẽ loại bỏ cái tên "unit" thừa
    .sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'}));
}

function getPartsForUnit(unitName) {
  if (typeof vocabularyData === 'undefined') return [];
  const filtered = vocabularyData.filter(w => w.unit === unitName);
  const parts = [...new Set(filtered.map(w => w.part))];
  return parts.sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'}));
}

function getWords(unitName, partName) {
  return vocabularyData.filter(w => w.unit === unitName && w.part === partName);
}

function renderUnitTabs(units) {
  const bar = document.getElementById('unit-tabs-bar');
  if (!bar) return;
  
  bar.innerHTML = units.map(u => {
    const totalWords = vocabularyData.filter(w => w.unit === u).length;
    const activeClass = (u === state.activeUnit) ? 'active' : '';
    return `
      <button class="unit-tab ${activeClass}" onclick="selectUnit('${escAttr(u)}')">
        ${u} <span class="unit-word-count">${totalWords}</span>
      </button>
    `;
  }).join('');
}

function selectUnit(unitName) {
  stopAllAudio();
  state.activeUnit = unitName;
  renderUnitTabs(getUnits());
  renderUnitContent();
}

function toggleAccordion(unit, part) {
  const partKey = `${unit}_${part}`;
  const el = document.getElementById(`acc-item-${escAttr(partKey)}`);
  if (!el) return;
  
  // Nếu đã mở thì đóng lại
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    stopAllAudio(); // dừng audio nếu đang phát khi đóng accordion
    if (state.activeAccordion[unit] === part) {
      state.activeAccordion[unit] = null;
    }
  } else {
    // Đóng các item khác trong cùng unit
    if (state.activeAccordion[unit]) {
      const prev = document.getElementById(`acc-item-${escId(unit)}_${escId(state.activeAccordion[unit])}`);
      if (prev) prev.classList.remove('open');
    }
    
    // Mở item được chọn
    el.classList.add('open');
    state.activeAccordion[unit] = part;
    
    const curTab = state.activeSubTab[partKey] || 'study';
    buildWorkspacePanels(partKey, curTab);
  }
}
function renderUnitContent() {
  const wrap = document.getElementById('unit-content-wrap');
  if (!wrap) return;
  
  const unit = state.activeUnit;
  const parts = getPartsForUnit(unit);
  
  if (parts.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No data available for this Unit.</div>`;
    return;
  }
  
  let html = `<div class="parts-container">`;
  
  parts.forEach((p, idx) => {
    const partKey = `${unit}_${p}`;
    
    // Mặc định ban đầu sẽ đóng hết, chỉ mở khi người dùng chủ động click
    const isOpen = (state.activeAccordion[unit] === p);
    
    const savedScore = localStorage.getItem(`quiz_${partKey}`);
    let badgeHtml = `<div class="progress-badge not-started">Not Started</div>`;
    let fillWidth = '0%';
    let partialClass = '';
    
    if (savedScore !== null) {
      const [score, total] = savedScore.split('/').map(Number);
      if (total > 0) {
        fillWidth = `${(score / total) * 100}%`;
        if (score === total) {
          badgeHtml = `<div class="progress-badge complete">✓ Passed (${score}/${total})</div>`;
        } else {
          badgeHtml = `<div class="progress-badge in-progress">${score}/${total}</div>`;
          partialClass = 'partial';
        }
      }
    }
    
    const curTab = state.activeSubTab[partKey] || 'study';
    
    html += `
      <div class="accordion-item ${isOpen ? 'open' : ''}" id="acc-item-${escAttr(partKey)}">
        <button class="accordion-header" onclick="toggleAccordion('${escAttr(unit)}', '${escAttr(p)}')">
          <span class="accordion-chevron">▶</span>
          <span class="accordion-part-label">${p}</span>
          <div class="accordion-meta">
            ${badgeHtml}
            <div class="progress-bar-mini">
              <div class="progress-bar-mini-fill ${partialClass}" style="width: ${fillWidth}"></div>
            </div>
          </div>
        </button>
        <div class="accordion-body">
          <div class="workspace">
            <div class="sub-tabs-bar">
              <button class="sub-tab ${curTab === 'study' ? 'active' : ''}" id="tab-btn-${partKey}-study" onclick="switchSubTab('${escAttr(partKey)}', 'study')"><span class="tab-icon">📖</span> Study & Listen</button>
              <button class="sub-tab ${curTab === 'card' ? 'active' : ''}" id="tab-btn-${partKey}-card" onclick="switchSubTab('${escAttr(partKey)}', 'card')"><span class="tab-icon">🎴</span> Flashcard</button>
              <button class="sub-tab ${curTab === 'quiz' ? 'active' : ''}" id="tab-btn-${partKey}-quiz" onclick="switchSubTab('${escAttr(partKey)}', 'quiz')"><span class="tab-icon">📝</span> Quiz</button>
            </div>
            <div class="sub-tabs-panels" id="panels-${escAttr(partKey)}">
            </div>
          </div>
        </div>
      </div>
    `;
  });
  
  html += `</div>`;
  wrap.innerHTML = html;

  // Chỉ dựng Workspace panel cho những bài nào đang thực sự được mở
  parts.forEach((p, idx) => {
    const partKey = `${unit}_${p}`;
    const isOpen = (state.activeAccordion[unit] === p);
    if (isOpen) {
      const curTab = state.activeSubTab[partKey] || 'study';
      buildWorkspacePanels(partKey, curTab);
    }
  });
}

function switchSubTab(partKey, tabName) {
  stopAllAudio();
  state.activeSubTab[partKey] = tabName;
  
  const container = document.getElementById(`panels-${partKey}`);
  if (!container) return;
  
  [`study`, `card`, `quiz`].forEach(t => {
    const btn = document.getElementById(`tab-btn-${partKey}-${t}`);
    if (btn) btn.classList.toggle('active', t === tabName);
  });

  buildWorkspacePanels(partKey, tabName);
}

function buildWorkspacePanels(partKey, activeTab) {
  const container = document.getElementById(`panels-${partKey}`);
  if (!container) return;
  
  const [u, p] = partKey.split('_');
  const words = getWords(u, p);
  
  let studyActive = activeTab === 'study' ? 'active' : '';
  let cardActive  = activeTab === 'card' ? 'active' : '';
  let quizActive  = activeTab === 'quiz' ? 'active' : '';

  let rowsHtml = words.map((w, index) => {
    return `
      <tr id="row-${partKey}-${w.id}">
        <td class="cell-num">${index + 1}</td>
        <td class="cell-kanji">${s(w.kanji)}</td>
        <td class="cell-kana">${s(w.kana)}</td>
        <td class="cell-meaning">
          <div style="font-weight:600; color:var(--ink)">${s(w.meaning)}</div>
          <div style="font-size:12px; color:var(--ink-mute); margin-top:2px;">${s(w.hanviet)}</div>
        </td>
        <td class="cell-example">${s(w.example)}</td>
        <td class="cell-action">
          <button class="quiz-listen-btn" style="width:32px; height:32px; font-size:13px;" onclick="playSingleAudio(${w.id}, '${buildAudioPath(w)}', '${partKey}')">🎵</button>
        </td>
      </tr>
    `;
  }).join('');

  let studyHtml = `
    <div class="sub-panel ${studyActive}">
      <div class="study-toolbar">
        <div class="study-toolbar-left">
          <button class="btn btn-primary" id="btn-autoplay-${partKey}" onclick="toggleAutoplay('${partKey}')">▶ Autoplay Audio</button>
        </div>
      </div>
      <table class="word-table">
        <thead>
          <tr>
            <th style="width:40px">#</th>
            <th>Kanji</th>
            <th>Kana</th>
            <th>Meaning</th>
            <th>Example</th>
            <th style="width:48px; text-align:center">Audio</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  let cardHtml = `
    <div class="sub-panel ${cardActive}">
      <div class="flashcard-area" id="flashcard-zone-${partKey}"></div>
    </div>
  `;

  let quizHtml = `
    <div class="sub-panel ${quizActive}">
      <div class="quiz-mode-selector">
        <button class="quiz-mode-btn active" id="mode-btn-${partKey}-k2m" onclick="changeQuizMode('${partKey}', 'k2m')">Kanji ➔ Meaning</button>
        <button class="quiz-mode-btn" id="mode-btn-${partKey}-f2k" onclick="changeQuizMode('${partKey}', 'f2k')">Kana ➔ Kanji</button>
        <button class="quiz-mode-btn" id="mode-btn-${partKey}-m2k" onclick="changeQuizMode('${partKey}', 'm2k')">Meaning ➔ Kanji</button>
      </div>
      <div class="quiz-area" id="quiz-zone-${partKey}"></div>
      <div class="quiz-review-screen" id="quiz-review-${partKey}"></div>
    </div>
  `;

  container.innerHTML = studyHtml + cardHtml + quizHtml;

  if (activeTab === 'card') initFlashcardEngine(partKey);
  if (activeTab === 'quiz') initQuizEngine(partKey);
}

function stopAllAudio() {
  state.isAutoplay = false;
  // Tăng token để "vô hiệu hóa" mọi callback (onended/onerror/setTimeout) của
  // audio cũ đang bay lơ lửng — tránh việc chúng vẫn chạy tiếp sau khi đã stop.
  state.autoplayToken = (state.autoplayToken || 0) + 1;
  document.querySelectorAll("[id^='btn-autoplay-']").forEach(b => b.textContent = '▶ Autoplay Audio');
  document.querySelectorAll('.word-table tbody tr').forEach(r => r.classList.remove('playing'));
  stopCurrentAudio();
}

// Dừng hẳn audio hiện tại: pause + gỡ toàn bộ handler + clear src, để tránh
// tình trạng audio cũ vẫn tiếp tục tải/phát ngầm và bắn onended muộn sau khi
// track kế tiếp đã bắt đầu (nguyên nhân gây phát đè / nhảy cóc bài).
function stopCurrentAudio() {
  if (state.currentAudio) {
    state.currentAudio.onended = null;
    state.currentAudio.onerror = null;
    state.currentAudio.pause();
    state.currentAudio.src = '';
    state.currentAudio = null;
  }
}

function playSingleAudio(wordId, path, partKey) {
  if (state.isAutoplay) stopAllAudio();

  document.querySelectorAll('.word-table tbody tr').forEach(r => r.classList.remove('playing'));
  const row = document.getElementById(`row-${partKey}-${wordId}`);
  if (row) row.classList.add('playing');

  stopCurrentAudio();

  state.currentAudio = new Audio(path);
  state.currentAudio.onended = () => { if (row) row.classList.remove('playing'); };
  state.currentAudio.onerror = () => { if (row) row.classList.remove('playing'); };
  state.currentAudio.play().catch(e => console.log(e));
}

function toggleAutoplay(partKey) {
  if (state.isAutoplay) { stopAllAudio(); return; }
  stopCurrentAudio();

  state.isAutoplay = true;
  state.autoplayToken = (state.autoplayToken || 0) + 1;
  const btn = document.getElementById(`btn-autoplay-${partKey}`);
  if (btn) btn.textContent = '⏹ Stop Autoplay';

  const [u, p] = partKey.split('_');
  const words = getWords(u, p);
  
  state.playlist = words.map(w => ({ id: w.id, path: buildAudioPath(w) }));
  state.playlistIndex = 0;
  
  runAutoplayCycle(partKey, state.autoplayToken);
}

function runAutoplayCycle(partKey, token) {
  // Nếu đã stop hoặc một chu kỳ autoplay mới khác đã bắt đầu (token đổi),
  // bỏ qua ngay — đây là chốt chặn chính chống việc 2 audio chạy song song.
  if (!state.isAutoplay || token !== state.autoplayToken || state.playlistIndex >= state.playlist.length) {
    stopAllAudio();
    return;
  }

  document.querySelectorAll('.word-table tbody tr').forEach(r => r.classList.remove('playing'));
  const targetItem = state.playlist[state.playlistIndex];
  const row = document.getElementById(`row-${partKey}-${targetItem.id}`);
  if (row) {
    row.classList.add('playing');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Dừng dứt điểm audio của track trước khi tạo audio mới cho track tiếp theo.
  stopCurrentAudio();

  state.currentAudio = new Audio(targetItem.path);

  // An toàn: một số trình duyệt không bắn 'error' đáng tin cậy khi file audio
  // không tồn tại (404) — audio "treo" im lặng mãi mãi, không phát cũng không
  // báo lỗi, khiến autoplay bị đứng lại ở đúng từ đó thay vì đi tiếp.
  //
  // Thay vì dùng 1 mốc thời gian cố định (sẽ cắt ngang các file dài hơn mốc
  // đó), ta theo dõi "có tiến triển hay không": mỗi khi trình duyệt xác nhận
  // đã load được audio (loadedmetadata/canplay) hoặc đang thực sự phát tiến
  // (timeupdate), ta reset lại đồng hồ đếm ngược. Track chỉ bị coi là "treo"
  // và tự động bỏ qua khi KHÔNG có bất kỳ tiến triển nào trong suốt một
  // khoảng thời gian — tức file thực sự lỗi/không tồn tại — nên file audio
  // dài bao nhiêu cũng luôn được phát trọn vẹn.
  const STALL_LIMIT_MS = 6000;
  let advanced = false;
  let watchdog = null;

  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
  const resetWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(advanceOnce, STALL_LIMIT_MS);
  };

  function advanceOnce() {
    if (advanced || token !== state.autoplayToken) return;
    advanced = true;
    clearWatchdog();
    if (row) row.classList.remove('playing');
    state.playlistIndex++;
    setTimeout(() => runAutoplayCycle(partKey, token), 400);
  }

  resetWatchdog();

  state.currentAudio.onended = advanceOnce;
  state.currentAudio.onerror = advanceOnce;
  state.currentAudio.onabort = advanceOnce;

  // Có tiến triển thật sự -> reset đồng hồ, không cắt ngang track đang phát
  state.currentAudio.onloadedmetadata = resetWatchdog;
  state.currentAudio.oncanplay = resetWatchdog;
  state.currentAudio.ontimeupdate = resetWatchdog;
  state.currentAudio.onplaying = resetWatchdog;

  state.currentAudio.play().catch(advanceOnce);
}

function initFlashcardEngine(partKey) {
  state.sessionStartTimes[partKey] = new Date().toISOString();

  const [u, p] = partKey.split('_');
  const words = _shuffle(getWords(u, p)).slice(0, 20); 

  state.flashcardState[partKey] = {
    index: 0,
    cards: words,
    remembered: 0,
    notYet: 0,
    notYetList: [],
    isFinished: false
  };

  // Spaced Repetition: đánh dấu các từ trong Part này là "đã học lần đầu"
  // (chỉ áp dụng cho từ chưa từng có trong sr_vocab, không ghi đè lịch sử ôn cũ)
  srMarkWordsAsLearned(words);

  renderFlashcard(partKey);
}

function renderFlashcard(partKey) {
  const zone = document.getElementById(`flashcard-zone-${partKey}`);
  if (!zone) return;

  const fState = state.flashcardState[partKey];
  if (!fState || fState.cards.length === 0) {
    zone.innerHTML = `<div class="empty-state">No flashcards available.</div>`;
    return;
  }

  if (fState.isFinished) {
    renderFlashcardReport(partKey);
    return;
  }

  const idx = fState.index;
  const currentWord = fState.cards[idx];
  const progressPct = ((idx) / fState.cards.length) * 100;

  zone.innerHTML = `
    <div class="flashcard-counter">Card <span>${idx + 1}</span> of <span>${fState.cards.length}</span></div>
    
    <div class="flashcard-scene" id="card-scene-${partKey}" onclick="this.classList.toggle('flipped')">
      <div class="flashcard-inner">
        <div class="card-face card-front">
          ${getFrontCardDisplay(currentWord)}
          <div class="card-example">${s(currentWord.example)}</div>
          <div style="margin-top: 12px;" onclick="event.stopPropagation();">
             <button class="card-listen-btn-front" style="background:#fff; color:var(--ink); border-color:#fff;" onclick="playSingleAudio(${currentWord.id}, '${buildAudioPath(currentWord)}', '${partKey}')">🎵</button>
          </div>
          <div class="flip-hint" style="color:rgba(255,255,255,0.3); margin-top:16px;">Click card to flip</div>
        </div>
        
        <div class="card-face card-back" onclick="event.stopPropagation();">
          <div class="card-kana-big">${s(currentWord.kana)}</div>
          <div class="card-hanviet">${s(currentWord.hanviet)}</div>
          <div class="card-meaning">${s(currentWord.meaning)}</div>
          <div class="flip-hint" style="margin-top:16px;" onclick="document.getElementById('card-scene-${partKey}').classList.toggle('flipped')">Click to turn back</div>
        </div>
      </div>
    </div>

    <div class="flashcard-actions">
      <button class="btn btn-action-notyet" onclick="evaluateFlashcard('${partKey}', false)">❌ Not Yet</button>
      <button class="btn btn-action-remember" onclick="evaluateFlashcard('${partKey}', true)">✓ Remember</button>
    </div>

    <div class="flashcard-nav" style="margin-top:5px;">
      <div class="flashcard-progress-bar" style="width: 260px;">
        <div class="flashcard-progress-fill" style="width: ${progressPct}%"></div>
      </div>
    </div>
  `;
}

function evaluateFlashcard(partKey, isRemembered) {
  const fState = state.flashcardState[partKey];
  if (!fState) return;

  const currentWord = fState.cards[fState.index];
  if (isRemembered) { fState.remembered++; } else { fState.notYet++; fState.notYetList.push(currentWord); }

  // Spaced Repetition: ghi nhận kết quả để tính lại lịch ôn tiếp theo cho từ này
  srUpdateWordState(currentWord.id, isRemembered);

  // Ghi log hoạt động vào vocab_review_log — chỉ 1 lần khi phiên Flashcard
  // hoàn tất (không ghi mỗi thẻ), chỉ ghi khi đã đăng nhập.
  if (fState.index + 1 >= fState.cards.length) {
    if (state.currentUser) {
      fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/vocab_review_log`, {
        method: 'POST',
        headers: sbAuthHeaders(),
        body: JSON.stringify({
          user_id: state.currentUser.id,
          vocab_id: currentWord.id,
          reviewed_at: new Date().toISOString().split('T')[0]
        })
      }).catch(err => console.error('Lỗi ghi vocab_review_log:', err));

      fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/study_sessions`, {
        method: 'POST',
        headers: sbAuthHeaders(),
        body: JSON.stringify({
          user_id: state.currentUser.id,
          session_type: 'flashcard',
          part_key: partKey,
          word_count: fState.cards.length,
          started_at: state.sessionStartTimes[partKey],
          ended_at: new Date().toISOString()
        })
      }).catch(err => console.error('Lỗi ghi study_sessions:', err));
    }
  }

  if (fState.index + 1 < fState.cards.length) {
    fState.index++;
    renderFlashcard(partKey);
  } else {
    fState.isFinished = true;
    renderFlashcardReport(partKey);
  }
}

function renderFlashcardReport(partKey) {
  const zone = document.getElementById(`flashcard-zone-${partKey}`);
  if (!zone) return;
  const fState = state.flashcardState[partKey];

  let listItemsHtml = fState.notYetList.map(w => `
    <div class="notyet-item">
      <span><strong>${displayKanjiOrKana(w)}</strong>${hasKanji(w) ? ` (${w.kana})` : ''}</span>
      <span style="color:var(--vermillion); text-align:right;">${w.meaning}</span>
    </div>
  `).join('');

  if (fState.notYetList.length === 0) {
    listItemsHtml = `<div class="empty-state" style="padding:15px;">🎉 Tuyệt vời! Bạn đã thuộc toàn bộ từ vựng!</div>`;
  }

  zone.innerHTML = `
    <div class="flashcard-report">
      <h3 style="text-align:center; font-size:18px; color:var(--ink);">📊 KẾT QUẢ ÔN TẬP</h3>
      <div class="report-grid">
        <div class="report-box remembered">
          <span class="report-num">${fState.remembered}</span>
          <span class="report-title">Remember</span>
        </div>
        <div class="report-box notyet">
          <span class="report-num">${fState.notYet}</span>
          <span class="report-title">Not Yet</span>
        </div>
      </div>
      <h4 style="font-size:13px; margin-top:15px; color:var(--ink-soft);">📝 Danh sách từ chưa nhớ cần ôn lại:</h4>
      <div class="notyet-list">${listItemsHtml}</div>
      <div style="margin-top:20px; text-align:center;">
        <button class="btn btn-outline" style="width:100%; justify-content:center;" onclick="initFlashcardEngine('${partKey}')">🔄 Restart Session</button>
      </div>
    </div>
  `;
}

function changeQuizMode(partKey, newMode) {
  [`k2m`, `f2k`, `m2k`].forEach(m => {
    const btn = document.getElementById(`mode-btn-${partKey}-${m}`);
    if (btn) btn.classList.toggle('active', m === newMode);
  });
  initQuizEngine(partKey, newMode);
}

function initQuizEngine(partKey, mode = 'k2m') {
  state.sessionStartTimes[partKey] = new Date().toISOString();

  const [u, p] = partKey.split('_');
  let words = _shuffle(getWords(u, p));

  // Kanji ➔ Meaning: ẩn các từ chỉ có Kana (không có Kanji) vì không phù hợp
  // với dạng câu hỏi này (tránh hiển thị "null"/kana thay Kanji).
  if (mode === 'k2m') {
    words = words.filter(w => hasKanji(w));
  }

  state.quizState[partKey] = {
    index: 0,
    score: 0,
    quizMode: mode, 
    questions: words.map(w => {
      let questionMain = '';
      let questionSub = '';
      let correctAnswer = '';
      let optionPool = [];

      switch(mode) {
        case 'f2k':
          questionMain = w.kana;
          questionSub = w.meaning;
          correctAnswer = displayKanjiOrKana(w);
          optionPool = vocabularyData.map(item => displayKanjiOrKana(item));
          break;
        case 'm2k':
          questionMain = w.meaning;
          questionSub = `(${w.hanviet})`;
          correctAnswer = displayKanjiOrKana(w);
          optionPool = vocabularyData.map(item => displayKanjiOrKana(item));
          break;
        case 'k2m':
        default:
          questionMain = w.kanji;
          questionSub = w.kana;
          correctAnswer = w.meaning;
          optionPool = vocabularyData.map(item => item.meaning);
          break;
      }

      const cleanPool = [...new Set(optionPool.filter(opt => opt !== correctAnswer))];
      const distractors = _shuffle(cleanPool).slice(0, 3);
      const choices = _shuffle([correctAnswer, ...distractors]);

      return { 
        word: w, 
        questionMain: questionMain,
        questionSub: questionSub,
        correctAnswer: correctAnswer,
        choices: choices, 
        selected: null, 
        status: 'unanswered' 
      };
    })
  };

  document.getElementById(`quiz-zone-${partKey}`).style.display = 'flex';
  document.getElementById(`quiz-review-${partKey}`).style.display = 'none';

  renderQuizQuestion(partKey);
}

function renderQuizQuestion(partKey) {
  const zone = document.getElementById(`quiz-zone-${partKey}`);
  const quiz = state.quizState[partKey];
  if (!zone || !quiz) return;

  if (quiz.questions.length === 0) {
    zone.innerHTML = `<div class="empty-state">No question sets found for this mode.</div>`;
    return;
  }

  const q = quiz.questions[quiz.index];
  const progressPct = (quiz.index / quiz.questions.length) * 100;
  const labels = ['A', 'B', 'C', 'D'];

  zone.innerHTML = `
    <div class="quiz-header">
      <div class="quiz-progress-track">
        <div class="quiz-progress-fill" style="width: ${progressPct}%"></div>
      </div>
      <div class="quiz-score">Score: ${quiz.score}/${quiz.questions.length}</div>
    </div>

    <div class="quiz-card">
      <div class="quiz-question-label">
        <span class="quiz-q-number">Q${quiz.index + 1}</span> Multiple Choice Quiz
      </div>
      
      <div class="quiz-word-display">
        <div>
          <div class="quiz-word-main">${q.questionMain}</div>
        </div>
        <button class="quiz-listen-btn" onclick="playSingleAudio(${q.word.id}, '${buildAudioPath(q.word)}', '${partKey}')">🎵</button>
      </div>

      <div class="quiz-choices">
        ${q.choices.map((c, i) => {
          let btnClass = '';
          if (q.status !== 'unanswered') {
            if (c === q.correctAnswer) btnClass = 'correct';
            else if (c === q.selected) btnClass = 'wrong';
          }
          const isDisabled = q.status !== 'unanswered' ? 'disabled' : '';
          return `
            <button class="choice-btn ${btnClass}" ${isDisabled} onclick="submitQuizAnswer('${partKey}', '${escAttr(c)}')">
              <span class="choice-label">${labels[i]}</span> ${s(c)}
            </button>
          `;
        }).join('')}
      </div>

      ${q.status !== 'unanswered' ? `
        <div style="margin-top:20px; display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" onclick="nextQuizQuestion('${partKey}')">
            ${quiz.index + 1 === quiz.questions.length ? 'Finish Quiz' : 'Next Question ➜'}
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

function submitQuizAnswer(partKey, answerStr) {
  const quiz = state.quizState[partKey];
  if (!quiz) return;
  const q = quiz.questions[quiz.index];
  if (q.status !== 'unanswered') return;

  q.selected = answerStr;
  if (answerStr === q.correctAnswer) { q.status = 'correct'; quiz.score++; } else { q.status = 'wrong'; }
  renderQuizQuestion(partKey);
}

function nextQuizQuestion(partKey) {
  const quiz = state.quizState[partKey];
  if (!quiz) return;
  if (quiz.index + 1 < quiz.questions.length) { quiz.index++; renderQuizQuestion(partKey); } else { evaluateQuizEnd(partKey); }
}

function evaluateQuizEnd(partKey) {
  document.getElementById(`quiz-zone-${partKey}`).style.display = 'none';
  const review = document.getElementById(`quiz-review-${partKey}`);
  if (!review) return;
  
  const quiz = state.quizState[partKey];
  const total = quiz.questions.length;
  const score = quiz.score;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  localStorage.setItem(`quiz_${partKey}`, `${score}/${total}`);
  updateGlobalProgress();
  refreshBadgeOnAccordion(partKey, score, total);

  // Ghi log kết quả Quiz lên Supabase — nhánh riêng, không chặn luồng render UI phía dưới.
  if (state.currentUser) {
    const attemptsPayload = quiz.questions.map(q => ({
      user_id: state.currentUser.id,
      vocab_id: q.word.id,
      is_correct: q.status === 'correct'
    }));

    fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/quiz_attempts`, {
      method: 'POST',
      headers: sbAuthHeaders(),
      body: JSON.stringify(attemptsPayload)
    }).catch(err => console.error('Lỗi ghi quiz_attempts:', err));

    // 1 dòng đại diện vào vocab_review_log để ngày đó tính vào streak
    if (quiz.questions.length > 0) {
      fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/vocab_review_log`, {
        method: 'POST',
        headers: sbAuthHeaders(),
        body: JSON.stringify({
          user_id: state.currentUser.id,
          vocab_id: quiz.questions[0].word.id,
          reviewed_at: new Date().toISOString().split('T')[0]
        })
      }).catch(err => console.error('Lỗi ghi vocab_review_log:', err));
    }

    fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/study_sessions`, {
      method: 'POST',
      headers: sbAuthHeaders(),
      body: JSON.stringify({
        user_id: state.currentUser.id,
        session_type: 'quiz',
        part_key: partKey,
        word_count: quiz.questions.length,
        started_at: state.sessionStartTimes[partKey],
        ended_at: new Date().toISOString()
      })
    }).catch(err => console.error('Lỗi ghi study_sessions:', err));
  }

  let emoji = '🎉'; let title = 'Excellent Work!';
  if (pct < 50) { emoji = '🩹'; title = 'Keep Practicing!'; } else if (pct < 80) { emoji = '👍'; title = 'Good Effort!'; }

  review.style.display = 'block';
  review.innerHTML = `
    <div class="review-emoji">${emoji}</div>
    <div class="review-title">${title}</div>
    <div class="review-sub">You finished the quiz for this section!</div>
    <div class="review-stats">
      <div class="review-stat"><span class="review-stat-val green">${score}</span><span class="review-stat-label">Correct</span></div>
      <div class="review-stat"><span class="review-stat-val red">${total - score}</span><span class="review-stat-label">Wrong</span></div>
      <div class="review-stat"><span class="review-stat-val" style="color:var(--ink)">${pct}%</span><span class="review-stat-label">Accuracy</span></div>
    </div>
    <button class="btn btn-outline" onclick="initQuizEngine('${partKey}', '${quiz.quizMode}')">🔄 Retry Quiz</button>
  `;
}

function refreshBadgeOnAccordion(partKey, score, total) {
  const item = document.getElementById(`acc-item-${partKey}`);
  if (!item) return;
  const meta = item.querySelector('.accordion-meta');
  if (!meta) return;

  const width = `${(score / total) * 100}%`;
  let badgeClass = 'in-progress'; let partialClass = 'partial'; let label = `${score}/${total}`;
  if (score === total) { badgeClass = 'complete'; partialClass = ''; label = `✓ Passed (${score}/${total})`; }

  meta.innerHTML = `
    <div class="progress-badge ${badgeClass}">${label}</div>
    <div class="progress-bar-mini"><div class="progress-bar-mini-fill ${partialClass}" style="width: ${width}"></div></div>
  `;
}

function updateGlobalProgress() {
  const el = document.getElementById('global-progress');
  if (!el || typeof vocabularyData === 'undefined') return;
  let passedCount = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('quiz_')) {
      const val = localStorage.getItem(key);
      if (val) {
        const [score, total] = val.split('/').map(Number);
        if (score === total && total > 0) passedCount++;
      }
    }
  }
  el.innerHTML = `Total Progress: <strong>${passedCount}</strong> Section(s) Passed`;
}

function syncData() {
  const btn = document.getElementById('sync-btn');
  btn?.classList.add('rotating'); // Bắt đầu hiệu ứng xoay (an toàn nếu #sync-btn không tồn tại trong HTML)
  
  // Thông báo cho người dùng
  const progressEl = document.getElementById('global-progress');
  if (progressEl) progressEl.textContent = 'Đang đồng bộ lại dữ liệu...';

  // Xóa bộ nhớ đệm
  localStorage.removeItem('vocab_cache');
  localStorage.removeItem('vocab_cache_time');

  // Gọi lại hàm initApp để tải mới hoàn toàn
  initApp().then(() => {
    btn?.classList.remove('rotating'); // Dừng xoay khi xong (an toàn nếu #sync-btn không tồn tại)
  });
}

// ============================================================
//  TRANG "ÔN TẬP HÔM NAY" (Spaced Repetition Review)
//  Tái sử dụng giao diện flashcard hiện có, khác ở nguồn dữ liệu:
//  thay vì lấy theo Part, lấy theo danh sách từ ĐẾN HẠN ôn hôm nay.
//  Yêu cầu HTML: 1 nút/khu vực gọi openReviewToday() và 1 container
//  rỗng có id="review-zone" để render vào (xem ghi chú cuối file).
// ============================================================

// Cập nhật badge số từ cần ôn hôm nay — gọi hàm này ở bất cứ đâu
// bạn muốn hiển thị con số (vd: trên nav bar, sau khi initApp xong).
function updateReviewBadge() {
  const badge = document.getElementById('review-due-badge');
  if (!badge) return; // an toàn nếu HTML chưa có phần tử này
  const count = srCountDueWords();
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// Mở phiên Ôn tập hôm nay — gọi từ nút nav "Ôn tập hôm nay" trong index.html
function openReviewToday() {
  state.sessionStartTimes['review'] = new Date().toISOString();

  const zone = document.getElementById('review-zone');
  if (!zone) {
    console.error('Không tìm thấy #review-zone trong HTML. Cần thêm 1 container rỗng với id này.');
    return;
  }

  stopAllAudio();
  switchMainSection('review'); // chuyển panel + active đúng nút nav nhờ data-section="review"

  const dueWords = _shuffle(srGetDueWords());

  state.reviewFlashcardState = {
    index: 0,
    cards: dueWords,
    remembered: 0,
    notYet: 0,
    notYetList: [],
    isFinished: dueWords.length === 0
  };

  renderReviewFlashcard();
}

function renderReviewFlashcard() {
  const zone = document.getElementById('review-zone');
  if (!zone) return;

  const rState = state.reviewFlashcardState;
  if (!rState || rState.cards.length === 0) {
    zone.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:40px 20px;">
        <div style="font-size:40px; margin-bottom:10px;">🎉</div>
        <div style="font-weight:600; color:var(--ink);">Không có từ nào cần ôn hôm nay!</div>
        <div style="color:var(--ink-mute); margin-top:6px; font-size:13px;">Quay lại vào buổi học tiếp theo nhé.</div>
      </div>
    `;
    return;
  }

  if (rState.isFinished) {
    renderReviewReport();
    return;
  }

  const idx = rState.index;
  const currentWord = rState.cards[idx];
  const progressPct = (idx / rState.cards.length) * 100;

  zone.innerHTML = `
    <div class="flashcard-counter">Ôn tập <span>${idx + 1}</span> / <span>${rState.cards.length}</span></div>

    <div class="flashcard-scene" id="review-card-scene" onclick="this.classList.toggle('flipped')">
      <div class="flashcard-inner">
        <div class="card-face card-front">
          ${getFrontCardDisplay(currentWord)}
          <div class="card-example">${s(currentWord.example)}</div>
          <div style="margin-top: 12px;" onclick="event.stopPropagation();">
             <button class="card-listen-btn-front" style="background:#fff; color:var(--ink); border-color:#fff;" onclick="playSingleAudio(${currentWord.id}, '${buildAudioPath(currentWord)}', 'review')">🎵</button>
          </div>
          <div class="flip-hint" style="color:rgba(255,255,255,0.3); margin-top:16px;">Click card to flip</div>
        </div>

        <div class="card-face card-back" onclick="event.stopPropagation();">
          <div class="card-kana-big">${s(currentWord.kana)}</div>
          <div class="card-hanviet">${s(currentWord.hanviet)}</div>
          <div class="card-meaning">${s(currentWord.meaning)}</div>
          <div class="flip-hint" style="margin-top:16px;" onclick="document.getElementById('review-card-scene').classList.toggle('flipped')">Click to turn back</div>
        </div>
      </div>
    </div>

    <div class="flashcard-actions">
      <button class="btn btn-action-notyet" onclick="evaluateReviewFlashcard(false)">❌ Chưa thuộc</button>
      <button class="btn btn-action-remember" onclick="evaluateReviewFlashcard(true)">✓ Đã thuộc</button>
    </div>

    <div class="flashcard-nav" style="margin-top:5px;">
      <div class="flashcard-progress-bar" style="width: 260px;">
        <div class="flashcard-progress-fill" style="width: ${progressPct}%"></div>
      </div>
    </div>
  `;
}

function evaluateReviewFlashcard(isRemembered) {
  const rState = state.reviewFlashcardState;
  if (!rState) return;

  const currentWord = rState.cards[rState.index];
  if (isRemembered) { rState.remembered++; } else { rState.notYet++; rState.notYetList.push(currentWord); }

  // Đây là bước quan trọng nhất: cập nhật lại lịch ôn tiếp theo cho từ này
  srUpdateWordState(currentWord.id, isRemembered);

  // Ghi log hoạt động ôn tập hôm nay vào vocab_review_log — chỉ ghi khi đã
  // đăng nhập; không kiểm tra trùng, cho phép nhiều dòng cùng ngày vì chỉ
  // cần biết "ngày đó có hoạt động hay không".
  if (state.currentUser) {
    fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/vocab_review_log`, {
      method: 'POST',
      headers: sbAuthHeaders(),
      body: JSON.stringify({
        user_id: state.currentUser.id,
        vocab_id: currentWord.id,
        reviewed_at: new Date().toISOString().split('T')[0]
      })
    }).catch(err => console.error('Lỗi ghi vocab_review_log:', err));
  }

  // Ghi study_sessions — chỉ 1 lần khi phiên Ôn tập hôm nay hoàn tất.
  if (rState.index + 1 >= rState.cards.length) {
    if (state.currentUser) {
      fetch(`${STUDENT_CONFIG.supabaseUrl}/rest/v1/study_sessions`, {
        method: 'POST',
        headers: sbAuthHeaders(),
        body: JSON.stringify({
          user_id: state.currentUser.id,
          session_type: 'review_srs',
          part_key: null,
          word_count: rState.cards.length,
          started_at: state.sessionStartTimes['review'],
          ended_at: new Date().toISOString()
        })
      }).catch(err => console.error('Lỗi ghi study_sessions:', err));
    }
  }

  if (rState.index + 1 < rState.cards.length) {
    rState.index++;
    renderReviewFlashcard();
  } else {
    rState.isFinished = true;
    renderReviewReport();
  }

  // Cập nhật lại badge số từ còn lại đến hạn (vd: trên nav)
  updateReviewBadge();
}

function renderReviewReport() {
  const zone = document.getElementById('review-zone');
  if (!zone) return;
  const rState = state.reviewFlashcardState;

  let listItemsHtml = rState.notYetList.map(w => `
    <div class="notyet-item">
      <span><strong>${displayKanjiOrKana(w)}</strong>${hasKanji(w) ? ` (${w.kana})` : ''}</span>
      <span style="color:var(--vermillion); text-align:right;">${w.meaning}</span>
    </div>
  `).join('');

  if (rState.notYetList.length === 0) {
    listItemsHtml = `<div class="empty-state" style="padding:15px;">🎉 Tuyệt vời! Bạn đã ôn xong toàn bộ từ hôm nay!</div>`;
  }

  zone.innerHTML = `
    <div class="flashcard-report">
      <h3 style="text-align:center; font-size:18px; color:var(--ink);">📊 KẾT QUẢ ÔN TẬP HÔM NAY</h3>
      <div class="report-grid">
        <div class="report-box remembered">
          <span class="report-num">${rState.remembered}</span>
          <span class="report-title">Đã thuộc</span>
        </div>
        <div class="report-box notyet">
          <span class="report-num">${rState.notYet}</span>
          <span class="report-title">Chưa thuộc</span>
        </div>
      </div>
      <h4 style="font-size:13px; margin-top:15px; color:var(--ink-soft);">📝 Từ chưa thuộc, sẽ được nhắc lại sớm hơn:</h4>
      <div class="notyet-list">${listItemsHtml}</div>
      <div style="margin-top:20px; text-align:center;">
        <button class="btn btn-outline" style="width:100%; justify-content:center;" onclick="openReviewToday()">🔄 Ôn lại từ đầu</button>
      </div>
    </div>
  `;
}

/*
  ─────────────────────────────────────────────────────────────────
  GHI CHÚ TÍCH HỢP HTML (đã áp dụng sẵn trong index.html mới):

  1) Mỗi nút trong .main-nav cần có thuộc tính data-section khớp với
     id của panel tương ứng (id="section-XXX" -> data-section="XXX").
     switchMainSection() dựa vào thuộc tính này để active đúng nút,
     không còn dò theo nội dung chữ trên nút như bản cũ.

  2) Nút "Ôn tập hôm nay" gọi openReviewToday() thay vì
     switchMainSection() trực tiếp — vì cần khởi tạo lại
     state.reviewFlashcardState mỗi lần mở. Hàm này tự gọi
     switchMainSection('review') ở bên trong.

  3) Panel "Vocab" không còn gắn class "active" cứng trong HTML —
     startUI() gọi switchMainSection('vocab') ngay khi app load xong,
     đảm bảo đúng 1 nguồn sự thật duy nhất cho việc panel nào active.
  ─────────────────────────────────────────────────────────────────
*/