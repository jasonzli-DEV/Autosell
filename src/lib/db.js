const mongoose = require('mongoose');

let connected = false;

async function connectDb() {
  if (connected) return;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set.');

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    connected = true;
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    throw err;
  }
}

module.exports = { connectDb };
