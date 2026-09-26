/**
 * test-build-tonight-stations.js - 首頁機位排名資料產生
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildTonightStations, pickSession } = require('../scripts/build-tonight-stations.js');

console.log('--- 🧪 測試: build-tonight-stations ---');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-tn-'));
const dataDir = path.join(dir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'locked-sunset-forecast.json'), JSON.stringify({
  date: '2026-09-10', session: 'sunset',
  stations: {
    dadaocheng: { score: 44, rating: '平淡暮光', color: '#7B88A8' },
    tamsui: { score: 51, rating: '局部霞光', color: '#E5A50A' },
    ghost: { score: 99, rating: 'x', color: '#000' }   // 不在註冊表 → 略過
  }
}));

const out = buildTonightStations({ dataDir, session: 'sunset', now: new Date('2026-09-10T09:00:00Z') });
assert.strictEqual(out.session, 'sunset');
assert.strictEqual(out.date, '2026-09-10');
assert.strictEqual(out.stations.length, 2, '不在註冊表的站被略過');
assert.strictEqual(out.stations[0].id, 'tamsui', '依分數由高至低排序');
assert.strictEqual(out.stations[1].id, 'dadaocheng');
assert.ok(out.stations[0].youtubeUrl.includes('watch?v='));
assert.ok(Number.isFinite(out.stations[0].viewAzimuth));
assert.strictEqual(out.stations[0].icon, '🌉');

const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'tonight-stations.json'), 'utf8'));
assert.deepStrictEqual(onDisk.stations.map(s => s.id), ['tamsui', 'dadaocheng']);

// 晴天：火燒雲分同分 → 由天空美感分決定名次；沒有美感分的排最後
fs.writeFileSync(path.join(dataDir, 'locked-sunset-forecast.json'), JSON.stringify({
  date: '2026-09-11', session: 'sunset',
  stations: {
    xiangshan: { score: 10, beautyScore: 35, rating: '晴空無雲', color: '#7B88A8' },
    tamsui: { score: 10, beautyScore: 92, rating: '晴空無雲', color: '#7B88A8' },
    jiufen: { score: 10, rating: '晴空無雲', color: '#7B88A8' },
    maokong: { score: 12, beautyScore: 60, rating: '晴空無雲', color: '#7B88A8' }
  }
}));
const clear = buildTonightStations({ dataDir, session: 'sunset', now: new Date('2026-09-11T09:00:00Z') });
assert.deepStrictEqual(clear.stations.map(s => s.id), ['maokong', 'tamsui', 'xiangshan', 'jiufen']);
assert.strictEqual(clear.stations[1].beautyScore, 92);
assert.strictEqual(clear.stations[3].beautyScore, null);

// 缺鎖定檔 → 空清單，不炸
const out2 = buildTonightStations({ dataDir, session: 'sunrise', now: new Date('2026-09-10T00:00:00Z') });
assert.deepStrictEqual(out2.stations, []);

assert.strictEqual(pickSession(new Date('2026-09-10T02:00:00Z')), 'sunrise', '台北 10:00 → sunrise');
assert.strictEqual(pickSession(new Date('2026-09-10T10:00:00Z')), 'sunset', '台北 18:00 → sunset');

fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ build-tonight-stations：排序、略過未知站、缺檔不炸、時段判斷');
