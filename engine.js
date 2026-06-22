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
                // Trigger AI analysis on raw text
                const aiAnalysisResult = await analyzeDataWithAI(data.rawData);
                
                // Write results back to Firestore and set status to completed
                await db.collection('analysis_requests').doc(docId).update({
                    result: aiAnalysisResult,
                    status: 'completed'
                });
                
                console.log(`✅ Successfully completed and updated results on Firestore for request ID: ${docId}`);
            } catch (error) {
                console.error(`❌ Error processing request ID ${docId}:`, error);
                // Update Firestore status to failed to stop client-side loading
                await db.collection('analysis_requests').doc(docId).update({
                    status: 'failed',
                    error: error.message || 'Unknown error occurred during AI analysis'
                }).catch(err => console.error("Could not write error state back to Firestore:", err));
            }
        }
    });
  }, error => {
      console.error("❌ Error in Firestore Realtime Listener:", error);
  });

async function analyzeDataWithAI(rawCsvText) {
    const model = ai.getGenerativeModel({ 
        model: "gemini-2.5-flash-lite",
        systemInstruction: "You are a Senior E-commerce Financial Auditor. Analyze the provided raw CSV sample data. Detect any financial leaks, overcharged shipping fees, or layout issues. Provide a clear 3-bullet-point summary in English with actionable recommendations."
    });

    const prompt = `Here is the raw data string from the seller's report:\n${rawCsvText}`;
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
