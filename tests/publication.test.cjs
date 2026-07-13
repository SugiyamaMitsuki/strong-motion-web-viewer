const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeStationDistanceRows,
  sourceLocationFromRecords,
} = require('../.test-dist/src/analysis/distance.js');
const { computePlotGeometry } = require('../.test-dist/src/visualization/plotGeometry.js');
const { computeHorizontalVerticalRatios } = require('../.test-dist/src/analysis/horizontalVerticalRatio.js');

function record(id, component, originTime, eventLat, eventLon) {
  return {
    id,
    fileName: `${id}.${component}`,
    sourceType: 'knet',
    component,
    componentLabel: component,
    quantity: 'acceleration',
    unit: 'cm/s²',
    values: [],
    dt: 0.01,
    samplingHz: 100,
    metadata: {
      stationCode: 'TEST01',
      stationLat: 35,
      stationLon: 139,
      originTime,
      eventLat,
      eventLon,
      depthKm: 10,
    },
  };
}

test('distance rows keep different events at the same station separate', () => {
  const records = [
    record('event-a-ns', 'NS', '2026/01/01 00:00:00', 35.1, 139.1),
    record('event-a-ew', 'EW', '2026/01/01 00:00:00', 35.1, 139.1),
    record('event-b-ns', 'NS', '2026/01/02 00:00:00', 36.2, 140.2),
    record('event-b-ew', 'EW', '2026/01/02 00:00:00', 36.2, 140.2),
  ];

  const rows = computeStationDistanceRows(records);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.recordIds), [
    ['event-a-ns', 'event-a-ew'],
    ['event-b-ns', 'event-b-ew'],
  ]);
  assert.deepEqual(rows.map((row) => row.eventLat), [35.1, 36.2]);
  assert.ok(rows.every((row) => Number.isFinite(row.epicentralDistanceKm)));
  assert.notEqual(rows[0].epicentralDistanceKm, rows[1].epicentralDistanceKm);
});

test('a mixed-event source editor never presents the first source as a shared value', () => {
  const source = sourceLocationFromRecords([
    record('event-a', 'NS', '2026/01/01 00:00:00', 35.1, 139.1),
    record('event-b', 'NS', '2026/01/02 00:00:00', 36.2, 140.2),
  ]);
  assert.equal(source.eventLat, undefined);
  assert.equal(source.eventLon, undefined);
  assert.equal(source.depthKm, 10);
});

test('equal-aspect publication plots use an exactly square plotting rectangle', () => {
  const orbit = computePlotGeometry(680, 680, { left: 82, right: 28, top: 73, bottom: 66 }, true);
  const response = computePlotGeometry(700, 700, { left: 82, right: 28, top: 73, bottom: 66 }, true);
  assert.equal(orbit.width, orbit.height);
  assert.equal(response.width, response.height);
  assert.ok(orbit.left > 82);
  assert.equal(orbit.top, 73);
});

test('H/V ratios keep different events at the same station separate', () => {
  const sampleCount = 512;
  const dt = 0.01;
  const makeWaveform = (event, component, phase) => ({
    sourceRecordId: `${event}-${component}`,
    fileName: `${event}.${component}`,
    component,
    componentLabel: component,
    dt,
    samplingHz: 1 / dt,
    time: Array.from({ length: sampleCount }, (_, index) => index * dt),
    acceleration: Array.from({ length: sampleCount }, (_, index) => Math.sin(2 * Math.PI * 5 * index * dt + phase) + 0.1),
    velocity: Array(sampleCount).fill(0),
    displacement: Array(sampleCount).fill(0),
    metadata: { stationCode: 'TEST01', originTime: event },
  });
  const waveforms = [
    makeWaveform('2026/01/01 00:00:00', 'NS', 0),
    makeWaveform('2026/01/01 00:00:00', 'EW', 0.2),
    makeWaveform('2026/01/01 00:00:00', 'UD', 0.4),
    makeWaveform('2026/01/02 00:00:00', 'NS', 0.1),
    makeWaveform('2026/01/02 00:00:00', 'EW', 0.3),
    makeWaveform('2026/01/02 00:00:00', 'UD', 0.5),
  ];

  const results = computeHorizontalVerticalRatios(waveforms, 'acceleration', {
    minFrequency: 1,
    maxFrequency: 20,
    frequencyCount: 24,
    smoothingBandwidth: 0,
  });
  assert.equal(results.length, 2);
  assert.ok(results[0].label.includes('2026/01/01'));
  assert.ok(results[1].label.includes('2026/01/02'));
});
