const express = require("express");
const { Log } = require("../logging_middleware/logger");
const scheduleRoutes = require("./routes");

const app = express();
const PORT = 3001;

app.use(express.json());
app.use(scheduleRoutes);

const startServer = async () => {
	try {
		await Log("backend", "info", "service", "vehicle scheduler ready on port " + PORT);
		app.listen(PORT);
	} catch (err) {
		await Log("backend", "fatal", "service", "server error: " + err.message);
		process.exit(1);
	}
};

if (require.main === module) {
	startServer();
}

module.exports = app;
