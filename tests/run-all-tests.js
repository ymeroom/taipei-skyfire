/**
 * run-all-tests.js - 執行 Taipei SkyFire 全套自動化測試
 */

console.log('====================================================');
console.log('🚀 開始執行 Taipei SkyFire 專業全功能自動化測試套件');
console.log('====================================================\n');

try {
  require('./test-solar-calc.js');
  require('./test-skyfire-engine.js');
  require('./test-weather-service.js');
  require('./test-spots-data.js');
  require('./test-dom-bindings.js');
  require('./test-live-capture-core.js');
  require('./test-live-frame-capture.js');
  require('./test-ray-path-model.js');

  console.log('====================================================');
  console.log('🏆 恭喜！Taipei SkyFire 所有測試案例 100% 全數通過！');
  console.log('====================================================');
} catch (err) {
  console.error('\n❌ 測試未通過，錯誤詳情:', err.message);
  process.exit(1);
}
