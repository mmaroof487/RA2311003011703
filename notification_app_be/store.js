const axios = require('axios');
const { getToken } = require('../logging_middleware/tokenStore');
const { Log } = require('../logging_middleware/logger');
const cfg = require('../config');

let notifications = [];

async function refresh() {
  try {
    const token = await getToken();
    const res = await axios.get(`${cfg.base}/notifications`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    notifications = res.data.notifications || [];
    await Log('backend', 'info', 'service', `Refreshed: ${notifications.length} notifs`);
  } catch (err) {
    await Log('backend', 'error', 'handler', `refresh failed: ${err.message.slice(0, 30)}`);
    throw err;
  }
}

function getAll() {
  return notifications;
}

function byType(type) {
  return notifications.filter(n => n.Type === type);
}

module.exports = { refresh, getAll, byType };
