import axios from "axios";

export const listSalesInvoice = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    const {
      start_date,
      end_date,
      page = 1,
      per_page = 100
    } = req.body;

    if (!sessionId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const parsedLimit = Math.min(parseInt(per_page) || 100, 1000);

    const filterParams = [];

    if (start_date) {
      filterParams.push(`transactionDate >= '${start_date}'`);
    }

    if (end_date) {
      filterParams.push(`transactionDate <= '${end_date}'`);
    }

    const filterQuery =
      filterParams.length > 0
        ? `&filter=${encodeURIComponent(filterParams.join(" AND "))}`
        : "";

    const url = `https://public.accurate.id/accurate/api/sales-invoice/list.do?page=${page}&limit=${parsedLimit}${filterQuery}`;

    const { data } = await axios.get(url, {
      headers: { "X-Session-ID": sessionId },
    });

    if (!data?.d) {
      return res.status(400).json({
        success: false,
        message: data?.r || "Failed fetch data from Accurate",
      });
    }

    const result = {
      success: true,
      page: data.d.page,
      per_page: data.d.limit,
      total_data: data.d.totalItems,
      total_page: data.d.totalPage,
      orders: data.d.list.map((item) => ({
        id: item.id,
        nomor: item.number,
        tanggal: item.transactionDate, // Sudah YYYY-MM-DD dari Accurate → biarkan
        pelanggan: item.customerName,
        deskripsi: item.description ?? "-",
        status: item.statusName,
        total: item.totalAmount,
        typePajak: item.vatType ?? "-",
        omzet: item.taxableAmount,
        nilaiPPN: item.vatAmount,
      })),
    };

    res.json(result);

  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      debug: error.response?.data || error.message,
    });
  }
};
