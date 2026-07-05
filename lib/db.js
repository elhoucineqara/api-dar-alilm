const mongoose = require('mongoose');
const dns = require('node:dns');
const dotenv = require('dotenv');

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error('Please define the MONGODB_URI environment variable inside .env');
}

let cached = global.mongoose || { conn: null, promise: null };

if (!global.mongoose) {
  global.mongoose = cached;
}

function getMongoDnsServers() {
  if (process.env.MONGODB_DNS_SERVERS) {
    return process.env.MONGODB_DNS_SERVERS.split(',')
      .map((server) => server.trim())
      .filter(Boolean);
  }

  // Node can fail SRV lookups on some Windows DNS setups; fall back to public resolvers.
  if (process.platform === 'win32') {
    return ['8.8.8.8', '1.1.1.1'];
  }

  return [];
}

function shouldRetryWithDnsFallback(error) {
  return (
    MONGODB_URI.startsWith('mongodb+srv://') &&
    error &&
    error.code === 'ECONNREFUSED' &&
    error.syscall === 'querySrv'
  );
}

async function createConnection(opts) {
  try {
    return await mongoose.connect(MONGODB_URI, opts);
  } catch (error) {
    const dnsServers = getMongoDnsServers();

    if (!shouldRetryWithDnsFallback(error) || dnsServers.length === 0) {
      throw error;
    }

    dns.setServers(dnsServers);
    console.warn(
      `MongoDB SRV lookup failed, retrying with DNS servers: ${dnsServers.join(', ')}`
    );

    return mongoose.connect(MONGODB_URI, opts);
  }
}

async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
    };

    cached.promise = createConnection(opts).then((mongoose) => {
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

module.exports = connectDB;
