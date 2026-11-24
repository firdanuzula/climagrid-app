'use strict';

const crypto = require('crypto');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { ingestReading } = require('./ingest');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'climagrid.proto');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeReading(reading) {
  return {
    station_id: reading.station_id,
    timestamp: reading.timestamp,
    temp: Math.fround(reading.temp),
    rh: Math.fround(reading.rh),
    rain: Math.fround(reading.rain),
    wind: Math.fround(reading.wind)
  };
}

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class RpcTransport {
  constructor({ context, host = '127.0.0.1', port = 8443 }) {
    this.context = context;
    this.host = host;
    this.port = port;
    this.server = new grpc.Server();
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    this.v1 = grpc.loadPackageDefinition(packageDefinition).climagrid.v1;
    this.server.addService(this.v1.WeatherService.service, {
      ingestBatch: this.ingestBatch.bind(this),
      getReadings: this.getReadings.bind(this)
    });
    this.server.addService(this.v1.JobService.service, {
      submitJob: this.submitJob.bind(this)
    });
    this.server.addService(this.v1.ResultService.service, {
      store: this.storeResult.bind(this)
    });
    this.server.addService(this.v1.AlertService.service, {
      publish: this.publishAlert.bind(this)
    });
    this.clients = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(`${this.host}:${this.port}`, grpc.ServerCredentials.createInsecure(), (error, port) => {
        if (error) return reject(error);
        this.port = port;
        const target = `${this.host}:${this.port}`;
        const credentials = grpc.credentials.createInsecure();
        this.clients = {
          weather: new this.v1.WeatherService(target, credentials),
          jobs: new this.v1.JobService(target, credentials),
          results: new this.v1.ResultService(target, credentials),
          alerts: new this.v1.AlertService(target, credentials)
        };
        resolve(this.port);
      });
    });
  }

  call(client, method, request, retries = 0, metadataValues = {}) {
    let attempts = 0;
    const metadata = new grpc.Metadata();
    Object.entries(metadataValues).forEach(([key, value]) => metadata.set(key, String(value)));
    const execute = () => new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + 2000);
      client[method](request, metadata, { deadline }, (error, response) => {
        if (!error) return resolve(response);
        if (attempts < retries && [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED].includes(error.code)) {
          attempts++;
          return resolve(execute());
        }
        reject(error);
      });
    });
    return execute();
  }

  async ingestBatch(call, callback) {
    try {
      const batch = call.request;
      const traceId = call.metadata && call.metadata.get('x-trace-id')[0];
      if (traceId) this.context.trace(traceId, 'ingest.batch', { readings: batch.readings.length });
      const canonicalReadings = batch.readings.map(normalizeReading);
      const actualHash = sha256(stableJson(canonicalReadings));
      if (batch.payload_sha256 && batch.payload_sha256 !== actualHash) {
        return callback(rpcError(grpc.status.INVALID_ARGUMENT, 'Reading batch checksum mismatch'));
      }
      const batchKey = `rpc-batch:${batch.batch_id}`;
      const previousBatch = this.context.batches.get(batchKey);
      if (previousBatch) {
        if (previousBatch.payload_sha256 !== actualHash) {
          return callback(rpcError(grpc.status.ALREADY_EXISTS, 'Batch id was already used for a different payload'));
        }
        this.context.incrementDuplicate(batch.readings.length);
        this.context.persist();
        return callback(null, {
          batch_id: batch.batch_id,
          accepted: 0,
          duplicates: batch.readings.length
        });
      }
      let accepted = 0;
      let duplicates = 0;
      for (const reading of batch.readings) {
        const result = ingestReading({
          stationId: reading.station_id,
          body: {
            timestamp: reading.timestamp,
            temp: reading.temp,
            rh: reading.rh,
            rain: reading.rain,
            wind: reading.wind
          },
          idempotencyKey: `${batch.batch_id}:${reading.station_id}:${reading.timestamp}`,
          stations: this.context.stations,
          batches: this.context.batches,
          payloadIndex: this.context.payloadIndex,
          readingUnique: this.context.readingUnique,
          registerReading: readingData => this.context.store.registerReading(readingData, false),
          dhtWrite: (key, value) => {
            if (traceId) this.context.trace(traceId, 'dht.write', { key });
            return this.context.dht.write(key, value);
          },
          persist: this.context.persist
        });
        if (result.error) {
          return callback(rpcError(result.status === 409 ? grpc.status.ALREADY_EXISTS : grpc.status.INVALID_ARGUMENT, result.error.message));
        }
        if (result.body.duplicate) duplicates++;
        else accepted++;
      }
      this.context.batches.set(batchKey, {
        payload_sha256: actualHash,
        received_at: new Date().toISOString(),
        reading_count: batch.readings.length
      });
      this.context.incrementDuplicate(duplicates);
      this.context.incrementIngested(accepted);
      this.context.persist();
      callback(null, { batch_id: batch.batch_id, accepted, duplicates });
    } catch (error) {
      callback(rpcError(grpc.status.INTERNAL, error.message));
    }
  }

  getReadings(call, callback) {
    const { station_id: stationId, from, to } = call.request;
    if (!this.context.stations.has(stationId)) return callback(rpcError(grpc.status.NOT_FOUND, 'Station not found'));
    let readings = this.context.readings.get(stationId) || [];
    if (from) readings = readings.filter(item => item.timestamp >= new Date(from).toISOString());
    if (to) readings = readings.filter(item => item.timestamp <= new Date(to).toISOString());
    callback(null, { readings });
  }

  submitJob(call, callback) {
    const request = call.request;
    const stations = [...this.context.stations.values()].map(station => {
      const history = this.context.readings.get(station.id) || [];
      const latest = history[history.length - 1];
      return {
        ...station,
        values: latest || {
          temp: station.tempBase, rain: station.rainBase,
          rh: station.rhBase, wind: station.windBase
        }
      };
    });
    const submitted = this.context.master.submit({
      type: request.type,
      variable: request.variable,
      time: request.time_offset,
      station_id: request.station_id
    }, request.idempotency_key, {
      stations,
      readings: this.context.readings,
      dataSource: stations.some(station => (this.context.readings.get(station.id) || []).length)
        ? 'readings+seed'
        : 'seed'
    });
    callback(null, {
      job_id: submitted.job.id,
      status: submitted.job.status,
      progress: submitted.job.progress,
      result_sha256: ''
    });
  }

  storeResult(call, callback) {
    const request = call.request;
    const prior = this.context.jobResults.get(request.job_id);
    if (prior) return callback(null, { batch_id: request.job_id, accepted: 0, duplicates: 1 });
    let result;
    try { result = JSON.parse(request.payload_json); }
    catch (_) { return callback(rpcError(grpc.status.INVALID_ARGUMENT, 'payload_json is not valid JSON')); }
    if (sha256(stableJson(result)) !== request.payload_sha256) {
      return callback(rpcError(grpc.status.INVALID_ARGUMENT, 'Result checksum mismatch'));
    }
    this.context.jobResults.set(request.job_id, result);
    this.context.persist();
    callback(null, { batch_id: request.job_id, accepted: 1, duplicates: 0 });
  }

  publishAlert(call, callback) {
    const request = call.request;
    if (this.context.alerts.has(request.alert_id)) {
      return callback(null, { alert_id: request.alert_id, published: false, duplicate: true });
    }
    let payload;
    try { payload = JSON.parse(request.payload_json); }
    catch (_) { return callback(rpcError(grpc.status.INVALID_ARGUMENT, 'payload_json is not valid JSON')); }
    if (sha256(stableJson(payload)) !== request.payload_sha256) {
      return callback(rpcError(grpc.status.INVALID_ARGUMENT, 'Alert checksum mismatch'));
    }
    this.context.alerts.set(request.alert_id, { ...payload, payload_sha256: request.payload_sha256, published_at: new Date().toISOString() });
    this.context.persist();
    callback(null, { alert_id: request.alert_id, published: true, duplicate: false });
  }

  async close() {
    if (this.clients) {
      for (const client of Object.values(this.clients)) client.close();
    }
    await new Promise(resolve => this.server.tryShutdown(resolve));
  }
}

module.exports = { RpcTransport, stableJson, sha256, normalizeReading };
