/**
 * Taipei SkyFire - 主程式控制器 (App Controller)
 */

class SkyFireApp {
  constructor() {
    this.currentForecastData = null;
    this.activeSessionType = 'auto'; // 'auto' (自動判定最近時段) | 'today-sunrise' | 'today-sunset' | 'tomorrow-sunrise' | 'tomorrow-sunset' | 'custom'
    this.selectedDayIndex = 0;
    this.map = null;
    this.markers = [];
    this.azimuthRayLine = null;
    this.selectedSpot = null;
    this.countdownInterval = null;

    this.init();
  }

  async init() {
    this.bindEvents();
    this.initMap();
    await this.loadActiveCalibration();
    await this.loadWeatherData();
    this.startCountdownTimer();
    this.initSimulator();
    this.loadVerificationCorridor();
  }

  /**
   * 載入最新自適應模型校準參數
   */
  async loadActiveCalibration() {
    try {
      const res = await fetch('data/model-calibration-params.json');
      if (res.ok) {
        const cal = await res.json();
        if (cal && cal.weights) {
          SkyFireEngine.setWeights(cal.weights);
          console.log('✨ 已成功載入最新自適應校準物理權重 (Version: ' + (cal.version || '2.5') + ')');
        }
      }
    } catch (e) {}
  }

  /**
   * 載入即時天氣預報與天文數據
   */
  async loadWeatherData(forceRefresh = false) {
    const statusText = document.getElementById('liveStatusText');
    if (statusText) statusText.innerText = '正在擷取台北即時高空中低雲層氣象數據...';

    try {
      this.currentForecastData = await WeatherService.fetchForecast(forceRefresh);
      if (statusText) {
        statusText.innerText = this.currentForecastData.isSimulated 
          ? '離線示範模式（氣象物理模型）' 
          : `即時數據已更新 (${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })})`;
      }
      this.render();
    } catch (err) {
      console.error('載入氣象失敗', err);
      if (statusText) statusText.innerText = '載入失敗，使用備援模型';
    }
  }

  /**
   * 渲染主要介面
   */
  render() {
    if (!this.currentForecastData || !this.currentForecastData.daysForecast) return;

    this.renderSessionSwitcher();
    const currentData = this.getActiveSessionData();
    if (!currentData) return;

    this.renderHeroGauge(currentData);
    this.renderCloudCrossSection(currentData);
    this.renderSolarTimeline(currentData);
    this.render5DayForecastDeck();
    this.renderSpotsList();
    this.updateMapSunAzimuth(currentData);
  }

