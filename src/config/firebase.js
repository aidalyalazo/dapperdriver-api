const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.');
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const messaging = admin.messaging();

module.exports = { admin, messaging };
