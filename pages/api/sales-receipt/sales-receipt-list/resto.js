// pages/api/resto.js
import axios from "axios";

// Helper untuk konversi YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// Helper ambil detail faktur (untuk ambil pajak & nilai jika tidak ada di list)
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
    return {
      typePajak:
        detail.tax1?.description ||
        detail.detailTax?.[0]?.tax?.description ||
        "-",
      dppAmount: detail.dppAmount || 0,
      tax1Amount: detail.tax1Amount || 0,
    };
  } catch (err) {
    console.error(`Gagal ambil detail pajak ID ${id}:`, err.message);
    return {
      typePajak: "-",
      dppAmount: 0,
      tax1Amount: 0,
    };
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
          "id,number,transDate,customer,description,statusName,statusOutstanding,age,totalAmount,tax1,tax1.description,dppAmount,tax1Amount",
        "sp.sort": "transDate|desc",
        ...filterParams,
      },
    });

    const list = response.data.d || [];

    // 🔹 Lengkapi data pajak jika belum lengkap
    const restoData = (
      await Promise.all(
        list.map(async (item) => {
          let typePajak =
            item.tax1?.description ||
            item.detailTax?.[0]?.tax?.description ||
            "-";
          let dppAmount = item.dppAmount || 0;
          let tax1Amount = item.tax1Amount || 0;

          // Jika belum lengkap → ambil detail faktur
          if (typePajak === "-" || (!dppAmount && !tax1Amount)) {
            const detail = await fetchInvoiceTaxDetail(
              host,
              access_token,
              session_id,
              item.id
            );
            typePajak = detail.typePajak;
            dppAmount = detail.dppAmount;
            tax1Amount = detail.tax1Amount;
          }

          return {
            id: item.id,
            nomor: item.number,
            tanggal: item.transDate,
            pelanggan: item.customer?.name || "-",
            deskripsi: item.description || "-",
            status: item.statusName || item.statusOutstanding || "-",
            umur: item.age || 0,
            total: item.totalAmount,
            typePajak, // <- menggantikan 'pajak'
            omzet: dppAmount, // Dasar Pengenaan Pajak
            nilaiPPN: tax1Amount, // Nilai PPN
          };
        })
      )
    ).filter((item) => (item.typePajak || "").toLowerCase().includes("resto"));

    // 🔽 Kembalikan hanya data dengan pajak resto
    return res.status(200).json({ orders: restoData });
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error:
        error.response?.data ||
        "Gagal mengambil data sales invoice dengan pajak resto",
    });
  }
}
