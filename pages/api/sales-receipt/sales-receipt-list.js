// pages/api/order-list.js
import axios from "axios";

// --------------------------------------------------
//  HELPER FUNCTIONS
// --------------------------------------------------

/**
 * 🔹 Konversi tanggal YYYY-MM-DD menjadi DD/MM/YYYY
 * @param {string | null | undefined} dateStr Tanggal dalam format YYYY-MM-DD
 * @returns {string | null} Tanggal dalam format DD/MM/YYYY atau null
 */
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  // Pastikan formatnya benar sebelum split
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      console.warn(`⚠️ Format tanggal tidak valid diterima: ${dateStr}`);
      return dateStr; // Kembalikan apa adanya jika format salah
  }
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * 🔹 Ambil detail faktur penjualan dari API Accurate untuk mendapatkan info pajak.
 * (Versi Gabungan v5.1 - Perbaikan Final)
 * @param {string} host URL host Accurate
 * @param {string} access_token Token otentikasi Bearer
 * @param {string} session_id ID sesi Accurate
 * @param {number} id ID faktur penjualan
 * @returns {Promise<{typePajak: string, dppAmount: number, tax1Amount: number}>}
 */
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

    // 1. Ambil Tipe Pajak (Logika Kode 1 - Paling Robust)
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.find((i) => i.item?.tax1?.description)?.item.tax1.description ||
      (d.taxable ? "PPN" : "NON-PAJAK"); // Menggunakan d.taxable?

    // 2. Ambil DPP (Logika Berlapis - Paling Lengkap)
    let dppAmount =
      Number(d.dppAmount) ||
      Number(d.taxableAmount1) ||
      Number(d.detailTax?.[0]?.taxableAmount) ||
      0;

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

    if (dppAmount === 0 && d.salesAmountBase && Number(d.salesAmountBase) > 0) {
        dppAmount = Number(d.salesAmountBase);
    }

    // 3. Ambil Nilai PPN (Logika Berlapis)
    let tax1Amount =
      Number(d.tax1Amount) ||
      Number(d.detailTax?.[0]?.taxAmount) ||
      0;

    if (tax1Amount === 0 && Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      tax1Amount = d.detailItem.reduce((sum, item) => {
        const itemTax = Number(item.tax1Amount) || 0;
        return sum + itemTax;
      }, 0);
    }

    // Pastikan hasil akhir selalu number
    return {
      typePajak: typePajak || "NON-PAJAK",
      dppAmount: Number(dppAmount) || 0,
      tax1Amount: Number(tax1Amount) || 0,
    };

  } catch (err) {
    // Log error spesifik untuk ID yang gagal
    console.warn(`⚠️ Gagal ambil detail pajak ID ${id}:`, err.response?.data?.message || err.message);
    // Kembalikan nilai default jika error
    return { typePajak: "GAGAL AMBIL", dppAmount: 0, tax1Amount: 0 };
  }
}

