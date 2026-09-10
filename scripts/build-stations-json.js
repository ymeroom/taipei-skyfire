/**
 * build-stations-json.js — regenerate data/stations.json from js/stations.js.
 * Python (generate_daily_briefing.py, build-tonight-stations.js standalone)
 * reads the JSON so it has station metadata without a JS dependency, and the
 * file is checked in so CI's early test steps pass on a clean checkout.
 * tests/test-stations.js asserts the on-disk file matches render().
 */

const fs = require('fs');
const path = require('path');
const { STATIONS } = require('../js/stations.js');

function render() {
  return JSON.stringify({ generatedFrom: 'js/stations.js', stations: STATIONS }, null, 2) + '\n';
}

function write() {
  const out = path.join(__dirname, '../data/stations.json');
  fs.writeFileSync(out, render(), 'utf8');
  console.log(`✅ wrote ${out}`);
}

if (require.main === module) write();

module.exports = { render, write };
