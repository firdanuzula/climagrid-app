'use strict';

const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2000];

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

class PrometheusMetrics {
  constructor() {
    this.requests = new Map();
  }

  observe(method, route, status, durationMs) {
    const key = `${method}\u0000${route}\u0000${status}`;
    let metric = this.requests.get(key);
    if (!metric) {
      metric = { method, route, status: String(status), count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      this.requests.set(key, metric);
    }
    metric.count++;
    metric.sum += durationMs;
    BUCKETS.forEach((bucket, index) => {
      if (durationMs <= bucket) metric.buckets[index]++;
    });
  }

  render({ ingestedCount, duplicateCount, cache, dht }) {
    const lines = [
      '# HELP climagrid_http_request_duration_ms HTTP request duration in milliseconds.',
      '# TYPE climagrid_http_request_duration_ms histogram'
    ];
    for (const metric of this.requests.values()) {
      const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${escapeLabel(metric.status)}"`;
      BUCKETS.forEach((bucket, index) => {
        lines.push(`climagrid_http_request_duration_ms_bucket{${labels},le="${bucket}"} ${metric.buckets[index]}`);
      });
      lines.push(`climagrid_http_request_duration_ms_bucket{${labels},le="+Inf"} ${metric.count}`);
      lines.push(`climagrid_http_request_duration_ms_sum{${labels}} ${metric.sum.toFixed(3)}`);
      lines.push(`climagrid_http_request_duration_ms_count{${labels}} ${metric.count}`);
    }
    lines.push(
      '# HELP climagrid_ingest_readings_total Readings accepted by the ingest service.',
      '# TYPE climagrid_ingest_readings_total counter',
      `climagrid_ingest_readings_total{result="accepted"} ${ingestedCount}`,
      `climagrid_ingest_readings_total{result="duplicate"} ${duplicateCount}`,
      '# HELP climagrid_cache_requests_total Edge cache lookups by result.',
      '# TYPE climagrid_cache_requests_total counter',
      `climagrid_cache_requests_total{result="hit"} ${cache.hits}`,
      `climagrid_cache_requests_total{result="miss"} ${cache.misses}`,
      '# HELP climagrid_dht_node_up Whether a DHT node is online.',
      '# TYPE climagrid_dht_node_up gauge'
    );
    dht.forEach(node => lines.push(`climagrid_dht_node_up{id="${escapeLabel(node.id)}"} ${node.online ? 1 : 0}`));
    return `${lines.join('\n')}\n`;
  }
}

module.exports = { PrometheusMetrics };
