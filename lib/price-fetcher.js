/**
 * Live Price Fetcher for Wealth Module
 *
 * Fetches current market prices from:
 *   - Yahoo Finance (stocks, ETFs, commodities)
 *   - CoinGecko (crypto)
 *   - Polymarket CLOB (prediction markets)
 *
 * FX conversion via ECB daily reference rates (free, no rate limits).
 * In-memory cache: 1-hour TTL for prices, 4-hour TTL for FX rates.
 * No API keys required — all free endpoints.
 */

const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;    // 1 hour
const FX_CACHE_TTL_MS = 4 * 60 * 60 * 1000;   // 4 hours (ECB updates once/day at ~16:00 CET)

// Cache: asset_id -> { price, currency, fetchedAt }
const priceCache = new Map();

// FX rate cache: { rates: Map<currency, rateToEUR>, fetchedAt }
let ecbCache = { rates: new Map(), fetchedAt: 0 };

/**
 * Fetch live prices for a list of positions/assets.
 * @param {Array<{ asset_id, symbol, price_source, lookup_id, currency }>} assets
 * @returns {Map<string, { price: number, currency: string, fetchedAt: number }>}
 */
export async function fetchPrices(assets) {
  const now = Date.now();
  const results = new Map();
  const toFetch = [];

  // Deduplicate and check cache
  const seen = new Set();
  for (const asset of assets) {
    if (seen.has(asset.asset_id)) continue;
    seen.add(asset.asset_id);

    const cached = priceCache.get(asset.asset_id);
    if (cached && (now - cached.fetchedAt) < PRICE_CACHE_TTL_MS) {
      results.set(asset.asset_id, cached);
    } else {
      toFetch.push(asset);
    }
  }

  if (toFetch.length === 0) return results;

  // Group by price_source
  const groups = {};
  for (const asset of toFetch) {
    const source = asset.price_source || 'manual';
    if (!groups[source]) groups[source] = [];
    groups[source].push(asset);
  }

  // Fetch in parallel by source
  const fetchers = {
    yahoo: fetchYahoo,
    coingecko: fetchCoinGecko,
    polymarket: fetchPolymarket,
  };

  const promises = Object.entries(groups).map(async ([source, sourceAssets]) => {
    const fetcher = fetchers[source];
    if (!fetcher) return; // manual, fx, metal_api — skip

    try {
      const prices = await fetcher(sourceAssets);
      for (const [assetId, data] of prices) {
        const entry = { price: data.price, currency: data.currency, fetchedAt: now };
        priceCache.set(assetId, entry);
        results.set(assetId, entry);
      }
    } catch (err) {
      console.error(`[price-fetcher] ${source} fetch failed:`, err.message);
    }
  });

  await Promise.all(promises);
  return results;
}

// ── Yahoo Finance (stocks, ETFs, commodities) ────────────────────────────────

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MyceliumBot/1.0)',
};

async function fetchYahoo(assets) {
  const results = new Map();

  // Yahoo v8 chart API — one request per symbol
  await Promise.all(assets.map(async (asset) => {
    const symbol = asset.lookup_id || asset.symbol;
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
        { signal: AbortSignal.timeout(10_000), headers: YAHOO_HEADERS },
      );
      if (!res.ok) return;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        results.set(asset.asset_id, {
          price: meta.regularMarketPrice,
          currency: meta.currency || asset.currency,
        });
      }
    } catch (err) {
      console.error(`[price-fetcher] yahoo ${symbol}:`, err.message);
    }
  }));

  return results;
}

// ── CoinGecko (crypto) ───────────────────────────────────────────────────────

