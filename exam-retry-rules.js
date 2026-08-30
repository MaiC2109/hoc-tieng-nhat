// ============================================================
//  exam-retry-rules.js
//  Hàm dùng chung để tính retry_after_days từ bảng exam_retry_rules.
//  Dùng được ở cả 2 phía:
//    - Admin (admin/exams.js, admin/results.js) — cấu hình rule, override
//    - Học viên (exam.js) — sau khi nộp bài, tính next_retry_date
//  Không tạo client Supabase mới — dựa vào biến global `supabaseClient`
//  đã được khởi tạo sẵn ở app.js (trang học viên) hoặc admin.js (trang admin).
//
//  Cần <script src="exam-retry-rules.js"></script> SAU dòng khởi tạo
//  supabaseClient và TRƯỚC file nào gọi computeRetryAfterDays().
//  (Chưa gắn vào index.html / admin/index.html ở bước này.)
// ============================================================

/**
 * Tính số ngày chờ trước khi được làm lại đề, dựa trên % điểm đạt được.
 *
 * Ưu tiên áp dụng:
 *   1. Rule riêng của đề (exam_retry_rules.exam_id = examId) có khoảng
 *      [min_score_pct, max_score_pct] chứa pct điểm.
 *   2. Nếu không có rule riêng nào khớp -> fallback rule mặc định toàn hệ
 *      thống (exam_retry_rules.exam_id IS NULL) có khoảng chứa pct điểm.
 *   3. Nếu vẫn không có rule nào khớp -> trả về null (không có gợi ý ngày
 *      retry; nơi gọi tự quyết định xử lý — vd để next_retry_date = null).
 *
 * @param {Object} params
 * @param {number} params.totalScore     - Điểm đạt được (exam_attempts.total_score)
 * @param {number} params.totalPossible  - Điểm tối đa (exam_attempts.total_possible)
 * @param {string} params.examId         - UUID của đề thi (exam_attempts.exam_id)
 * @returns {Promise<number|null>} retry_after_days, hoặc null nếu không có rule khớp
 */
async function computeRetryAfterDays({ totalScore, totalPossible, examId }) {
  if (!totalPossible || totalPossible <= 0) {
    console.error('computeRetryAfterDays: totalPossible không hợp lệ:', totalPossible);
    return null;
  }
  if (!examId) {
    console.error('computeRetryAfterDays: thiếu examId');
    return null;
  }

  const pct = Math.round((totalScore / totalPossible) * 100);

  // Lấy đồng thời rule riêng của đề (exam_id = examId) và rule mặc định
  // (exam_id IS NULL) trong 1 query duy nhất, lọc phần match ở phía client.
  const { data: rules, error } = await supabaseClient
    .from('exam_retry_rules')
    .select('exam_id, min_score_pct, max_score_pct, retry_after_days')
    .or(`exam_id.eq.${examId},exam_id.is.null`);

  if (error) {
    console.error('Lỗi tải exam_retry_rules:', error);
    return null;
  }
  if (!rules || rules.length === 0) return null;

  const isMatch = (rule) => pct >= rule.min_score_pct && pct <= rule.max_score_pct;

  // Ưu tiên 1: rule riêng của đề
  const examSpecificMatch = rules.find((r) => r.exam_id === examId && isMatch(r));
  if (examSpecificMatch) return examSpecificMatch.retry_after_days;

  // Ưu tiên 2 (fallback): rule mặc định toàn hệ thống
  const defaultMatch = rules.find((r) => r.exam_id === null && isMatch(r));
  if (defaultMatch) return defaultMatch.retry_after_days;

  // Không có rule nào khớp khoảng % điểm này
  return null;
}
