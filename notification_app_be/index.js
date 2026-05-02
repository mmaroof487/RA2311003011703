const express = require('express');
const { Log } = require('../logging_middleware/logger');
const store = require('./store');
const notificationRoutes = require('./routes');

const app = express();
const PORT = 3002;

app.use(express.json());
app.use(notificationRoutes);

const startServer = async () => {
  try {
    await store.refresh();
    const allNotifs = store.getAll();
    await Log('backend', 'info', 'service', `app ready: ${allNotifs.length} notifs`);
    app.listen(PORT, () => {
      // Log call already made above
    });
  } catch (err) {
    await Log('backend', 'fatal', 'service', `error: ${err.message.slice(0, 38)}`);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = app;
