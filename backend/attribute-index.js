'use strict';

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('id-ID');
}

class StationAttributeIndex {
  constructor(stations = []) {
    this.stations = new Map();
    this.values = new Map();
    for (const station of stations) this.add(station);
  }

  attributes(station) {
    const sensorValues = String(station.sensors || '')
      .split(/[·,;]/)
      .map(value => value.trim())
      .filter(Boolean);
    return {
      provinsi: [station.provinsi || 'Jawa Timur'],
      sensor: sensorValues,
      type: [station.type],
      operator: [station.operator],
      status: [station.status]
    };
  }

  add(station) {
    this.remove(station.id);
    this.stations.set(station.id, station);
    for (const [attribute, values] of Object.entries(this.attributes(station))) {
      let valueIndex = this.values.get(attribute);
      if (!valueIndex) this.values.set(attribute, valueIndex = new Map());
      for (const value of values) {
        const key = normalize(value);
        if (!key) continue;
        let stationIds = valueIndex.get(key);
        if (!stationIds) valueIndex.set(key, stationIds = new Set());
        stationIds.add(station.id);
      }
    }
  }

  remove(stationId) {
    const previous = this.stations.get(stationId);
    if (!previous) return;
    for (const [attribute, values] of Object.entries(this.attributes(previous))) {
      const valueIndex = this.values.get(attribute);
      for (const value of values) {
        const key = normalize(value);
        const stationIds = valueIndex && valueIndex.get(key);
        if (!stationIds) continue;
        stationIds.delete(stationId);
        if (!stationIds.size) valueIndex.delete(key);
      }
    }
    this.stations.delete(stationId);
  }

  matchingValues(attribute, value) {
    const valueIndex = this.values.get(attribute);
    if (!valueIndex) return new Set();
    const query = normalize(value);
    const result = new Set();
    for (const [indexedValue, stationIds] of valueIndex) {
      if (indexedValue.includes(query)) for (const id of stationIds) result.add(id);
    }
    return result;
  }

  query(filters = {}) {
    let candidates = new Set(this.stations.keys());
    for (const attribute of ['provinsi', 'sensor', 'type', 'operator', 'status']) {
      if (!filters[attribute]) continue;
      const matches = this.matchingValues(attribute, filters[attribute]);
      candidates = new Set([...candidates].filter(id => matches.has(id)));
    }
    if (filters.q) {
      const query = normalize(filters.q);
      candidates = new Set([...candidates].filter(id => {
        const station = this.stations.get(id);
        return normalize([
          station.id, station.name, station.area, station.kab,
          station.provinsi, station.type, station.operator, station.sensors
        ].join(' ')).includes(query);
      }));
    }
    return [...candidates].map(id => this.stations.get(id));
  }
}

module.exports = { StationAttributeIndex, normalize };
