require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const cors = require("cors");

const allowedOrigins = [
  "http://localhost:3000", // local dev
  "https://arzino-eight.vercel.app", // replace with real domain
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // allow server-to-server
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
const PORT = process.env.PORT || 3001;

// Path where we store cached response.
const CACHE_FILE = path.join(__dirname, "cache.json");
const CACHE_TTL_MS = 65 * 60 * 1000; // 65 minutes


const DEFAULT_FOREX_SPREAD = 0.008;
const DEFAULT_CRYPTO_SPREAD = 0.012;

const FOREX_SPREAD = (() => {
  const raw = process.env.FOREX_SPREAD;
  const num = raw != null ? Number(raw) : NaN;
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_FOREX_SPREAD;
})();

const CRYPTO_SPREAD = (() => {
  const raw = process.env.CRYPTO_SPREAD;
  const num = raw != null ? Number(raw) : NaN;
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_CRYPTO_SPREAD;
})();

const CURRENCY_LABELS = {
  USD: "US Dollar",
  EUR: "Euro",
  GBP: "British Pound",
  CHF: "Swiss Franc",
  SAR: "KSA Riyal",
  AED: "UAE Dirham",
  KWD: "Kuwaiti Dinar",
  QAR: "Qatari Riyal",
  IRR: "Iranian Rial",
  IQD: "Iraqi Dinar",
  RUB: "Russian Ruble",
  AZN: "Azerbaijani Manat",
  CAD: "Canadian Dollar",
  AUD: "Australian Dollar",
  SEK: "Swedish Krona",
  NOK: "Norwegian Krone",
  DKK: "Danish Krone",
  JPY: "Japanese Yen",
  CNY: "Chinese Yuan",
};

const ALLOWED_CURRENCIES_IN_ORDER = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "SAR",
  "AED",
  "KWD",
  "QAR",
  "IRR",
  "IQD",
  "RUB",
  "AZN",
  "CAD",
  "AUD",
  "SEK",
  "NOK",
  "DKK",
  "JPY",
  "CNY",
];

function parseLocaleNumber(val) {
  if (val == null) return null;
  const str = String(val).trim();
  if (!str || str === "-") return null;

  let cleaned = str;
  // Turkish-style numbers: dots are thousands, comma is decimal.
  if (cleaned.includes(",")) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }

  const num = Number(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function buildRates(forexData) {
  if (!Array.isArray(forexData)) return [];

  return ALLOWED_CURRENCIES_IN_ORDER.map((code) => {
    const match = forexData.find((item) => item.code === code);
    const rateFromApi = match?.rate;
    const numericRate = Number(rateFromApi);

    if (!Number.isFinite(numericRate) || numericRate <= 0) {
      return null;
    }

    const midPrice = 1 / numericRate;
    const sell = midPrice * (1 + FOREX_SPREAD);
    const buy = midPrice * (1 - FOREX_SPREAD);

    return {
      code,
      name: CURRENCY_LABELS[code] ?? code,
      midPrice,
      sell,
      buy,
    };
  }).filter(Boolean);
}

function buildGoldItems(goldArr) {
  if (!Array.isArray(goldArr) || goldArr.length === 0) return [];

  return goldArr
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.name === "string"
    )
    .map((item) => {
      const sell = parseLocaleNumber(item.sell ?? item.selling);
      const buy = parseLocaleNumber(item.buy ?? item.buying);
      if (sell == null && buy == null) return null;
      return { name: item.name, sell, buy };
    })
    .filter(Boolean);
}

function buildSilverItem(silverRaw) {
  if (!silverRaw || typeof silverRaw !== "object") return null;

  const buying = parseLocaleNumber(silverRaw.buying ?? silverRaw.buy);
  const selling = parseLocaleNumber(silverRaw.selling ?? silverRaw.sell);

  if (buying == null && selling == null) return null;
  return { buying, selling };
}

function buildCryptoItems(cryptoRaw) {
  if (!Array.isArray(cryptoRaw)) return [];

  const preferredCodes = ["BTC", "ETH"];
  const picked = [];

  preferredCodes.forEach((code) => {
    const found = cryptoRaw.find((item) => item.code === code);
    if (found) picked.push(found);
  });

  for (const item of cryptoRaw) {
    if (picked.length >= 5) break;
    if (picked.some((p) => p.code === item.code)) continue;
    picked.push(item);
  }

  return picked
    .map((item) => {
      const priceUsd = Number(item.price);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

      const midPrice = priceUsd;
      return {
        code: item.code,
        name: item.name,
        midPrice,
        sell: midPrice * (1 + CRYPTO_SPREAD),
        buy: midPrice * (1 - CRYPTO_SPREAD),
      };
    })
    .filter(Boolean);
}

