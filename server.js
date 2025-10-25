// server.js - PayNecta backend compatible with SwiftWallet / Techspace Finance frontend
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Configuration ======
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || "ceofreddy254@gmail.com";
const PAYNECTA_API_KEY =
  process.env.PAYNECTA_API_KEY ||
  "hmp_qRLRJKTcVe4BhEQyp7GX5bttJTPzgYUUBU8wPZgO";
const PAYNECTA_CODE = process.env.PAYNECTA_CODE || "PNT_109820";

// ✅ FIXED: must be a string
const CALLBACK_URL =
  process.env.CALLBACK_URL ||
  "https://swift-capital.onrender.com/callback";

// JSON storage file for receipts
const receiptsFile = path.join(__dirname, "receipts.json");

// ✅ FIXED: Allow multiple origins (for dev & prod)
const FRONTEND_ORIGINS = [
  "https://techspacefinance.onrender.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: FRONTEND_ORIGINS,
  })
);

// ====== Helper functions ======
function readReceipts() {
  try {
    if (!fs.existsSync(receiptsFile)) return {};
    return JSON.parse(fs.readFileSync(receiptsFile));
  } catch (err) {
    console.error("readReceipts error:", err.message);
    return {};
  }
}

function writeReceipts(data) {
  try {
    fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("writeReceipts error:", err.message);
  }
}

