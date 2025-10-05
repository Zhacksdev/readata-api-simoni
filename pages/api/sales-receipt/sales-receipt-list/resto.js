// pages/api/hotel.js
import axios from "axios";

// Helper untuk konversi YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Gunakan metode GET" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Access token tidak ditemukan di Header" });
  }

  const access_token = authHeader.split(" ")[1];
  const session_id = "0df81062-641d-42b2-b835-33aff8bb856c";
  const host = "https://zeus.accurate.id";

  // Ambil dari body meskipun GET (mirip Olsera)
  const { start_date, end_date, per_page } = req.body || {};

  const filterParams = {};

  if (start_date && end_date) {
    filterParams["filter.transDate.op"] = "BETWEEN";
    filterParams["filter.transDate.val[0]"] = convertToDMY(start_date);
    filterParams["filter.transDate.val[1]"] = convertToDMY(end_date);
  }

  if (per_page) {
    filterParams["sp.pageSize"] = per_page;
  }

  try {
    const response = await axios({
      method: "get",
      url: `${host}/accurate/api/sales-receipt/list.do`,
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "number,transDate,chequeDate,customer,bank,description,useCredit,totalPayment",
        "sp.sort": "transDate|desc",
        ...filterParams,
      },
    });

    // 🔽 Filter hanya yang deskripsinya mengandung "hotel" (case-insensitive)
    const orderedData = response.data.d
      .filter((item) =>
        (item.description || "").toLowerCase().includes("resto")
      )
      .map((item) => ({
        number: item.number,
        transDate: item.transDate,
        chequeDate: item.chequeDate,
        customerName: item.customer?.name || "-",
        bankName: item.bank?.name || "-",
        description: item.description || "-",
        useCredit: item.useCredit,
        totalPayment: item.totalPayment,
      }));

    return res.status(200).json({ orders: orderedData });
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data sales order",
    });
  }
}
