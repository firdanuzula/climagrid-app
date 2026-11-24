'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapFrom(value) {
  return new Map(Object.entries(value || {}));
}

class JsonStore {
  constructor(file) {
    this.file = file;
    const initial = this.readFile();
    this.readings = mapFrom(initial.readings);
    this.batches = mapFrom(initial.batches);
    this.jobs = mapFrom(initial.jobs);
    this.jobResults = mapFrom(initial.jobResults);
    this.maps = mapFrom(initial.maps);
    this.alerts = mapFrom(initial.alerts);
    this.hourlyAggregates = mapFrom(initial.hourlyAggregates);
    this.dhtState = initial.dhtState || {};
    this.counters = {
      duplicateCount: Number(initial.duplicateCount || 0),
      ingestedCount: Number(initial.ingestedCount || 0)
    };
    this.readingUnique = new Map();
    this.payloadIndex = new Map();
    this.rebuildIndexes();
  }

  readFile() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  rebuildIndexes() {
    for (const [stationId, stationReadings] of this.readings) {
      for (const reading of stationReadings) {
        const key = `${stationId}\u0000${reading.timestamp}`;
        this.readingUnique.set(key, reading);
        const payloadHash = reading.payload_sha256 || hash(reading);
        this.payloadIndex.set(payloadHash, reading);
        this.updateHourlyAggregate(reading);
      }
    }
    for (const [jobId, job] of this.jobs) {
      if (job && job.result && job.id === jobId) this.jobResults.set(jobId, job.result);
    }
  }

  registerReading(reading, persist = true) {
    const uniqueKey = `${reading.station_id}\u0000${reading.timestamp}`;
    const current = this.readingUnique.get(uniqueKey);
    if (current) {
      return current.payload_sha256 === reading.payload_sha256
        ? { status: 'duplicate', current }
        : { status: 'conflict', current };
    }
    this.readingUnique.set(uniqueKey, reading);
    this.payloadIndex.set(reading.payload_sha256, reading);
    const list = this.readings.get(reading.station_id) || [];
    list.push(reading);
    this.readings.set(reading.station_id, list);
    this.updateHourlyAggregate(reading);
    if (persist) this.persist();
    return { status: 'inserted', reading };
  }

  updateHourlyAggregate(reading) {
    const hour = new Date(reading.timestamp);
    hour.setUTCMinutes(0, 0, 0);
    const key = `${reading.station_id}:${hour.toISOString()}`;
    const values = this.readings.get(reading.station_id)
      .filter(item => item.timestamp.slice(0, 13) === hour.toISOString().slice(0, 13));
    const aggregate = { station_id: reading.station_id, bucket: hour.toISOString(), count: values.length };
    for (const variable of ['temp', 'rh', 'rain', 'wind']) {
      const nums = values.map(item => item[variable]).filter(Number.isFinite);
      aggregate[`${variable}_avg`] = nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
      aggregate[`${variable}_min`] = nums.length ? Math.min(...nums) : null;
      aggregate[`${variable}_max`] = nums.length ? Math.max(...nums) : null;
      aggregate[`${variable}_sum`] = nums.reduce((sum, value) => sum + value, 0);
    }
    this.hourlyAggregates.set(key, aggregate);
  }

  prune(now = Date.now()) {
    const cutoffs = {
      readings: now - 90 * 86400000,
      batches: now - 30 * 86400000,
      jobs: now - 365 * 86400000,
      maps: now - 730 * 86400000,
      alerts: now - 730 * 86400000
    };
    for (const [stationId, list] of this.readings) {
      const retained = list.filter(reading => new Date(reading.timestamp).getTime() >= cutoffs.readings);
      if (retained.length !== list.length) this.readings.set(stationId, retained);
    }
    this.readingUnique.clear();
    this.payloadIndex.clear();
    this.rebuildIndexes();
    for (const [key, batch] of this.batches) {
      const received = new Date(batch.received_at || batch.timestamp || 0).getTime();
      if (received < cutoffs.batches) this.batches.delete(key);
    }
    for (const [key, job] of this.jobs) {
      if (job && job.id === key && new Date(job.created_at).getTime() < cutoffs.jobs) {
        this.jobs.delete(key);
        this.jobResults.delete(key);
        for (const [idemKey, idemJob] of this.jobs) if (idemJob && idemJob.id === key) this.jobs.delete(idemKey);
      }
    }
    for (const [key, map] of this.maps) {
      if (new Date(map.generated_at || map.period || 0).getTime() < cutoffs.maps) this.maps.delete(key);
    }
    for (const [key, alert] of this.alerts) {
      if (new Date(alert.detected_at || alert.issued_at || 0).getTime() < cutoffs.alerts) this.alerts.delete(key);
    }
    for (const [key, aggregate] of this.hourlyAggregates) {
      if (new Date(aggregate.bucket).getTime() < cutoffs.readings) this.hourlyAggregates.delete(key);
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = {
      version: 2,
      readings: Object.fromEntries(this.readings),
      batches: Object.fromEntries(this.batches),
      jobs: Object.fromEntries(this.jobs),
      jobResults: Object.fromEntries(this.jobResults),
      maps: Object.fromEntries(this.maps),
      alerts: Object.fromEntries(this.alerts),
      hourlyAggregates: Object.fromEntries(this.hourlyAggregates),
      dhtState: this.dhtState,
      duplicateCount: this.counters.duplicateCount,
      ingestedCount: this.counters.ingestedCount
    };
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { JsonStore };
