// firebase-admin.js
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Exportamos 'db' para usarlo en el webhook más adelante
module.exports = { db, admin };