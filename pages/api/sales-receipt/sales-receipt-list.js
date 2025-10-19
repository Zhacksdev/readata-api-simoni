// pages/api/order-list.js
import axios from "axios";

// 🔹 Helper konversi tanggal YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// 🔹 Helper format angka ke format Indonesia tanpa desimal
function formatID(num) {
  if (num === null || num === undefined || isNaN(num)) return "0";
  return Math.round(num).toLocaleString("id-ID");
}

// 🔹 Ambil detail faktur (untuk ambil pajak dan nilai DPP/PPN)
async function fetchInvoiceTaxDetail(host, access_token, session_id, id) {
  try {
    const res = await axios.get(`${host}/accurate/api/sales-invoice/detail.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: { id },
    });

    const d = res.data?.d || {};

    // 🧩 Tentukan tipe pajak
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.[0]?.item?.tax1?.description ||
      (d.taxable ? "PPN" : "NON-PAJAK");

    // 🧮 Ambil DPP (Dasar Pengenaan Pajak)
    let dppAmount =
      Number(d.taxableAmount1) ||
      Number(d.dppAmount) ||
      Number(d.detailTax?.[0]?.taxableAmount) ||
      0;

    // Jika masih 0, akumulasi dari detailItem
    if (dppAmount === 0 && Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      dppAmount = d.detailItem.reduce((sum, item) => {
        const val =
          Number(item.dppAmount) ||
          Number(item.salesAmountBase) ||
          Number(item.grossAmount) ||
          0;
        return sum + val;
      }, 0);
    }

    // 🧾 Ambil langsung nilai PPN (tax1Amount)
    let tax1Amount =
      Number(d.tax1Amount) ||
      Number(d.detailTax?.[0]?.taxAmount) ||
      0;

    // Jika tidak ada, hitung manual
    if (tax1Amount === 0 && dppAmount > 0 && d.taxable) {
      tax1Amount = dppAmount * 0.1;
    }

    // 🔁 Return data mentah & format string IDR
    return {
      typePajak: typePajak || "NON-PAJAK",
      dppAmount,
      tax1Amount,
      formatted: {
        omzet: formatID(dppAmount),
        nilaiPPN: formatID(tax1Amount),
      },
    };
  } catch (err) {
    console.warn(`⚠️ Gagal ambil detail pajak ID ${id}:`, err.message);
    return {
      typePajak: "NON-PAJAK",
      dppAmount: 0,
      tax1Amount: 0,
      formatted: { omzet: "0", nilaiPPN: "0" },
    };
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

  // 🔍 Filter tanggal dan jumlah data per halaman
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
    // 🔹 Ambil daftar faktur
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

    // 🔁 Loop setiap faktur dan ambil detail pajaknya
    const result = await Promise.all(
      list.map(async (item) => {
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
          total: formatID(item.totalAmount),
          typePajak: taxDetail.typePajak,
          omzet: taxDetail.formatted.omzet,
          nilaiPPN: taxDetail.formatted.nilaiPPN,
        };
      })
    );

    return res.status(200).json({
      success: true,
      count: result.length,
      orders: result,
    });
  } catch (error) {
    console.error("💥 ERROR API:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data faktur penjualan",
    });
  }
}