function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// ---------- 1. /pay - initiate STK push ----------
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      code: PAYNECTA_CODE,
      mobile_number: formattedPhone,
      amount: Math.round(amount),
    };

    const resp = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      payload,
      {
        headers: {
          "X-API-Key": PAYNECTA_API_KEY,
          "X-User-Email": PAYNECTA_EMAIL,
          "Content-Type": "application/json",
        },
        timeout: 30000, // ✅ Increased timeout for slow PayNecta responses
      }
    );

    console.log("PayNecta response:", resp.data);

    const receipts = readReceipts();

    if (resp.data && resp.data.success) {
      const transaction_reference = resp.data.data.transaction_reference || null;

      const receiptData = {
        reference,
        transaction_id: transaction_reference,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Enter your M-Pesa PIN to complete.`,
        timestamp: new Date().toISOString(),
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      // ✅ Polling PayNecta status every 15 seconds
      if (transaction_reference) {
        const interval = setInterval(async () => {
          try {
            const url = `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${encodeURIComponent(
              transaction_reference
            )}`;
            const statusResp = await axios.get(url, {
              headers: {
                "X-API-Key": PAYNECTA_API_KEY,
                "X-User-Email": PAYNECTA_EMAIL,
              },
              timeout: 10000,
            });

            const payData = statusResp.data?.data || {};
            const payStatus = (payData.status || "").toLowerCase();
            console.log(`[${reference}] PayNecta poll status:`, payStatus);

            const receiptsNow = readReceipts();
            const current = receiptsNow[reference];
            if (!current) {
              clearInterval(interval);
              return;
            }

            if (payStatus === "completed" || payStatus === "processing") {
              current.status = "processing";
              current.transaction_code =
                payData.mpesa_receipt_number ||
                payData.mpesa_transaction_id ||
                current.transaction_code;
              current.amount = payData.amount || current.amount;
              current.phone = payData.mobile_number || current.phone;
              current.status_note = `✅ Payment received. Loan Reference: ${reference}. Processing started.`;
              current.timestamp = new Date().toISOString();
              writeReceipts(receiptsNow);
              clearInterval(interval);
            } else if (payStatus === "failed" || payStatus === "cancelled") {
              current.status = "cancelled";
              current.status_note =
                payData.failure_reason || "Payment failed or cancelled.";
              current.timestamp = new Date().toISOString();
              writeReceipts(receiptsNow);
              clearInterval(interval);
            }
          } catch (err) {
            console.log(`[${reference}] Poll error:`, err.message);
          }
        }, 15000);
      }

      return res.json({
        success: true,
        message: "STK push sent, check your phone",
        reference,
        receipt: receiptData,
      });
    } else {
      const failedReceipt = {
        reference,
        transaction_id: resp.data?.data?.transaction_reference || null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        status: "stk_failed",
        status_note:
          resp.data?.message || "STK push failed to send. Try again later.",
        timestamp: new Date().toISOString(),
      };

      receipts[reference] = failedReceipt;
      writeReceipts(receipts);
      return res
        .status(400)
        .json({ success: false, error: failedReceipt.status_note });
    }
  } catch (err) {
    console.error("Payment initiation error:", err.message);

    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    const errorReceipt = {
      reference,
      transaction_id: null,
      amount: amount ? Math.round(amount) : null,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      status: "error",
      status_note: "System error occurred. Please try again later.",
      timestamp: new Date().toISOString(),
    };

    const receipts = readReceipts();
    receipts[reference] = errorReceipt;
    writeReceipts(receipts);

    // ✅ Always return valid JSON to avoid frontend "network error"
    return res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message || "Server error",
      reference,
    });
  }
});

// ---------- 2. /callback - webhook handler ----------
app.post("/callback", (req, res) => {
  console.log("Callback received:", JSON.stringify(req.body).slice(0, 500));
  const data = req.body;
  processWebhookData(data);
  return res.json({ ResultCode: 0, ResultDesc: "Success" });
});

function processWebhookData(data) {
  const receipts = readReceipts();
  const refCandidates = [
    data.external_reference,
    data.transaction_reference,
    data.reference,
    data.data?.transaction_reference,
  ].filter(Boolean);

  const ref = refCandidates[0];
  if (!ref) return;

  const receipt = receipts[ref] || {};
  const payData = data.data || data;
  const status = (payData.status || "").toLowerCase();

  if (status === "completed" || payData.result_code === 0) {
    receipt.status = "processing";
    receipt.status_note = "✅ Payment verified. Loan processing started.";
  } else {
    receipt.status = "cancelled";
    receipt.status_note =
      payData.failure_reason ||
      payData.result?.ResultDesc ||
      "Payment failed or cancelled.";
  }

  receipt.timestamp = new Date().toISOString();
  receipts[ref] = receipt;
  writeReceipts(receipts);
}

// ---------- 3. /receipt/:reference ----------
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt)
    return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// ---------- 4. /receipt/:reference/pdf ----------
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt)
    return res.status(404).json({ success: false, error: "Receipt not found" });
  generateReceiptPDF(receipt, res);
});

// ---------- PDF Generator ----------
function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=receipt-${receipt.reference}.pdf`
  );

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  let color = "#2196F3";
  let watermark = "PENDING";

  if (receipt.status === "processing") {
    watermark = "PROCESSING";
  } else if (receipt.status === "loan_released") {
    color = "#4caf50";
    watermark = "RELEASED";
  } else if (["cancelled", "error"].includes(receipt.status)) {
    color = "#f44336";
    watermark = "FAILED";
  }

  doc.rect(0, 0, doc.page.width, 80).fill(color);
  doc
    .fillColor("white")
    .fontSize(20)
    .text("SWIFTLOAN KENYA LOAN RECEIPT", 50, 30);

  doc.moveDown(2);
  doc.fillColor("black").fontSize(14).text("Receipt Details", { underline: true });

  const details = [
    ["Reference", receipt.reference],
    ["Transaction ID", receipt.transaction_id || "N/A"],
    ["Amount", `KSH ${receipt.amount}`],
    ["Loan Amount", `KSH ${receipt.loan_amount}`],
    ["Phone", receipt.phone],
    ["Status", receipt.status.toUpperCase()],
    ["Note", receipt.status_note || "N/A"],
    ["Time", new Date(receipt.timestamp).toLocaleString()],
  ];

  details.forEach(([k, v]) => doc.text(`${k}: ${v}`));
  doc.moveDown(2);
  doc
    .fontSize(60)
    .fillColor("gray")
    .opacity(0.2)
    .rotate(-30)
    .text(watermark, 150, 300, { align: "center" })
    .rotate(30)
    .opacity(1);

  doc.end();
}

// ---------- Cron job: release loans after 24 hours ----------
cron.schedule("*/5 * * * *", () => {
  const receipts = readReceipts();
  const now = Date.now();
  for (const ref in receipts) {
    const r = receipts[ref];
    if (r.status === "processing") {
      const releaseTime =
        new Date(r.timestamp).getTime() + 24 * 60 * 60 * 1000;
      if (now >= releaseTime) {
        r.status = "loan_released";
        r.status_note = "Loan has been released to your account. Thank you.";
        console.log(`✅ Released loan for ${ref}`);
      }
    }
  }
  writeReceipts(receipts);
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
