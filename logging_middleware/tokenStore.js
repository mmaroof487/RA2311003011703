const axios = require('axios');
const cfg = require('../config');

let cachedToken = null;
let expiresAt = 0;

async function getToken() {
  const now = Date.now() / 1000;
  
  if (cachedToken && now < expiresAt - 60) {
    return cachedToken;
  }

  const payload = {
    email: cfg.email,
    name: cfg.name,
    rollNo: cfg.rollNo,
    accessCode: cfg.accessCode,
    clientID: cfg.clientID,
    clientSecret: cfg.clientSecret
  };

  try {
    const tokenRes = await axios.post(`${cfg.base}/auth`, payload);
    cachedToken = tokenRes.data.access_token;
    expiresAt = (Date.now() / 1000) + tokenRes.data.expires_in;
    return cachedToken;
  } catch (err) {
    const error = new Error(err.message);
    error.status = err.response?.status;
    error.responseBody = err.response?.data;
    throw error;
  }
}

module.exports = { getToken };
