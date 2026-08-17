/**
 * test-dom-bindings.js - 靜態掃描 taipei-skyfire 的 index.html 與 app.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- 🧪 測試 5: Taipei SkyFire DOM 綁定完整性掃描 ---');

const htmlContent = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const jsContent = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

const getElementRegex = /getElementById\(['"]([^'"]+)['"]\)/g;
let match;
const usedIds = new Set();

while ((match = getElementRegex.exec(jsContent)) !== null) {
  usedIds.add(match[1]);
}

console.log(`在 app.js 中檢測到 ${usedIds.size} 個 DOM ID 引用。`);

const missingIds = [];
usedIds.forEach(id => {
  const idRegex = new RegExp(`id=['"]${id}['"]`);
  if (!idRegex.test(htmlContent)) {
    missingIds.push(id);
  }
});

if (missingIds.length > 0) {
  console.error('❌ 發現遺失的 DOM ID:', missingIds);
  assert.fail(`index.html 缺少以下在 app.js 中使用的 DOM ID: ${missingIds.join(', ')}`);
} else {
  console.log('✅ 所有 app.js 引用的 DOM ID 在 index.html 中皆 100% 存在！');
}

console.log('🎉 Taipei SkyFire DOM 綁定測試全數 PASS!\n');
