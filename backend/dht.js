'use strict';

const crypto = require('crypto');

const RING_SIZE = 0x100000000;
const REPLICATION_FACTOR = 3;
const WRITE_QUORUM = 2;
const READ_QUORUM = 2;

function hashKey(value) {
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 8), 16) >>> 0;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function successorIndex(nodes, id) {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (nodes[middle].key < id) low = middle + 1;
    else high = middle;
  }
  return low === nodes.length ? 0 : low;
}

class ChordNode {
  constructor(id, key, saved = {}) {
    this.id = id;
    this.key = key >>> 0;
    this.replicas = new Map(Object.entries(saved.replicas || {}));
    this.online = saved.online !== false;
    this.successor = null;
    this.predecessor = null;
    this.fingerTable = [];
  }
}

class ChordRing {
  constructor(ids = ['chord-a', 'chord-b', 'chord-c'], options = {}) {
    this.onChange = options.onChange || (() => {});
    this.lookupCount = 0;
    this.lookupSteps = 0;
    this.hints = new Map();
    const savedNodes = options.state && options.state.nodes || {};
    for (const [target, records] of Object.entries(options.state && options.state.hints || {})) {
      this.hints.set(target, new Map(Object.entries(records)));
    }
    this.nodes = ids.map(id => new ChordNode(id, hashKey(id), savedNodes[id] || {}));
    this.refreshTopology();
    const interval = options.antiEntropyMs || 300000;
    this.antiEntropyTimer = setInterval(() => this.antiEntropy(), interval);
    this.antiEntropyTimer.unref();
  }

  refreshTopology() {
    const ordered = this.nodes.slice().sort((a, b) => a.key - b.key);
    const online = ordered.filter(node => node.online);
    for (const node of ordered) {
      const position = ordered.indexOf(node);
      const livePosition = online.indexOf(node);
      node.successor = livePosition >= 0 && online.length ? online[(livePosition + 1) % online.length] : ordered[(position + 1) % ordered.length] || null;
      node.predecessor = livePosition >= 0 && online.length ? online[(livePosition - 1 + online.length) % online.length] : ordered[(position - 1 + ordered.length) % ordered.length] || null;
      node.fingerTable = Array.from({ length: 32 }, (_, index) => {
        const start = (node.key + (2 ** index % RING_SIZE)) % RING_SIZE;
        if (online.length === 0) return null;
        return online[successorIndex(online, start)];
      });
    }
  }

  lookup(key) {
    const ordered = this.nodes.slice().sort((a, b) => a.key - b.key);
    const online = ordered.filter(node => node.online);
    if (online.length === 0) throw new Error('DHT has no online nodes');
    const id = hashKey(key);
    let current = online[0];
    let steps = 0;
    while (steps <= online.length) {
      if (current.key === id) break;
      const successor = current.successor;
      if (!successor) throw new Error('Chord successor is unavailable');
      const targetDistance = (id - current.key + RING_SIZE) % RING_SIZE;
      const successorDistance = (successor.key - current.key + RING_SIZE) % RING_SIZE;
      steps++;
      if (targetDistance > 0 && targetDistance <= successorDistance) {
        current = successor;
        break;
      }
      const finger = current.fingerTable.slice().reverse().find(candidate => {
        if (!candidate || !candidate.online || candidate === current) return false;
        const distance = (candidate.key - current.key + RING_SIZE) % RING_SIZE;
        return distance > 0 && distance < targetDistance;
      });
      current = finger || successor;
    }
    const owner = current;
    const orderedIndex = ordered.indexOf(owner);
    const successorList = ordered.map((_, offset) => ordered[(orderedIndex + offset) % ordered.length]);
    this.lookupCount++;
    this.lookupSteps += steps;
    return {
      owner,
      hops: steps,
      successorList
    };
  }

  write(key, value) {
    const { owner, successorList } = this.lookup(key);
    const checksum = hashValue(value);
    let acknowledgements = 0;
    const targets = successorList.slice(0, Math.min(REPLICATION_FACTOR, this.nodes.length));
    const hintHolder = targets.find(node => node.online);

    for (const node of targets) {
      const replica = { value, checksum, updated_at: new Date().toISOString() };
      if (node.online) {
        node.replicas.set(key, replica);
        acknowledgements++;
      } else if (hintHolder) {
        let targetHints = this.hints.get(node.id);
        if (!targetHints) this.hints.set(node.id, targetHints = new Map());
        targetHints.set(key, replica);
      }
    }

    if (acknowledgements < WRITE_QUORUM) {
      throw new Error(`DHT write quorum W=${WRITE_QUORUM} unavailable`);
    }
    this.onChange();
    return { owner: owner.id, acknowledgements, hints: targets.length - acknowledgements };
  }

