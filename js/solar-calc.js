/**
 * SolarCalc - 精確天文太陽計算庫
 * 用於計算特定經緯度與日期的太陽位置、日出日落、黃金時刻、藍調時刻及方位角
 */

class SolarCalc {
  static rad = Math.PI / 180;
  static deg = 180 / Math.PI;

  // 台北經緯度預設值
  static TAIPEI = {
    lat: 25.0330,
    lng: 121.5654,
    name: '台北市 (Taipei)'
  };

  /**
   * 計算特定日期的太陽時刻表
   * @param {Date} date 
   * @param {number} lat 
   * @param {number} lng 
   */
  static getTimes(date = new Date(), lat = this.TAIPEI.lat, lng = this.TAIPEI.lng) {
    const d = this.toDays(date);
    const lw = -lng * this.rad;
    const phi = lat * this.rad;

    const n = d - 0.0009 - lw / (2 * Math.PI);
    const ds = Math.round(n);
    const M = (357.5291 + 0.98560028 * ds) % 360 * this.rad;
    const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * this.rad;
    const L = (M + C + 180 * this.rad + 102.9372 * this.rad) % (2 * Math.PI);
    const dec = Math.asin(Math.sin(L) * Math.sin(23.44 * this.rad));
    const Jnoon = 2451545.0 + ds + 0.0009 + lw / (2 * Math.PI) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

    // 太陽高度角角度定義
    const angles = [
      { name: 'astronomicalDawn', angle: -18, morning: true },
      { name: 'nauticalDawn', angle: -12, morning: true },
      { name: 'civilDawn', angle: -6, morning: true },
      { name: 'sunrise', angle: -0.833, morning: true },
      { name: 'sunriseGoldenEnd', angle: 6, morning: true },
      { name: 'sunsetGoldenStart', angle: 6, morning: false },
      { name: 'sunset', angle: -0.833, morning: false },
      { name: 'blueHourSunsetStart', angle: -4, morning: false },
      { name: 'blueHourSunsetEnd', angle: -8, morning: false },
      { name: 'civilDusk', angle: -6, morning: false },
      { name: 'nauticalDusk', angle: -12, morning: false },
      { name: 'astronomicalDusk', angle: -18, morning: false }
    ];

    const result = {
      solarNoon: this.fromJulian(Jnoon)
    };

    angles.forEach(item => {
      const h0 = item.angle * this.rad;
      const w0 = Math.acos((Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
      if (isNaN(w0)) return;

      const Jset = Jnoon + w0 / (2 * Math.PI);
      const Jrise = Jnoon - w0 / (2 * Math.PI);

      result[item.name] = this.fromJulian(item.morning ? Jrise : Jset);
    });

    // 額外定義火燒雲最佳觀測窗口 (SkyFire Optimal Windows)
    // 晨霞火燒雲窗口：日出前 30 分鐘 至 日出後 10 分鐘
    if (result.sunrise) {
      result.sunriseSkyfireWindow = {
        start: new Date(result.sunrise.getTime() - 32 * 60000),
        peak: new Date(result.sunrise.getTime() - 15 * 60000),
        end: new Date(result.sunrise.getTime() + 10 * 60000)
      };
    }

    // 晚霞火燒雲窗口：日落前 15 分鐘 至 日落後 30 分鐘 (特別是日落後10-25分漫天火燒最烈)
    if (result.sunset) {
      result.sunsetSkyfireWindow = {
        start: new Date(result.sunset.getTime() - 15 * 60000),
        peak: new Date(result.sunset.getTime() + 15 * 60000),
        end: new Date(result.sunset.getTime() + 35 * 60000)
      };
    }

    return result;
  }

  /**
   * 計算即時太陽方位角與高度角
   * @param {Date} date 
   * @param {number} lat 
   * @param {number} lng 
   * @returns {{azimuth: number, elevation: number, azimuthCompass: string}}
   */
  static getPosition(date = new Date(), lat = this.TAIPEI.lat, lng = this.TAIPEI.lng) {
    const d = this.toDays(date);
    const lw = -lng * this.rad;
    const phi = lat * this.rad;

    const M = (357.5291 + 0.98560028 * d) % 360 * this.rad;
    const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * this.rad;
    const L = (M + C + 180 * this.rad + 102.9372 * this.rad) % (2 * Math.PI);
    const dec = Math.asin(Math.sin(L) * Math.sin(23.44 * this.rad));
    const ra = Math.atan2(Math.sin(L) * Math.cos(23.44 * this.rad), Math.cos(L));

    const th0 = 280.16 + 360.9856235 * d;
    const H = (th0 - lw * this.deg - ra * this.deg) % 360 * this.rad;

    const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const azimuthRad = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    
    // 轉換成正北為 0°，順時針 (0° = 北, 90° = 東, 180° = 南, 270° = 西)
    let azimuthDeg = (azimuthRad * this.deg + 180) % 360;

    return {
      azimuth: parseFloat(azimuthDeg.toFixed(1)),
      elevation: parseFloat((elevation * this.deg).toFixed(1)),
      azimuthCompass: this.azimuthToCompass(azimuthDeg)
    };
  }

  static toDays(date) {
    return date.getTime() / 86400000 - 10957.5;
  }

  static fromJulian(j) {
    return new Date((j - 2451545.0) * 86400000 + 946728000000);
  }

  static azimuthToCompass(deg) {
    const directions = ['北 (N)', '東北偏北 (NNE)', '東北 (NE)', '東北偏東 (ENE)', '東 (E)', '東南偏東 (ESE)', '東南 (SE)', '東南偏南 (SSE)', '南 (S)', '西南偏南 (SSW)', '西南 (SW)', '西南偏西 (WSW)', '西 (W)', '西北偏西 (WNW)', '西北 (NW)', '西北偏北 (NNW)'];
    const idx = Math.round(deg / 22.5) % 16;
    return directions[idx];
  }

  /**
   * 格式化時間為 HH:mm 格式
   */
  static formatTime(date) {
    if (!date || isNaN(date.getTime())) return '--:--';
    return date.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }

  /**
   * 計算距離某個時間的剩餘時間描述
   */
  static getRelativeTimeText(targetDate) {
    const diffMs = targetDate.getTime() - Date.now();
    const absDiff = Math.abs(diffMs);
    const hours = Math.floor(absDiff / (1000 * 60 * 60));
    const mins = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

    if (diffMs > 0) {
      if (hours === 0) return `${mins} 分鐘後`;
      return `${hours} 小時 ${mins} 分後`;
    } else {
      if (hours === 0) return `${mins} 分鐘前`;
      return `${hours} 小時 ${mins} 分前`;
    }
  }
}

// 支援全域
if (typeof window !== 'undefined') {
  window.SolarCalc = SolarCalc;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SolarCalc;
}
