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

    // Tipe pajak - ambil dari berbagai sumber
    const typePajak =
      d.tax1?.description ||
      d.detailTax?.[0]?.tax?.description ||
      d.detailItem?.[0]?.item?.tax1?.description ||
      (d.taxable === true ? "PPN" : "NON-PAJAK");

    // DPP - coba dari berbagai sumber dengan prioritas
    let dppAmount = 0;
    
    if (d.dppAmount > 0) {
      dppAmount = d.dppAmount;
    } else if (d.taxableAmount1 > 0) {
      dppAmount = d.taxableAmount1;
    } else if (d.detailTax?.[0]?.taxableAmount > 0) {
      dppAmount = d.detailTax[0].taxableAmount;
    } else if (Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      dppAmount = d.detailItem.reduce((sum, item) => {
        const itemDpp = item.dppAmount || item.salesAmountBase || item.grossAmount || 0;
        return sum + Number(itemDpp);
      }, 0);
    }

    // PPN - coba dari berbagai sumber
    let tax1Amount = 0;
    
    if (d.tax1Amount > 0) {
      tax1Amount = d.tax1Amount;
    } else if (d.detailTax?.[0]?.taxAmount > 0) {
      tax1Amount = d.detailTax[0].taxAmount;
    } else if (Array.isArray(d.detailItem) && d.detailItem.length > 0) {
      tax1Amount = d.detailItem.reduce((sum, item) => {
        return sum + Number(item.tax1Amount || 0);
      }, 0);
    }

    return {
      typePajak: typePajak || "NON-PAJAK",
      dppAmount: Number(dppAmount) || 0,
      tax1Amount: Number(tax1Amount) || 0,
    };
  } catch (err) {
    console.error(`ERROR Detail ID ${id}:`, err.message);
    return { typePajak: "NON-PAJAK", dppAmount: 0, tax1Amount: 0 };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Gunakan GET" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token tidak valid" });
  }

  const access_token = authHeader.split(" ")[1];
  const session_id = process.env.ACCURATE_SESSION_ID;
  const host = process.env.ACCURATE_HOST;

  if (!session_id || !host) {
    return res.status(500).json({ error: "ENV tidak lengkap" });
  }

  const { start_date, end_date, per_page } = req.query || {};

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

    if (list.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        orders: [],
      });
    }

    const result = await Promise.all(
      list.map(async (item) => {
        const taxDetail = await fetchInvoiceTaxDetail(host, access_token, session_id, item.id);

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
    console.error("[API] ERROR:", error.message);

    return res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
    });
  }
}