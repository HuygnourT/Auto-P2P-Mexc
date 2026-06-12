const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'settings.json');
const DEFAULT = { mexc: {}, bitget: {}, bybit: {}, mexcPricer: {}, bitgetPricer: {} };
const ALLOWED = Object.keys(DEFAULT);

function getSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      const dir = path.dirname(SETTINGS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT, null, 2));
      return { ...DEFAULT };
    }
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch (err) {
    logger.error(`[Settings] Read error: ${err.message}`);
    return { ...DEFAULT };
  }
}

function saveSection(section, data) {
  if (!ALLOWED.includes(section)) throw new Error(`Invalid section: ${section}`);
  const settings = getSettings();
  settings[section] = data;
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    logger.info(`[Settings] Saved section: ${section}`);
  } catch (err) {
    logger.error(`[Settings] Write error: ${err.message}`);
    throw err;
  }
  return settings;
}

module.exports = { getSettings, saveSection };