/**
 * SkyFireEngine - 台北火燒雲科學預測演算法引擎
 * 依據大氣光學、雷利/米氏散射原理與多層雲量配比進行綜合評分
 */

class SkyFireEngine {
  /**
   * 計算火燒雲預測評分
   * @param {Object} params 氣象與地理參數
   * @param {number} params.highCloud 高雲量 (0-100%)
   * @param {number} params.midCloud 中雲量 (0-100%)
   * @param {number} params.lowCloud 低雲量 (0-100%)
   * @param {number} params.totalCloud 總雲量 (0-100%)
   * @param {number} params.visibility 能見度 (公尺或公里)
   * @param {number} params.humidity 相對濕度 (0-100%)
   * @param {number} params.precipProb 降雨機率 (0-100%)
   * @param {number} [params.horizonClearance] 地平線透光度 (0-100%，若無則自動估算)
   * @param {'sunset' | 'sunrise'} [params.type='sunset'] 評估時段 (日落或日出)
   * @param {number} [params.aqi=45] 空氣品質指標
   * @returns {Object} 完整評分、等級、成因診斷與攝影建議
   */
  static calculate(params) {
    const {
      highCloud = 0,
      midCloud = 0,
      lowCloud = 0,
      totalCloud = 0,
      visibility = 20000, // 預設 20km
      humidity = 65,
      precipProb = 0,
      type = 'sunset',
      aqi = 45
    } = params;

    // 1. 雲層質地與反射面評分 (最高 45 分)
    // 高雲 (卷雲/卷層雲 6000-12000m) 能在太陽低於地平線後長時間接收紅橙長波光
    let highCloudScore = 0;
    if (highCloud >= 25 && highCloud <= 75) {
      highCloudScore = 25 - Math.abs(highCloud - 50) * 0.3; // 最佳 50%
    } else if (highCloud > 75) {
      highCloudScore = Math.max(8, 25 - (highCloud - 75) * 0.6);
    } else {
      highCloudScore = highCloud * 0.7;
    }

    // 中雲 (高積雲/高層雲 2000-6000m) 提供最具震撼力的魚鱗狀、波狀立體火燒紋理
    let midCloudScore = 0;
    if (midCloud >= 20 && midCloud <= 65) {
      midCloudScore = 20 - Math.abs(midCloud - 42) * 0.35; // 最佳 40-45%
    } else if (midCloud > 65) {
      midCloudScore = Math.max(5, 20 - (midCloud - 65) * 0.5);
    } else {
      midCloudScore = midCloud * 0.6;
    }

    // 高中雲搭配加成 (雙層天幕反射)
    let synergyBonus = 0;
    if (highCloud >= 30 && midCloud >= 20 && lowCloud < 40) {
      synergyBonus = 5;
    }

    const cloudBaseScore = Math.min(45, highCloudScore + midCloudScore + synergyBonus);

    // 2. 低雲遮擋與地平線視線懲罰 (扣分項，最高扣 50 分)
    // 低雲 (<2000m 層雲/碎積雲) 會直接阻擋地平線夕陽光束，或在上方雲底投下死黑陰影
    let lowCloudPenalty = 0;
    if (lowCloud <= 20) {
      lowCloudPenalty = 0;
    } else if (lowCloud <= 40) {
      lowCloudPenalty = (lowCloud - 20) * 0.5; // 扣 0-10 分
    } else if (lowCloud <= 65) {
      lowCloudPenalty = 10 + (lowCloud - 40) * 1.0; // 扣 10-35 分
    } else {
      lowCloudPenalty = 35 + (lowCloud - 65) * 0.6; // 扣 35-50 分
    }

    // 3. 地平線透光窗指數 (Horizon Sunlight Window) (最高 30 分)
    // 遠方地平線（日落西側海峽、日出東側太平洋）若有透光縫隙，陽光才能穿透照射到台北上方雲底
    let horizonClearance = params.horizonClearance;
    if (horizonClearance === undefined) {
      // 依據低雲量與總雲量自動估算透光窗比例
      horizonClearance = Math.max(0, 100 - (lowCloud * 1.1 + Math.max(0, totalCloud - 60) * 0.5));
    }
    const horizonScore = (horizonClearance / 100) * 30;

    // 4. 大氣純淨度與能見度評分 (最高 15 分)
    // 能見度以公里計算
    const visKm = visibility > 1000 ? visibility / 1000 : visibility;
    let visibilityScore = 0;
    if (visKm >= 25) {
      visibilityScore = 15;
    } else if (visKm >= 15) {
      visibilityScore = 11 + (visKm - 15) * 0.4;
    } else if (visKm >= 8) {
      visibilityScore = 6 + (visKm - 8) * 0.7;
    } else {
      visibilityScore = Math.max(0, visKm * 0.7);
    }

    // AQI 空氣品質微調：適度 AQI (40-75) 帶有細懸浮微粒加強米氏散射（更偏紅），但 AQI > 120 會造成死灰灰霧
    let aqiModifier = 0;
    if (aqi >= 30 && aqi <= 75) {
      aqiModifier = 2; // 微粒散射加成
    } else if (aqi > 110) {
      aqiModifier = -Math.min(10, (aqi - 110) * 0.2);
    }

    // 5. 降水與濕度懲罰/加成 (最高 10 分)
    let moistureScore = 0;
    if (precipProb > 50) {
      moistureScore = -Math.min(25, (precipProb - 50) * 0.6); // 降雨通常為厚重雨雲
    } else if (precipProb > 25) {
      moistureScore = -5;
    } else {
      // 若無降雨且濕度適中 (55-80%)，高空水氣充足有利折射
      if (humidity >= 50 && humidity <= 82) {
        moistureScore = 8;
      } else {
        moistureScore = 4;
      }
    }

    // 6. 綜合總分計算 (0 - 100)
    let rawScore = cloudBaseScore - lowCloudPenalty + horizonScore + visibilityScore + aqiModifier + moistureScore;

    // 邊界保護
    // 特殊情況：如果完全無雲 (高雲<5% 且 中雲<5%)，只能算晴朗黃昏，不是火燒雲
    if (highCloud < 6 && midCloud < 6) {
      rawScore = Math.min(rawScore, 35);
    }
    // 特殊情況：如果低雲 > 85%，火燒雲幾率幾乎為 0
    if (lowCloud > 85) {
      rawScore = Math.min(rawScore, 15);
    }

    const finalScore = Math.max(5, Math.min(100, Math.round(rawScore)));

    // 7. 評級與色彩診斷
    const rating = this.getRatingLevel(finalScore);
    const diagnostics = this.generateDiagnostics({
      highCloud,
      midCloud,
      lowCloud,
      horizonClearance,
      visKm,
      finalScore,
      type
    });
    const photoTips = this.getPhotographerAdvice(finalScore, type);

    return {
      score: finalScore,
      rating,
      metrics: {
        cloudQualityScore: Math.round(cloudBaseScore),
        lowCloudPenalty: Math.round(lowCloudPenalty),
        horizonScore: Math.round(horizonScore),
        visibilityScore: Math.round(visibilityScore),
        horizonClearance: Math.round(horizonClearance),
        visKm: parseFloat(visKm.toFixed(1))
      },
      diagnostics,
      photoTips
    };
  }

