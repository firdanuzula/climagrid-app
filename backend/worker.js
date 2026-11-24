'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
let mpiAvailability;

function interpolate(stations, variable, timeOffset = 0, width = 95, height = 56) {
  const values = [];
  for (let y = 0; y < height; y++) {
    const lat = -6.65 - (y + 0.5) / height * 2.2;
    for (let x = 0; x < width; x++) {
      const lon = 110.85 + (x + 0.5) / width * 3.8;
      const cos = Math.cos(lat * Math.PI / 180);
      let numerator = 0;
      let denominator = 0;
      for (const station of stations) {
        const dx = (lon - station.lon) * cos;
        const dy = lat - station.lat;
        const distance2 = dx * dx + dy * dy;
        const weight = 1 / (Math.pow(distance2, 1.12) + 0.00035);
        const value = station.values && station.values[variable] !== undefined
          ? station.values[variable]
          : station[`${variable}Base`];
        numerator += (value - (timeOffset ? timeOffset * ((lon + lat) % 0.1) : 0)) * weight;
        denominator += weight;
      }
      values.push(Number((numerator / denominator).toFixed(3)));
    }
  }
  return values;
}

function summarize(readings) {
  const values = readings.map(reading => reading.temp).filter(Number.isFinite);
  if (values.length === 0) return { count: 0, average: null, minimum: null, maximum: null, moving_average: [] };
  const movingAverage = values.map((_, index) => {
    const window = values.slice(Math.max(0, index - 2), index + 1);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
  return {
    count: values.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    moving_average: movingAverage
  };
}

async function executeJob(job, context) {
  if (job.type === 'idw') {
    const variable = ['temp', 'rain', 'rh'].includes(job.payload.variable) ? job.payload.variable : 'temp';
    const time = Number(job.payload.time) || 0;
    const analytics = await runPythonAnalytics({
      caseName: 'idw',
      stations: context.stations,
      variable,
      time
    });
    if (analytics) {
      return {
        width: 95, height: 56, variable, values: analytics.values,
        execution_engine: analytics.mode, serial_matches: analytics.match,
        data_source: context.dataSource || 'seed'
      };
    }
    return {
      width: 95, height: 56, variable,
      values: interpolate(context.stations, variable, time),
      execution_engine: 'javascript-serial-fallback',
      data_source: context.dataSource || 'seed'
    };
  }
  if (job.type === 'stats') {
    const stationId = job.payload.station_id;
    const readings = stationId ? context.readings.get(stationId) || [] : [...context.readings.values()].flat();
    const values = readings.map(reading => reading.temp).filter(Number.isFinite);
    const analytics = await runPythonAnalytics({ caseName: 'stats', values });
    return analytics
      ? { ...analytics.result, execution_engine: analytics.mode, serial_matches: analytics.match }
      : { ...summarize(readings), execution_engine: 'javascript-serial-fallback' };
  }
  throw new Error(`Unsupported job type: ${job.type}`);
}

async function hasMpiRuntime() {
  if (!mpiAvailability) {
    mpiAvailability = (async () => {
      try {
        await execFileAsync(process.env.MPIEXEC || 'mpiexec', [
          '-n', '1',
          process.env.PYTHON || 'python',
          '-c',
          'from mpi4py import MPI; print(MPI.COMM_WORLD.Get_size())'
        ], { timeout: 10000 });
        return true;
      } catch (_) {
        return false;
      }
    })();
  }
  return mpiAvailability;
}

async function runPythonAnalytics(options) {
  const python = process.env.PYTHON || 'python';
  const script = path.join(__dirname, '..', 'analytics', 'mpi_idw.py');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climagrid-mpi-'));
  try {
    const args = ['--case', options.caseName];
    if (options.caseName === 'idw') {
      const stationFile = path.join(tempDir, 'stations.json');
      fs.writeFileSync(stationFile, JSON.stringify(options.stations));
      args.push('--stations', stationFile, '--variable', options.variable, '--time', String(options.time));
    } else {
      args.push('--values', options.values.join(','));
    }
    const useMpi = process.env.CLIMAGRID_MPI !== 'false' && await hasMpiRuntime();
    const command = useMpi ? (process.env.MPIEXEC || 'mpiexec') : python;
    const commandArgs = useMpi
      ? ['-n', String(Math.max(1, Number(process.env.MPI_RANKS) || 4)), python, script, ...args]
      : [script, ...args];
    const { stdout } = await execFileAsync(command, commandArgs, {
      cwd: path.join(__dirname, '..'),
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    const outputLine = stdout.trim().split(/\r?\n/).pop();
    const result = JSON.parse(outputLine);
    if (result.match !== true) throw new Error('MPI result does not match the serial reference');
    return options.caseName === 'idw'
      ? { mode: result.mode, match: result.match, values: result.values }
      : { mode: result.mode, match: result.match, result: result.result };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { executeJob, interpolate, summarize, runPythonAnalytics, hasMpiRuntime };
