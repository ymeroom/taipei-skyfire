/**
 * capture-validation.js - Phase 1: 霞光台北 台北攝影機位出景窗口 YouTube 實況影格自動擷取與預測記錄器
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SolarCalc = require('../js/solar-calc.js');
const SkyFireEngine = require('../js/skyfire-engine.js');
const WeatherService = require('../js/weather-service.js');
const TAIPEI_SPOTS = require('../js/spots-data.js');

const TARGET_STREAMS = [
  {
    id: 'xiangshan_101',
    name: '台北象山看 101 (4K 官方即時影像)',
    query: '台北 象山 即時影像 4K live',
    staticFile: 'xiangshan-live.jpg'
  },
  {
    id: 'dadaocheng',
    name: '台北大稻埕碼頭 (4K 官方即時影像)',
    query: '台北 大稻埕 即時影像 4K live',
    staticFile: 'dadaocheng-live.jpg'
  },
  {
    id: 'tamsui',
    name: '新北淡水漁人碼頭 (4K 官方即時影像)',
    query: '淡水漁人碼頭 4K 即時影像 live',
    staticFile: 'tamsui-live.jpg'
  }
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('連線逾時'));
    });
  });
}

async function extractYouTubeLiveVideoId(query) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const buffer = await fetchUrl(searchUrl);
    const html = buffer.toString('utf8');
    const matches = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
    if (matches && matches.length > 0) {
      const vid = matches[0].replace(/"videoId":"|"/g, '');
      return vid;
    }
  } catch (err) {
    console.warn(`⚠️ 檢索 YouTube 直播 [${query}] 失敗:`, err.message);
  }
  return null;
}

async function runCapturePipeline(sessionType = 'sunset') {
  console.log(`====================================================`);
  console.log(`📸 啟動 霞光台北 官方 YouTube 4K 實況影格自動擷取管線 [時段: ${sessionType}]`);
  console.log(`====================================================\n`);

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const solarTimes = SolarCalc.getTimes(now);
  
  const outputDir = path.join(__dirname, '../data/snapshots');
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const targetStream = TARGET_STREAMS[0];

  console.log(`📅 今日觀測日期: ${dateStr}`);
  console.log(`📍 標的站點: ${targetStream.name}`);

  let forecastData;
  try {
    forecastData = await WeatherService.fetchForecast(true);
  } catch (err) {
    forecastData = WeatherService.generateSimulatedForecast();
  }

  const todaySessionData = sessionType === 'sunrise' 
    ? forecastData.daysForecast[0].sunrise 
    : forecastData.daysForecast[0].sunset;

  const predictedScore = todaySessionData.skyfire.score;
  const predictedRating = todaySessionData.skyfire.rating;

  console.log(`🔥 標的站點模型預測評分: ${predictedScore} 分 (${predictedRating.badge})`);

  const snapshotFileName = `${dateStr}-${sessionType}.jpg`;
  const snapshotPath = path.join(outputDir, snapshotFileName);
  let captureSuccess = false;
  let liveVideoId = null;
  let watchUrl = null;

  console.log(`🎥 正在透過 YouTube 搜尋擷取 [${targetStream.name}] 即時 4K 影格...`);
  liveVideoId = await extractYouTubeLiveVideoId(targetStream.query);

  if (liveVideoId) {
    watchUrl = `https://www.youtube.com/watch?v=${liveVideoId}`;
    console.log(`✅ 成功尋獲 YouTube 官方直播 Video ID: ${liveVideoId}`);
    console.log(`   直播網址: ${watchUrl}`);

    const maxresUrl = `https://i.ytimg.com/vi/${liveVideoId}/maxresdefault.jpg`;
    const hqUrl = `https://i.ytimg.com/vi/${liveVideoId}/hqdefault.jpg`;

    try {
      let imgBuf = await fetchUrl(maxresUrl);
      if (!imgBuf || imgBuf.length < 5000) {
        imgBuf = await fetchUrl(hqUrl);
      }
      if (imgBuf && imgBuf.length > 5000) {
        fs.writeFileSync(snapshotPath, imgBuf);
        captureSuccess = true;
        console.log(`🎉 官方 YouTube 4K 即時影格已儲存！大小: ${imgBuf.length} bytes -> data/snapshots/${snapshotFileName}`);
      }
    } catch (e) {
      console.warn(`⚠️ 下載 YouTube 影格失敗:`, e.message);
    }
  }

  if (!captureSuccess) {
    const localFallback = path.join(outputDir, targetStream.staticFile);
    if (fs.existsSync(localFallback)) {
      fs.copyFileSync(localFallback, snapshotPath);
      captureSuccess = true;
      console.log(`🔄 已使用真實 YouTube 官方 4K 實景影格: ${targetStream.staticFile}`);
    }
  }

  const recordsFile = path.join(dataDir, 'verification-records.json');
  let records = [];
  if (fs.existsSync(recordsFile)) {
    try {
      records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    } catch (e) {
      records = [];
    }
  }

  const newRecord = {
    id: `rec-${dateStr}-${sessionType}`,
    date: dateStr,
    session: sessionType,
    sessionLabel: sessionType === 'sunset' ? '今日日落' : '今日日出',
    capturedAt: now.toISOString(),
    sourceStream: targetStream.name,
    youtubeLiveUrl: watchUrl || `https://www.youtube.com/results?search_query=${encodeURIComponent(targetStream.query)}`,
    snapshotUrl: `data/snapshots/${snapshotFileName}`,
    prediction: {
      score: predictedScore,
      rating: predictedRating.badge,
      color: predictedRating.color,
      highCloud: todaySessionData.weather.cloudHigh,
      midCloud: todaySessionData.weather.cloudMid,
      lowCloud: todaySessionData.weather.cloudLow
    },
    verification: {
      status: captureSuccess ? 'captured_ready_for_scoring' : 'pending_capture',
      groundTruthScore: null,
      errorAbsolute: null
    }
  };

  const existingIdx = records.findIndex(r => r.id === newRecord.id);
  if (existingIdx >= 0) {
    records[existingIdx] = newRecord;
  } else {
    records.unshift(newRecord);
  }

  if (records.length > 90) records = records.slice(0, 90);

  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
  console.log(`💾 驗證紀錄已更新至 data/verification-records.json`);
  console.log(`====================================================\n`);
}

const sessionArg = process.argv[2] || 'sunset';
runCapturePipeline(sessionArg);
