// ✅ pages/api/order-list.js
import axios from "axios";

// 🔹 Helper konversi tanggal YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// 🔹 Ambil detail faktur lengkap dan deteksi pajak secara akurat
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

    // ==============================
    // 1️⃣ DETEKSI TIPE PAJAK
    // ==============================
    let typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.find(i => i.item?.tax1?.description)?.item.tax1?.description ||
      d.detailItem?.find(i => i.tax?.description)?.tax?.description ||
      null;

    // Fallback jika belum ditemukan
    if (!typePajak) {
      if (d.taxable === true) {
        typePajak = "PPN";
      } else if ((d.tax1Amount || 0) > 0) {
        typePajak = "PAJAK HOTEL";
      } else {
        typePajak = "NON-PAJAK";
      }
    }

    // Normalisasi label (agar rapi)
    if (/restoran/i.test(typePajak)) typePajak = "PAJAK RESTORAN";
    else if (/hotel/i.test(typePajak)) typePajak = "PAJAK HOTEL";
    else if (/ppn/i.test(typePajak)) typePajak = "PPN";
    else if (typePajak === "-" || !typePajak) typePajak = "NON-PAJAK";

    // ==============================
    // 2️⃣ HITUNG DPP (OMZET)
    // ==============================
    let dppAmount = 0;

    if (d.dppAmount > 0) {
      dppAmount = d.dppAmount;
    } else if (d.taxableAmount1 > 0) {
      dppAmount = d.taxableAmount1;
    } else if (d.detailTax?.[0]?.taxableAmount > 0) {
      dppAmount = d.detailTax[0].taxableAmount;
    } else if (Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      // Jumlahkan dari detail item
      dppAmount = d.detailItem.reduce((sum, i) => {
        const val =
          i.dppAmount ||
          i.salesAmountBase ||
          i.grossAmount ||
          i.taxableAmount ||
          0;
        return sum + Number(val);
      }, 0);
    } else if (d.salesAmountBase > 0) {
      dppAmount = d.salesAmountBase;
    }

    // ==============================
    // 3️⃣ HITUNG PPN (PAJAK KELUARAN)
    // ==============================
    let tax1Amount = 0;

    if (d.tax1Amount > 0) {
      tax1Amount = d.tax1Amount;
    } else if (d.detailTax?.[0]?.taxAmount > 0) {
      tax1Amount = d.detailTax[0].taxAmount;
    } else if (Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      tax1Amount = d.detailItem.reduce((sum, i) => {
        const val = i.tax1Amount || i.taxAmount || 0;
        return sum + Number(val);
      }, 0);
    }

    // ==============================
    // 4️⃣ VALIDASI RELASI OMZET vs PPN
    // ==============================
    // Jika ditemukan anomali (misal PPN = 0 tapi ada pajak restoran)
    if (tax1Amount === 0 && /restoran/i.test(typePajak)) {
      tax1Amount = Math.round(dppAmount * 0.1);
    }
    if (tax1Amount === 0 && /hotel/i.test(typePajak)) {
      tax1Amount = Math.round(dppAmount * 0.1);
    }

    // ==============================
    // ✅ KEMBALIKAN HASIL
    // ==============================
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

  // 🔍 Filter tanggal & page size
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
    // 🧾 Ambil daftar faktur dasar
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

    // 🔁 Loop faktur & ambil detail pajak
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
          total: item.totalAmount || 0,
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
