'use strict';

const crypto = require('crypto');
const { executeJob } = require('./worker');

class MasterNode {
  constructor({ jobs, persist, worker = executeJob, onResult = () => {}, heartbeatMs = 5000 }) {
    this.jobs = jobs;
    this.persist = persist;
    this.worker = worker;
    this.onResult = onResult;
    this.queue = [];
    this.active = false;
    this.startedAt = Date.now();
    this.lastHeartbeat = null;
    this.workerStatus = 'starting';
    this.workerOnline = true;
    this.processed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.workerOnline) return;
      this.lastHeartbeat = new Date().toISOString();
      if (!this.active) this.workerStatus = 'healthy';
    }, heartbeatMs);
    this.heartbeatTimer.unref();
    this.lastHeartbeat = new Date().toISOString();
    this.workerStatus = 'healthy';
  }

  submit(payload, idempotencyKey, context) {
    if (idempotencyKey && this.jobs.has(idempotencyKey)) {
      return { status: 202, job: this.jobs.get(idempotencyKey), duplicate: true };
    }
    const job = {
      id: crypto.randomUUID(),
      type: payload.type,
      payload,
      status: 'queued',
      created_at: new Date().toISOString(),
      progress: 0,
      result: null
    };
    this.jobs.set(job.id, job);
    if (idempotencyKey) this.jobs.set(idempotencyKey, job);
    this.queue.push({ job, context });
    this.persist();
    this.drain();
    return { status: 202, job, duplicate: false };
  }

  async drain() {
    if (this.active || !this.workerOnline) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = true;
    this.workerStatus = 'busy';
    task.job.status = 'running';
    task.job.started_at = new Date().toISOString();
    this.persist();
    try {
      task.job.result = await this.worker(task.job, task.context);
      this.onResult(task.job);
      task.job.status = 'completed';
      task.job.progress = 100;
      task.job.completed_at = new Date().toISOString();
      this.processed++;
    } catch (error) {
      task.job.status = 'failed';
      task.job.error = error.message;
      task.job.completed_at = new Date().toISOString();
    } finally {
      this.active = false;
      this.workerStatus = this.workerOnline ? 'healthy' : 'offline';
      this.persist();
      setImmediate(() => this.drain());
    }
  }

  setWorkerOnline(online) {
    this.workerOnline = online;
    this.workerStatus = online ? (this.active ? 'busy' : 'healthy') : 'offline';
    if (online) setImmediate(() => this.drain());
    return this.health();
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter(task => task.job.id !== jobId);
      job.status = 'cancelled';
      this.persist();
      return true;
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      this.jobs.delete(jobId);
      this.persist();
      return true;
    }
    return false;
  }

  health() {
    return {
      status: this.workerStatus,
      worker_online: this.workerOnline,
      heartbeat_at: this.lastHeartbeat,
      heartbeat_interval_ms: 5000,
      queue_depth: this.queue.length,
      active: this.active,
      jobs_processed: this.processed,
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000)
    };
  }

  close() {
    clearInterval(this.heartbeatTimer);
  }
}

module.exports = { MasterNode };
