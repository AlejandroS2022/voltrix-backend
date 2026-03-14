const TwelveDataAdapter = require('./twelveDataAdapter');

// Singleton instance - configure with your Twelve Data API key in .env
const twelveData = new TwelveDataAdapter({
  apiKey: process.env.TWELVEDATA_API_KEY
});

module.exports = twelveData;
