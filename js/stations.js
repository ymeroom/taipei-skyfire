/**
 * stations.js — the single source of truth for the 6 sunset / 2 sunrise
 * official livestream lookouts. Dual-exported for Node and the browser.
 *
 * viewAzimuth is metadata (compass hint / framing) — it is NOT fed to the
 * sampling geometry. The upstream ray path always follows the solar azimuth
 * ("upstream" = toward the light source). jiufen at sunset faces NE (~45°),
 * so its model score reflects a horizon blocked by mountains to its west —
 * the honest prediction for a classic sunset shot from there.
 *
 * DVR rewind: dadaocheng / tamsui / bali / hongludi ≥ 9h · jiufen ~10h ·
 *   waimushan ~12h (both confirmed 2026-09-11 by manually scrubbing the
 *   live player back to a timestamped frame — see docs/operations.md).
 *   Corrects a 2026-09-10 captureLiveFrame probe that had wrongly read
 *   waimushan as having no DVR at all; that was never true, so its
 *   isPrimary:false here is a plain secondary-station choice, not a
 *   DVR-capability workaround.
 *
 * Keep data/stations.json in sync: node scripts/build-stations-json.js
 */

const STATIONS = [
  { id: 'dadaocheng', name: '台北大稻埕碼頭', icon: '⛵', session: 'sunset', isPrimary: true,
    lat: 25.057045046459375, lng: 121.50771810454582, elevation: 5,
    videoId: 'Ndo_8RuefH4', uploaderId: '@taipeitravelofficial', viewAzimuth: 292,
    tag: '臺北旅遊網 4K 直播・淡水河倒影晚霞' },
  { id: 'xiangshan', name: '台北象山看 101', icon: '🏙️', session: 'sunset', isPrimary: false,
    lat: 25.029049882166394, lng: 121.57276615548665, elevation: 150,
    videoId: 'z_fY1pj1VBw', uploaderId: '@taipeitravelofficial', viewAzimuth: 280,
    tag: '臺北旅遊網 4K 直播・101 與西方天際線' },
  { id: 'tamsui', name: '新北淡水漁人碼頭', icon: '🌉', session: 'sunset', isPrimary: false,
    lat: 25.18325188330396, lng: 121.41209767613158, elevation: 5,
    videoId: 'xwAWSh35uuw', uploaderId: '@ntctour', viewAzimuth: 270,
    tag: '新北觀光 4K 直播・情人橋烈焰落日' },
  { id: 'bali', name: '新北八里左岸', icon: '🌊', session: 'sunset', isPrimary: false,
    lat: 25.15470, lng: 121.41030, elevation: 5,
    videoId: 'di-4DCblWq4', uploaderId: '@ntctour', viewAzimuth: 250,
    tag: '新北觀光 4K 直播・淡江大橋與台灣海峽晚霞' },
  { id: 'maokong', name: '台北貓空指南宮', icon: '⛩️', session: 'sunset', isPrimary: false,
    lat: 24.98421427814147, lng: 121.58655991120213, elevation: 280,
    videoId: '215ahZ_0rTg', uploaderId: '@taipeitravelofficial', viewAzimuth: 290,
    tag: '臺北旅遊網 4K 直播・高處俯瞰盆地火燒雲' },
  { id: 'jiufen', name: '新北九份即時影像', icon: '🏮', session: 'sunset', isPrimary: false,
    lat: 25.110048954642046, lng: 121.83829071730524, elevation: 350,
    videoId: 'XSD5ptYisw8', uploaderId: '@ntctour', viewAzimuth: 45,
    tag: '新北觀光 4K 直播・山海交界落日' },

  { id: 'hongludi', name: '新北中和烘爐地', icon: '⛰️', session: 'sunrise', isPrimary: true,
    lat: 24.972013872318254, lng: 121.4976771944775, elevation: 300,
    videoId: 'xxMRjVwCQ3o', uploaderId: '@ntctour', viewAzimuth: 75,
    tag: '新北觀光・雙北盆地俯瞰晨光' },
  { id: 'waimushan', name: '基隆外木山濱海', icon: '🌊', session: 'sunrise', isPrimary: false,
    lat: 25.17594381403899, lng: 121.70593771941236, elevation: 10,
    videoId: 'A9pluEagLD4', uploaderId: '@goocean520', viewAzimuth: 95,
    tag: '國海院・太平洋日出第一線' },
];

function withUrl(s) {
  return { ...s, url: `https://www.youtube.com/watch?v=${s.videoId}` };
}
const RESOLVED = STATIONS.map(withUrl);

function stationsForSession(session) {
  return RESOLVED.filter(s => s.session === session);
}
function primaryStation(session) {
  return RESOLVED.find(s => s.session === session && s.isPrimary);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STATIONS: RESOLVED, stationsForSession, primaryStation };
}
if (typeof window !== 'undefined') {
  window.STATIONS = RESOLVED;
  window.stationsForSession = stationsForSession;
  window.primaryStation = primaryStation;
}
