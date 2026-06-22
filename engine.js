const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

// 1. Check for serviceAccountKey.json existence
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error("❌ ERROR: File 'serviceAccountKey.json' not found in the root directory!");
  console.error("👉 Please visit Firebase Console -> Project Settings -> Service Accounts to download your key, then save it here.");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = require('./serviceAccountKey.json');
  if (serviceAccount.comment || serviceAccount.private_key_id === "YOUR_PRIVATE_KEY_ID") {
    console.warn("⚠️ WARNING: File 'serviceAccountKey.json' is currently a placeholder!");
    console.warn("👉 Please paste your actual Firebase Service Account key into this file to continue.");
  }
} catch (e) {
  console.error("❌ ERROR: Failed to parse 'serviceAccountKey.json'. Invalid JSON format!", e.message);
  process.exit(1);
}

// 2. Check for GEMINI_API_KEY
if (!process.env.GEMINI_API_KEY || 
    process.env.GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE" || 
    process.env.GEMINI_API_KEY.trim() === "") {
  console.error("❌ ERROR: GEMINI_API_KEY is not configured in the .env file!");
  console.error("👉 Please open the '.env' file and update it with your Gemini API key.");
  process.exit(1);
}

// 3. Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("🔥 Firebase Admin initialized successfully!");
} catch (e) {
  console.error("❌ ERROR: Firebase Admin initialization failed! Make sure the credentials in serviceAccountKey.json are correct.", e.message);
  process.exit(1);
}

const db = admin.firestore();

// 4. Initialize Gemini AI
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

console.log("🚀 Local Backend Engine is running and listening for pending audits...");

// Listen to Firestore updates for pending requests
db.collection('analysis_requests')
  .where('status', '==', 'pending')
  .onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
            const docId = change.doc.id;
            const data = change.doc.data();
            
            console.log(`📥 Received new analysis request [ID: ${docId}] from user: ${data.userEmail}. Processing...`);
            
            try {
                // Run local cross-check and data profiling logic first
                const auditReport = runLocalAudit(data.rawData);
                
                // Trigger AI analysis on structured pre-processed data
                const aiAnalysisResult = await analyzeDataWithAI(auditReport);
                
                // Write results back to Firestore and set status to completed
                await db.collection('analysis_requests').doc(docId).update({
                    result: aiAnalysisResult,
                    status: 'completed'
                });
                
                console.log(`✅ Successfully completed and updated results on Firestore for request ID: ${docId}`);
            } catch (error) {
                console.error(`❌ Error processing request ID ${docId}:`, error);
                
                // Translate system error into user-friendly message
                let friendlyError = 'The auditing engine encountered a temporary problem. Please try again.';
                const errMsg = error.message || '';
                
                if (errMsg.includes('503') || errMsg.includes('Service Unavailable') || errMsg.includes('high demand')) {
                    friendlyError = 'The AI analyst is temporarily busy due to high demand. Please try again in a few moments.';
                } else if (errMsg.includes('429') || errMsg.includes('Quota exceeded') || errMsg.includes('rate limit')) {
                    friendlyError = 'System rate limit exceeded. Please wait a minute and try again.';
                } else if (errMsg.includes('API key') || errMsg.includes('key not found') || errMsg.includes('API_KEY')) {
                    friendlyError = 'Configuration error: AI service credentials are misconfigured. Please check setup.';
                } else if (errMsg.includes('permission') || errMsg.includes('denied')) {
                    friendlyError = 'Database error: Insufficient permissions to complete the request.';
                }

                // Update Firestore status to failed to stop client-side loading
                await db.collection('analysis_requests').doc(docId).update({
                    status: 'failed',
                    error: friendlyError
                }).catch(err => console.error("Could not write error state back to Firestore:", err));
            }
        }
    });
  }, error => {
      console.error("❌ Error in Firestore Realtime Listener:", error);
  });

