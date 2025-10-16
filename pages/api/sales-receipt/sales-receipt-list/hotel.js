// pages/api/hotel.js
import axios from "axios";

// Helper untuk konversi YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// Helper ambil detail faktur (untuk ambil pajak jika tidak ada di list)
async function fetchInvoiceTaxDetail(host, access_token, session_id, id) {
  try {
    const res = await axios({
      method: "get",
      url: `${host}/accurate/api/sales-invoice/detail.do`,
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: { id },
    });

    const detail = res.data?.d || {};
    return (
      detail.tax1?.description ||
      detail.detailTax?.[0]?.tax?.description ||
      "-"
    );
  } catch (err) {
    console.error(`Gagal ambil detail pajak ID ${id}:`, err.message);
    return "-";
  }
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
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;

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
    // 🔹 Ambil list faktur
    const response = await axios({
      method: "get",
      url: `${host}/accurate/api/sales-invoice/list.do`,
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "id,number,transDate,customer,description,statusName,statusOutstanding,age,totalAmount,tax1,tax1.description",
        "sp.sort": "transDate|desc",
        ...filterParams,
      },
    });

    const list = response.data.d || [];

    // 🔹 Ambil pajak dan filter khusus “PAJAK HOTEL”
    const filteredData = await Promise.all(
      list.map(async (item) => {
        let pajak =
          item.tax1?.description ||
          item.detailTax?.[0]?.tax?.description ||
          "-";

        // Jika pajak kosong, ambil dari detail faktur
        if (pajak === "-") {
          pajak = await fetchInvoiceTaxDetail(
            host,
            access_token,
            session_id,
            item.id
          );
        }

        return {
          id: item.id,
          number: item.number,
          transDate: item.transDate,
          customerName: item.customer?.name || "-",
          description: item.description || "-",
          status: item.statusName || item.statusOutstanding || "-",
          age: item.age || 0,
          totalAmount: item.totalAmount,
          pajak,
        };
      })
    );

    // 🔽 Filter hanya yang mengandung "hotel" di deskripsi pajak
    const hotelData = filteredData.filter((item) =>
      (item.pajak || "").toLowerCase().includes("hotel")
    );

    return res.status(200).json({ orders: hotelData });
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data sales invoice hotel",
    });
  }
}
