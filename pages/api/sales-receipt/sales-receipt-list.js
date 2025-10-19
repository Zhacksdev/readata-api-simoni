// pages/api/order-list.js
import axios from "axios";

function convertToDMY(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

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

    // Debug log untuk lihat struktur response
    console.log(`📋 Detail untuk ID ${id}:`, {
      hasDppAmount: !!d.dppAmount,
      dppAmount: d.dppAmount,
      hasTax1Amount: !!d.tax1Amount,
      tax1Amount: d.tax1Amount,
      detailItemCount: d.detailItem?.length || 0,
      detailTaxCount: d.detailTax?.length || 0,
    });

    // Tipe pajak
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.[0]?.item?.tax1?.description ||
      (d.taxable === true ? "PPN" : "NON-PAJAK");

    // DPP - coba dari berbagai sumber
    let dppAmount = 0;
    
    if (d.dppAmount && d.dppAmount > 0) {
      dppAmount = d.dppAmount;
    } else if (d.taxableAmount1 && d.taxableAmount1 > 0) {
      dppAmount = d.taxableAmount1;
    } else if (d.detailTax?.[0]?.taxableAmount && d.detailTax[0].taxableAmount > 0) {
      dppAmount = d.detailTax[0].taxableAmount;
    } else if (d.detailItem?.length > 0) {
      // Jumlahkan dari detail item
      dppAmount = d.detailItem.reduce((sum, item) => {
        const itemDpp = item.dppAmount || item.salesAmountBase || item.grossAmount || 0;
        return sum + Number(itemDpp);
      }, 0);
    } else if (d.salesAmountBase && d.salesAmountBase > 0) {
      // Fallback ke salesAmountBase di level dokumen
      dppAmount = d.salesAmountBase;
    }

    // PPN - coba dari berbagai sumber
    let tax1Amount = 0;
    
    if (d.tax1Amount && d.tax1Amount > 0) {
      tax1Amount = d.tax1Amount;
    } else if (d.detailTax?.[0]?.taxAmount && d.detailTax[0].taxAmount > 0) {
      tax1Amount = d.detailTax[0].taxAmount;
    } else if (d.detailItem?.length > 0) {
      // Jumlahkan dari detail item
      tax1Amount = d.detailItem.reduce((sum, item) => {
        const itemTax = item.tax1Amount || 0;
        return sum + Number(itemTax);
      }, 0);
    }

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

    return res.status(200).json({ orders: result });
  } catch (error) {
    console.error("💥 ERROR API:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || "Gagal mengambil data faktur penjualan",
    });
  }
}