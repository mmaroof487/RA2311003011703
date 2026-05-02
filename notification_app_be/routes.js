const express = require('express');
const { Log } = require('../logging_middleware/logger');
const store = require('./store');
const { getTopN } = require('./inbox');

const router = express.Router();

router.get('/notifications', async (req, res) => {
  try {
    await Log('backend', 'info', 'route', 'GET /notifications');
    const type = req.query.type;
    let result;

    if (type) {
      result = store.byType(type);
    } else {
      result = store.getAll();
    }

    res.json(result);
  } catch (err) {
    await Log('backend', 'error', 'handler', `notifs failed: ${err.message.slice(0, 30)}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/notifications/top/:n', async (req, res) => {
  try {
    const n = parseInt(req.params.n, 10);
    if (isNaN(n) || n < 1) {
      return res.status(400).json({ error: 'n must be a positive integer' });
    }

    await Log('backend', 'info', 'route', `GET /notifications/top/${n}`);
    const all = store.getAll();
    const top = await getTopN(all, n);
    res.json(top);
  } catch (err) {
    await Log('backend', 'error', 'handler', `top failed: ${err.message.slice(0, 34)}`);
    res.status(500).json({ error: err.message });
  }
});


router.post('/notifications/refresh', async (req, res) => {
  try {
    await Log('backend', 'info', 'route', 'POST /notifications/refresh');
    await store.refresh();
    res.status(204).send();
  } catch (err) {
    await Log('backend', 'error', 'handler', `refresh failed: ${err.message.slice(0, 30)}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
