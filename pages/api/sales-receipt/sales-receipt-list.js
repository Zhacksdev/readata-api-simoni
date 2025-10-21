import axios from "axios";

// Delay helper (ms)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Konversi dari YYYY-MM-DD -> DD/MM/YYYY (untuk filter Accurate)
function convertToDMYFromISO(dateStr) {
  if (!dateStr) return null;
  // expect YYYY-MM-DD
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

// Normalisasi input filter date (terima YYYY-MM-DD atau DD-MM-YYYY atau DD/MM/YYYY)
// Return string DD/MM/YYYY (suitable for Accurate filter) or null
function normalizeFilterToAccurate(dateStr) {
  if (!dateStr) return null;

  // already in YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return convertToDMYFromISO(dateStr);
  }

  // dd-mm-yyyy or dd/mm/yyyy -> convert to dd/mm/yyyy
  if (/^\d{2}[\/-]\d{2}[\/-]\d{4}$/.test(dateStr)) {
    return dateStr.replace(/-/g, "/");
  }

  // try to guess yyyy/mm/dd
  const alt = dateStr.replace(/\s+/g, "");
  if (/^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(alt)) {
    return convertToDMYFromISO(alt.replace(/\//g, "-"));
  }

  // unknown format -> return null
  return null;
}

// Normalisasi tanggal dari Accurate (terima "dd-mm-yyyy", "dd/mm/yyyy", atau "yyyy-mm-dd")
// Return YYYY-MM-DD
function normalizeAccurateDateToISO(dateStr) {
  if (!dateStr) return null;

  // already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

  // dd-mm-yyyy or dd/mm/yyyy
  const m = dateStr.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo}-${d}`;
  }

  // try to parse yyyy/mm/dd
  const m2 = dateStr.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})$/);
  if (m2) {
    const [, y, mo, d] = m2;
    return `${y}-${mo}-${d}`;
  }

  // fallback: return original (so we don't drop data)
  return dateStr;
}

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

// Ambil detail faktur
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

    // Normalisasi type pajak
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
      .replace(/\b\w/g, (c) => c.toUpperCase());

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
  const { start_date, end_date, per_page = 10000 } = req.query || {};

  // Prepare filter params — Accurate expects DD/MM/YYYY
  const filterParams = {};
  if (start_date && end_date) {
    const s = normalizeFilterToAccurate(start_date);
    const e = normalizeFilterToAccurate(end_date);

    if (!s || !e) {
      return res.status(400).json({
        error:
          "Format tanggal filter tidak valid. Terima: YYYY-MM-DD atau DD-MM-YYYY atau DD/MM/YYYY",
      });
    }

    filterParams["filter.transDate.op"] = "BETWEEN";
    filterParams["filter.transDate.val[0]"] = s; // DD/MM/YYYY
    filterParams["filter.transDate.val[1]"] = e; // DD/MM/YYYY
  }

  if (per_page) filterParams["sp.pageSize"] = Number(per_page) || 10000;

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
    const result = [];
    const batchSize = 5; // maksimal 5 request paralel biar aman

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
              tanggal: normalizeAccurateDateToISO(item.transDate), // -> YYYY-MM-DD
              pelanggan: item.customer?.name || "-",
              deskripsi: item.description || "-",
              status: item.statusName || item.statusOutstanding || "-",
              total: Number(item.totalAmount) || 0,
              typePajak: taxDetail.typePajak,
              omzet: Number(taxDetail.dppAmount) || 0,
              nilaiPPN: Number(taxDetail.tax1Amount) || 0,
            };
          } catch (err) {
            console.warn(`❌ Detail gagal (ID ${item.id}):`, err.message);
            return {
              id: item.id,
              nomor: item.number,
              tanggal: normalizeAccurateDateToISO(item.transDate),
              pelanggan: item.customer?.name || "-",
              deskripsi: item.description || "-",
              status: item.statusName || item.statusOutstanding || "-",
              umur: item.age || 0,
              total: Number(item.totalAmount) || 0,
              typePajak: "NON-PAJAK",
              omzet: 0,
              nilaiPPN: 0,
            };
          }
        })
      );

      result.push(...batchResults);
      await delay(700);
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
