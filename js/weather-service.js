/**
 * WeatherService - 串接 Open-Meteo 即時氣象 API 與多層雲量解析
 */

const SolarCalcModule = typeof window !== 'undefined' ? window.SolarCalc : (typeof global !== 'undefined' && global.SolarCalc ? global.SolarCalc : require('./solar-calc.js'));
const SkyFireEngineModule = typeof window !== 'undefined' ? window.SkyFireEngine : (typeof global !== 'undefined' && global.SkyFireEngine ? global.SkyFireEngine : require('./skyfire-engine.js'));

class WeatherService {
  // 台北核心基準點（大稻埕碼頭/市中心）
  static TAIPEI_COORDS = { lat: 25.057045, lng: 121.507718, name: '台北核心（大稻埕）' };
  static CACHE_KEY = 'taipei_skyfire_weather_cache_v2';
  static CACHE_DURATION_MS = 15 * 60 * 1000; // 15 分鐘快取

  /**
   * 計算沿太陽方位角向量延伸的上游進光點座標 (Upstream Ray-Path Sampling Point)
   * @param {number} lat 本地緯度
   * @param {number} lng 本地經度
   * @param {number} azimuthDeg 太陽方位角 (度，0-360)
   * @param {number} distanceKm 延伸距離 (公里，預設 60km)
   */
  static calculateUpstreamCoords(lat, lng, azimuthDeg, distanceKm = 60) {
    const rad = (azimuthDeg * Math.PI) / 180;
    // 緯度 1 度約 111.32 km
    const deltaLat = (distanceKm * Math.cos(rad)) / 111.32;
    // 經度 1 度約 111.32 * cos(lat) km
    const deltaLng = (distanceKm * Math.sin(rad)) / (111.32 * Math.cos((lat * Math.PI) / 180));
    return {
      lat: parseFloat((lat + deltaLat).toFixed(4)),
      lng: parseFloat((lng + deltaLng).toFixed(4)),
      azimuth: parseFloat(azimuthDeg.toFixed(1)),
      distanceKm
    };
  }

  // 地球平均半徑 (公里)
  static EARTH_RADIUS_KM = 6371;

  // 光路取樣階梯：沿太陽方位角外推的取樣距離 (公里)
  // 單點取樣容易被 Open-Meteo 約 11km 的網格切過帶狀雲系，故改為整條光路多點取樣。
  static RAY_PATH_LADDER_KM = [60, 110, 160, 210, 260];

  /**
   * 計算近水平太陽射線在上游某距離處的高度 (公里)
   *
   * 日出/日落時太陽仰角約 0°，射線可視為與地表相切的直線。
   * 抵達觀測點上空 h 公里的射線，其切地點距觀測點 sqrt(2Rh) 公里；
   * 在上游 d 公里處，射線距切地點 x = sqrt(2Rh) - d，高度為 x^2 / (2R)。
   * 超過切地點 (x <= 0) 表示射線已被地表截斷，回傳 0。
   *
   * @param {number} targetAltitudeKm 射線最終抵達觀測點上空的高度 (公里)
   * @param {number} distanceKm 上游取樣距離 (公里)
   * @returns {number} 射線在該處的高度 (公里)
   */
  static rayAltitudeAtDistanceKm(targetAltitudeKm, distanceKm) {
    const R = this.EARTH_RADIUS_KM;
    const tangentDistanceKm = Math.sqrt(2 * R * targetAltitudeKm);
    const x = tangentDistanceKm - distanceKm;
    if (x <= 0) return 0;
    return parseFloat(((x * x) / (2 * R)).toFixed(3));
  }

  /**
   * 沿太陽方位角建立整條光路的取樣點清單
   * @param {number} lat 觀測點緯度
   * @param {number} lng 觀測點經度
   * @param {number} azimuthDeg 太陽方位角 (度)
   * @returns {Array<{distanceKm:number, lat:number, lng:number, azimuth:number}>}
   */
  static buildRayPathSamplingPlan(lat, lng, azimuthDeg) {
    return this.RAY_PATH_LADDER_KM.map(distanceKm =>
      this.calculateUpstreamCoords(lat, lng, azimuthDeg, distanceKm)
    );
  }

