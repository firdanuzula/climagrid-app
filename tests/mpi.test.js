'use strict';

const assert = require('assert');
const { runPythonAnalytics } = require('../backend/worker');

(async () => {
  const stations = require('../data/stations.json');
  const map = await runPythonAnalytics({
    caseName: 'idw', stations, variable: 'temp', time: 0
  });
  assert.ok(map);
  assert.strictEqual(map.match, true);
  assert.strictEqual(map.values.length, 95 * 56);

  const stats = await runPythonAnalytics({
    caseName: 'stats', values: [1, 2, 3, 4, 5, 6]
  });
  assert.ok(stats);
  assert.strictEqual(stats.match, true);
  assert.deepStrictEqual(stats.result.moving_average, [1, 1.5, 2, 3, 4, 5]);
  console.log(`Analytics worker tests passed (${map.mode}; MPI runtime available: ${map.mode === 'mpi'})`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