  /**
   * 動態時段切換器渲染（依據當前時間智慧判定最近即將到來的天文事件）
   */
  renderSessionSwitcher() {
    const container = document.getElementById('sessionSwitcher');
    if (!container || !this.currentForecastData || !this.currentForecastData.daysForecast) return;

    const days = this.currentForecastData.daysForecast;
    const now = new Date();
    const todaySunrise = days[0].sunrise.time;
    const todaySunset = days[0].sunset.time;

    let tabs = [];
    if (now < todaySunrise) {
      // 凌晨時段 (00:00 ~ 日出前): 第一優先是「今日清晨日出」！
      tabs = [
        { id: 'today-sunrise', icon: '🌅', label: `今日日出 (${SolarCalc.formatTime(todaySunrise)})` },
        { id: 'today-sunset', icon: '🌇', label: `今日日落 (${SolarCalc.formatTime(todaySunset)})` },
        { id: 'tomorrow-sunrise', icon: '🌅', label: `明日日出 (${SolarCalc.formatTime(days[1].sunrise.time)})` }
      ];
      if (this.activeSessionType === 'auto') {
        this.activeSessionType = 'today-sunrise';
      }
    } else if (now < todaySunset) {
      // 白天時段 (日出後 ~ 日落前): 第一優先是「今日傍晚日落」
      tabs = [
        { id: 'today-sunset', icon: '🌇', label: `今日日落 (${SolarCalc.formatTime(todaySunset)})` },
        { id: 'tomorrow-sunrise', icon: '🌅', label: `明日日出 (${SolarCalc.formatTime(days[1].sunrise.time)})` },
        { id: 'tomorrow-sunset', icon: '🌆', label: `明日日落 (${SolarCalc.formatTime(days[1].sunset.time)})` }
      ];
      if (this.activeSessionType === 'auto') {
        this.activeSessionType = 'today-sunset';
      }
    } else {
      // 入夜時段 (日落後 ~ 午夜): 第一優先是「明日清晨日出」
      tabs = [
        { id: 'tomorrow-sunrise', icon: '🌅', label: `明日日出 (${SolarCalc.formatTime(days[1].sunrise.time)})` },
        { id: 'tomorrow-sunset', icon: '🌆', label: `明日日落 (${SolarCalc.formatTime(days[1].sunset.time)})` },
        { id: 'day2-sunrise', icon: '🌅', label: `後日日出 (${SolarCalc.formatTime(days[2].sunrise.time)})` }
      ];
      if (this.activeSessionType === 'auto') {
        this.activeSessionType = 'tomorrow-sunrise';
      }
    }

    if (!tabs.some(t => t.id === this.activeSessionType) && !this.activeSessionType.startsWith('custom')) {
      this.activeSessionType = tabs[0].id;
    }

    container.innerHTML = tabs.map(tab => `
      <button class="tab-btn ${this.activeSessionType === tab.id ? 'active' : ''}" data-session="${tab.id}">
        <span>${tab.icon}</span> ${tab.label}
      </button>
    `).join('');

    container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeSessionType = btn.dataset.session;
        this.render();
      });
    });
  }

  /**
   * 獲取當前所選時段的資料
   */
  getActiveSessionData() {
    const days = this.currentForecastData.daysForecast;
    if (this.activeSessionType === 'today-sunrise') {
      return {
        ...days[0].sunrise,
        dayMeta: days[0],
        type: 'sunrise',
        label: '今日日出 (Today Sunrise)'
      };
    } else if (this.activeSessionType === 'today-sunset') {
      return {
        ...days[0].sunset,
        dayMeta: days[0],
        type: 'sunset',
        label: '今日日落 (Today Sunset)'
      };
    } else if (this.activeSessionType === 'tomorrow-sunrise') {
      return {
        ...days[1].sunrise,
        dayMeta: days[1],
        type: 'sunrise',
        label: '明日日出 (Tomorrow Sunrise)'
      };
    } else if (this.activeSessionType === 'tomorrow-sunset') {
      return {
        ...days[1].sunset,
        dayMeta: days[1],
        type: 'sunset',
        label: '明日日落 (Tomorrow Sunset)'
      };
    } else if (this.activeSessionType === 'day2-sunrise') {
      return {
        ...days[2].sunrise,
        dayMeta: days[2],
        type: 'sunrise',
        label: `${days[2].dateFormatted} 日出`
      };
    } else {
      // 點擊 5 天預報特定天
      const day = days[this.selectedDayIndex] || days[0];
      const sessType = this.selectedSessionSubtype || 'sunset';
      return {
        ...day[sessType],
        dayMeta: day,
        type: sessType,
        label: `${day.dateFormatted} ${sessType === 'sunrise' ? '日出' : '日落'}`
      };
    }
  }

  /**
   * 渲染 Hero 儀表板
   */
  renderHeroGauge(data) {
    const { skyfire, time, weather, dayMeta, type } = data;
    const { score, rating, metrics } = skyfire;

    // 標籤與日期
    const targetDateText = document.getElementById('targetDateText');
    if (targetDateText) {
      targetDateText.innerText = `${dayMeta.dateFormatted} ${type === 'sunset' ? '日落' : '日出'}火燒雲預報`;
    }

    // 圓形計量表動畫 (周長 440)
    const circle = document.getElementById('gaugeFillCircle');
    const scoreNum = document.getElementById('gaugeScoreNum');
    if (circle) {
      const offset = 440 - (440 * score) / 100;
      circle.style.strokeDashoffset = offset;
      circle.style.stroke = rating.color;
    }
    if (scoreNum) {
      scoreNum.innerText = score;
    }

    // 評級徽章與簡評
    const ratingBadge = document.getElementById('ratingBadge');
    const ratingIcon = document.getElementById('ratingIcon');
    const ratingBadgeText = document.getElementById('ratingBadgeText');
    const ratingSummary = document.getElementById('ratingSummary');

    if (ratingBadge) {
      ratingBadge.style.backgroundColor = `${rating.color}25`;
      ratingBadge.style.borderColor = `${rating.color}66`;
      ratingBadge.style.color = rating.color;
    }
    if (ratingIcon) ratingIcon.innerText = rating.icon;
    if (ratingBadgeText) ratingBadgeText.innerText = rating.badge;
    if (ratingSummary) ratingSummary.innerText = rating.summary;

    // 最佳出景窗口
    const peakWindowText = document.getElementById('peakWindowText');
    if (peakWindowText) {
      const windowObj = type === 'sunset' 
        ? dayMeta.solarTimes.sunsetSkyfireWindow 
        : dayMeta.solarTimes.sunriseSkyfireWindow;

      if (windowObj) {
        peakWindowText.innerText = `${SolarCalc.formatTime(windowObj.start)} - ${SolarCalc.formatTime(windowObj.end)} (巔峰 ${SolarCalc.formatTime(windowObj.peak)})`;
      }
    }

    // 4 大診斷指標
    const horizonEl = document.getElementById('metricHorizonWindow');
    const highEl = document.getElementById('metricHighCloud');
    const lowEl = document.getElementById('metricLowCloud');
    const visEl = document.getElementById('metricVisibility');

    if (horizonEl) horizonEl.innerText = `${metrics.horizonClearance}% (${metrics.horizonClearance > 75 ? '極通透' : metrics.horizonClearance > 45 ? '部分透光' : '受阻'})`;
    if (highEl) highEl.innerText = `${weather.cloudHigh}% (${weather.cloudHigh >= 30 && weather.cloudHigh <= 70 ? '最佳' : '一般'})`;
    if (lowEl) lowEl.innerText = `${weather.cloudLow}% (${weather.cloudLow <= 25 ? '無阻擋' : weather.cloudLow <= 50 ? '輕微' : '遮蔽厚重'})`;
    if (visEl) visEl.innerText = `${metrics.visKm} km (${metrics.visKm >= 20 ? '清澈' : '普通'})`;

    // 調整動態背景光暈色調
    const ambient = document.getElementById('ambientGlow');
    if (ambient) {
      ambient.style.background = rating.bgGradient;
    }
  }

  /**
   * 渲染 3D 大氣垂直雲層剖面
   */
  renderCloudCrossSection(data) {
    const { weather, skyfire, type } = data;

    const barHigh = document.getElementById('barHighCloud');
    const barMid = document.getElementById('barMidCloud');
    const barLow = document.getElementById('barLowCloud');

    const tagHigh = document.getElementById('tagHighCloud');
    const tagMid = document.getElementById('tagMidCloud');
    const tagLow = document.getElementById('tagLowCloud');

    if (barHigh) {
      barHigh.style.width = `${weather.cloudHigh}%`;
      barHigh.innerText = `${weather.cloudHigh}%`;
    }
    if (barMid) {
      barMid.style.width = `${weather.cloudMid}%`;
      barMid.innerText = `${weather.cloudMid}%`;
    }
    if (barLow) {
      barLow.style.width = `${weather.cloudLow}%`;
      barLow.innerText = `${weather.cloudLow}%`;
    }

    if (tagHigh) {
      if (weather.cloudHigh >= 30 && weather.cloudHigh <= 70) {
        tagHigh.className = 'level-status-tag good';
        tagHigh.innerText = '極佳天幕';
      } else if (weather.cloudHigh > 70) {
        tagHigh.className = 'level-status-tag fair';
        tagHigh.innerText = '覆蓋偏厚';
      } else {
        tagHigh.className = 'level-status-tag fair';
        tagHigh.innerText = '雲量稀疏';
      }
    }

    if (tagMid) {
      if (weather.cloudMid >= 25 && weather.cloudMid <= 60) {
        tagMid.className = 'level-status-tag good';
        tagMid.innerText = '立體魚鱗';
      } else {
        tagMid.className = 'level-status-tag fair';
        tagMid.innerText = '正常';
      }
    }

    if (tagLow) {
      if (weather.cloudLow <= 25) {
        tagLow.className = 'level-status-tag good';
        tagLow.innerText = '通透無阻';
      } else if (weather.cloudLow <= 50) {
        tagLow.className = 'level-status-tag fair';
        tagLow.innerText = '微有遮擋';
      } else {
        tagLow.className = 'level-status-tag danger';
        tagLow.innerText = '嚴重遮蔽';
      }
    }

    const physicsEl = document.getElementById('physicsExplanation');
    if (physicsEl) {
      if (skyfire.score >= 70) {
        physicsEl.innerText = `低雲量僅 ${weather.cloudLow}%，地平線透光窗高達 ${skyfire.metrics.horizonClearance}%，夕陽紅光直接照亮高空卷雲底部，漫天金紅！`;
      } else if (weather.cloudLow > 55) {
        physicsEl.innerText = `低雲量偏厚 (${weather.cloudLow}%)，阻擋了地平線入射光，上方雲底恐籠罩在暗灰陰影中。`;
      } else {
        physicsEl.innerText = `雲層分佈均勻，具備局部晚霞機會，可把握太陽沒入地平線後的藍調時刻。`;
      }
    }
  }

  /**
   * 渲染天文日光時間軸
   */
  renderSolarTimeline(data) {
    const times = data.dayMeta.solarTimes;

    const dawnEl = document.getElementById('timeCivilDawn');
    const sunriseEl = document.getElementById('timeSunrise');
    const peakEl = document.getElementById('timeSkyfirePeak');
    const sunsetEl = document.getElementById('timeSunset');
    const blueEl = document.getElementById('timeBlueHour');

    if (dawnEl) dawnEl.innerText = SolarCalc.formatTime(times.civilDawn);
    if (sunriseEl) sunriseEl.innerText = SolarCalc.formatTime(times.sunrise);
    if (sunsetEl) sunsetEl.innerText = SolarCalc.formatTime(times.sunset);
    
    if (peakEl) {
      const peakTime = data.type === 'sunset' 
        ? times.sunsetSkyfireWindow?.peak 
        : times.sunriseSkyfireWindow?.peak;
      peakEl.innerText = SolarCalc.formatTime(peakTime);
    }

    if (blueEl) {
      const blueTime = data.type === 'sunset' 
        ? times.blueHourSunsetStart 
        : times.civilDawn;
      blueEl.innerText = SolarCalc.formatTime(blueTime);
    }
  }

  /**
   * 渲染 5 天火燒雲預報卡片
   */
  render5DayForecastDeck() {
    const container = document.getElementById('daysForecastContainer');
    if (!container || !this.currentForecastData) return;

    const days = this.currentForecastData.daysForecast;
    container.innerHTML = '';

    days.forEach((day, idx) => {
      const sunsetSky = day.sunset.skyfire;
      const isSelected = (this.activeSessionType === 'custom' && this.selectedDayIndex === idx) ||
        (this.activeSessionType === 'today-sunset' && idx === 0) ||
        (this.activeSessionType === 'tomorrow-sunset' && idx === 1);

      const card = document.createElement('div');
      card.className = `day-forecast-card ${isSelected ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="card-day-title">${day.dateFormatted}</div>
        <div class="card-event-badge" style="background: ${sunsetSky.rating.color}20; color: ${sunsetSky.rating.color};">
          ${sunsetSky.rating.icon} ${sunsetSky.rating.badge}
        </div>
        <div class="card-score-num" style="color: ${sunsetSky.rating.color};">${sunsetSky.score}</div>
        <div class="card-cloud-spec">日落 ${SolarCalc.formatTime(day.sunset.time)}</div>
        <div class="card-cloud-spec">高雲 ${day.sunset.weather.cloudHigh}% / 低雲 ${day.sunset.weather.cloudLow}%</div>
      `;

      card.addEventListener('click', () => {
        this.activeSessionType = 'custom';
        this.selectedDayIndex = idx;
        // 移除其他按鈕 active
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        this.render();
      });

      container.appendChild(card);
    });
  }

  /**
   * 渲染景點列表
   */
  renderSpotsList(filterCategory = 'all') {
    const container = document.getElementById('spotsListContainer');
    if (!container) return;

    container.innerHTML = '';
    const filtered = TAIPEI_SPOTS.filter(s => {
      if (filterCategory === 'all') return true;
      return s.category === filterCategory || s.category === 'both';
    });

    filtered.forEach(spot => {
      const isSelected = this.selectedSpot && this.selectedSpot.id === spot.id;
      const item = document.createElement('div');
      item.className = `spot-card-item ${isSelected ? 'active' : ''}`;
      item.innerHTML = `
        <div class="spot-card-head">
          <div class="spot-name">${spot.name}</div>
          <div class="spot-type-tag ${spot.category}">
            ${spot.category === 'sunset' ? '🌇 日落' : spot.category === 'sunrise' ? '🌅 日出' : '🔄 晨昏雙絕'}
          </div>
        </div>
        <div class="spot-card-meta">
          <span>⛰️ 海拔 ${spot.elevation}m</span>
          <span>🧭 方位 ${spot.bestAzimuth}</span>
          <span>🚶 ${spot.difficulty}</span>
        </div>
        <div class="spot-card-desc">${spot.description}</div>
        <div class="spot-card-tags">
          ${spot.tags.map(t => `<span class="spot-tag-pill">#${t}</span>`).join('')}
          <span class="spot-tag-pill" style="color: #ff9e00;">📷 ${spot.recommendedFocal}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        this.selectSpot(spot);
      });

      container.appendChild(item);
    });
  }

  /**
   * 初始化 Leaflet 地圖
   */
  initMap() {
    const mapElement = document.getElementById('taipeiMap');
    if (!mapElement) return;

    // 台北市中心視角
    this.map = L.map('taipeiMap', {
      center: [25.0600, 121.5300],
      zoom: 11.5,
      zoomControl: true
    });

    // 暗黑沉浸地圖圖磚 (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);

    // 載入機位標記
    this.renderMapMarkers();
  }

  renderMapMarkers() {
    if (!this.map) return;

    // 清除舊標記
    this.markers.forEach(m => this.map.removeLayer(m));
    this.markers = [];

    TAIPEI_SPOTS.forEach(spot => {
      const customIcon = L.divIcon({
        className: 'custom-spot-marker',
        html: `
          <div style="
            background: linear-gradient(135deg, #ff4500, #ff8c00);
            width: 28px;
            height: 28px;
            border-radius: 50%;
            border: 2px solid #ffffff;
            box-shadow: 0 0 12px rgba(255, 107, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            cursor: pointer;
          ">
            ${spot.category === 'sunrise' ? '🌅' : '🔥'}
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const marker = L.marker([spot.lat, spot.lng], { icon: customIcon }).addTo(this.map);
      marker.bindPopup(`
        <div style="color: #0f172a; font-family: sans-serif; min-width: 200px;">
          <h4 style="margin: 0 0 6px 0; font-size: 14px; color: #d9480f;">${spot.name}</h4>
          <p style="margin: 0 0 6px 0; font-size: 12px; line-height: 1.4;">${spot.photoTips}</p>
          <div style="font-size: 11px; color: #495057;">
            <strong>推薦焦段：</strong>${spot.recommendedFocal}<br>
            <strong>交通：</strong>${spot.traffic}
          </div>
        </div>
      `);

      marker.on('click', () => {
        this.selectSpot(spot);
      });

      this.markers.push(marker);
    });
  }

  /**
   * 點選機位時在地圖上聚焦與連動
   */
  selectSpot(spot) {
    this.selectedSpot = spot;
    if (this.map) {
      this.map.flyTo([spot.lat, spot.lng], 13.5, { duration: 1 });
      const targetMarker = this.markers.find(m => {
        const pos = m.getLatLng();
        return Math.abs(pos.lat - spot.lat) < 0.001 && Math.abs(pos.lng - spot.lng) < 0.001;
      });
      if (targetMarker) {
        targetMarker.openPopup();
      }
    }
    this.renderSpotsList(document.querySelector('.filter-chip.active')?.dataset.filter || 'all');
  }

  /**
   * 更新地圖上的太陽方位角光錐射線
   */
  updateMapSunAzimuth(data) {
    if (!this.map) return;

    const solarPos = SolarCalc.getPosition(data.time || new Date());
    const azimuthOverlay = document.getElementById('sunAzimuthOverlay');
    if (azimuthOverlay) {
      azimuthOverlay.innerText = `${data.type === 'sunset' ? '今日日落' : '今日日出'}太陽方位角：${solarPos.azimuth}° (${solarPos.azimuthCompass})`;
    }

    if (this.azimuthRayLine) {
      this.map.removeLayer(this.azimuthRayLine);
    }

    // 從台北中心向太陽方位角拉一條 25 公里的光束
    const center = [25.0500, 121.5300];
    const distanceKm = 22;
    const rad = solarPos.azimuth * (Math.PI / 180);
    // 粗略經緯度增量
    const latOffset = (distanceKm / 111) * Math.cos(rad);
    const lngOffset = (distanceKm / (111 * Math.cos(center[0] * Math.PI / 180))) * Math.sin(rad);

    const endPoint = [center[0] + latOffset, center[1] + lngOffset];

    this.azimuthRayLine = L.polyline([center, endPoint], {
      color: '#ff7043',
      weight: 3,
      dashArray: '6, 8',
      opacity: 0.85
    }).addTo(this.map);
  }

  /**
   * 即時倒數計時器
   */
  startCountdownTimer() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);

    const updateCountdown = () => {
      const countdownText = document.getElementById('countdownText');
      if (!countdownText || !this.currentForecastData) return;

      const currentData = this.getActiveSessionData();
      if (!currentData || !currentData.time) return;

      const now = Date.now();
      const target = currentData.time.getTime();
      const diff = target - now;

      if (diff > 0) {
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);
        countdownText.innerText = `距出景約 ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      } else {
        const passMins = Math.floor(Math.abs(diff) / 60000);
        if (passMins < 45) {
          countdownText.innerText = `🔥 正在出景窗口中！(進行中)`;
        } else {
          countdownText.innerText = `本日時段已過`;
        }
      }
    };

    updateCountdown();
    this.countdownInterval = setInterval(updateCountdown, 1000);
  }

  /**
   * 氣象沙盒模擬器
   */
  initSimulator() {
    const modal = document.getElementById('simulatorModal');
    const btnOpen = document.getElementById('btnOpenSimulator');
    const footerOpen = document.getElementById('footerOpenSim');
    const btnClose = document.getElementById('btnCloseSimulator');
    const btnReset = document.getElementById('btnResetSimulator');
    const btnApply = document.getElementById('btnApplySimulator');

    const sliderHigh = document.getElementById('sliderSimHigh');
    const sliderMid = document.getElementById('sliderSimMid');
    const sliderLow = document.getElementById('sliderSimLow');
    const sliderVis = document.getElementById('sliderSimVis');
    const sliderHorizon = document.getElementById('sliderSimHorizon');

    const updateSimResult = () => {
      const high = parseInt(sliderHigh.value);
      const mid = parseInt(sliderMid.value);
      const low = parseInt(sliderLow.value);
      const vis = parseInt(sliderVis.value);
      const horizon = parseInt(sliderHorizon.value);

      document.getElementById('valSimHigh').innerText = `${high}%`;
      document.getElementById('valSimMid').innerText = `${mid}%`;
      document.getElementById('valSimLow').innerText = `${low}%`;
      document.getElementById('valSimVis').innerText = `${vis} km`;
      document.getElementById('valSimHorizon').innerText = `${horizon}%`;

      const result = SkyFireEngine.calculate({
        highCloud: high,
        midCloud: mid,
        lowCloud: low,
        totalCloud: Math.min(100, high + mid * 0.5),
        visibility: vis * 1000,
        horizonClearance: horizon,
        type: 'sunset'
      });

      const scoreEl = document.getElementById('simResultScore');
      const ratingEl = document.getElementById('simResultRating');
      const descEl = document.getElementById('simResultDesc');

      if (scoreEl) {
        scoreEl.innerText = `${result.score} 分`;
        scoreEl.style.color = result.rating.color;
      }
      if (ratingEl) {
        ratingEl.innerText = `${result.rating.icon} ${result.rating.badge}`;
        ratingEl.style.color = result.rating.color;
      }
      if (descEl) {
        descEl.innerText = result.rating.summary;
      }

      return result;
    };

    [sliderHigh, sliderMid, sliderLow, sliderVis, sliderHorizon].forEach(s => {
      s?.addEventListener('input', updateSimResult);
    });

    btnOpen?.addEventListener('click', () => {
      modal.classList.add('active');
      updateSimResult();
    });
    footerOpen?.addEventListener('click', () => {
      modal.classList.add('active');
      updateSimResult();
    });
    btnClose?.addEventListener('click', () => modal.classList.remove('active'));

    btnReset?.addEventListener('click', () => {
      sliderHigh.value = 55;
      sliderMid.value = 40;
      sliderLow.value = 15;
      sliderVis.value = 25;
      sliderHorizon.value = 88;
      updateSimResult();
    });

    btnApply?.addEventListener('click', () => {
      const simResult = updateSimResult();
      modal.classList.remove('active');

      // 將模擬結果套用至儀表板主畫面
      this.renderHeroGauge({
        skyfire: simResult,
        time: new Date(),
        weather: {
          cloudHigh: parseInt(sliderHigh.value),
          cloudMid: parseInt(sliderMid.value),
          cloudLow: parseInt(sliderLow.value),
          visibility: parseInt(sliderVis.value) * 1000
        },
        dayMeta: {
          dateFormatted: '自訂沙盒模擬情境',
          solarTimes: SolarCalc.getTimes(new Date())
        },
        type: 'sunset'
      });

      this.renderCloudCrossSection({
        weather: {
          cloudHigh: parseInt(sliderHigh.value),
          cloudMid: parseInt(sliderMid.value),
          cloudLow: parseInt(sliderLow.value)
        },
        skyfire: simResult,
        type: 'sunset'
      });
    });
  }

  /**
   * 載入並渲染每日實況驗證走廊 (Ground Truth Verification Corridor)
   */
  async loadVerificationCorridor() {
    const container = document.getElementById('verificationCardsContainer');
    const badgeEl = document.getElementById('accuracySummaryBadge');
    const statAcc = document.getElementById('statAccuracyPct');
    const statMAE = document.getElementById('statAvgMAE');
    const statTotal = document.getElementById('statTotalVerified');

    if (!container) return;

    try {
      const response = await fetch('data/verification-records.json');
      if (!response.ok) return;
      const records = await response.json();

      if (!records || records.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">目前尚無歷史驗證資料。</div>';
        return;
      }

      // 只接受具備完整來源證據的真實 YouTube 直播影格。
      // 舊的封面圖、縮圖、生成圖或模擬評分繼續保留在資料檔，但不納入走廊與指標。
      const verifiedList = records.filter(r =>
        typeof r.snapshotUrl === 'string' &&
        r.snapshotUrl.startsWith('data/snapshots/') &&
        r.capture?.kind === 'youtube-live-frame' &&
        r.capture?.validated === true &&
        r.verification?.status === 'verified_completed' &&
        r.verification?.isSimulated !== true &&
        Number.isFinite(r.verification?.groundTruthScore)
      );

      if (verifiedList.length === 0) {
        if (badgeEl) badgeEl.innerText = '等待下一個日出／日落實景';
        if (statAcc) statAcc.innerText = '--';
        if (statMAE) statMAE.innerText = '--';
        if (statTotal) statTotal.innerText = '0 場';
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">現有紀錄未具備「直播中、日出／日落時窗內、實際影格」的完整證據，已排除不顯示。完成下一個天文時窗的真實擷取後會自動出現。</div>';
        return;
      }

      // 計算有效實況影格指標
      const totalVerified = verifiedList.length;
      const totalError = verifiedList.reduce((acc, cur) => acc + (cur.verification.errorAbsolute || 0), 0);
      const avgMAE = (totalError / totalVerified).toFixed(1);
      const withinTolerance = verifiedList.filter(r => r.verification.errorAbsolute <= 15).length;
      const accuracyPct = ((withinTolerance / totalVerified) * 100).toFixed(1);

      if (badgeEl) badgeEl.innerText = `歷史累計準確率 ${accuracyPct}%`;
      if (statAcc) statAcc.innerText = `${accuracyPct}%`;
      if (statMAE) statMAE.innerText = `±${avgMAE} 分`;
      if (statTotal) statTotal.innerText = `${totalVerified} 場 (持續累積)`;

      container.innerHTML = '';

      verifiedList.forEach(rec => {
        const v = rec.verification || {};
        const p = rec.prediction || {};
        const isVerified = v.groundTruthScore !== null;
        const capturedTime = rec.capturedAt
          ? new Date(rec.capturedAt).toLocaleTimeString('zh-TW', {
              timeZone: 'Asia/Taipei',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            })
          : '--:--:--';

        const card = document.createElement('div');
        card.className = 'verification-card-item';
        card.innerHTML = `
          <div class="verification-img-wrapper">
            <img src="${rec.snapshotUrl || 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=600&q=80'}" alt="實況截圖" loading="lazy">
            <div class="verdict-floating-tag" style="color: ${isVerified && v.errorAbsolute <= 10 ? '#4ade80' : '#fbbf24'}; border-color: ${isVerified && v.errorAbsolute <= 10 ? 'rgba(74, 222, 128, 0.4)' : 'rgba(251, 191, 36, 0.4)'}">
              ${v.verdictBadge || '⏳ 驗證中'}
            </div>
          </div>
          <div class="verification-body">
            <div class="verification-title-row">
              <span class="verification-date">📅 ${rec.date} ${rec.sessionLabel || (rec.session === 'sunset' ? '日落' : '日出')}</span>
              <span class="verification-source">📹 ${rec.sourceStream || '4K 即時串流'} · 🕐 ${capturedTime}</span>
            </div>
            <div class="score-compare-bar">
              <div class="compare-score-box">
                <span>🤖 模型預測</span>
                <strong style="color: ${p.color || '#ff6b00'};">${p.score || '--'} 分</strong>
              </div>
              <div class="compare-divider">⚡ VS ⚡</div>
              <div class="compare-score-box">
                <span>👁️ 實況光學觀測</span>
                <strong style="color: #38bdf8;">${v.groundTruthScore !== null ? `${v.groundTruthScore} 分` : '觀測中'}</strong>
              </div>
            </div>
            <div class="verification-metrics-chips">
              <span>🌈 色彩純度 ${v.chromaticPurity || 85}%</span> •
              <span>☁️ 漫射面積 ${v.skyCoveragePct || 70}%</span>
            </div>
          </div>
        `;
        container.appendChild(card);
      });
    } catch (err) {
      console.warn('載入驗證資料失敗:', err);
    }
  }

  /**
   * 綁定事件監聽
   */
  bindEvents() {
    // 時段切換
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeSessionType = btn.dataset.session;
        this.render();
      });
    });

    // 重新整理按鈕
    const btnRefresh = document.getElementById('btnRefreshWeather');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async () => {
        btnRefresh.classList.add('rotating');
        await this.loadWeatherData(true);
        btnRefresh.classList.remove('rotating');
      });
    }

    // 景點過濾按鈕
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.renderSpotsList(chip.dataset.filter);
      });
    });

    // 今日出景實況眾包回報 (Ground Truth Feedback)
    document.querySelectorAll('.feedback-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const rating = btn.dataset.rating;
        const group = document.getElementById('feedbackBtnGroup');
        const thanks = document.getElementById('feedbackThanksMsg');
        
        // 儲存至本機快取
        try {
          const feedbackLog = JSON.parse(localStorage.getItem('skyfire_feedback_log') || '[]');
          feedbackLog.push({
            timestamp: new Date().toISOString(),
            reportedRating: rating,
            modelScore: this.getActiveSessionData()?.skyfire?.score || null
          });
          localStorage.setItem('skyfire_feedback_log', JSON.stringify(feedbackLog));
        } catch (err) {}

        if (group) group.style.display = 'none';
        if (thanks) thanks.style.display = 'block';
      });
    });
  }
}

// 頁面載入完成後啟動應用
window.addEventListener('DOMContentLoaded', () => {
  window.app = new SkyFireApp();
});
