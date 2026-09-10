/**
 * build-tonight-stations.js — 由鎖定預測產生首頁「今晚各機位排名」靜態資料。
 * data/tonight-stations.json：依鎖定分數排序的該時段測站清單。
 * lock_forecast / auto_validate_capture 兩條 workflow 各跑一次刷新。
 */

const fs = require('fs');
const path = require('path');
const { STATIONS } = require('../js/stations.js');
const { getTaipeiDateString } = require('./live-capture-core.js');

function pickSession(now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit'
  }).format(now));
  return hour < 15 ? 'sunrise' : 'sunset';
}

function buildTonightStations({ dataDir = path.join(__dirname, '../data'), session, now = new Date() } = {}) {
  const sess = session || pickSession(now);
  const lockPath = path.join(dataDir, `locked-${sess}-forecast.json`);
  const locked = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {};
  const map = locked.stations || {};
  const meta = Object.fromEntries(STATIONS.map(s => [s.id, s]));

  const stations = Object.entries(map)
    .filter(([id]) => meta[id])
    .map(([id, s]) => ({
      id,
      name: meta[id].name,
      icon: meta[id].icon,
      score: s.score,
      rating: s.rating,
      color: s.color,
      viewAzimuth: meta[id].viewAzimuth,
      tag: meta[id].tag,
      youtubeUrl: meta[id].url
    }))
    .sort((a, b) => b.score - a.score);

  const out = {
    session: sess,
    date: locked.date || getTaipeiDateString(now),
    generatedAt: new Date().toISOString(),
    stations
  };
  fs.writeFileSync(path.join(dataDir, 'tonight-stations.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`✅ tonight-stations.json: ${sess} ${out.date} — ${stations.length} 站`);
  return out;
}

if (require.main === module) {
  buildTonightStations({ session: process.argv[2] || undefined });
}

module.exports = { buildTonightStations, pickSession };