// --------------------------------------------------
// API HANDLER
// --------------------------------------------------
export default async function handler(req, res) {
  // 1. Validasi Metode Request
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Gunakan metode GET" });
  }

  // 2. Validasi Autentikasi
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Access token tidak ditemukan di Header Authorization" });
  }
  const access_token = authHeader.split(" ")[1];

  // 3. Ambil Konfigurasi & Parameter
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;
  // Ambil parameter dari query string (GET) bukan body (POST)
  const { start_date, end_date, per_page } = req.query || {};

  if (!session_id || !host) {
     console.error("💥 Variabel environment ACCURATE_SESSION_ID atau ACCURATE_HOST belum diatur!");
     return res.status(500).json({ error: "Konfigurasi server tidak lengkap." });
  }

  // 4. Siapkan Filter Parameter untuk API Accurate
  const filterParams = {};
  if (start_date && end_date) {
    // Validasi format YYYY-MM-DD sederhana
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
        return res.status(400).json({ error: "Format start_date atau end_date salah. Gunakan YYYY-MM-DD." });
    }
    filterParams["filter.transDate.op"] = "BETWEEN";
    // Konversi ke DD/MM/YYYY untuk API Accurate
    filterParams["filter.transDate.val[0]"] = convertToDMY(start_date);
    filterParams["filter.transDate.val[1]"] = convertToDMY(end_date);
  }
  if (per_page && Number(per_page) > 0) {
    filterParams["sp.pageSize"] = Number(per_page);
  } else {
    filterParams["sp.pageSize"] = 100; // Default page size jika tidak diset atau tidak valid
  }

  // 5. Proses Pengambilan Data
  try {
    console.log("🚀 Memulai pengambilan daftar faktur...");
    // Ambil daftar faktur, urutkan dari API (ASC = oldest first)
    const listResponse = await axios.get(`${host}/accurate/api/sales-invoice/list.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "id,number,transDate,customer.name,description,statusName,statusOutstanding,age,totalAmount", // Ambil customer.name langsung
        "sp.sort": "transDate|asc", // Urutkan dari tanggal terlama
        ...filterParams,
      },
    });

    const list = listResponse.data?.d || [];
    console.log(`✅ Daftar faktur didapatkan: ${list.length} item.`);

    if (list.length === 0) {
       return res.status(200).json({ orders: [] }); // Kembalikan array kosong jika tidak ada data
    }

    console.log(`⏳ Memulai pengambilan detail untuk ${list.length} faktur secara paralel...`);
    // Ambil detail pajak untuk setiap item secara paralel
    const resultUnsorted = await Promise.all(
      list.map(async (item) => {
        const taxDetail = await fetchInvoiceTaxDetail(
          host,
          access_token,
          session_id,
          item.id
        );

        // Data dari list API (sudah terurut ASC dari API)
        return {
          id: item.id,
          nomor: item.number || "-",
          tanggal: item.transDate, // Masih YYYY-MM-DD dari API list
          pelanggan: item.customer?.name || "-", // Ambil dari customer.name
          deskripsi: item.description || "-",
          status: item.statusName || item.statusOutstanding || "-",
          umur: item.age || 0,
          total: item.totalAmount || 0,
          // Data tambahan dari detail API
          typePajak: taxDetail.typePajak,
          omzet: taxDetail.dppAmount,
          nilaiPPN: taxDetail.tax1Amount,
        };
      })
    );
    console.log("👍 Semua detail selesai diambil.");

    // 6. Sortir Hasil Akhir (Meskipun API sudah sort ASC, Promise.all bisa mengacak)
    //    Sorting ini memastikan urutan final benar berdasarkan tanggal YYYY-MM-DD
    const resultSorted = resultUnsorted.sort((a, b) => {
        // Handle jika tanggal null atau undefined untuk keamanan
        const dateA = a.tanggal || '';
        const dateB = b.tanggal || '';
        return dateA.localeCompare(dateB);
    });

    // 7. Format Tanggal ke DD/MM/YYYY untuk output
    const finalResult = resultSorted.map(item => ({
       ...item,
       tanggal: convertToDMY(item.tanggal) // Konversi format di langkah terakhir
    }));

    console.log("🎉 Proses selesai. Mengirim respons...");
    // 8. Kirim Respons
    return res.status(200).json({ orders: finalResult });

  } catch (error) {
    // Tangani error dengan lebih detail
    console.error("💥 ERROR API:", error.response?.data || error.message);
    // Cek apakah error karena token expired (biasanya status 401)
    if (error.response?.status === 401) {
         return res.status(401).json({ error: "Autentikasi gagal. Token mungkin expired atau tidak valid.", details: error.response?.data });
    }
    // Error lainnya
    return res.status(error.response?.status || 500).json({
      error: "Gagal mengambil data faktur penjualan.",
      details: error.response?.data || error.message, // Sertakan detail error jika ada
    });
  }
}