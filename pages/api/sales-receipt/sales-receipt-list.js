import axios from "axios";

// 🔹 Konversi tanggal DD/MM/YYYY → YYYY-MM-DD (response)
function convertToYMD(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split("/");
  return `${year}-${month}-${day}`;
}

// 🔹 Konversi tanggal YYYY-MM-DD → DD/MM/YYYY (filter)
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

// 🔹 Delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🔹 Retry Helper
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

// 🔹 Ambil detail pajak invoice
async function fetchInvoiceTaxDetail(host, access_token, session_id, id) {
  return retry(async () => {
    const res = await axios.get(`${host}/accurate/api/sales-invoice/detail.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: { id },
      timeout: 10000,
    });

    const d = res.data?.d;
    if (!d) throw new Error("Empty response");

    let rawType =
      d.searchCharField1?.name ||
      d.searchCharField1 ||
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      "NON-PAJAK";

    if (typeof rawType !== "string") rawType = String(rawType);
    const typePajak = rawType.replace(/PAJAK\s*/i, "").trim().toLowerCase();

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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access token tidak ditemukan di Header" });
  }

  const access_token = authHeader.split(" ")[1];
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;
  const { start_date, end_date, page = 1, per_page = 100 } = req.body || {};

  // ✅ Limit per page maksimal 1000 sesuai aturan Accurate
  const perPage = per_page > 1000 ? 1000 : per_page;

  // 🔹 Filter tanggal
  const filterParams = {};
  if (start_date && end_date) {
    filterParams["filter.transDate.op"] = "BETWEEN";
    filterParams["filter.transDate.val[0]"] = convertToDMY(start_date);
    filterParams["filter.transDate.val[1]"] = convertToDMY(end_date);
  }

  try {
    // ✅ Ambil data halaman yang diminta langsung dari Accurate
    const response = await axios.get(`${host}/accurate/api/sales-invoice/list.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "id,number,transDate,customer,description,statusName,statusOutstanding,totalAmount",
        "sp.page": page,
        "sp.pageSize": perPage,
        "sp.sort": "transDate|desc",
        ...filterParams,
        _: Date.now(),
      },
    });

    const list = response.data?.d || [];
    const total_data = response.data?.sp?.totalRows || list.length;
    const total_page = Math.ceil(total_data / perPage);

    const result = [];
    const batchSize = 5;

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
              tanggal: convertToYMD(item.transDate), // ✅ sudah YYYY-MM-DD
              pelanggan: item.customer?.name || "-",
              deskripsi: item.description || "-",
              status: item.statusName || item.statusOutstanding || "-",
              total: Number(item.totalAmount), // ✅ angka asli dari Accurate
              typePajak: taxDetail.typePajak || "-",
              omzet: Number(taxDetail.dppAmount),
              nilaiPPN: Number(taxDetail.tax1Amount),
            };
          } catch {
            return null;
          }
        })
      );

      result.push(...batchResults.filter(Boolean));
      await delay(500);
    }

    return res.status(200).json({
      success: true,
      page: +page,
      per_page: perPage,
      total_data,
      total_page,
      next_page: page < total_page ? page + 1 : null,
      prev_page: page > 1 ? page - 1 : null,
      orders: result,
    });

  } catch (error) {
    console.error("💥 API ERROR:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data faktur",
    });
  }
}
