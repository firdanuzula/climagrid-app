'use strict';

class TraceBuffer {
  constructor(limit = 1000) {
    this.limit = limit;
    this.spans = [];
  }

  record(traceId, span, attributes = {}) {
    if (!traceId) return;
    this.spans.push({
      trace_id: traceId,
      span,
      timestamp: new Date().toISOString(),
      ...attributes
    });
    if (this.spans.length > this.limit) this.spans.splice(0, this.spans.length - this.limit);
  }

  get(traceId) {
    return this.spans.filter(item => item.trace_id === traceId);
  }
}

module.exports = { TraceBuffer };
