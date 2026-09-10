/**
 * test-stations.js - 測站註冊表不變式 + data/stations.json 同步 + 多站擷取腳本同步
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { STATIONS, stationsForSession, primaryStation } = require('../js/stations.js');

console.log('--- 🧪 測試: 測站註冊表 (js/stations.js) ---');

// id 唯一
const ids = STATIONS.map(s => s.id);
assert.strictEqual(new Set(ids).size, ids.length, 'station id 必須唯一');

for (const s of STATIONS) {
  assert.ok(['sunrise', 'sunset'].includes(s.session), `${s.id}: session 非法`);
  assert.ok(/^[\w-]{11}$/.test(s.videoId), `${s.id}: videoId 格式錯誤`);
  assert.ok(Number.isFinite(s.viewAzimuth) && s.viewAzimuth >= 0 && s.viewAzimuth < 360, `${s.id}: viewAzimuth 超出 [0,360)`);
  assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng), `${s.id}: 座標非數值`);
  assert.ok(typeof s.uploaderId === 'string' && s.uploaderId.startsWith('@'), `${s.id}: uploaderId 格式錯誤`);
  assert.strictEqual(s.url, `https://www.youtube.com/watch?v=${s.videoId}`, `${s.id}: url 與 videoId 不一致`);
}

for (const session of ['sunrise', 'sunset']) {
  const primaries = STATIONS.filter(s => s.session === session && s.isPrimary);
  assert.strictEqual(primaries.length, 1, `${session}: 必須剛好一個 isPrimary`);
  assert.strictEqual(primaryStation(session).id, primaries[0].id, `${session}: primaryStation 與 isPrimary 一致`);
  assert.deepStrictEqual(
    stationsForSession(session).map(s => s.id).sort(),
    STATIONS.filter(s => s.session === session).map(s => s.id).sort(),
    `${session}: stationsForSession 涵蓋所有該時段測站`
  );
}

assert.strictEqual(stationsForSession('sunset').length, 6, '日落 6 站');
assert.strictEqual(stationsForSession('sunrise').length, 2, '日出 2 站');
assert.strictEqual(primaryStation('sunset').id, 'dadaocheng');
assert.strictEqual(primaryStation('sunrise').id, 'hongludi');

// data/stations.json 與 js/stations.js 同步 (比對前正規化換行，容忍 Windows CRLF checkout)
const buildStationsJson = require('../scripts/build-stations-json.js');
const norm = s => s.replace(/\r\n/g, '\n');
const onDisk = fs.readFileSync(path.join(__dirname, '../data/stations.json'), 'utf8');
assert.strictEqual(norm(onDisk), norm(buildStationsJson.render()), 'data/stations.json 已過期 —— 執行 node scripts/build-stations-json.js');

console.log('✅ 測站註冊表不變式 + data/stations.json 同步');

// 多站縮時擷取腳本的機位清單須含註冊表的 videoId
const pySrc = fs.readFileSync(path.join(__dirname, '../scripts/capture_timelapse_multi_station.py'), 'utf8');
for (const s of STATIONS) {
  assert.ok(pySrc.includes(s.videoId), `capture_timelapse_multi_station.py 缺少 ${s.id} 的 videoId`);
}
console.log('✅ capture_timelapse_multi_station.py 與註冊表同步');