  /**
   * 取得評級資訊
   */
  static getRatingLevel(score) {
    if (score >= 82) {
      return {
        level: 'EPIC',
        badge: '史詩級爆發',
        icon: '🌟',
        color: '#FF3366',
        secondaryColor: '#FF9900',
        summary: '漫天紅霞・全城燃燒！極高機率出現遮天蔽日的史詩級火燒雲。',
        bgGradient: 'linear-gradient(135deg, rgba(255,51,102,0.3) 0%, rgba(255,153,0,0.2) 100%)'
      };
    } else if (score >= 68) {
      return {
        level: 'GREAT',
        badge: '壯麗火燒雲',
        icon: '🔥',
        color: '#FF6B00',
        secondaryColor: '#FFB800',
        summary: '雲層立體・霞光萬道！高中雲層層次豐富，強烈建議攜帶相機出景。',
        bgGradient: 'linear-gradient(135deg, rgba(255,107,0,0.3) 0%, rgba(255,184,0,0.2) 100%)'
      };
    } else if (score >= 48) {
      return {
        level: 'MODERATE',
        badge: '局部霞光',
        icon: '⛅',
        color: '#E5A50A',
        secondaryColor: '#3A86FF',
        summary: '局部泛紅・唯美溫潤。地平線或天際線邊緣可見金橘色光芒。',
        bgGradient: 'linear-gradient(135deg, rgba(229,165,10,0.25) 0%, rgba(58,134,255,0.15) 100%)'
      };
    } else if (score >= 30) {
      return {
        level: 'FAINT',
        badge: '平淡暮光',
        icon: '🌤️',
        color: '#7B88A8',
        secondaryColor: '#A0AEC0',
        summary: '雲量偏少或光線受阻，主要為漸層藍調或柔和微光。',
        bgGradient: 'linear-gradient(135deg, rgba(123,136,168,0.2) 0%, rgba(160,174,192,0.1) 100%)'
      };
    } else {
      return {
        level: 'OVERCAST',
        badge: '陰沉沉寂',
        icon: '☁️',
        color: '#5A6275',
        secondaryColor: '#394150',
        summary: '厚重低雲覆蓋天際或有陣雨，天色灰暗難見彩霞。',
        bgGradient: 'linear-gradient(135deg, rgba(90,98,117,0.2) 0%, rgba(57,65,80,0.1) 100%)'
      };
    }
  }

