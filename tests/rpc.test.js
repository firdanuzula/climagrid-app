'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../backend/store');
const { ChordRing } = require('../backend/dht');
const { MasterNode } = require('../backend/master');
const { RpcTransport, stableJson, sha256, normalizeReading } = require('../backend/rpc');

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climagrid-rpc-'));
  const store = new JsonStore(path.join(tempDir, 'state.json'));
  const definitions = require('../data/stations.json');
  const stations = new Map(definitions.map(station => [station.id, station]));
  const dht = new ChordRing();
  let duplicateCount = 0;
  let ingestedCount = 0;
  let master;
  const rpc = new RpcTransport({
    port: 0,
    context: {
      stations,
      readings: store.readings,
      batches: store.batches,
      payloadIndex: store.payloadIndex,
      readingUnique: store.readingUnique,
      store,
      dht,
      jobResults: store.jobResults,
      alerts: store.alerts,
      persist: () => store.persist(),
      incrementDuplicate: count => { duplicateCount += count; },
      incrementIngested: count => { ingestedCount += count; },
      master: null
    }
  });
  master = new MasterNode({
    jobs: store.jobs,
    persist: () => store.persist(),
    onResult: async job => {
      await rpc.call(rpc.clients.results, 'store', {
        job_id: job.id,
        payload_json: JSON.stringify(job.result),
        payload_sha256: sha256(stableJson(job.result))
      });
    }
  });
  rpc.context.master = master;

  try {
    await rpc.start();
    const reading = normalizeReading({
      station_id: 'SBY-01',
      timestamp: '2026-11-24T05:30:00.000Z',
      temp: 29, rh: 70, rain: 0.2, wind: 7
    });
    const batch = {
      batch_id: 'rpc-test-batch',
      readings: [reading],
      checksum_crc32: 0,
      resend: false,
      payload_sha256: sha256(stableJson([reading]))
    };
    const inserted = await rpc.call(rpc.clients.weather, 'ingestBatch', batch, 2);
    assert.strictEqual(inserted.accepted, 1);
    const retransmission = await rpc.call(rpc.clients.weather, 'ingestBatch', batch, 2);
    assert.strictEqual(retransmission.duplicates, 1);
    assert.strictEqual(duplicateCount, 1);
    assert.strictEqual(ingestedCount, 1);

    const fetched = await rpc.call(rpc.clients.weather, 'getReadings', {
      station_id: 'SBY-01', from: '', to: ''
    }, 2);
    assert.strictEqual(fetched.readings.length, 1);

    const jobRequest = { idempotency_key: 'rpc-job-once', type: 'stats', variable: '', time_offset: 0 };
    const firstJob = await rpc.call(rpc.clients.jobs, 'submitJob', jobRequest);
    const duplicateJob = await rpc.call(rpc.clients.jobs, 'submitJob', jobRequest);
    assert.strictEqual(firstJob.job_id, duplicateJob.job_id);
    for (let attempt = 0; attempt < 50 && !store.jobResults.has(firstJob.job_id); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(store.jobResults.has(firstJob.job_id));

    const alert = { alert_id: 'rpc-alert-once', payload_json: JSON.stringify({ severity: 'high' }) };
    alert.payload_sha256 = sha256(stableJson(JSON.parse(alert.payload_json)));
    const published = await rpc.call(rpc.clients.alerts, 'publish', alert);
    const duplicateAlert = await rpc.call(rpc.clients.alerts, 'publish', alert);
    assert.strictEqual(published.published, true);
    assert.strictEqual(duplicateAlert.duplicate, true);

    const result = await rpc.call(rpc.clients.results, 'store', {
      job_id: firstJob.job_id,
      payload_json: JSON.stringify(store.jobResults.get(firstJob.job_id)),
      payload_sha256: sha256(stableJson(store.jobResults.get(firstJob.job_id)))
    });
    assert.strictEqual(result.duplicates, 1);
    console.log('gRPC ingest/read/job/result/alert tests passed');
  } finally {
    master.close();
    dht.close();
    await rpc.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
