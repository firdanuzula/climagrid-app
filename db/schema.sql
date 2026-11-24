CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE stations (
  id text PRIMARY KEY,
  name text NOT NULL,
  provinsi text NOT NULL,
  kabupaten text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  elevation integer NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Jakarta',
  status text NOT NULL CHECK (status IN ('online', 'offline')),
  operator text
);

CREATE TABLE station_attributes (
  station_id text NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  attr_key text NOT NULL,
  attr_value text NOT NULL,
  PRIMARY KEY (station_id, attr_key)
);
CREATE INDEX station_attributes_avtree_idx ON station_attributes(attr_key, attr_value);

CREATE TABLE ingest_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id text NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  payload_sha256 char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE readings (
  time timestamptz NOT NULL,
  station_id text NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES ingest_batches(id) ON DELETE RESTRICT,
  temp double precision,
  rh double precision,
  rain double precision,
  wind double precision,
  quality smallint NOT NULL DEFAULT 100
);
SELECT create_hypertable('readings', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX readings_station_time_idx ON readings(station_id, time DESC);
CREATE BRIN INDEX readings_time_brin_idx ON readings USING brin(time);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,
  type text NOT NULL CHECK (type IN ('stats', 'idw')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE job_results (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL
);

CREATE TABLE maps (
  variable text NOT NULL,
  period timestamptz NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (variable, period)
);

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id text NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  type text NOT NULL,
  severity text NOT NULL,
  detected_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (station_id, type, detected_at)
);

CREATE MATERIALIZED VIEW readings_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket, station_id,
       avg(temp) AS temp_avg, min(temp) AS temp_min, max(temp) AS temp_max,
       avg(rh) AS rh_avg, sum(rain) AS rain_sum, avg(wind) AS wind_avg
FROM readings GROUP BY bucket, station_id;
