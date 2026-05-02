const express = require('express');
const { getToken } = require('../logging_middleware/tokenStore');
const { Log } = require('../logging_middleware/logger');
const { fetchDepots, fetchVehicles, runForAllDepots } = require('./scheduler');

const router = express.Router();

router.get('/schedule/run', async (req, res) => {
  try {
    await Log('backend', 'info', 'route', 'GET /schedule/run');
    const token = await getToken();
    const results = await runForAllDepots(token);
    res.json(results);
  } catch (err) {
    await Log('backend', 'error', 'handler', `run failed: ${err.message.slice(0, 34)}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/schedule/depots', async (req, res) => {
  try {
    await Log('backend', 'info', 'route', 'GET /schedule/depots');
    const token = await getToken();
    const depots = await fetchDepots(token);
    res.json(depots);
  } catch (err) {
    await Log('backend', 'error', 'handler', `depots failed: ${err.message.slice(0, 31)}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/schedule/vehicles', async (req, res) => {
  try {
    await Log('backend', 'info', 'route', 'GET /schedule/vehicles');
    const token = await getToken();
    const vehicles = await fetchVehicles(token);
    res.json(vehicles);
  } catch (err) {
    await Log('backend', 'error', 'handler', `vehicles failed: ${err.message.slice(0, 29)}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
