import axios from "axios";

// 🔹 Konversi tanggal DD/MM/YYYY → YYYY-MM-DD (untuk output ke user)
function convertToYMD(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split("/");
  return `${year}-${month}-${day}`;
}

// 🔹 Konversi tanggal YYYY-MM-DD → DD/MM/YYYY (filter Accurate)
function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function fetchInvoiceTaxDetail(host, access_token, session_id, id) {
  return retry(async () => {
    const res = await axios.get(`${host}/accurate/api/sales-invoice/detail.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: { id },
    });

    const d = res.data?.d;

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

    const tax1Amount = Number(d.tax1Amount) || Math.round(dppAmount * 0.1);

    return { typePajak, dppAmount, tax1Amount };
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Gunakan metode GET" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access token tidak ditemukan" });
  }

  const access_token = authHeader.split(" ")[1];
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;

  const {
    start_date,
    end_date,
    page = 1,
    per_page = 100,
  } = req.query || {};

  // ✅ per_page tidak boleh lebih besar dari 1000 (ketentuan Accurate)
  const perPage = per_page > 1000 ? 1000 : per_page;

  const filterParams = {};
  if (start_date && end_date) {
    filterParams["filter.transDate.op"] = "BETWEEN";
    filterParams["filter.transDate.val[0]"] = convertToDMY(start_date);
    filterParams["filter.transDate.val[1]"] = convertToDMY(end_date);
  }

  try {
    const response = await axios.get(`${host}/accurate/api/sales-invoice/list.do`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Session-ID": session_id,
      },
      params: {
        fields:
          "id,number,transDate,customer,description,statusName,statusOutstanding,totalAmount",
        "sp.page": Number(page),
        "sp.pageSize": Number(perPage),
        "sp.sort": "transDate|desc",
        ...filterParams,
        _: Date.now(),
      },
    });

    const list = response.data?.d || [];
    const total_data = response.data?.sp?.totalRows || list.length;
    const total_page = Math.ceil(total_data / perPage);

    const results = [];

    const batchSize = 5;
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      const detailChunk = await Promise.all(
        chunk.map(async (item) => {
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
              tanggal: convertToYMD(item.transDate),
              pelanggan: item.customer?.name || "-",
              deskripsi: item.description || "-",
              status: item.statusName || item.statusOutstanding || "-",
              total: Number(item.totalAmount), // ✅ angka asli Accurate
              typePajak: taxDetail.typePajak,
              omzet: Number(taxDetail.dppAmount),
              nilaiPPN: Number(taxDetail.tax1Amount),
            };
          } catch {
            return null;
          }
        })
      );
      results.push(...detailChunk.filter(Boolean));
      await delay(400);
    }

    res.status(200).json({
      success: true,
      page: Number(page),
      per_page: Number(perPage),
      total_data,
      orders: results,
    });

  } catch (err) {
    console.error("API Error:", err.message);
    return res.status(500).json({ error: "Gagal ambil data" });
  }
}
