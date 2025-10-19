// pages/api/order-list.js
import axios from "axios";

/* 🧩 Helper: Konversi tanggal YYYY-MM-DD → DD/MM/YYYY */
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

/* 🧮 Helper: pastikan angka valid (hindari NaN/null/undefined) */
function safeNumber(val) {
  const num = Number(val);
  return isNaN(num) ? 0 : num;
}

/* 🔍 Ambil detail faktur (untuk pajak & nilai DPP/PPN) */
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

    // 🧾 Debug log (aktifkan jika perlu)
    if (process.env.DEBUG_ACCURATE === "true") {
      console.log(`📋 Faktur ID ${id}:`, {
        dppAmount: d.dppAmount,
        tax1Amount: d.tax1Amount,
        taxableAmount1: d.taxableAmount1,
        detailTaxCount: d.detailTax?.length || 0,
        detailItemCount: d.detailItem?.length || 0,
      });
    }

    // 🔹 Tipe Pajak — gabungan logika dari versi 1 & 2
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.find((i) => i.item?.tax1?.description)?.item.tax1.description ||
      (d.taxable === true ? "PPN" : "NON-PAJAK");

    // 🔹 DPP (Dasar Pengenaan Pajak)
    let dppAmount = 0;

    if (safeNumber(d.dppAmount) > 0) {
      dppAmount = safeNumber(d.dppAmount);
    } else if (safeNumber(d.taxableAmount1) > 0) {
      dppAmount = safeNumber(d.taxableAmount1);
    } else if (safeNumber(d.detailTax?.[0]?.taxableAmount) > 0) {
      dppAmount = safeNumber(d.detailTax[0].taxableAmount);
    } else if (Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      // Jumlahkan dari setiap item
      dppAmount = d.detailItem.reduce((sum, item) => {
        const itemDpp =
          safeNumber(item.dppAmount) ||
          safeNumber(item.salesAmountBase) ||
          safeNumber(item.grossAmount);
        return sum + itemDpp;
      }, 0);
    } else if (safeNumber(d.salesAmountBase) > 0) {
      dppAmount = safeNumber(d.salesAmountBase);
    }

    // 🔹 PPN (Pajak keluaran)
    let tax1Amount = 0;

    if (safeNumber(d.tax1Amount) > 0) {
      tax1Amount = safeNumber(d.tax1Amount);
    } else if (safeNumber(d.detailTax?.[0]?.taxAmount) > 0) {
      tax1Amount = safeNumber(d.detailTax[0].taxAmount);
    } else if (Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      tax1Amount = d.detailItem.reduce(
        (sum, item) => sum + safeNumber(item.tax1Amount),
        0
      );
    }

    // 🔁 Hasil akhir yang aman
    return {
      typePajak: typePajak || "NON-PAJAK",
      dppAmount: safeNumber(dppAmount),
      tax1Amount: safeNumber(tax1Amount),
    };
  } catch (err) {
    console.warn(`⚠️ Gagal ambil detail pajak ID ${id}:`, err.message);
    return { typePajak: "NON-PAJAK", dppAmount: 0, tax1Amount: 0 };
  }
}

/* ⚙️ Handler utama API */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Gunakan metode GET" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Access token tidak ditemukan di Header" });
  }

  const access_token = authHeader.split(" ")[1];
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;
  const { start_date, end_date, per_page } = req.body || {};

  // 🔎 Filter parameter
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
    // 🧾 Ambil daftar faktur
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

    // 🔁 Ambil pajak untuk setiap faktur secara paralel
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
          total: safeNumber(item.totalAmount),
          typePajak: taxDetail.typePajak,
          omzet: taxDetail.dppAmount,
          nilaiPPN: taxDetail.tax1Amount,
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
