'use strict';
// ============================================================
//  STREAK UTILS — hàm tính toán streak THUẦN (pure functions)
//  Dùng chung giữa trang học viên (app.js) và trang admin (admin.js).
//  File này KHÔNG chứa logic fetch Supabase, KHÔNG đụng DOM —
//  chỉ nhận mảng ngày "YYYY-MM-DD" và trả về số liệu.
//
//  Phải load file này TRƯỚC app.js và TRƯỚC admin.js trong HTML,
//  vì 2 file đó gọi thẳng 2 hàm dưới đây từ global scope.
// ============================================================

// Input: mảng ngày dạng "YYYY-MM-DD" (lấy từ vocab_review_log.reviewed_at /
//        quiz_attempts.answered_at của bảng vocab_review_log, có thể trùng lặp, không
//        cần sắp xếp trước).
// Output: { streak: number, activeDatesSet: Set<string> }
//         - activeDatesSet: Set các ngày duy nhất (đã khử trùng) từ input.
//         - streak: số ngày liên tiếp có hoạt động, đếm ngược từ hôm nay.
//           Nếu hôm nay chưa có hoạt động (chưa học/ôn gì hôm nay), streak
//           vẫn được tính bắt đầu từ hôm qua (không bị mất streak chỉ vì
//           chưa mở app hôm nay) — dừng đếm ngay khi gặp 1 ngày trống.
function computeStreakFromDates(dateStrings) {
  const activeDatesSet = new Set(dateStrings);
  const toDateStr = (d) => d.toISOString().split('T')[0];
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  let streak = 0;
  // Nếu hôm nay chưa có hoạt động, lùi mốc bắt đầu đếm về hôm qua,
  // không tính hôm nay là ngày "gãy" streak.
  if (!activeDatesSet.has(toDateStr(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (activeDatesSet.has(toDateStr(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { streak, activeDatesSet };
}

// Hàm thuần — nhận mảng ngày "YYYY-MM-DD" (có thể trùng lặp, không cần sort
// trước), trả về số nguyên = độ dài chuỗi ngày liên tiếp DÀI NHẤT từng có
// trong toàn bộ lịch sử (không nhất thiết phải liên quan tới "hôm nay",
// khác với computeStreakFromDates() ở trên).
function computeBestStreak(dateStrings) {
  const uniqueDates = [...new Set(dateStrings)].sort();
  if (uniqueDates.length === 0) return 0;

  let best = 1;
  let current = 1;

  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = new Date(uniqueDates[i - 1]);
    const cur = new Date(uniqueDates[i]);
    const diffDays = Math.round((cur - prev) / 86400000);

    if (diffDays === 1) {
      current++;
    } else if (diffDays > 1) {
      current = 1;
    }
    // diffDays === 0 (trùng ngày, không nên xảy ra vì đã unique) -> bỏ qua

    if (current > best) best = current;
  }

  return best;
}