  /**
   * 產生成因科學診斷
   */
  static generateDiagnostics(data) {
    const list = [];
    const { highCloud, midCloud, lowCloud, horizonClearance, visKm, type } = data;
    const direction = type === 'sunset' ? '西方（台灣海峽/海平面）' : '東方（太平洋/宜蘭外海）';

    // 1. 高雲診斷
    if (highCloud >= 35 && highCloud <= 70) {
      list.push({
        label: '高空卷雲天幕 (6,000m+)',
        status: 'optimal',
        desc: `高雲量達 ${highCloud}%，呈現完美的天然反射天幕，極利於接收低仰角紅光。`
      });
    } else if (highCloud > 70) {
      list.push({
        label: '高空卷層雲 (6,000m+)',
        status: 'fair',
        desc: `高雲量偏高 (${highCloud}%)，漫射面積大但光線穿透度可能稍微受限。`
      });
    } else {
      list.push({
        label: '高空卷雲 (6,000m+)',
        status: highCloud < 15 ? 'low' : 'fair',
        desc: `高雲量僅 ${highCloud}%，上方缺少大面積紅色漫射反光板。`
      });
    }

    // 2. 中雲診斷
    if (midCloud >= 25 && midCloud <= 60) {
      list.push({
        label: '中空立體高積雲 (2,000-6,000m)',
        status: 'optimal',
        desc: `中雲量達 ${midCloud}%，極易形成如魚鱗、波狀之立體金色燃燒雲紋。`
      });
    } else if (midCloud > 60) {
      list.push({
        label: '中空雲層 (2,000-6,000m)',
        status: 'fair',
        desc: `中雲量厚實 (${midCloud}%)，層次豐富但需留意下方陰影。`
      });
    } else {
      list.push({
        label: '中空雲層 (2,000-6,000m)',
        status: 'low',
        desc: `中雲量稀疏 (${midCloud}%)，雲彩層次感較為單純。`
      });
    }

    // 3. 低雲與透光窗診斷
    if (lowCloud <= 25 && horizonClearance >= 70) {
      list.push({
        label: `遠方${direction}透光窗`,
        status: 'optimal',
        desc: `低雲遮蔽極低 (${lowCloud}%)，透光窗達 ${horizonClearance}%，夕陽/晨光無阻直射雲底！`
      });
    } else if (lowCloud > 60) {
      list.push({
        label: `遠方${direction}透光窗`,
        status: 'bad',
        desc: `低雲遮蔽高達 ${lowCloud}%，厚雲層恐阻斷地平線入射光，投下暗灰色陰影。`
      });
    } else {
      list.push({
        label: `遠方${direction}透光窗`,
        status: 'fair',
        desc: `低雲量約 ${lowCloud}%，地平線具有部分透光縫隙，呈現局部霞光。`
      });
    }

    // 4. 能見度診斷
    if (visKm >= 20) {
      list.push({
        label: '大氣能見度與通透度',
        status: 'optimal',
        desc: `能見度優異（${visKm} 公里），大氣清澈通透，晚霞色彩飽和純淨。`
      });
    } else if (visKm >= 10) {
      list.push({
        label: '大氣能見度與通透度',
        status: 'fair',
        desc: `能見度正常（${visKm} 公里），色彩呈現良好。`
      });
    } else {
      list.push({
        label: '大氣能見度與通透度',
        status: 'bad',
        desc: `能見度受限（${visKm} 公里），霧霾或水氣可能使天色偏灰白。`
      });
    }

    return list;
  }