// Run local cross-checking algorithms on raw CSV data before calling AI
function runLocalAudit(rawDataText) {
    let data;
    try {
        data = JSON.parse(rawDataText);
    } catch (e) {
        console.error("Failed to parse raw data JSON", e);
        return null;
    }

    if (!Array.isArray(data) || data.length < 2) {
        return null;
    }

    const headers = data[0].map(h => h ? h.trim() : '');
    
    // Find index of each column dynamically to prevent ordering issues
    const colIndices = {
        orderId: headers.findIndex(h => h.toLowerCase().includes('order id') || h.toLowerCase() === 'id'),
        productName: headers.findIndex(h => h.toLowerCase().includes('product name') || h.toLowerCase().includes('product')),
        sku: headers.findIndex(h => h.toLowerCase() === 'sku'),
        quantity: headers.findIndex(h => h.toLowerCase().includes('quantity') || h.toLowerCase() === 'qty'),
        price: headers.findIndex(h => h.toLowerCase().includes('price')),
        shipPaidByCust: headers.findIndex(h => h.toLowerCase().includes('shipping fee paid') || h.toLowerCase().includes('ship paid')),
        shipChargedByPlatform: headers.findIndex(h => h.toLowerCase().includes('actual shipping fee') || h.toLowerCase().includes('ship charged') || h.toLowerCase().includes('ship actual')),
        commission: headers.findIndex(h => h.toLowerCase().includes('commission') || h.toLowerCase().includes('platform fee')),
        discount: headers.findIndex(h => h.toLowerCase().includes('discount') || h.toLowerCase().includes('voucher')),
        payout: headers.findIndex(h => h.toLowerCase().includes('payout') || h.toLowerCase().includes('net')),
        status: headers.findIndex(h => h.toLowerCase() === 'status')
    };

    let totalOrders = 0;
    let grossRevenue = 0;
    let totalPayout = 0;
    let totalLeaks = 0;
    
    const shippingLeaks = [];
    const commissionLeaks = [];
    const profitLeaks = [];

    // Loop through rows (skip header)
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length < headers.length || !row[0]) continue;

        totalOrders++;
        
        const orderId = colIndices.orderId !== -1 ? row[colIndices.orderId] : `Order #${i}`;
        const productName = colIndices.productName !== -1 ? row[colIndices.productName] : 'Unknown Product';
        const sku = colIndices.sku !== -1 ? row[colIndices.sku] : 'N/A';
        const qty = colIndices.quantity !== -1 ? parseInt(row[colIndices.quantity]) || 1 : 1;
        const price = colIndices.price !== -1 ? parseFloat(row[colIndices.price]) || 0 : 0;
        
        const shipCustomer = colIndices.shipPaidByCust !== -1 ? parseFloat(row[colIndices.shipPaidByCust]) || 0 : 0;
        const shipPlatform = colIndices.shipChargedByPlatform !== -1 ? parseFloat(row[colIndices.shipChargedByPlatform]) || 0 : 0;
        const commission = colIndices.commission !== -1 ? parseFloat(row[colIndices.commission]) || 0 : 0;
        const discount = colIndices.discount !== -1 ? parseFloat(row[colIndices.discount]) || 0 : 0;
        const payout = colIndices.payout !== -1 ? parseFloat(row[colIndices.payout]) || 0 : 0;

        grossRevenue += price * qty;
        totalPayout += payout;

        // Leak 1: Shipping Overcharge (Platform charged more than customer paid)
        if (shipPlatform > shipCustomer) {
            const difference = parseFloat((shipPlatform - shipCustomer).toFixed(2));
            if (difference > 0) {
                totalLeaks += difference;
                shippingLeaks.push({
                    orderId,
                    customerPaid: shipCustomer,
                    platformCharged: shipPlatform,
                    lostAmount: difference
                });
            }
        }

        // Leak 2: High Platform Commission (Commission > 15% of product price)
        const expectedMaxCommission = price * qty * 0.15;
        if (commission > expectedMaxCommission && price > 0) {
            const excess = parseFloat((commission - (price * qty * 0.05)).toFixed(2)); // Excess over standard 5% commission
            if (excess > 0) {
                totalLeaks += excess;
                commissionLeaks.push({
                    orderId,
                    productName,
                    price: price * qty,
                    commissionCharged: commission,
                    excessAmount: excess
                });
            }
        }

        // Leak 3: Dangerously Low Payout (Payout less than 50% of gross item value)
        const itemGrossValue = price * qty;
        if (payout < itemGrossValue * 0.5 && itemGrossValue > 0) {
            const marginLost = parseFloat((itemGrossValue - payout).toFixed(2));
            profitLeaks.push({
                orderId,
                productName,
                sku,
                grossValue: itemGrossValue,
                payout,
                discount,
                lostAmount: marginLost
            });
        }
    }

    return {
        totalOrders,
        grossRevenue: parseFloat(grossRevenue.toFixed(2)),
        totalPayout: parseFloat(totalPayout.toFixed(2)),
        totalLeaks: parseFloat(totalLeaks.toFixed(2)),
        shippingLeaks,
        commissionLeaks,
        profitLeaks
    };
}

async function analyzeDataWithAI(auditReport) {
    const model = ai.getGenerativeModel({ 
        model: "gemini-2.5-flash",
        systemInstruction: `You are a Senior E-commerce Financial Auditor. Analyze the pre-processed financial audit data provided by our server algorithms.
Your role is to translate these raw calculations and leak findings into a highly professional executive report in Markdown format.

Structure your response as follows:
1. **Executive Summary**: Synthesize the total orders analyzed, gross revenue, payout, and the total financial leaks detected. Write a compelling summary.
2. **Detected Leaks & Issues (Summary Table)**: Build a clean Markdown table summarizing the most critical leaked orders. Show columns: | Order ID | Issue Type | Lost Amount ($) | Description | (Limit table to max 10 most critical rows, but mention if there are more in the description).
3. **Deep-Dive Diagnostic**: 
   - Summarize shipping overcharge findings (how many orders, total loss).
   - Summarize marketplace fee commission anomalies.
   - Mention product SKUs with high voucher discounts or dangerously low margin rates.
4. **Actionable Recommendations**: Clear, bulleted steps explaining what the shop owner needs to do (e.g. claim refunds from logistics partners, adjust voucher settings, renegotiate platform rates).`
    });

    const prompt = `Here is the pre-processed audit data from our local server engine:\n${JSON.stringify(auditReport, null, 2)}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
}

// 5. Spin up a lightweight HTTP server to serve the frontend client (prevents CORS errors)
const PORT = 3000;
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  // Normalize and parse URL
  let parsedUrl = req.url.split('?')[0];
  let filePath = path.join(__dirname, parsedUrl === '/' ? 'index.html' : parsedUrl);
  
  // Security check: ensure path is within workspace directory
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`🌍 Frontend client is now running at: http://localhost:${PORT}`);
});
