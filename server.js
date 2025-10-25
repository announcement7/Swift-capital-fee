// server.js - Enhanced PayNecta backend with database, balance, and withdrawal features
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cron = require("node-cron");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 5000;

// ====== Database Configuration ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(15) UNIQUE NOT NULL,
        balance DECIMAL(15, 2) DEFAULT 0,
        has_paid_fee BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        reference VARCHAR(100) UNIQUE NOT NULL,
        user_phone VARCHAR(15) NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(15, 2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_user_phone ON transactions(user_phone);
      CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    `);

    console.log("✅ Database initialized successfully");
  } catch (err) {
    console.error("Database initialization error:", err.message);
  } finally {
    client.release();
  }
}

initDatabase();

// ====== Configuration ======
const PAYNECTA_EMAIL = process.env.PAYNECTA_EMAIL || "ceofreddy254@gmail.com";
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY || "hmp_qRLRJKTcVe4BhEQyp7GX5bttJTPzgYUUBU8wPZgO";
const PAYNECTA_CODE = process.env.PAYNECTA_CODE || "PNT_109820";
const CALLBACK_URL = process.env.CALLBACK_URL || "https://swift-capital.onrender.com/callback";

// JSON storage file for receipts (legacy support)
const receiptsFile = path.join(__dirname, "receipts.json");

// Middleware
app.use(bodyParser.json());
app.use(cors({ origin: "*" }));
app.use(express.static('public'));

// ====== Helper functions ======
function formatPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

async function getOrCreateUser(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query('SELECT * FROM users WHERE phone = $1', [phone]);
    
    if (result.rows.length === 0) {
      result = await client.query(
        'INSERT INTO users (phone, balance, has_paid_fee) VALUES ($1, 0, FALSE) RETURNING *',
        [phone]
      );
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function updateUserBalance(phone, amount, operation = 'add') {
  const client = await pool.connect();
  try {
    const query = operation === 'add' 
      ? 'UPDATE users SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE phone = $2 RETURNING *'
      : 'UPDATE users SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE phone = $2 RETURNING *';
    
    const result = await client.query(query, [amount, phone]);
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function markUserFeePaid(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'UPDATE users SET has_paid_fee = TRUE, updated_at = CURRENT_TIMESTAMP WHERE phone = $1 RETURNING *',
      [phone]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function createTransaction(data) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO transactions (reference, user_phone, type, amount, status, description, metadata) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.reference, data.user_phone, data.type, data.amount, data.status, data.description, JSON.stringify(data.metadata || {})]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function updateTransaction(reference, updates) {
  const client = await pool.connect();
  try {
    const setClause = Object.keys(updates).map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = [reference, ...Object.values(updates)];
    
    const result = await client.query(
      `UPDATE transactions SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE reference = $1 RETURNING *`,
      values
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function getUserTransactions(phone, limit = 50) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM transactions WHERE user_phone = $1 ORDER BY created_at DESC LIMIT $2',
      [phone, limit]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

// ====== API ENDPOINTS ======

// Get user balance
app.get("/balance/:phone", async (req, res) => {
  try {
    const formattedPhone = formatPhone(req.params.phone);
    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone number" });
    }

    const user = await getOrCreateUser(formattedPhone);
    
    res.json({
      success: true,
      balance: parseFloat(user.balance),
      has_paid_fee: user.has_paid_fee,
      phone: user.phone
    });
  } catch (err) {
    console.error("Balance fetch error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Get user transactions
app.get("/transactions/:phone", async (req, res) => {
  try {
    const formattedPhone = formatPhone(req.params.phone);
    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone number" });
    }

    const transactions = await getUserTransactions(formattedPhone);
    
    res.json({
      success: true,
      transactions: transactions.map(t => ({
        reference: t.reference,
        type: t.type,
        amount: parseFloat(t.amount),
        status: t.status,
        description: t.description,
        created_at: t.created_at
      }))
    });
  } catch (err) {
    console.error("Transactions fetch error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Withdrawal request
app.post("/withdraw", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone number" });
    }

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, error: "Minimum withdrawal is KES 100" });
    }

    const user = await getOrCreateUser(formattedPhone);

    if (!user.has_paid_fee) {
      return res.status(403).json({ success: false, error: "You must pay the service fee before withdrawing" });
    }

    if (parseFloat(user.balance) < amount) {
      return res.status(400).json({ success: false, error: "Insufficient balance" });
    }

    const reference = "WD-" + Date.now();
    
    await createTransaction({
      reference,
      user_phone: formattedPhone,
      type: "withdrawal",
      amount,
      status: "processing",
      description: `Withdrawal of KES ${amount}`,
      metadata: { withdrawal_to: formattedPhone }
    });

    await updateUserBalance(formattedPhone, amount, 'subtract');

    res.json({
      success: true,
      message: "Withdrawal request submitted successfully",
      reference,
      amount,
      new_balance: parseFloat(user.balance) - amount
    });

  } catch (err) {
    console.error("Withdrawal error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Payment initiation
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    await getOrCreateUser(formattedPhone);

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
        timeout: 30000,
      }
    );

    console.log("PayNecta response:", resp.data);

    if (resp.data && resp.data.success) {
      const transaction_reference = resp.data.data.transaction_reference || null;

      await createTransaction({
        reference,
        user_phone: formattedPhone,
        type: "service_fee",
        amount: Math.round(amount),
        status: "pending",
        description: `Service fee payment for loan of KES ${loan_amount}`,
        metadata: {
          transaction_id: transaction_reference,
          loan_amount: loan_amount || "50000"
        }
      });

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

            if (payStatus === "completed" || payStatus === "processing") {
              await updateTransaction(reference, { status: "completed" });
              await markUserFeePaid(formattedPhone);
              
              const loanAmount = loan_amount || 50000;
              await updateUserBalance(formattedPhone, parseFloat(loanAmount), 'add');
              
              await createTransaction({
                reference: "LOAN-" + Date.now(),
                user_phone: formattedPhone,
                type: "loan_disbursement",
                amount: parseFloat(loanAmount),
                status: "completed",
                description: `Loan disbursement of KES ${loanAmount}`,
                metadata: { related_payment: reference }
              });
              
              clearInterval(interval);
            } else if (payStatus === "failed" || payStatus === "cancelled") {
              await updateTransaction(reference, { status: "failed" });
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
        reference
      });
    } else {
      await createTransaction({
        reference,
        user_phone: formattedPhone,
        type: "service_fee",
        amount: Math.round(amount),
        status: "failed",
        description: "STK push failed to send",
        metadata: { loan_amount: loan_amount || "50000" }
      });
      
      return res.status(400).json({ 
        success: false, 
        error: resp.data?.message || "STK push failed to send. Try again later." 
      });
    }
  } catch (err) {
    console.error("Payment initiation error:", err.message);

    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (formattedPhone) {
      await createTransaction({
        reference,
        user_phone: formattedPhone,
        type: "service_fee",
        amount: amount ? Math.round(amount) : null,
        status: "error",
        description: "System error occurred",
        metadata: { loan_amount: loan_amount || "50000" }
      });
    }

    return res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message || "Server error",
      reference,
    });
  }
});

// Get transaction/receipt by reference
app.get("/receipt/:reference", async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM transactions WHERE reference = $1',
        [req.params.reference]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Receipt not found" });
      }
      
      const transaction = result.rows[0];
      res.json({ 
        success: true, 
        receipt: {
          reference: transaction.reference,
          amount: parseFloat(transaction.amount),
          status: transaction.status,
          phone: transaction.user_phone,
          description: transaction.description,
          timestamp: transaction.created_at,
          metadata: transaction.metadata
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Receipt fetch error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Generate PDF receipt
app.get("/receipt/:reference/pdf", async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM transactions WHERE reference = $1',
        [req.params.reference]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Receipt not found" });
      }
      
      const receipt = result.rows[0];
      generateReceiptPDF(receipt, res);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("PDF generation error:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// PDF Generator
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

  if (receipt.status === "completed") {
    color = "#4caf50";
    watermark = "COMPLETED";
  } else if (["failed", "error"].includes(receipt.status)) {
    color = "#f44336";
    watermark = "FAILED";
  }

  doc.rect(0, 0, doc.page.width, 80).fill(color);
  doc.fillColor("white").fontSize(20).text("TECHSPACE FINANCE RECEIPT", 50, 30);

  doc.moveDown(2);
  doc.fillColor("black").fontSize(14).text("Receipt Details", { underline: true });

  const details = [
    ["Reference", receipt.reference],
    ["Type", receipt.type.toUpperCase()],
    ["Amount", `KSH ${parseFloat(receipt.amount).toFixed(2)}`],
    ["Phone", receipt.user_phone],
    ["Status", receipt.status.toUpperCase()],
    ["Description", receipt.description || "N/A"],
    ["Time", new Date(receipt.created_at).toLocaleString()],
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

// Callback webhook
app.post("/callback", (req, res) => {
  console.log("Callback received:", JSON.stringify(req.body).slice(0, 500));
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Database connected`);
});