async function fetchCoinGecko(assets) {
  const results = new Map();

  // Batch: up to 250 ids in one call
  const idMap = new Map(); // coingecko slug -> asset
  for (const asset of assets) {
    const slug = asset.lookup_id || asset.symbol.toLowerCase();
    idMap.set(slug, asset);
  }

  const ids = [...idMap.keys()].join(',');
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd,eur`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return results;
    const data = await res.json();

    for (const [slug, asset] of idMap) {
      const priceData = data[slug];
      if (priceData) {
        // Prefer the asset's own currency, fallback to USD
        const cur = asset.currency?.toLowerCase() || 'usd';
        const price = priceData[cur] || priceData.usd;
        if (price != null) {
          results.set(asset.asset_id, {
            price,
            currency: priceData[cur] ? asset.currency : 'USD',
          });
        }
      }
    }
  } catch (err) {
    console.error(`[price-fetcher] coingecko:`, err.message);
  }

  return results;
}

// ── FX Rates via ECB (European Central Bank) ─────────────────────────────────

// ECB publishes daily reference rates for ~30 currencies vs EUR.
// Format: "1 EUR = X foreign currency" — to convert foreign→EUR, use 1/rate.
// Free, no API key, no rate limits. Updated daily at ~16:00 CET.

const ECB_CURRENCIES = 'USD+GBP+CHF+NOK+SEK+JPY+DKK+PLN+CZK+HUF+AUD+CAD+NZD+SGD+HKD+TRY+ZAR+BRL+CNY+INR+KRW+MXN+THB+IDR+MYR+PHP+ILS+RON+BGN+ISK+HRK';
const ECB_URL = `https://data-api.ecb.europa.eu/service/data/EXR/D.${ECB_CURRENCIES}.EUR.SP00.A?lastNObservations=1&format=csvdata`;

/**
 * Fetch all ECB rates (cached). Returns Map<currency, ratePerEUR>.
 * ratePerEUR = how many units of foreign currency per 1 EUR.
 * E.g., USD: 1.08 means 1 EUR = 1.08 USD.
 */
async function fetchEcbRates() {
  const now = Date.now();
  if (ecbCache.rates.size > 0 && (now - ecbCache.fetchedAt) < FX_CACHE_TTL_MS) {
    return ecbCache.rates;
  }

  try {
    const res = await fetch(ECB_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`[price-fetcher] ECB returned ${res.status}`);
      return ecbCache.rates; // return stale cache
    }

    const csv = await res.text();
    const rates = new Map();
    const lines = csv.split('\n');
    // Skip header row (line 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // CSV fields: KEY,FREQ,CURRENCY,CURRENCY_DENOM,...,OBS_VALUE,...
      // CURRENCY is field index 2, OBS_VALUE is field index 7
      const fields = line.split(',');
      const currency = fields[2];
      const value = parseFloat(fields[7]);
      if (currency && !isNaN(value)) {
        rates.set(currency, value);
      }
    }

    if (rates.size > 0) {
      ecbCache = { rates, fetchedAt: now };
      console.log(`[price-fetcher] ECB rates loaded: ${rates.size} currencies`);
    }
    return rates;
  } catch (err) {
    console.error(`[price-fetcher] ECB fetch failed:`, err.message);
    return ecbCache.rates; // return stale cache on error
  }
}

/**
 * Fetch FX rates to convert from various currencies to the base currency.
 * Uses ECB daily reference rates (primary) with Yahoo Finance as fallback.
 * @param {string} baseCurrency - Target currency (e.g., 'EUR')
 * @param {string[]} fromCurrencies - Source currencies (e.g., ['USD', 'CHF'])
 * @returns {Map<string, number>} currency -> rate (multiply price by rate to get baseCurrency)
 */
export async function fetchFxRates(baseCurrency, fromCurrencies) {
  const rates = new Map();
  rates.set(baseCurrency, 1);

  const normalize = (c) => c === 'USDC' ? 'USD' : c.toUpperCase();
  const base = normalize(baseCurrency);

  // Collect unique currencies to convert
  const needed = new Map(); // normalized -> raw
  for (const raw of fromCurrencies) {
    const cur = normalize(raw);
    if (cur === base || needed.has(cur)) continue;
    needed.set(cur, raw);
  }

  if (needed.size === 0) return rates;

  // ECB rates are always vs EUR
  if (base === 'EUR') {
    const ecbRates = await fetchEcbRates();
    for (const [cur, raw] of needed) {
      const ecbRate = ecbRates.get(cur);
      if (ecbRate) {
        // ECB gives "1 EUR = X foreign", we need "1 foreign = ? EUR" → 1/ecbRate
        const toEur = 1 / ecbRate;
        rates.set(cur, toEur);
        if (raw !== cur) rates.set(raw, toEur);
      }
    }
  }

  // Fallback: for any currencies not resolved by ECB, try Yahoo
  const missing = [];
  for (const [cur, raw] of needed) {
    if (!rates.has(cur)) {
      missing.push({ cur, raw });
    }
  }

  if (missing.length > 0) {
    await Promise.all(missing.map(async ({ cur, raw }) => {
      const pair = `${cur}${base}=X`;
      try {
        const res = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair)}?interval=1d&range=1d`,
          { signal: AbortSignal.timeout(10_000), headers: YAHOO_HEADERS },
        );
        if (!res.ok) return;
        const data = await res.json();
        const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (rate) {
          rates.set(cur, rate);
          if (raw !== cur) rates.set(raw, rate);
        }
      } catch (err) {
        console.error(`[price-fetcher] fx fallback ${pair}:`, err.message);
      }
    }));
  }

  return rates;
}

// ── Polymarket CLOB (prediction markets) ─────────────────────────────────────

async function fetchPolymarket(assets) {
  const results = new Map();

  await Promise.all(assets.map(async (asset) => {
    const tokenId = asset.lookup_id;
    if (!tokenId) return;
    try {
      const res = await fetch(
        `https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=buy`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.price != null) {
        results.set(asset.asset_id, {
          price: parseFloat(data.price),
          currency: 'USDC',
        });
      }
    } catch (err) {
      console.error(`[price-fetcher] polymarket ${asset.symbol}:`, err.message);
    }
  }));

  return results;
}