  /**
   * 攝影參數與機位建議小抄
   */
  static getPhotographerAdvice(score, type = 'sunset') {
    const isSunset = type === 'sunset';
    if (score >= 70) {
      return {
        bestTime: isSunset ? '日落前 15 分 至 日落後 25 分 (反火燒巔峰)' : '日出前 30 分 至 日出前 10 分 (朝霞巔峰)',
        whiteBalance: '色溫手動設為 5600K - 6500K 或「陰影/陰天模式」(強調濃郁暖金色調)',
        filter: '建議搭配 0.9 (3-Stop) 軟式漸變減光鏡 (Soft GND) 平衡天空與地景光比',
        exposure: '建議曝光補償 -0.7 EV 至 -1.0 EV，避免天空高光橘紅區域溢出過曝',
        lens: '超廣角 (16-24mm) 捕捉全天漫天火燒，中焦段 (50-85mm) 特寫局部高積雲波紋',
        mobileTip: '手機拍攝請長按對焦在亮部雲彩並「向下拉低曝光小太陽」以獲得最濃郁飽和色彩。'
      };
    } else if (score >= 45) {
      return {
        bestTime: isSunset ? '日落當刻至日落後 15 分鐘' : '日出前 20 分鐘至日出刻',
        whiteBalance: '建議 6000K - 7000K 增強夕陽色彩飽和度',
        filter: '可搭配 CPL 偏光鏡增強雲層對比度',
        exposure: '曝光補償 -0.3 EV 至 -0.7 EV',
        lens: '標準變焦鏡頭 (24-70mm)，取景聚焦於地平線光芒交會處與地景輪廓',
        mobileTip: '建議開啟手機 HDR 模式，並利用三分法將地平線置於下 1/3 處。'
      };
    } else {
      return {
        bestTime: isSunset ? '日落後 20-35 分鐘之「藍調時刻 (Blue Hour)」' : '日出前 35-20 分鐘之藍調時段',
        whiteBalance: '色溫設為 3800K - 4500K 拍出城市冷冽深藍氛圍',
        filter: '長曝減光鏡 (ND64/ND1000) 霧化雲流或車軌',
        exposure: '建議使用腳架進行 10-30 秒慢速長曝',
        lens: '廣角至中望遠，適合捕捉台北夜景、橋樑車軌與建築點燈',
        mobileTip: '切換至手機「夜景模式 (Night Mode)」，藉由多幀降噪紀錄城市藍調夜景。'
      };
    }
  }
}

// 支援全域
if (typeof window !== 'undefined') {
  window.SkyFireEngine = SkyFireEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SkyFireEngine;
}