  /**
   * 分層光路帶定義 (Layered Ray-Path Bands)
   *
   * 每一層雲要被染紅，靠的是「抵達它的那條射線」沿途沒被擋住。
   * 由 rayAltitudeAtDistanceKm 可知，同一段上游距離對不同高度的雲意義完全不同：
   *   - 抵達 6km 高雲的射線在上游 60km 處已爬到 3.68km，該處的低雲擋不到它；
   *   - 真正會遮斷高雲進光的低雲，位置在 160~276km 外。
   * 因此每層雲各自對應一段取樣距離區間，不可共用單一距離。
   *
   * weight 為三層對「地平線透光窗」總分的貢獻權重，總和為 1。
   * 高雲天幕是火燒雲的主角，故權重最高。
   */
  static RAY_PATH_BANDS = Object.freeze({
    low: Object.freeze({
      targetAltitudeKm: 1.5,
      distancesKm: [60, 110],
      weight: 0.2,
      label: '低雲染色帶'
    }),
    mid: Object.freeze({
      targetAltitudeKm: 3,
      distancesKm: [110, 160],
      weight: 0.3,
      label: '中雲光路帶'
    }),
    high: Object.freeze({
      targetAltitudeKm: 6,
      distancesKm: [160, 210, 260],
      weight: 0.5,
      label: '高雲天幕帶'
    })
  });

  /**
   * 依地形高度分類取樣點
   *
   * 注意：Open-Meteo 的 elevation 是網格平均高度，台北盆地同樣回傳 0，
   * 因此高度 0 只能判定為「海面或平原」，不能斷言是海面。
   * 真正可嚴謹計算的是地形遮蔽 (computeTerrainBlocking)，此分類僅供診斷標示。
   *
   * @param {number} elevationM 地形高度 (公尺)
   */
  static classifyTerrain(elevationM) {
    const m = Number(elevationM);
    if (!Number.isFinite(m) || m <= 0) {
      return { kind: 'sea_level', label: '海面／平原', elevationM: 0 };
    }
    if (m <= 500) {
      return { kind: 'lowland', label: '平原丘陵', elevationM: m };
    }
    return { kind: 'mountain', label: '山區', elevationM: m };
  }

  // 地形遮蔽軟化門檻：地形高度達射線高度的此比例時開始遮蔽。
  // 網格高度是格點平均值，實際山峰高於平均，故不等到 100% 才開始扣。
  static TERRAIN_BLOCKING_ONSET_RATIO = 0.6;

  // 射線高度地板 (公里)：低於此高度的取樣點不計地形遮蔽。
  // 該處的地形實質上就是「日出／日落地平線」本身，已由 SolarCalc 的
  // 日出日落時刻反映；再扣一次即為重複計算。
  // 例：台北日落光路 260km 處為福建丘陵，射線僅約 21m 高，若計入
  // 地形遮蔽會使天幕帶每天恆為 100%，模型完全失去鑑別力。
  static TERRAIN_RAY_ALTITUDE_FLOOR_KM = 0.1;

