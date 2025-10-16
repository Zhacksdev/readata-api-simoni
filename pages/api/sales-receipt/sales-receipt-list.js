// pages/api/order-list.js
import axios from "axios";

// Helper konversi tanggal YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// Helper ambil detail faktur (untuk ambil pajak dan nilai DPP/PPN)
async function fetchInvoiceTaxDetail(host, access_token, session_id, id) {
  try {
    const res = await axios.get(`${host}/accurate/api/sales-invoice/detail.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: { id },
    });

    const detail = res.data?.d || {};

    // Ambil type pajak dari berbagai kemungkinan
    const typePajak =
      detail.tax1?.description ||
      detail.detailTax?.[0]?.tax?.description ||
      detail.detailItem?.[0]?.item?.tax1?.description ||
      "-";

    return {
      typePajak,
      dppAmount: detail.dppAmount || 0,
      tax1Amount: detail.tax1Amount || 0,
    };
  } catch (err) {
    console.error(`❌ Gagal ambil detail pajak ID ${id}:`, err.message);
    return { typePajak: "-", dppAmount: 0, tax1Amount: 0 };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Gunakan metode GET" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access token tidak ditemukan di Header" });
  }

  const access_token = authHeader.split(" ")[1];
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;
  const { start_date, end_date, per_page } = req.body || {};

  // Filter tanggal & page size
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
    // 🔹 Ambil daftar faktur (hanya data dasar)
    const response = await axios.get(`${host}/accurate/api/sales-invoice/list.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "id,number,transDate,customer,description,statusName,statusOutstanding,age,totalAmount",
        "sp.sort": "transDate|desc",
        ...filterParams,
      },
    });

    const list = response.data?.d || [];

    // 🔹 Ambil detail untuk setiap faktur untuk memastikan data pajak lengkap
    const result = await Promise.all(
      list.map(async (item) => {
        // Langsung panggil fetchInvoiceTaxDetail untuk setiap item
        const taxDetail = await fetchInvoiceTaxDetail(
          host,
          access_token,
          session_id,
          item.id
        );

        return {
          id: item.id,
          nomor: item.number,
          tanggal: item.transDate,
          pelanggan: item.customer?.name || "-",
          deskripsi: item.description || "-",
          status: item.statusName || item.statusOutstanding || "-",
          umur: item.age || 0,
          total: item.totalAmount,
          typePajak: taxDetail.typePajak,
          omzet: taxDetail.dppAmount, // Dasar Pengenaan Pajak
          nilaiPPN: taxDetail.tax1Amount, // Nilai Pajak (PPN)
        };
      })
    );

    return res.status(200).json({ orders: result });
  } catch (error) {
    console.error("💥 ERROR API:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data faktur penjualan",
    });
  }
}