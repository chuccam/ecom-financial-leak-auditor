import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    signInWithPopup, 
    GoogleAuthProvider, 
    onAuthStateChanged,
    signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    getFirestore, 
    collection, 
    addDoc, 
    doc, 
    onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Import secure Firebase configuration (ignored by Git)
import { firebaseConfig } from "./firebase-config.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
let unsubscribeResult = null;

// UI Elements
const btnLogin = document.getElementById('btn-login');
const loginContainer = document.getElementById('login-container');
const workspaceContainer = document.getElementById('workspace-container');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const loadingBox = document.getElementById('loading-box');
const resultBox = document.getElementById('result-box');
const resultContent = document.getElementById('result-content');
const btnReset = document.getElementById('btn-reset');
const btnLogout = document.getElementById('btn-logout');

const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const userEmail = document.getElementById('user-email');

// Auth: Sign in with Google
btnLogin.addEventListener('click', async () => {
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error("Sign in failed:", error);
        alert("Sign in failed: " + error.message);
    }
});

// Auth: Sign out
btnLogout.addEventListener('click', async () => {
    try {
        if (unsubscribeResult) {
            unsubscribeResult();
            unsubscribeResult = null;
        }
        await signOut(auth);
    } catch (error) {
        console.error("Sign out failed:", error);
    }
});

// Observe auth state changes
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        loginContainer.style.display = 'none';
        workspaceContainer.style.display = 'block';
        
        // Update user panel
        userAvatar.src = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || user.email)}`;
        userName.textContent = user.displayName || 'Partner';
        userEmail.textContent = user.email;
    } else {
        currentUser = null;
        loginContainer.style.display = 'flex';
        workspaceContainer.style.display = 'none';
        resetUI();
    }
});

// Click upload zone to select file
uploadZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

// Drag & drop handlers
uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

// Handle raw CSV upload
function handleFile(file) {
    if (!file) return;
    
    // Check file format
    if (!file.name.endsWith('.csv')) {
        alert('Only raw CSV report files (.csv) are supported!');
        return;
    }

    workspaceContainer.style.display = 'none';
    loadingBox.style.display = 'block';

    // Parse CSV on client-side to push rows to Firestore
    Papa.parse(file, {
        complete: async function(results) {
            try {
                // Slice to first 50 rows for PoC to avoid token limit issues
                const slicedData = results.data.slice(0, 50); 
                const rawTextData = JSON.stringify(slicedData);

                // Add request to Firestore
                const docRef = await addDoc(collection(db, "analysis_requests"), {
                    userId: currentUser.uid,
                    userEmail: currentUser.email,
                    rawData: rawTextData,
                    status: "pending",
                    result: "",
                    createdAt: new Date()
                });

                console.log("Analysis request added to Firestore, ID:", docRef.id);
                // Listen to result from local engine in real-time
                listenToResult(docRef.id);
            } catch (error) {
                console.error("Error writing request to Firestore:", error);
                alert("Firestore connection error: " + error.message);
                resetUI();
            }
        },
        error: function(err) {
            console.error("Error parsing CSV file:", err);
            alert("CSV parse error: " + err.message);
            resetUI();
        }
    });
}

// Listen to Firestore updates
function listenToResult(docId) {
    if (unsubscribeResult) {
        unsubscribeResult();
    }

    unsubscribeResult = onSnapshot(doc(db, "analysis_requests", docId), (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (data.status === "completed") {
                loadingBox.style.display = 'none';
                resultBox.style.display = 'block';
                
                // Format markdown response using marked.js and display
                const formattedResult = marked.parse(data.result);
                resultContent.innerHTML = formattedResult;
                
                // Unsubscribe once done
                if (unsubscribeResult) {
                    unsubscribeResult();
                    unsubscribeResult = null;
                }
            } else if (data.status === "failed") {
                loadingBox.style.display = 'none';
                alert("Local engine error: " + (data.error || "Unknown error occurred"));
                resetUI();
                
                if (unsubscribeResult) {
                    unsubscribeResult();
                    unsubscribeResult = null;
                }
            }
        }
    }, (error) => {
        console.error("Error listening to document:", error);
        loadingBox.style.display = 'none';
        alert("Realtime connection error: " + error.message);
        resetUI();
    });
}

// Reset UI for new analysis
btnReset.addEventListener('click', () => {
    resetUI();
});

function resetUI() {
    fileInput.value = "";
    loadingBox.style.display = 'none';
    resultBox.style.display = 'none';
    resultContent.innerHTML = "";
    if (currentUser) {
        workspaceContainer.style.display = 'block';
    } else {
        workspaceContainer.style.display = 'none';
    }
}
