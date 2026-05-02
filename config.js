require('dotenv').config({ path: require('path').join(__dirname, '.env') });

module.exports = {
	email: "mm4116@srmist.edu.in",
	name: "Mohammad Maroof",
	rollNo: "RA2311003011703",
	accessCode: process.env.ACCESS_CODE || "QkbpxH",
	clientID: process.env.CLIENT_ID || "34c867a8-06fe-4a7e-af41-6465dee93039",
	clientSecret: process.env.CLIENT_SECRET,
	base: process.env.BASE_URL || "http://20.207.122.201/evaluation-service",
};

if (!module.exports.clientSecret) {
  throw new Error('[config] CLIENT_SECRET is not set. Check your .env file.');
}
