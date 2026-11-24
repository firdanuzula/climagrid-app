'use strict';

const crypto = require('crypto');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createGateway({ token = '', limit = 120, windowMs = 60000 } = {}) {
  const buckets = new Map();
  return {
    authorize(req, res, sendError) {
      const now = Date.now();
      const key = req.socket.remoteAddress || 'unknown';
      const bucket = buckets.get(key) || { start: now, count: 0 };
      if (now - bucket.start >= windowMs) {
        bucket.start = now;
        bucket.count = 0;
      }
      bucket.count++;
      buckets.set(key, bucket);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
      if (bucket.count > limit) {
        sendError(res, 429, 'RATE_LIMITED', 'Too many requests');
        return false;
      }
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        sendError(res, 401, 'UNAUTHORIZED', 'Bearer token required');
        return false;
      }
      return true;
    },
    etag(value) {
      return `"${crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24)}"`;
    },
    stableJson
  };
}

module.exports = { createGateway };
