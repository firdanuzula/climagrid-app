'use strict';

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalReading(stationId, body, timestamp) {
  const payload = {
    station_id: stationId,
    timestamp: timestamp.toISOString(),
    temp: body.temp,
    rh: body.rh,
    rain: body.rain,
    wind: body.wind
  };
  return { payload, payloadHash: sha256(JSON.stringify(payload)) };
}

function validateReading(stationId, body, stations) {
  if (!stations.has(stationId)) return { status: 404, code: 'STATION_NOT_FOUND', message: 'Station not found' };
  if (!body || !['timestamp', 'temp', 'rh', 'rain', 'wind'].every(key => body[key] !== undefined && body[key] !== null)) {
    return { status: 400, code: 'INVALID_READING', message: 'timestamp, temp, rh, rain, and wind are required' };
  }
  const timestamp = new Date(body.timestamp);
  if (Number.isNaN(timestamp.getTime())) return { status: 400, code: 'INVALID_TIMESTAMP', message: 'timestamp must be ISO 8601' };
  for (const key of ['temp', 'rh', 'rain', 'wind']) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
      return { status: 400, code: 'INVALID_READING', message: `${key} must be a finite number` };
    }
  }
  return { timestamp };
}

function ingestReading({
  stationId, body, idempotencyKey, stations, batches, payloadIndex,
  readingUnique, registerReading, dhtWrite, persist
}) {
  const validation = validateReading(stationId, body, stations);
  if (validation.status) return { status: validation.status, error: validation };
  const { payload, payloadHash } = canonicalReading(stationId, body, validation.timestamp);
  const key = idempotencyKey || payloadHash;
  const batchKey = `idempotency:${key}`;
  const duplicate = batches.get(batchKey) || batches.get(key);
  if (duplicate) {
    if (duplicate.payload_sha256 !== payloadHash) {
      return { status: 409, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used for a different payload' } };
    }
    return { status: 200, body: { accepted: true, duplicate: true, station_id: stationId, idempotency_key: key } };
  }

  const uniqueKey = `${stationId}\u0000${payload.timestamp}`;
  const sameObservation = readingUnique.get(uniqueKey);
  if (sameObservation) {
    if (sameObservation.payload_sha256 !== payloadHash) {
      return { status: 409, error: { code: 'OBSERVATION_CONFLICT', message: 'A different reading already exists for this station and timestamp' } };
    }
    batches.set(batchKey, { ...sameObservation, received_at: new Date().toISOString() });
    persist();
    return { status: 200, body: { accepted: true, duplicate: true, station_id: stationId, idempotency_key: key } };
  }
  const samePayload = payloadIndex.get(payloadHash);
  if (samePayload) {
    batches.set(batchKey, { ...samePayload, received_at: new Date().toISOString() });
    persist();
    return { status: 200, body: { accepted: true, duplicate: true, station_id: stationId, idempotency_key: key } };
  }

  const reading = { ...payload, payload_sha256: payloadHash };
  const stored = registerReading(reading);
  if (stored.status === 'conflict') {
    return { status: 409, error: { code: 'OBSERVATION_CONFLICT', message: 'A different reading already exists for this station and timestamp' } };
  }
  if (stored.status === 'duplicate') {
    return { status: 200, body: { accepted: true, duplicate: true, station_id: stationId, idempotency_key: key } };
  }
  batches.set(batchKey, { ...reading, received_at: new Date().toISOString() });
  batches.set(`payload:${payloadHash}`, { ...reading, received_at: new Date().toISOString() });
  if (dhtWrite) dhtWrite(`reading:${stationId}:${payload.timestamp}`, reading);
  persist();
  return {
    status: 201,
    body: { accepted: true, duplicate: false, station_id: stationId, idempotency_key: key, payload_sha256: payloadHash }
  };
}

module.exports = { ingestReading, validateReading, canonicalReading };