  /**
   * 計算地形對光路的遮蔽率 (0-100)
   *
   * 光路跨越山脈時，擋住陽光的是山體本身而非雲。將取樣點的地形高度
   * 與射線在該處的高度相比：地形達射線高度即完全遮斷，達 60% 起開始線性遞增。
   *
   * 僅計算「超出地平線之外的額外障礙」：射線已貼近地表 (低於
   * TERRAIN_RAY_ALTITUDE_FLOOR_KM) 的取樣點不計，因為該處地形就是
   * 日出／日落地平線本身，已由天文時刻反映。
   *
   * @param {Object} params
   * @param {number} params.elevationM 取樣點地形高度 (公尺)
   * @param {number} params.distanceKm 取樣點的上游距離 (公里)
   * @param {number} params.targetAltitudeKm 該光路帶要照亮的雲高 (公里)
   * @returns {number} 地形遮蔽率 (0-100)
   */
  static computeTerrainBlocking({ elevationM, distanceKm, targetAltitudeKm }) {
    const terrainKm = Math.max(0, (Number(elevationM) || 0) / 1000);
    if (terrainKm === 0) return 0;

    const rayAltKm = this.rayAltitudeAtDistanceKm(targetAltitudeKm, distanceKm);
    // 射線已貼近地平線：此處地形即為日出／日落地平線本身，不重複扣分
    if (rayAltKm <= this.TERRAIN_RAY_ALTITUDE_FLOOR_KM) return 0;

    const onset = this.TERRAIN_BLOCKING_ONSET_RATIO;
    const ratio = terrainKm / rayAltKm;
    if (ratio <= onset) return 0;
    if (ratio >= 1) return 100;
    return Math.round(((ratio - onset) / (1 - onset)) * 100);
  }

  /**
   * 計算某一光路帶的遮蔽率 (0-100)
   *
   * 視線被擋住是「或」的關係：整條光路上只要有任何一個取樣點被低雲或山體塞住，
   * 光就到不了。因此帶內取最差點 (max)，取平均會把單一片致命的雲稀釋掉。
   * 每個取樣點同時檢查雲層遮蔽與地形遮蔽，取兩者較嚴重者。
   *
   * @param {Array<{distanceKm:number, cloudLow:number, elevationM:number}>} samples 各取樣距離的氣象與地形
   * @param {'low'|'mid'|'high'} bandKey 光路帶代號
   * @returns {number} 該帶的遮蔽率 (0-100)
   */
  static computeBandBlocking(samples, bandKey) {
    const band = this.RAY_PATH_BANDS[bandKey];
    if (!band) {
      throw new Error(`unknown ray-path band: ${bandKey}`);
    }
    if (!Array.isArray(samples)) return 0;

    const inBand = samples.filter(sample => band.distancesKm.includes(sample.distanceKm));
    if (inBand.length === 0) return 0;

    return inBand.reduce((worst, sample) => {
      const cloudBlocking = Number(sample.cloudLow) || 0;
      const terrainBlocking = this.computeTerrainBlocking({
        elevationM: sample.elevationM,
        distanceKm: sample.distanceKm,
        targetAltitudeKm: band.targetAltitudeKm
      });
      return Math.max(worst, cloudBlocking, terrainBlocking);
    }, 0);
  }

  /**
   * 計算複合地平線透光窗 (0-100)
   *
   * 光要走完兩段才看得到：先穿過上游光路（遠方海面低雲），再穿過觀測點的垂直雲柱。
   * 兩段是串聯關係，故相乘。舊版由上游值完全覆寫，會出現
   * 「台北本地滿天低雲、但 60km 外很乾淨 → 透光窗仍拿滿分」的假陽性。
   *
   * @param {Object} params
   * @param {{cloudLow:number, cloudTotal:number}} params.localWeather 觀測點氣象
   * @param {{low:number, mid:number, high:number}} params.bandBlocking 各光路帶遮蔽率
   * @returns {number} 複合透光窗 (0-100)
   */
  static computeRayPathHorizonClearance({ localWeather = {}, bandBlocking = {} } = {}) {
    const localLow = Number(localWeather.cloudLow) || 0;
    const localTotal = Number(localWeather.cloudTotal) || 0;

    // 第一段：觀測點垂直雲柱穿透率
    const localClearance = Math.max(0, Math.min(100,
      100 - (localLow * 1.1 + Math.max(0, localTotal - 60) * 0.5)
    ));

    // 第二段：上游光路加權穿透率
    const weightedBlocking = Object.entries(this.RAY_PATH_BANDS).reduce(
      (acc, [key, band]) => acc + band.weight * (Number(bandBlocking[key]) || 0),
      0
    );
    const upstreamTransmittance = Math.max(0, Math.min(100, 100 - weightedBlocking));

    return Math.round(localClearance * upstreamTransmittance / 100);
  }

