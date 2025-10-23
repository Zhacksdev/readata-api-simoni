import axios from "axios";

function convertToYMD(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${year}-${month}-${day}`;
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

    const typePajak = String(rawType).toLowerCase().trim();
    const dppAmount = Number(d.taxableAmount1 || d.dppAmount || 0);
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

  const { start_date, end_date, page = 1, per_page = 100 } = req.query || {};
  const perPage = Math.min(Number(per_page) || 100, 1000);

  let filterQuery = "";
  if (start_date && end_date) {
    filterQuery =
      `&filter=${encodeURIComponent(
        `transactionDate >= '${start_date}' AND transactionDate <= '${end_date}'`
      )}`;
  }

  try {
    const response = await axios.get(
      `${host}/accurate/api/sales-invoice/list.do?page=${page}&limit=${perPage}${filterQuery}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "X-Session-ID": session_id,
        },
      }
    );

    const d = response.data?.d;
    if (!d?.list) {
      return res.status(400).json({ error: "Gagal ambil data Accurate" });
    }

    const list = d.list;
    const total_data = d.totalItems;
    const total_page = d.totalPage;

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
              tanggal: item.transactionDate, // ✅ Biarkan asli dari Accurate
              pelanggan: item.customerName,
              deskripsi: item.description || "-",
              status: item.statusName,
              total: Number(item.totalAmount),
              typePajak: taxDetail.typePajak,
              omzet: taxDetail.dppAmount,
              nilaiPPN: taxDetail.tax1Amount,
            };
          } catch {
            return null;
          }
        })
      );

      results.push(...detailChunk.filter(Boolean));
      await delay(350);
    }

    return res.json({
      success: true,
      page: Number(page),
      per_page: Number(perPage),
      total_data,
      total_page,
      orders: results,
    });

  } catch (err) {
    console.error("API Error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Gagal ambil data Accurate" });
  }
}
