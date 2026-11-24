'use strict';

class EdgeCache {
  constructor({ redisUrl = '', limit = 192 } = {}) {
    this.redisUrl = redisUrl;
    this.limit = limit;
    this.items = new Map();
    this.leases = new Map();
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
    this.instanceId = `${process.pid}-${Math.random().toString(16).slice(2)}`;
    this.adapter = 'memory-lru';
    this.client = null;
    this.subscriber = null;
    this.ready = this.connect();
  }

  async connect() {
    if (!this.redisUrl) return;
    try {
      const { createClient } = require('redis');
      this.client = createClient({ url: this.redisUrl });
      this.client.on('error', error => this.fallback(error));
      await this.client.connect();
      this.subscriber = this.client.duplicate();
      this.subscriber.on('error', error => this.fallback(error));
      await this.subscriber.connect();
      await this.subscriber.subscribe('climagrid:cache:invalidate', message => {
        try {
          const event = JSON.parse(message);
          if (event.origin === this.instanceId) return;
          this.invalidateLocal(event.key);
        } catch (error) {
          console.error('Invalid Redis cache invalidation event:', error.message);
        }
      });
      this.adapter = 'redis-lru';
    } catch (error) {
      this.fallback(error);
    }
  }

  fallback(error) {
    if (this.adapter !== 'memory-lru') console.warn(`Redis cache unavailable; using in-memory LRU: ${error.message}`);
    this.adapter = 'memory-lru';
    this.client = null;
    this.subscriber = null;
  }

  readLocal(key) {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }

  writeLocal(key, value, ttlMs) {
    this.items.delete(key);
    this.items.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
  }

  async get(key) {
    await this.ready;
    let value = this.readLocal(key);
    if (value !== undefined) {
      this.hits++;
      return value;
    }
    if (this.client) {
      try {
        const remote = await this.client.get(key);
        if (remote !== null) {
          value = JSON.parse(remote);
          this.writeLocal(key, value, 30000);
          this.hits++;
          return value;
        }
      } catch (error) {
        this.fallback(error);
      }
    }
    this.misses++;
    return undefined;
  }

  async set(key, value, ttlMs = 30000) {
    await this.ready;
    const previous = this.readLocal(key);
    this.writeLocal(key, value, ttlMs);
    if (this.client) {
      try {
        await this.client.set(key, JSON.stringify(value), { PX: ttlMs });
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
          this.notify(key, { type: 'replaced' });
          await this.client.publish('climagrid:cache:invalidate', JSON.stringify({ key, origin: this.instanceId }));
        }
      } catch (error) {
        this.fallback(error);
      }
    } else if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
      this.notify(key, { type: 'replaced' });
    }
  }

  lease(key, callback, ttlMs = 30000) {
    let listeners = this.leases.get(key);
    if (!listeners) this.leases.set(key, listeners = new Set());
    const lease = { callback, expiresAt: Date.now() + ttlMs };
    listeners.add(lease);
    return () => {
      listeners.delete(lease);
      if (!listeners.size) this.leases.delete(key);
    };
  }

  notify(key, event) {
    const listeners = this.leases.get(key);
    if (!listeners) return;
    for (const lease of [...listeners]) {
      if (lease.expiresAt <= Date.now()) {
        listeners.delete(lease);
        continue;
      }
      try {
        lease.callback({ key, ...event });
      } catch (error) {
        console.error('Cache lease callback failed:', error.message);
      }
    }
    if (!listeners.size) this.leases.delete(key);
    this.invalidations++;
  }

  invalidateLocal(key) {
    this.items.delete(key);
    this.notify(key, { type: 'remote-invalidation' });
  }

  async invalidate(key) {
    await this.ready;
    this.items.delete(key);
    if (this.client) {
      try {
        await this.client.del(key);
        await this.client.publish('climagrid:cache:invalidate', JSON.stringify({ key, origin: this.instanceId }));
      } catch (error) {
        this.fallback(error);
      }
    }
    this.notify(key, { type: 'invalidated' });
  }

  async invalidatePrefix(prefix) {
    await this.ready;
    const keys = new Set([...this.items.keys()].filter(key => key.startsWith(prefix)));
    if (this.client) {
      try {
        for await (const key of this.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.add(key);
      } catch (error) {
        this.fallback(error);
      }
    }
    await Promise.all([...keys].map(key => this.invalidate(key)));
  }

  health() {
    return {
      adapter: this.adapter,
      entries: this.items.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations
    };
  }

  async close() {
    if (this.subscriber) await this.subscriber.quit();
    if (this.client) await this.client.quit();
  }
}

module.exports = { EdgeCache };