  /**
   * 建立本次取樣所使用的上游光路幾何 (Ray-Path Sampling Geometry)
   * 上游氣象資料只會向 Open-Meteo 請求「一組」座標，這個方法就是那組座標的唯一真實來源。
   * fetchForecast 用它決定要抓哪裡，processRawData 用它回報資料實際來自哪裡，兩者保證一致。
   * @param {number} lat 觀測點緯度
   * @param {number} lng 觀測點經度
   * @param {Date} [referenceDate] 用來計算太陽方位角的基準日 (預設今日)
   */
  static buildSamplingGeometry(lat, lng, referenceDate = new Date()) {
    const solar = SolarCalcModule.getTimes(referenceDate, lat, lng);
    const sunsetPos = SolarCalcModule.getPosition(solar.sunset || referenceDate, lat, lng);
    const sunrisePos = SolarCalcModule.getPosition(solar.sunrise || referenceDate, lat, lng);

    return {
      referenceDate,
      // 錨點（60km），供 UI 標示光路方向
      sunset: this.calculateUpstreamCoords(lat, lng, sunsetPos.azimuth, 60),
      sunrise: this.calculateUpstreamCoords(lat, lng, sunrisePos.azimuth, 60),
      // 整條光路的分層取樣階梯
      sunsetPlan: this.buildRayPathSamplingPlan(lat, lng, sunsetPos.azimuth),
      sunrisePlan: this.buildRayPathSamplingPlan(lat, lng, sunrisePos.azimuth)
    };
  }

