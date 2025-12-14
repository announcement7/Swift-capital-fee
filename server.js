const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = 3000;

/// JSON storage file for receipts
const receiptsFile = path.join(__dirname, "receipts.json");
const errorLogFile = path.join(__dirname, "stk-errors.log");

// =======================
// ✅ GLOBAL AXIOS LOGGER
// =======================
axios.interceptors.response.use(
  response => response,
  error => {
    console.error("🔴 AXIOS ERROR");
    console.error("Status:", error.response?.status);
    console.error("Response:", error.response?.data);
    console.error("URL:", error.config?.url);
    console.error("Payload:", error.config?.data);
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━");

    fs.appendFileSync(
      errorLogFile,
      `[${new Date().toISOString()}]\n${JSON.stringify({
        status: error.response?.status,
        response: error.response?.data,
        url: error.config?.url,
        payload: error.config?.data
      }, null, 2)}\n\n`
    );

    return Promise.reject(error);
  }
);

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://swiftfinancelmtd.onrender.com"
  })
);

// Helpers for receipts
function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}
function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

// Phone formatter
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// =======================
// 1️⃣ Initiate Payment
// =======================
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    }
    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });
    }

    const reference = "ORDER-" + Date.now();

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: "https://swift-capital-fee-kuxs.onrender.com/callback",
      channel_id: "000235"
    };

    // ✅ LOG REQUEST PAYLOAD
    console.log("🟡 STK REQUEST PAYLOAD:", payload);

    const url = "https://swiftwallet.co.ke/pay-app-v2/payments.php";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer f7a932be3cd1251ab70bae129aacd9ae527287e927c5f45ec1cf4a3948eaf443`,
        "Content-Type": "application/json"
      }
    });

    console.log("SwiftWallet response:", resp.data);

    if (resp.data.success) {
      const receiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete the fee payment.`,
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({
        success: true,
        message: "STK push sent, check your phone",
        reference,
        receipt: receiptData
      });
    } else {
      const failedReceiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "stk_failed",
        status_note: "STK push failed to send.",
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = failedReceiptData;
      writeReceipts(receipts);

      res.status(400).json({
        success: false,
        error: resp.data.error || "Failed to initiate payment",
        receipt: failedReceiptData
      });
    }
  } catch (err) {
    console.error("❌ PAYMENT INITIATION ERROR");

    const errorLog = {
      message: err.message,
      status: err.response?.status,
      response: err.response?.data,
      request: err.config?.data,
      url: err.config?.url
    };

    console.error(errorLog);

    fs.appendFileSync(
      errorLogFile,
      `[${new Date().toISOString()}]\n${JSON.stringify(errorLog, null, 2)}\n\n`
    );

    res.status(500).json({
      success: false,
      error: err.response?.data || err.message || "Server error"
    });
  }
});

// =======================
// 2️⃣ Callback handler
// =======================
app.post("/callback", (req, res) => {
  console.log("Callback received:", req.body);

  const data = req.body;
  const ref = data.external_reference;
  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};

  const status = data.status?.toLowerCase();
  const resultCode = data.result?.ResultCode;

  const customerName =
    data.result?.Name ||
    [data.result?.FirstName, data.result?.MiddleName, data.result?.LastName].filter(Boolean).join(" ") ||
    existingReceipt.customer_name ||
    "N/A";

  if ((status === "completed" && data.success === true) || resultCode === 0) {
    receipts[ref] = {
      ...existingReceipt,
      reference: ref,
      transaction_id: data.transaction_id,
      transaction_code: data.result?.MpesaReceiptNumber || null,
      amount: data.result?.Amount || existingReceipt.amount,
      loan_amount: existingReceipt.loan_amount || "50000",
      phone: data.result?.Phone || existingReceipt.phone,
      customer_name: customerName,
      status: "processing",
      status_note: "✅ Payment confirmed. Loan is processing.",
      timestamp: new Date().toISOString()
    };
  } else {
    receipts[ref] = {
      reference: ref,
      transaction_id: data.transaction_id,
      transaction_code: null,
      amount: existingReceipt.amount,
      loan_amount: existingReceipt.loan_amount || "50000",
      phone: existingReceipt.phone,
      customer_name: customerName,
      status: "cancelled",
      status_note: data.result?.ResultDesc || "Payment failed",
      timestamp: new Date().toISOString()
    };
  }

  writeReceipts(receipts);
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// =======================
// 3️⃣ Fetch receipt
// =======================
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// =======================
// 4️⃣ PDF receipt
// =======================
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  generateReceiptPDF(receipt, res);
});

// =======================
// 5️⃣ Start server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
