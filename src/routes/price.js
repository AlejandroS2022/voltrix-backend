const express = require("express");
const axios = require("axios");
const router = express.Router();
const redis = require("../config/redis");

// GET /api/price/:symbol -> returns latest tick for symbol
router.get("/:symbol", async (req, res) => {
  try {
    let symbol = (req.params.symbol || "").toUpperCase();
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const key = `tick_latest:${symbol}`;
    const v = await redis.get(key);
    if (!v) return res.status(404).json({ error: "no_price" });
    const obj = JSON.parse(v);
    res.json(obj);
  } catch (err) {
    console.error("price route error", err);
    res.status(500).json({ error: "price_error" });
  }
});

router.get("/history/:symbol", async (req, res) => {
  try {
    let { symbol } = req.params;
    const apiKey = process.env.TWELVEDATA_API_KEY;
    const interval = req.query.interval || "1min";

    if (!symbol) return res.status(400).json({ error: "Símbolo faltante" });

    let s = symbol.toUpperCase().trim();

    // ESTRATEGIA: Intentar primero sin barra (Metales/Stocks) y si falla, con barra (Divisas/Cripto)
    let url = `https://api.twelvedata.com/time_series?symbol=${s}&interval=${interval}&outputsize=5000&apikey=${apiKey}`;
    let response = await axios.get(url);

    if (response.data.status === "error" && !s.includes("/")) {
      const quotes = ["USD", "EUR", "BTC", "ETH", "USDT", "JPY"];
      for (let quote of quotes) {
        if (s.endsWith(quote)) {
          const base = s.replace(quote, "");
          const formattedSymbol = `${base}/${quote}`;
          const retryUrl = `https://api.twelvedata.com/time_series?symbol=${formattedSymbol}&interval=${interval}&outputsize=5000&apikey=${apiKey}`;
          response = await axios.get(retryUrl);
          break;
        }
      }
    }

    if (response.data.status === "error" || !response.data.values) {
      return res
        .status(404)
        .json({ error: response.data.message || "No hay datos" });
    }

    // Tu processData actual es correcto, mantiene los decimales de TwelveData
    res.json(processData(response.data.values));
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
});

// processData está bien, el parseFloat preserva los decimales necesarios.
function processData(values) {
  return values
    .map((item) => ({
      time: Math.floor(new Date(item.datetime).getTime() / 1000),
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
    }))
    .sort((a, b) => a.time - b.time);
}

module.exports = router;