  /**
   * 組裝 Open-Meteo 批次請求 URL
   * 座標順序固定為 [觀測點, ...日落光路取樣點, ...日出光路取樣點]，
   * 回應陣列依同一順序切分，因此順序即為契約。
   * @param {{lat:number, lng:number}} coords 觀測點
   * @param {Object} geometry buildSamplingGeometry 的輸出
   */
  static buildForecastRequestUrl(coords, geometry) {
    const points = [
      { lat: coords.lat, lng: coords.lng },
      ...geometry.sunsetPlan,
      ...geometry.sunrisePlan
    ];
    const lats = points.map(p => p.lat).join(',');
    const lngs = points.map(p => p.lng).join(',');

    return `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
      '&hourly=cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,visibility,' +
      'relativehumidity_2m,precipitation_probability,direct_normal_irradiance,temperature_2m,weathercode' +
      '&daily=sunrise,sunset&timezone=Asia%2FTaipei&forecast_days=7';
  }

  /**
   * 取得台北未來 7 天逐小時氣象預報與雙版本雲層光路數據
   * @param {boolean} forceRefresh 是否強制重新整理
   * @param {Object} [customCoords] 自訂觀測點座標 (選填)
   */
  static async fetchForecast(forceRefresh = false, customCoords = null) {
    const coords = customCoords || this.TAIPEI_COORDS;
    if (!forceRefresh && !customCoords) {
      const cached = this.getCachedForecast();
      if (cached) return cached;
    }

    try {
      // 1. 計算今日太陽方位角，推估日落（海峽）與日出（太平洋）60km 上游進光點座標
      const samplingGeometry = this.buildSamplingGeometry(coords.lat, coords.lng);
      // 2. Open-Meteo 多座標一次批次請求 (觀測點 + 日落光路 5 點 + 日出光路 5 點)
      const url = this.buildForecastRequestUrl(coords, samplingGeometry);

      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Open-Meteo API 請求失敗: HTTP ${response.status}`);
      }

      const data = await response.json();
      let rawLocal, rawUpstreamSunset, rawUpstreamSunrise;

      const ladderSize = this.RAY_PATH_LADDER_KM.length;
      if (Array.isArray(data) && data.length >= 1 + ladderSize * 2) {
        rawLocal = data[0];
        rawUpstreamSunset = data.slice(1, 1 + ladderSize);
        rawUpstreamSunrise = data.slice(1 + ladderSize, 1 + ladderSize * 2);
      } else if (Array.isArray(data) && data.length > 0) {
        rawLocal = data[0];
        rawUpstreamSunset = data[0];
        rawUpstreamSunrise = data[0];
      } else {
        rawLocal = data;
        rawUpstreamSunset = data;
        rawUpstreamSunrise = data;
      }

      const parsed = this.processRawData(rawLocal, rawUpstreamSunset, rawUpstreamSunrise, coords, samplingGeometry);
      if (!customCoords) {
        this.cacheForecast(parsed);
      }
      return parsed;
    } catch (err) {
      console.warn('無法連線至 Open-Meteo API，切換為智慧離線/預設氣象模型:', err.message);
      return this.generateSimulatedForecast();
    }
  }

  /**
   * 解析 Open-Meteo 原始數據並計算雙版本（單點 vs 向量光路雙點）火燒雲指數
   */
  static processRawData(rawLocal, rawUpstreamSunset = null, rawUpstreamSunrise = null, localCoords = this.TAIPEI_COORDS, samplingGeometry = null) {
    const parseHourly = (raw) => {
      if (!raw || !raw.hourly || !raw.hourly.time) return [];
      const h = raw.hourly;
      return h.time.map((timeStr, i) => ({
        time: new Date(timeStr),
        timeStr,
        cloudHigh: h.cloudcover_high ? h.cloudcover_high[i] : 0,
        cloudMid: h.cloudcover_mid ? h.cloudcover_mid[i] : 0,
        cloudLow: h.cloudcover_low ? h.cloudcover_low[i] : 0,
        cloudTotal: h.cloudcover ? h.cloudcover[i] : 0,
        visibility: h.visibility ? h.visibility[i] : 20000,
        humidity: h.relativehumidity_2m ? h.relativehumidity_2m[i] : 70,
        precipProb: h.precipitation_probability ? h.precipitation_probability[i] : 0,
        temp: h.temperature_2m ? h.temperature_2m[i] : 28,
        weatherCode: h.weathercode ? h.weathercode[i] : 0
      }));
    };

    const hourlyLocal = parseHourly(rawLocal);

    // 上游資料可能是單一座標 (舊行為/降級) 或沿取樣階梯排列的陣列 (分層光路模型)。
    // 兩者一律正規化成 [{ distanceKm, hourly }]，下游邏輯不必分岔。
    const toUpstreamSeries = (raw) => {
      if (!raw) {
        return this.RAY_PATH_LADDER_KM.map(distanceKm => ({
          distanceKm,
          hourly: hourlyLocal,
          elevationM: 0
        }));
      }
      if (Array.isArray(raw)) {
        return raw.map((item, i) => ({
          distanceKm: this.RAY_PATH_LADDER_KM[i],
          hourly: parseHourly(item),
          elevationM: Number(item && item.elevation) || 0
        })).filter(item => item.distanceKm !== undefined);
      }
      // 單點資料：整條光路共用同一組觀測，退化為舊版行為
      const shared = parseHourly(raw);
      const sharedElevation = Number(raw.elevation) || 0;
      return this.RAY_PATH_LADDER_KM.map(distanceKm => ({
        distanceKm,
        hourly: shared,
        elevationM: sharedElevation
      }));
    };

    const sunsetUpstreamSeries = toUpstreamSeries(rawUpstreamSunset);
    const sunriseUpstreamSeries = toUpstreamSeries(rawUpstreamSunrise);

    const now = new Date();
    const daysForecast = [];
    const lat = (localCoords && localCoords.lat) || this.TAIPEI_COORDS.lat;
    const lng = (localCoords && localCoords.lng) || this.TAIPEI_COORDS.lng;

    // 上游氣象資料只來自這一組座標，因此每一天都必須回報同一組座標，
    // 不可逐日用當天方位角重算一個沒有對應資料的點。
    const geometry = samplingGeometry || this.buildSamplingGeometry(lat, lng, now);

    // 取未來 6 天
    for (let d = 0; d < 6; d++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      const solarTimes = SolarCalcModule.getTimes(targetDate, lat, lng);

      // 提取觀測點與上游進光點的最近小時數據
      const localSunriseWeather = this.getClosestHourData(hourlyLocal, solarTimes.sunrise);
      const localSunsetWeather = this.getClosestHourData(hourlyLocal, solarTimes.sunset);
      // 沿整條光路取樣，再依雲層高度分帶計算遮蔽率
      const sampleRayPath = (series, eventTime) => series.map(item => ({
        distanceKm: item.distanceKm,
        ...this.getClosestHourData(item.hourly, eventTime),
        elevationM: item.elevationM,
        terrain: this.classifyTerrain(item.elevationM)
      }));
      const blockingOf = (samples) => ({
        low: this.computeBandBlocking(samples, 'low'),
        mid: this.computeBandBlocking(samples, 'mid'),
        high: this.computeBandBlocking(samples, 'high')
      });

      const sunriseRaySamples = sampleRayPath(sunriseUpstreamSeries, solarTimes.sunrise);
      const sunsetRaySamples = sampleRayPath(sunsetUpstreamSeries, solarTimes.sunset);
      const sunriseBandBlocking = blockingOf(sunriseRaySamples);
      const sunsetBandBlocking = blockingOf(sunsetRaySamples);

      // 錨點 (60km) 氣象，維持既有 upstream.weather 欄位
      const upstreamSunriseWeather = sunriseRaySamples[0] || {};
      const upstreamSunsetWeather = sunsetRaySamples[0] || {};

      // ----------------------------------------------------
      // 版本 1: 經典單點模型 (Single-Point Mode)
      // ----------------------------------------------------
      const singlePointSunrise = SkyFireEngineModule.calculate({
        highCloud: localSunriseWeather.cloudHigh,
        midCloud: localSunriseWeather.cloudMid,
        lowCloud: localSunriseWeather.cloudLow,
        totalCloud: localSunriseWeather.cloudTotal,
        visibility: localSunriseWeather.visibility,
        humidity: localSunriseWeather.humidity,
        precipProb: localSunriseWeather.precipProb,
        type: 'sunrise'
      });

      const singlePointSunset = SkyFireEngineModule.calculate({
        highCloud: localSunsetWeather.cloudHigh,
        midCloud: localSunsetWeather.cloudMid,
        lowCloud: localSunsetWeather.cloudLow,
        totalCloud: localSunsetWeather.cloudTotal,
        visibility: localSunsetWeather.visibility,
        humidity: localSunsetWeather.humidity,
        precipProb: localSunsetWeather.precipProb,
        type: 'sunset'
      });

      // ----------------------------------------------------
      // 版本 2: 向量光路雙點模型 (Dual-Point Ray-Path Mode / 推薦)
      // 結合「觀測點頭頂高空反光天幕」與「上游 60km 地平線進光窗穿透度」
      // ----------------------------------------------------
      // 日落地平透光窗穿透度 (上游台灣海峽低雲愈少愈通透)
      const sunsetHorizonClearance = this.computeRayPathHorizonClearance({
        localWeather: localSunsetWeather,
        bandBlocking: sunsetBandBlocking
      });

      const rayPathSunset = SkyFireEngineModule.calculate({
        highCloud: localSunsetWeather.cloudHigh,
        midCloud: localSunsetWeather.cloudMid,
        lowCloud: localSunsetWeather.cloudLow,
        totalCloud: localSunsetWeather.cloudTotal,
        visibility: localSunsetWeather.visibility,
        humidity: localSunsetWeather.humidity,
        precipProb: localSunsetWeather.precipProb,
        horizonClearance: sunsetHorizonClearance,
        type: 'sunset'
      });

      // 日出地平透光窗穿透度 (上游太平洋低雲愈少愈通透)
      const sunriseHorizonClearance = this.computeRayPathHorizonClearance({
        localWeather: localSunriseWeather,
        bandBlocking: sunriseBandBlocking
      });

      const rayPathSunrise = SkyFireEngineModule.calculate({
        highCloud: localSunriseWeather.cloudHigh,
        midCloud: localSunriseWeather.cloudMid,
        lowCloud: localSunriseWeather.cloudLow,
        totalCloud: localSunriseWeather.cloudTotal,
        visibility: localSunriseWeather.visibility,
        humidity: localSunriseWeather.humidity,
        precipProb: localSunriseWeather.precipProb,
        horizonClearance: sunriseHorizonClearance,
        type: 'sunrise'
      });

      daysForecast.push({
        date: targetDate,
        dateFormatted: this.formatDateLabel(targetDate, d),
        dayIndex: d,
        solarTimes,
        sunrise: {
          time: solarTimes.sunrise,
          skyfire: rayPathSunrise, // 預設使用先進向量光路模型
          singlePoint: singlePointSunrise,
          rayPath: rayPathSunrise,
          weather: localSunriseWeather,
          upstream: {
            coords: geometry.sunrise,
            plan: geometry.sunrisePlan,
            samples: sunriseRaySamples,
            bands: sunriseBandBlocking,
            weather: upstreamSunriseWeather,
            horizonClearance: Math.round(sunriseHorizonClearance),
            locationLabel: `太平洋海面 (方位角 ${geometry.sunrise.azimuth}° · 60-260km 光路)`
          }
        },
        sunset: {
          time: solarTimes.sunset,
          skyfire: rayPathSunset, // 預設使用先進向量光路模型
          singlePoint: singlePointSunset,
          rayPath: rayPathSunset,
          weather: localSunsetWeather,
          upstream: {
            coords: geometry.sunset,
            plan: geometry.sunsetPlan,
            samples: sunsetRaySamples,
            bands: sunsetBandBlocking,
            weather: upstreamSunsetWeather,
            horizonClearance: Math.round(sunsetHorizonClearance),
            locationLabel: `台灣海峽北部海面 (方位角 ${geometry.sunset.azimuth}° · 60-260km 光路)`
          }
        }
      });
    }

    return {
      isSimulated: false,
      lastUpdated: new Date(),
      hourly: hourlyLocal,
      daysForecast
    };
  }

  static getClosestHourData(hourlyList, targetDate) {
    if (!targetDate || isNaN(targetDate.getTime())) {
      return hourlyList[0] || {};
    }
    const targetMs = targetDate.getTime();
    let best = hourlyList[0];
    let minDiff = Infinity;

    for (const item of hourlyList) {
      const diff = Math.abs(item.time.getTime() - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        best = item;
      }
    }
    return best;
  }

  static formatDateLabel(date, dayOffset) {
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekdayStr = weekdays[date.getDay()];

    if (dayOffset === 0) return `今天 (${month}/${day} ${weekdayStr})`;
    if (dayOffset === 1) return `明天 (${month}/${day} ${weekdayStr})`;
    if (dayOffset === 2) return `後天 (${month}/${day} ${weekdayStr})`;
    return `${month}/${day} (${weekdayStr})`;
  }

  static getCachedForecast() {
    try {
      const item = localStorage.getItem(this.CACHE_KEY);
      if (!item) return null;
      const data = JSON.parse(item);
      if (Date.now() - new Date(data.cachedAt).getTime() < this.CACHE_DURATION_MS) {
        // 重建 Date 物件
        data.lastUpdated = new Date(data.lastUpdated);
        data.daysForecast.forEach(d => {
          d.date = new Date(d.date);
          d.solarTimes = SolarCalcModule.getTimes(d.date);
          d.sunrise.time = new Date(d.sunrise.time);
          d.sunset.time = new Date(d.sunset.time);
        });
        return data;
      }
    } catch (e) {
      console.warn('快取讀取錯誤', e);
    }
    return null;
  }

  static cacheForecast(data) {
    try {
      const payload = {
        ...data,
        cachedAt: new Date().toISOString()
      };
      localStorage.setItem(this.CACHE_KEY, JSON.stringify(payload));
    } catch (e) {
      // ignore
    }
  }

  /**
   * 離線或模擬模式氣象生成器
   */
  static generateSimulatedForecast() {
    const now = new Date();
    const daysForecast = [];

    // 提供逼真、具層次且多樣的模擬氣象場景
    const sampleScenarios = [
      { high: 58, mid: 42, low: 15, vis: 24000, humidity: 62, precip: 5 },  // 壯麗火燒雲
      { high: 72, mid: 30, low: 18, vis: 22000, humidity: 68, precip: 0 },  // 史詩級高空漫射
      { high: 20, mid: 15, low: 25, vis: 18000, humidity: 55, precip: 0 },  // 局部微霞
      { high: 45, mid: 50, low: 20, vis: 26000, humidity: 60, precip: 0 },  // 魚鱗雲火燒
      { high: 10, mid: 20, low: 75, vis: 8000, humidity: 88, precip: 65 },  // 陰雨厚低雲
      { high: 65, mid: 35, low: 12, vis: 30000, humidity: 58, precip: 0 }   // 颱風前夕通透火燒
    ];

    for (let d = 0; d < 6; d++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      const solarTimes = SolarCalcModule.getTimes(targetDate);
      const scnSunset = sampleScenarios[d % sampleScenarios.length];
      const scnSunrise = sampleScenarios[(d + 2) % sampleScenarios.length];

      const sunsetSkyfire = SkyFireEngineModule.calculate({
        highCloud: scnSunset.high,
        midCloud: scnSunset.mid,
        lowCloud: scnSunset.low,
        totalCloud: Math.min(100, scnSunset.high + scnSunset.mid * 0.5),
        visibility: scnSunset.vis,
        humidity: scnSunset.humidity,
        precipProb: scnSunset.precip,
        type: 'sunset'
      });

      const sunriseSkyfire = SkyFireEngineModule.calculate({
        highCloud: scnSunrise.high,
        midCloud: scnSunrise.mid,
        lowCloud: scnSunrise.low,
        totalCloud: Math.min(100, scnSunrise.high + scnSunrise.mid * 0.5),
        visibility: scnSunrise.vis,
        humidity: scnSunrise.humidity,
        precipProb: scnSunrise.precip,
        type: 'sunrise'
      });

      daysForecast.push({
        date: targetDate,
        dateFormatted: this.formatDateLabel(targetDate, d),
        dayIndex: d,
        solarTimes,
        sunrise: {
          time: solarTimes.sunrise,
          skyfire: sunriseSkyfire,
          weather: {
            cloudHigh: scnSunrise.high,
            cloudMid: scnSunrise.mid,
            cloudLow: scnSunrise.low,
            visibility: scnSunrise.vis,
            humidity: scnSunrise.humidity,
            precipProb: scnSunrise.precip,
            temp: 26
          }
        },
        sunset: {
          time: solarTimes.sunset,
          skyfire: sunsetSkyfire,
          weather: {
            cloudHigh: scnSunset.high,
            cloudMid: scnSunset.mid,
            cloudLow: scnSunset.low,
            visibility: scnSunset.vis,
            humidity: scnSunset.humidity,
            precipProb: scnSunset.precip,
            temp: 31
          }
        }
      });
    }

    return {
      isSimulated: true,
      lastUpdated: new Date(),
      daysForecast
    };
  }
}

if (typeof window !== 'undefined') {
  window.WeatherService = WeatherService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WeatherService;
}
