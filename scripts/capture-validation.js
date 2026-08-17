/**
 * capture-validation.js - Phase 1: 晨昏出景窗口自動截圖與預測記錄器
 * 依據今日日出/日落天文時間，從公開 4K 即時串流截取實況影像並記錄模型預測數據
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SolarCalc = require('../js/solar-calc.js');
const SkyFireEngine = require('../js/skyfire-engine.js');
const WeatherService = require('../js/weather-service.js');

// 官方 4K 直播觀測串流來源配置
const STREAMS = [
  {
    id: 'xiangshan_101',
    name: '象山看台北 101 (西向全景)',
    url: 'https://www.youtube.com/@TaipeiTravelGeeks/live'
  },
  {
    id: 'dadaocheng',
    name: '大稻埕碼頭 (淡水河落日)',
    url: 'https://www.youtube.com/@TaipeiTravelGeeks/live'
  },
  {
    id: 'tamsui',
    name: '淡水漁人碼頭 (台灣海峽落日)',
    url: 'https://www.youtube.com/@ntpcrocks/live'
  }
];

async function runCapturePipeline(sessionType = 'sunset') {
  console.log(`====================================================`);
  console.log(`📸 啟動火燒雲即時驗證影像擷取管線 [時段: ${sessionType}]`);
  console.log(`====================================================\n`);

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const solarTimes = SolarCalc.getTimes(now);
  
  console.log(`📅 今日觀測日期: ${dateStr}`);
  console.log(`⏰ 日出時刻: ${SolarCalc.formatTime(solarTimes.sunrise)} / 日落時刻: ${SolarCalc.formatTime(solarTimes.sunset)}`);

  // 1. 確保 snapshots 與 data 目錄存在
  const outputDir = path.join(__dirname, '../data/snapshots');
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // 2. 獲取今日當前氣象預測數據
  console.log('📡 正在獲取當前氣象預報與 SkyFireEngine 評分...');
  let forecastData;
  try {
    forecastData = await WeatherService.fetchForecast(true);
  } catch (err) {
    console.warn('⚠️ API 連線失敗，使用離線模型:', err.message);
    forecastData = WeatherService.generateSimulatedForecast();
  }

  const todaySessionData = sessionType === 'sunrise' 
    ? forecastData.daysForecast[0].sunrise 
    : forecastData.daysForecast[0].sunset;

  const predictedScore = todaySessionData.skyfire.score;
  const predictedRating = todaySessionData.skyfire.rating;
  const metrics = todaySessionData.skyfire.metrics;

  console.log(`🔥 今日模型預測評分: ${predictedScore} 分 (${predictedRating.badge})`);

  // 3. 逐一嘗試從 YouTube Live 串流擷取即時影格
  const snapshotFileName = `${dateStr}-${sessionType}.jpg`;
  const snapshotPath = path.join(outputDir, snapshotFileName);
  let captureSuccess = false;
  let capturedSource = '';

  for (const stream of STREAMS) {
    console.log(`🎥 嘗試連線至串流: ${stream.name}...`);
    try {
      // 透過 yt-dlp 獲取 m3u8 即時串流 URL
      const getUrlCmd = `yt-dlp -g --format best "${stream.url}"`;
      const streamUrl = execSync(getUrlCmd, { timeout: 15000, encoding: 'utf8' }).trim().split('\n')[0];

      if (streamUrl && streamUrl.startsWith('http')) {
        console.log('✅ 成功取得串流 URL，正在透過 ffmpeg 擷取 1 幀 4K 影格...');
        const ffmpegCmd = `ffmpeg -y -ss 00:00:01 -i "${streamUrl}" -vframes 1 -q:v 2 "${snapshotPath}"`;
        execSync(ffmpegCmd, { timeout: 15000, stdio: 'ignore' });

        if (fs.existsSync(snapshotPath) && fs.statSync(snapshotPath).size > 1000) {
          captureSuccess = true;
          capturedSource = stream.name;
          console.log(`🎉 影格擷取成功！儲存於: data/snapshots/${snapshotFileName}`);
          break;
        }
      }
    } catch (err) {
      console.warn(`⚠️ 串流 [${stream.name}] 暫時無法提取:`, err.message);
    }
  }

  // 若處於本機開發或無 yt-dlp/ffmpeg 環境，建立標記用結構
  if (!captureSuccess) {
    console.log('ℹ️ 尚未於環境中偵測到可連線串流工具，記錄預測元數據...');
  }

  // 4. 寫入或更新 data/verification-records.json
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
    capturedAt: now.toISOString(),
    sourceStream: capturedSource || 'Taipei 4K Live Stream',
    snapshotUrl: captureSuccess ? `data/snapshots/${snapshotFileName}` : null,
    prediction: {
      score: predictedScore,
      rating: predictedRating.badge,
      color: predictedRating.color,
      highCloud: todaySessionData.weather.cloudHigh,
      midCloud: todaySessionData.weather.cloudMid,
      lowCloud: todaySessionData.weather.cloudLow,
      horizonClearance: metrics.horizonClearance,
      visibilityKm: metrics.visKm
    },
    verification: {
      status: captureSuccess ? 'captured_ready_for_scoring' : 'pending_capture',
      groundTruthScore: null,
      errorAbsolute: null,
      verifiedBy: null
    }
  };

  // 若已存在當天同 session 紀錄則覆寫，否則插入頭部
  const existingIdx = records.findIndex(r => r.id === newRecord.id);
  if (existingIdx >= 0) {
    records[existingIdx] = newRecord;
  } else {
    records.unshift(newRecord);
  }

  // 保留最近 90 天觀測紀錄
  if (records.length > 90) records = records.slice(0, 90);

  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
  console.log(`💾 驗證紀錄已更新至 data/verification-records.json (共 ${records.length} 筆歷史紀錄)`);
  console.log(`====================================================\n`);
}

// 支援命令列直接執行: node scripts/capture-validation.js [sunset|sunrise]
const sessionArg = process.argv[2] || 'sunset';
runCapturePipeline(sessionArg);
