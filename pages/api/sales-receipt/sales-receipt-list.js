// pages/api/order-list.js
import axios from "axios";

// 🔹 Helper konversi tanggal YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// 🔹 Ambil detail faktur (Versi GABUNGAN v5 - Perbaikan Final)
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
    
    // 1. 🧩 Ambil Tipe Pajak (KEMBALI 100% KE LOGIKA KODE 1 - TERBAIK)
    //    Menggunakan .find() DAN (d.taxable ? ...)
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.find((i) => i.item?.tax1?.description)?.item.tax1.description ||
      (d.taxable ? "PPN" : "NON-PAJAK"); // ❗️ Ini adalah perbaikan dari Kode 4

    // 2. 🧮 Ambil DPP (LOGIKA BERLAPIS DARI KODE 4 - TERLENGKAP)
    // Cek field utama dulu
    let dppAmount =
      Number(d.dppAmount) ||
      Number(d.taxableAmount1) ||
      Number(d.detailTax?.[0]?.taxableAmount) ||
      0;

    // Jika masih 0, cek akumulasi detailItem
    if (dppAmount === 0 && Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      dppAmount = d.detailItem.reduce((sum, item) => {
        const itemDpp =
          Number(item.dppAmount) ||
          Number(item.salesAmountBase) ||
          Number(item.grossAmount) ||
          0;
        return sum + itemDpp;
      }, 0);
    }
    
    // Jika MASIH 0, cek fallback 'salesAmountBase' (tambahan dari Kode 2)
    if (dppAmount === 0 && d.salesAmountBase && Number(d.salesAmountBase) > 0) {
        dppAmount = Number(d.salesAmountBase);
    }

    // 3. 🧾 Ambil Nilai PPN (LOGIKA BERLAPIS DARI KODE 4)
    // Cek field utama dulu
    let tax1Amount =
      Number(d.tax1Amount) ||
      Number(d.detailTax?.[0]?.taxAmount) ||
      0;

    // Jika masih 0, cek akumulasi detailItem
    if (tax1Amount === 0 && Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      tax1Amount = d.detailItem.reduce((sum, item) => {
        const itemTax = Number(item.tax1Amount) || 0;
        return sum + itemTax;
      }, 0);
    }

    return {
      typePajak: typePajak || "NON-PAJAK",
      dppAmount: Number(dppAmount) || 0,
      tax1Amount: Number(tax1Amount) || 0,
    };
  } catch (err) {
    console.warn(`⚠️ Gagal ambil detail pajak ID ${id}:`, err.message);
    return { typePajak: "NON-PAJAK", dppAmount: 0, tax1Amount: 0 };
  }
}


// 🛑 Handler API (SAMA, TIDAK PERLU DIUBAH)
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

    const result = await Promise.all(
      list.map(async (item) => {
        // Ini akan memanggil 'fetchInvoiceTaxDetail' v5
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
          total: item.totalAmount || 0,
          typePajak: taxDetail.typePajak,
          omzet: taxDetail.dppAmount,
          nilaiPPN: taxDetail.tax1Amount,
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