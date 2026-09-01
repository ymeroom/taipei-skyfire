/**
 * run-all-tests.js - 執行 Taipei SkyFire 全套自動化測試
 */

console.log('====================================================');
console.log('🚀 開始執行 Taipei SkyFire 專業全功能自動化測試套件');
console.log('====================================================\n');

const SUITES = [
  './test-solar-calc.js',
  './test-skyfire-engine.js',
  './test-weather-service.js',
  './test-spots-data.js',
  './test-dom-bindings.js',
  './test-live-capture-core.js',
  './test-live-frame-capture.js',
  './test-ray-path-model.js'
];

async function main() {
  // 測試檔若匯出 Promise（含非同步斷言），必須等它完成才能宣告通過，
  // 否則會在非同步測試失敗之前就先印出成功訊息。
  for (const suite of SUITES) {
    await require(suite);
  }

  console.log('====================================================');
  console.log('🏆 恭喜！Taipei SkyFire 所有測試案例 100% 全數通過！');
  console.log('====================================================');
}

main().catch(err => {
  console.error('\n❌ 測試未通過，錯誤詳情:', err.message);
  process.exit(1);
});
