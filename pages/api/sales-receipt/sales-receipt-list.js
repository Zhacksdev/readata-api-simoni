import axios from "axios";

// 🔹 Helper konversi tanggal YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// 🔹 Helper format angka ke format IDR
function formatID(num) {
  if (isNaN(num)) return "-";
  return Number(num).toLocaleString("id-ID");
}

// 🔹 Ambil detail pajak dari Accurate (1 ID per request)
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

    // 🧩 Ambil deskripsi pajak dengan fallback berlapis
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.[0]?.item?.tax1?.description ||
      "NON-PAJAK";

    // 🧮 Ambil omzet (DPP) dari berbagai kemungkinan field
    const dppAmount =
      Number(d.taxableAmount1) ||
      Number(d.dppAmount) ||
      Number(d.detailTax?.[0]?.taxableAmount) ||
      0;

    // 🧾 Hitung nilai PPN (10% dari omzet)
    const tax1Amount =
      Number(d.tax1Amount) ||
      Math.round(dppAmount * 0.1) ||
      0;

    return {
      typePajak,
      dppAmount,
      tax1Amount,
    };
  } catch (err) {
    console.warn(`⚠️ Gagal ambil detail pajak ID ${id}:`, err.message);
    return { typePajak: "Gagal Ambil Data", dppAmount: 0, tax1Amount: 0 };
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
  if (per_page) filterParams["sp.pageSize"] = per_page;

  try {
    // 🧾 Ambil daftar faktur (list.do)
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

    // 🔁 Loop semua ID → ambil detail pajak dari detail.do
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
          omzet: formatID(taxDetail.dppAmount),
          nilaiPPN: formatID(taxDetail.tax1Amount),
        };
      })
    );

    // ✅ Berhasil → kirim hasil JSON rapi
    return res.status(200).json({
      success: true,
      total_data: result.length,
      orders: result,
    });
  } catch (error) {
    console.error("💥 ERROR API:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data faktur penjualan",
    });
  }
}
