'use strict';

const assert = require('assert');
const { ChordRing } = require('../backend/dht');

const ring = new ChordRing();
try {
  const key = 'sensor:SBY-01:2026-11-24T05';
  const value = { temp: 30.25, checksum: 'expected' };
  const initialWrite = ring.write(key, value);
  assert.strictEqual(initialWrite.acknowledgements, 3);

  const owner = ring.lookup(key).owner;
  const secondary = ring.nodes.find(node => node !== owner);
  const third = ring.nodes.find(node => node !== owner && node !== secondary);
  const result = ring.read(key);
  assert.deepStrictEqual(result.value, value);

  third.replicas.set(key, { value: { temp: -99 }, checksum: 'corrupted', updated_at: new Date().toISOString() });
  assert.deepStrictEqual(ring.read(key).value, value);
  assert.strictEqual(third.replicas.get(key).checksum, ring.nodes.find(node => node !== third).replicas.get(key).checksum);

  ring.setNode(secondary.id, false);
  const failoverWrite = ring.write('sensor:SBY-02:2026-11-24T05', { temp: 31 });
  assert.strictEqual(failoverWrite.acknowledgements, 2);
  assert.ok(failoverWrite.hints >= 1);
  assert.deepStrictEqual(ring.read('sensor:SBY-02:2026-11-24T05').value, { temp: 31 });

  ring.setNode(secondary.id, true);
  assert.strictEqual(ring.hints.has(secondary.id), false);
  assert.deepStrictEqual(ring.read('sensor:SBY-02:2026-11-24T05').value, { temp: 31 });
  assert.ok(ring.lookup(key).hops <= 2);

  console.log('DHT quorum, repair, handoff, and lookup tests passed');
} finally {
  ring.close();
}
