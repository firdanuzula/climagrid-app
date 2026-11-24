'use strict';

const assert = require('assert');
const { EdgeCache } = require('../backend/edge-cache');

(async () => {
  const cache = new EdgeCache({ limit: 2 });
  const invalidations = [];
  try {
    await cache.set('map:temp:0', { revision: 1 });
    const release = cache.lease('map:temp:0', event => invalidations.push(event));
    await cache.set('map:temp:0', { revision: 2 });
    assert.deepStrictEqual(invalidations, [{ key: 'map:temp:0', type: 'replaced' }]);
    assert.deepStrictEqual(await cache.get('map:temp:0'), { revision: 2 });

    await cache.set('other:1', { value: 1 });
    await cache.set('other:2', { value: 2 });
    assert.strictEqual(await cache.get('map:temp:0'), undefined);
    release();

    await cache.set('history:SBY-01:today', { readings: [] });
    const historyEvents = [];
    cache.lease('history:SBY-01:today', event => historyEvents.push(event));
    await cache.invalidatePrefix('history:SBY-01:');
    assert.deepStrictEqual(historyEvents, [{ key: 'history:SBY-01:today', type: 'invalidated' }]);
    assert.strictEqual(await cache.get('history:SBY-01:today'), undefined);

    const expiredEvents = [];
    await cache.set('short-lease', { revision: 1 });
    cache.lease('short-lease', event => expiredEvents.push(event), 5);
    await new Promise(resolve => setTimeout(resolve, 10));
    await cache.set('short-lease', { revision: 2 });
    assert.deepStrictEqual(expiredEvents, []);
    console.log('Edge cache LRU and lease tests passed');
  } finally {
    await cache.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