  hintedValue(targetId, key) {
    const hints = this.hints.get(targetId);
    return hints && hints.get(key);
  }

  read(key) {
    const { owner, successorList } = this.lookup(key);
    const targets = successorList.slice(0, Math.min(REPLICATION_FACTOR, this.nodes.length));
    const replies = [];
    for (const target of targets) {
      if (target.online) {
        const replica = target.replicas.get(key);
        if (replica) replies.push({ target, replica });
      } else {
        for (const holder of this.nodes) {
          if (!holder.online) continue;
          const hint = this.hintedValue(target.id, key);
          if (hint) {
            replies.push({ target, replica: hint, hinted: true });
            break;
          }
        }
      }
    }
    if (replies.length < READ_QUORUM) {
      throw new Error(`DHT read quorum R=${READ_QUORUM} unavailable`);
    }
    const groups = new Map();
    for (const reply of replies) {
      const group = groups.get(reply.replica.checksum) || [];
      group.push(reply);
      groups.set(reply.replica.checksum, group);
    }
    const winner = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (winner.length < READ_QUORUM) {
      throw new Error('DHT replicas do not agree on a read quorum');
    }
    const chosen = winner[0].replica;
    for (const target of targets) {
      if (target.online) {
        const current = target.replicas.get(key);
        if (!current || current.checksum !== chosen.checksum) target.replicas.set(key, chosen);
      } else {
        let targetHints = this.hints.get(target.id);
        if (!targetHints) this.hints.set(target.id, targetHints = new Map());
        targetHints.set(key, chosen);
      }
    }
    this.onChange();
    return { value: chosen.value, owner: owner.id, replies: replies.length, repaired: true };
  }

  setNode(id, online) {
    const node = this.nodes.find(item => item.id === id);
    if (!node) return false;
    node.online = online;
    this.refreshTopology();
    if (online) this.handoff(id);
    this.onChange();
    return true;
  }

  handoff(id) {
    const node = this.nodes.find(item => item.id === id);
    const targetHints = this.hints.get(id);
    if (!node || !node.online || !targetHints) return 0;
    for (const [key, replica] of targetHints) node.replicas.set(key, replica);
    const transferred = targetHints.size;
    this.hints.delete(id);
    return transferred;
  }

  antiEntropy() {
    const keys = new Set();
    for (const node of this.nodes) for (const key of node.replicas.keys()) keys.add(key);
    for (const targetHints of this.hints.values()) for (const key of targetHints.keys()) keys.add(key);
    let repaired = 0;
    for (const key of keys) {
      try {
        this.read(key);
        repaired++;
      } catch (_) {
        // A key without a read quorum cannot be repaired automatically.
      }
    }
    if (repaired) this.onChange();
    return repaired;
  }

  exportState() {
    const nodes = {};
    for (const node of this.nodes) {
      nodes[node.id] = { online: node.online, replicas: Object.fromEntries(node.replicas) };
    }
    const hints = {};
    for (const [target, values] of this.hints) hints[target] = Object.fromEntries(values);
    return { nodes, hints };
  }

  health() {
    const ordered = this.nodes.slice().sort((a, b) => a.key - b.key);
    return ordered.map(node => ({
      id: node.id,
      online: node.online,
      key: node.key,
      successor: node.successor ? node.successor.id : null,
      predecessor: node.predecessor ? node.predecessor.id : null,
      finger_table: node.fingerTable.map(entry => entry ? entry.id : null),
      replicas: node.replicas.size,
      hinted_handoff: this.hints.has(node.id) ? this.hints.get(node.id).size : 0,
      lookup_count: this.lookupCount,
      average_lookup_steps: this.lookupCount ? this.lookupSteps / this.lookupCount : 0
    }));
  }

  close() {
    clearInterval(this.antiEntropyTimer);
  }
}

module.exports = { ChordRing, hashKey, hashValue, successorIndex };
