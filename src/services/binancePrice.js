const puppeteer = require('puppeteer');
const logger = require('../utils/logger');

const URL = 'https://www.pricedancing.com/vi/Binance-P2P-USDT-VND-chart-ZqzaQWc';

let cachedPrice = null;
let lastUpdated = null;
let browser = null;

async function fetchPriceFromTitle() {
  try {
    if (!browser) {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }

    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Đợi title thay đổi chứa số (trang JS cập nhật title với giá)
    await page.waitForFunction(
      () => /[\d,.]+/.test(document.title),
      { timeout: 15000 }
    );

    const title = await page.title();
    console.log("Title "+ title);
    await page.close();

    // Lấy số đầu tiên trong title: "25,500 | Binance P2P USDT-VND" → 25500
    const match = title.match(/([\d,.]+)/);
    if (match) {
      const priceStr = match[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      if (!isNaN(price)) {
        cachedPrice = price;
        lastUpdated = new Date().toISOString();
        //logger.info(`[BinancePrice] Title: "${title}" → Price: ${price}`);
      }
    }
  } catch (err) {
    logger.error(`[BinancePrice] Fetch error: ${err.message}`);
  }
}

function getPrice() {
  return { price: cachedPrice, lastUpdated };
}

function startPolling(intervalMs = 60000) {
  fetchPriceFromTitle();
  setInterval(fetchPriceFromTitle, intervalMs);
  logger.info(`[BinancePrice] Polling every ${intervalMs / 1000}s`);
}

module.exports = { getPrice, startPolling };