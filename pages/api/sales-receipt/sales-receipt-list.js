import axios from "axios";

// 🔹 Helper konversi tanggal YYYY-MM-DD → DD/MM/YYYY
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
  const session_id = process.env.ACCURATE_SESSION_ID; // dari .env
  const host = process.env.ACCURATE_HOST; // dari .env

  // Ambil filter dari body (meskipun GET)
  const { start_date, end_date, per_page } = req.body || {};

  // 🔍 Filter tanggal dan page size
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
    // 🧾 Ambil daftar faktur penjualan
    const response = await axios({
      method: "get",
      url: `${host}/accurate/api/sales-invoice/list.do`,
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "id,number,transDate,customer,description,statusName,totalAmount,tax1,taxableAmount1",
        "sp.sort": "transDate|desc",
        ...filterParams,
      },
    });

    // 🧮 Mapping data agar rapi dan mudah dibaca
    const invoiceData = response.data?.d?.map((item) => {
      // Pajak
      const typePajak =
        item.searchCharField1.id || item.tax1.description || item.detailItem[0].item.tax1.description;

      // Omzet (DPP)
      const dppAmount = Number(item.taxableAmount1);

      // PPN = 10% dari omzet
      const tax1Amount = Math.round(dppAmount * 0.1);

      // Format angka ke format Indonesia
      const formatID = (num) => Number(num || 0).toLocaleString("id-ID");

      return {
        id: item.id,
        nomor: item.number,
        tanggal: item.transDate,
        pelanggan: item.customer?.name || "-",
        deskripsi: item.description || "-",
        status: item.statusName || "-",
        total: formatID(item.totalAmount),
        typePajak,
        omzet: formatID(dppAmount),
        nilaiPPN: formatID(tax1Amount),
      };
    });

    return res.status(200).json({ success: true, orders: invoiceData });
  } catch (error) {
    console.error("💥 ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data faktur penjualan",
    });
  }
}