// Ensure runtime has a fetch implementation (Node 18+).
if (typeof fetch !== "function") {
  // Fail fast with a clear message instead of crashing later in handlers.
  throw new Error(
    "Global fetch is not available. Please run on Node.js >= 18 or add a fetch polyfill."
  );
}

// Reusable helper to call CollectAPI with required headers and error checks.
async function fetchFromCollectApi(url) {
  const apiKey = process.env.COLLECT_API_KEY;
  if (!apiKey) {
    throw new Error("COLLECT_API_KEY is missing in environment variables.");
  }

  const headers = {
    "content-type": "application/json",
    authorization: `${apiKey}`,
  };

  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Request to ${url} failed with status ${res.status}`);
  }
  return res.json();
}

// Shape raw CollectAPI responses into a single clean object with spread logic.
function buildBoardPayload({ forexJson, goldJson, silverJson, cryptoJson }) {
  const timestamp = Date.now();

  const currenciesRaw =
    forexJson?.result?.data ||
    forexJson?.result ||
    forexJson?.data ||
    forexJson?.result?.currencies ||
    [];

  const goldRaw =
    goldJson?.result?.data ||
    goldJson?.result ||
    goldJson?.data ||
    (Array.isArray(goldJson) ? goldJson : []);

  const silverRaw =
    silverJson?.result ||
    silverJson?.data ||
    silverJson ||
    null;

  const cryptoRaw =
    cryptoJson?.result?.data ||
    cryptoJson?.result ||
    cryptoJson?.data ||
    (Array.isArray(cryptoJson) ? cryptoJson : []);

  const currencies = buildRates(currenciesRaw);
  const gold = buildGoldItems(goldRaw);
  const silver = buildSilverItem(silverRaw);
  const crypto = buildCryptoItems(cryptoRaw);

  return {
    lastUpdate: timestamp,
    currencies,
    gold,
    silver,
    crypto,
  };
}

// Fetch fresh data from all CollectAPI endpoints and build unified payload.
async function fetchFreshBoardData() {
  const forexUrl =
    "https://api.collectapi.com/economy/currencyToAll?int=10&base=TRY";
  const goldUrl = "https://api.collectapi.com/economy/goldPrice";
  const silverUrl = "https://api.collectapi.com/economy/silverPrice";
  const cryptoUrl = "https://api.collectapi.com/economy/cripto";

  const [forexJson, goldJson, silverJson, cryptoJson] = await Promise.all([
    fetchFromCollectApi(forexUrl),
    fetchFromCollectApi(goldUrl),
    fetchFromCollectApi(silverUrl),
    fetchFromCollectApi(cryptoUrl),
  ]);

  const data = buildBoardPayload({ forexJson, goldJson, silverJson, cryptoJson });

  // Synchronous write keeps logic simple and avoids partial writes in this small app.
  const cachePayload = {
    lastFetch: Date.now(),
    data,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cachePayload, null, 2), "utf-8");

  return data;
}

// Health check endpoint.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Main board endpoint with file-based caching.
app.get("/api/board", async (req, res) => {
  try {
    let useCache = false;
    let cachedData = null;

    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        const lastFetch = parsed?.lastFetch;
        if (typeof lastFetch === "number") {
          const age = Date.now() - lastFetch;
          if (age < CACHE_TTL_MS) {
            useCache = true;
            cachedData = parsed.data;
          }
        }
      } catch (e) {
        // If cache is corrupt or unreadable, fall back to fresh fetch.
        console.warn("Failed to read cache.json, fetching fresh data.", e);
      }
    }

    if (useCache && cachedData) {
      return res.json(cachedData);
    }

    const freshData = await fetchFreshBoardData();
    return res.json(freshData);
  } catch (err) {
    console.error("Error in /api/board:", err);
    return res.status(500).json({
      message: "Failed to load board data from CollectAPI.",
      error: process.env.NODE_ENV === "production" ? undefined : String(err.message || err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

