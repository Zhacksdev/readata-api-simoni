import axios from "axios";

// Konversi tanggal YYYY-MM-DD → DD/MM/YYYY
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// Format angka ke format Indonesia
function formatID(num) {
  if (isNaN(num)) return "0";
  return Number(num).toLocaleString("id-ID");
}

// Delay helper (ms)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi retry jika gagal
async function retry(fn, retries = 3, delayMs = 400) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < retries - 1) await delay(delayMs);
    }
  }
  throw new Error("Max retries reached");
}

// 🔹 Ambil detail faktur
async function fetchInvoiceTaxDetail(host, access_token, session_id, id) {
  return retry(async () => {
    const res = await axios.get(
      `${host}/accurate/api/sales-invoice/detail.do`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "X-Session-ID": session_id,
        },
        params: { id },
        timeout: 10000,
      }
    );

    const d = res.data?.d;
    if (!d) throw new Error("Empty response");

    // Normalisasi type pajak biar bersih dan konsisten
    let rawType =
      d.searchCharField1?.name ||
      d.searchCharField1 ||
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      "NON-PAJAK";

    if (typeof rawType !== "string") rawType = String(rawType);
    const typePajak = rawType
      .replace(/PAJAK\s*/i, "")
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase()); // hapus awalan “PAJAK ”

    const dppAmount =
      Number(d.taxableAmount1) ||
      Number(d.dppAmount) ||
      Number(d.detailTax?.[0]?.taxableAmount) ||
      0;

    const tax1Amount = Number(d.tax1Amount) || Math.round(dppAmount * 0.1) || 0;

    return { typePajak, dppAmount, tax1Amount };
  });
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

  const filterParams = {};
  if (start_date && end_date) {
    filterParams["filter.transDate.op"] = "BETWEEN";
    filterParams["filter.transDate.val[0]"] = convertToDMY(start_date);
    filterParams["filter.transDate.val[1]"] = convertToDMY(end_date);
  }
  if (per_page) filterParams["sp.pageSize"] = per_page;

  try {
    const response = await axios.get(
      `${host}/accurate/api/sales-invoice/list.do`,
      {
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
      }
    );

    const list = response.data?.d || [];
    const result = [];
    const batchSize = 5; // 🔹 maksimal 5 request paralel biar aman

    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          try {
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
              total: formatID(item.totalAmount),
              typePajak: taxDetail.typePajak, // ← sekarang pasti string: “Hotel” / “Resto”
              omzet: formatID(taxDetail.dppAmount),
              nilaiPPN: formatID(taxDetail.tax1Amount),
            };
          } catch (err) {
            console.warn(`❌ Detail gagal (ID ${item.id}):`, err.message);
            return {
              id: item.id,
              nomor: item.number,
              tanggal: item.transDate,
              pelanggan: item.customer?.name || "-",
              deskripsi: item.description || "-",
              status: item.statusName || item.statusOutstanding || "-",
              umur: item.age || 0,
              total: formatID(item.totalAmount),
              typePajak: "NON-PAJAK",
              omzet: "0",
              nilaiPPN: "0",
            };
          }
        })
      );

      result.push(...batchResults);
      await delay(700); // jeda antar batch
    }

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
