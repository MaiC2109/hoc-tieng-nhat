export default async function handler(req, res) {
  // URL thực tế của Google Sheet giờ đây nằm an toàn trên Server Vercel
  const SHEET_URL = "https://script.google.com/macros/s/AKfycbwIAqL_cJKsHgDBWdaRrpUwTBAvGzs4rnDaVVsmSzaHMkvH19ODlduBzlDfkdq9dwaw7g/exec?tab=Vocabulary";

  try {
    const response = await fetch(SHEET_URL);
    const data = await response.json();
    
    // Trả dữ liệu về cho trình duyệt (website của bạn)
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Lỗi kết nối database" });
  }
}