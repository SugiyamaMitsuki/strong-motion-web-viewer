const test = require('node:test');
const assert = require('node:assert/strict');

const { fftComplex } = require('../.test-dist/src/analysis/fft.js');
const {
  applyJmaFrequencyFilter,
  computeJmaIntensity,
  selectJmaThreshold,
} = require('../.test-dist/src/analysis/jmaIntensity.js');
const { computeParticleOrbits } = require('../.test-dist/src/analysis/orbit.js');
const {
  computeSingleResponseSpectrum,
  generateLogPeriods,
} = require('../.test-dist/src/analysis/responseSpectrum.js');
const { parseJmaStrongMotionFile } = require('../.test-dist/src/parsers/jma.js');

function maxAbsoluteDifference(actual, expected) {
  assert.equal(actual.length, expected.length);
  let maximum = 0;
  for (let i = 0; i < actual.length; i += 1) {
    maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
  }
  return maximum;
}

function refinePiecewiseLinear(values, subdivisions) {
  const refined = [];
  for (let index = 1; index < values.length; index += 1) {
    const start = values[index - 1];
    const end = values[index];
    if (index === 1) refined.push(start);
    for (let step = 1; step <= subdivisions; step += 1) {
      refined.push(start + (end - start) * step / subdivisions);
    }
  }
  return refined;
}

function derivedWaveform({
  id,
  component,
  values,
  dt = 0.01,
  stationCode = 'TEST',
  recordTime = '2026-01-01 00:00:00',
  originTime,
  jmaIntensityWindowSec,
  time,
}) {
  return {
    sourceRecordId: id,
    fileName: `${id}.txt`,
    component,
    componentLabel: component,
    dt,
    samplingHz: 1 / dt,
    time: time ?? values.map((_, index) => index * dt),
    acceleration: [...values],
    velocity: [...values],
    displacement: [...values],
    metadata: { stationCode, recordTime, originTime, jmaIntensityWindowSec },
  };
}

function naiveDft(inputRe, inputIm = Array(inputRe.length).fill(0), inverse = false) {
  const n = inputRe.length;
  const re = Array(n).fill(0);
  const im = Array(n).fill(0);
  const direction = inverse ? 1 : -1;

  for (let k = 0; k < n; k += 1) {
    for (let sample = 0; sample < n; sample += 1) {
      const angle = direction * 2 * Math.PI * k * sample / n;
      re[k] += inputRe[sample] * Math.cos(angle) - inputIm[sample] * Math.sin(angle);
      im[k] += inputRe[sample] * Math.sin(angle) + inputIm[sample] * Math.cos(angle);
    }
    if (inverse) {
      re[k] /= n;
      im[k] /= n;
    }
  }

  return { re, im };
}

function referenceFftLength(sampleCount) {
  return 2 ** Math.ceil(Math.log2(Math.max(2, sampleCount * 2 + 1)));
}

function referenceJmaGain(frequencyHz) {
  if (frequencyHz <= 0) return 0;
  const x = frequencyHz / 10;
  const periodEffect = 1 / Math.sqrt(frequencyHz);
  const highCut = 1 / Math.sqrt(
    1 + 0.694 * x ** 2 + 0.241 * x ** 4 + 0.0557 * x ** 6
      + 0.009664 * x ** 8 + 0.00134 * x ** 10 + 0.000155 * x ** 12,
  );
  const lowCut = Math.sqrt(Math.max(0, 1 - Math.exp(-((frequencyHz / 0.5) ** 3))));
  return periodEffect * highCut * lowCut;
}

function referenceJmaFilter(values, dt) {
  const nFft = referenceFftLength(values.length);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const re = Array(nFft).fill(0);
  for (let i = 0; i < values.length; i += 1) re[i] = values[i] - mean;

  const spectrum = naiveDft(re);
  const outRe = Array(nFft).fill(0);
  const outIm = Array(nFft).fill(0);
  const df = 1 / (nFft * dt);

  for (let k = 0; k < nFft; k += 1) {
    const signedFrequency = k <= nFft / 2 ? k * df : (k - nFft) * df;
    const gain = referenceJmaGain(Math.abs(signedFrequency));
    outRe[k] = spectrum.re[k] * gain;
    outIm[k] = spectrum.im[k] * gain;
  }

  return naiveDft(outRe, outIm, true).re.slice(0, values.length);
}

test('complex FFT round-trip preserves samples', () => {
  const re = [0.25, -1.5, 2.25, 0, 1.75, -0.5, 0.125, 3];
  const im = [1, 0.5, -0.25, 2, 0, -1.25, 0.75, -0.5];
  const spectrum = fftComplex(re, im);
  const expectedSpectrum = naiveDft(re, im);
  const restored = fftComplex(spectrum.re, spectrum.im, true);

  assert.ok(maxAbsoluteDifference(spectrum.re, expectedSpectrum.re) < 1e-12);
  assert.ok(maxAbsoluteDifference(spectrum.im, expectedSpectrum.im) < 1e-12);
  assert.ok(maxAbsoluteDifference(restored.re, re) < 1e-12);
  assert.ok(maxAbsoluteDifference(restored.im, im) < 1e-12);
});

test('JMA filter applies the real gain to the complete complex spectrum', () => {
  const dt = 0.01;
  const values = Array.from({ length: 127 }, (_, index) => (
    18 * Math.sin(2 * Math.PI * 0.8 * index * dt + 0.4)
    + 7 * Math.cos(2 * Math.PI * 6.5 * index * dt)
    + (index === 53 ? 25 : 0)
  ));

  const actual = applyJmaFrequencyFilter(values, dt);
  const expected = referenceJmaFilter(values, dt);

  assert.equal(actual.length, values.length);
  assert.ok(maxAbsoluteDifference(actual, expected) < 1e-10);
  assert.ok(actual.every(Number.isFinite));
});

test('JMA threshold selects the K-th largest sample for 0.3 seconds', () => {
  const selection = selectJmaThreshold([1, 7, 3, 9, 5, 8, 4], 0.05);

  assert.equal(selection.requiredSamples, 6);
  assert.equal(selection.threshold, 3);
  assert.ok(Math.abs(selection.durationSec - 0.3) < 1e-12);
});

test('JMA threshold never represents less than 0.3 seconds for a non-divisor dt', () => {
  const selection = selectJmaThreshold([9, 8, 7, 6, 5, 4, 3], 0.07);

  assert.equal(selection.requiredSamples, 5);
  assert.equal(selection.threshold, 5);
  assert.ok(selection.durationSec >= 0.3);
});

test('JMA threshold reports the actual cumulative duration when values are tied', () => {
  const selection = selectJmaThreshold([9, 8, 8, 8, 1], 0.1);

  assert.equal(selection.requiredSamples, 3);
  assert.equal(selection.selectedSamples, 4);
  assert.equal(selection.threshold, 8);
  assert.ok(Math.abs(selection.durationSec - 0.4) < 1e-12);
});

test('JMA intensity never mixes components from different stations', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity([
    derivedWaveform({ id: 'a-ns', component: 'NS', values, stationCode: 'A' }),
    derivedWaveform({ id: 'a-ew', component: 'EW', values, stationCode: 'A' }),
    derivedWaveform({ id: 'b-ud', component: 'UD', values, stationCode: 'B' }),
  ]);

  assert.equal(result.available, false);
  assert.match(result.message, /same station|complete NS\/EW\/UD/i);
});

test('JMA intensity rejects multiple complete station groups as ambiguous', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const waveforms = ['A', 'B'].flatMap((stationCode) => ['NS', 'EW', 'UD'].map((component) => (
    derivedWaveform({ id: `${stationCode}-${component}`, component, values, stationCode })
  )));

  const result = computeJmaIntensity(waveforms);
  assert.equal(result.available, false);
  assert.match(result.message, /multiple|single station/i);
});

test('JMA intensity rejects an incomplete station mixed with a complete station', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity([
    derivedWaveform({ id: 'a-ns', component: 'NS', values, stationCode: 'A' }),
    ...['NS', 'EW', 'UD'].map((component) => (
      derivedWaveform({ id: `b-${component}`, component, values, stationCode: 'B' })
    )),
  ]);

  assert.equal(result.available, false);
  assert.match(result.message, /multiple|one complete/i);
});

test('JMA intensity does not mix different sensor channel suffixes', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity([
    { ...derivedWaveform({ id: 'ns1', component: 'NS', values }), componentLabel: 'NS1' },
    { ...derivedWaveform({ id: 'ew2', component: 'EW', values }), componentLabel: 'EW2' },
    { ...derivedWaveform({ id: 'ud2', component: 'UD', values }), componentLabel: 'UD2' },
  ]);

  assert.equal(result.available, false);
  assert.match(result.message, /same station|complete NS\/EW\/UD/i);
});

test('JMA intensity accepts a complete sensor channel suffix', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity(['NS', 'EW', 'UD'].map((component) => ({
    ...derivedWaveform({ id: `${component.toLowerCase()}1`, component, values }),
    componentLabel: `${component}1`,
  })));

  assert.equal(result.available, true);
});

test('JMA intensity rejects components with inconsistent start times', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity([
    derivedWaveform({ id: 'ns', component: 'NS', values }),
    derivedWaveform({ id: 'ew', component: 'EW', values, recordTime: '2026-01-01 00:00:01' }),
    derivedWaveform({ id: 'ud', component: 'UD', values }),
  ]);

  assert.equal(result.available, false);
  assert.match(result.message, /start time/i);
});

test('JMA intensity does not combine unrelated metadata-free files', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity([
    derivedWaveform({ id: 'ns', component: 'NS', values, stationCode: '', recordTime: '' }),
    { ...derivedWaveform({ id: 'ew', component: 'EW', values, stationCode: '', recordTime: '' }), fileName: 'ew.csv' },
    { ...derivedWaveform({ id: 'ud', component: 'UD', values, stationCode: '', recordTime: '' }), fileName: 'ud.csv' },
  ].map((waveform, index) => ({ ...waveform, fileName: ['ns.csv', 'ew.csv', 'ud.csv'][index] })));

  assert.equal(result.available, false);
  assert.match(result.message, /same station|complete NS\/EW\/UD/i);
});

test('JMA intensity does not combine unidentified stations solely because their start time matches', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity(['NS', 'EW', 'UD'].map((component, index) => ({
    ...derivedWaveform({ id: `anonymous-${component}`, component, values, stationCode: '' }),
    fileName: `anonymous-event-${index + 1}-${component}.csv`,
  })));

  assert.equal(result.available, false);
  assert.match(result.message, /multiple|one complete/i);
});

test('JMA intensity does not combine unrelated files when station metadata is shared but start time is absent', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity(['NS', 'EW', 'UD'].map((component, index) => ({
    ...derivedWaveform({ id: `event-${component}`, component, values, stationCode: 'A', recordTime: '' }),
    fileName: `event${index + 1}-${component}.csv`,
  })));

  assert.equal(result.available, false);
  assert.match(result.message, /multiple|one complete/i);
});

test('JMA intensity accepts three columns originating from one metadata-free file', () => {
  const values = Array.from({ length: 100 }, (_, index) => (index === 40 ? 100 : 0));
  const result = computeJmaIntensity(['NS', 'EW', 'UD'].map((component, index) => ({
    ...derivedWaveform({ id: component, component, values, stationCode: '', recordTime: '' }),
    fileName: index === 0 ? 'one.csv' : `one.csv#${component}`,
  })));

  assert.equal(result.available, true);
});

test('JMA resampling uses only the common sample span', () => {
  const fast = Array.from({ length: 30 }, (_, index) => (index === 10 ? 100 : 0));
  const slow = Array.from({ length: 15 }, (_, index) => (index === 5 ? 100 : 0));
  const result = computeJmaIntensity([
    derivedWaveform({ id: 'ns', component: 'NS', values: fast, dt: 0.01 }),
    derivedWaveform({ id: 'ew', component: 'EW', values: slow, dt: 0.02 }),
    derivedWaveform({ id: 'ud', component: 'UD', values: fast, dt: 0.01 }),
  ]);

  assert.equal(result.available, false);
  assert.match(result.message, /too short/i);
});

test('JMA-tagged multi-window data is evaluated one interval at a time', () => {
  const dt = 0.1;
  const window1 = Array.from({ length: 10 }, (_, index) => (index === 2 || index === 3 || index === 4 ? 80 : 0));
  const window2 = Array.from({ length: 10 }, (_, index) => (index === 6 || index === 7 || index === 8 ? 30 : 0));
  const combined = [...window1, ...window2];
  const components = ['NS', 'EW', 'UD'];
  const fullResult = computeJmaIntensity(components.map((component) => derivedWaveform({
    id: `full-${component}`,
    component,
    values: combined,
    dt,
    jmaIntensityWindowSec: 1,
  })));
  const separateResults = [window1, window2].map((values, windowIndex) => computeJmaIntensity(components.map((component) => derivedWaveform({
    id: `window-${windowIndex}-${component}`,
    component,
    values,
    dt,
  }))));
  const expectedThreshold = Math.max(...separateResults.map((result) => result.thresholdAcceleration));

  assert.equal(fullResult.available, true);
  assert.ok(Math.abs(fullResult.thresholdAcceleration - expectedThreshold) < 1e-10);
});

test('JMA-tagged data ignores a truncated trailing interval', () => {
  const dt = 0.1;
  const completeWindow = Array.from({ length: 10 }, (_, index) => (index >= 3 && index <= 5 ? 30 : 0));
  const truncatedTail = Array(5).fill(500);
  const components = ['NS', 'EW', 'UD'];
  const result = computeJmaIntensity(components.map((component) => derivedWaveform({
    id: `truncated-${component}`,
    component,
    values: [...completeWindow, ...truncatedTail],
    dt,
    jmaIntensityWindowSec: 1,
  })));
  const expected = computeJmaIntensity(components.map((component) => derivedWaveform({
    id: `complete-${component}`,
    component,
    values: completeWindow,
    dt,
  })));

  assert.equal(result.available, true);
  assert.ok(Math.abs(result.thresholdAcceleration - expected.thresholdAcceleration) < 1e-10);
});

test('JMA-tagged data retains a nearly complete archived trailing interval', () => {
  const dt = 0.01;
  const completeWindow = Array.from({ length: 100 }, (_, index) => (index >= 30 && index < 60 ? 20 : 0));
  const archivedTail = Array.from({ length: 99 }, (_, index) => (index >= 30 && index < 60 ? 200 : 0));
  const components = ['NS', 'EW', 'UD'];
  const result = computeJmaIntensity(components.map((component) => derivedWaveform({
    id: `archived-${component}`,
    component,
    values: [...completeWindow, ...archivedTail],
    dt,
    jmaIntensityWindowSec: 1,
  })));
  const expected = computeJmaIntensity(components.map((component) => derivedWaveform({
    id: `archived-tail-${component}`,
    component,
    values: archivedTail,
    dt,
  })));

  assert.equal(result.available, true);
  assert.ok(Math.abs(result.thresholdAcceleration - expected.thresholdAcceleration) < 1e-10);
});

test('JMA parser marks 60-second intervals without inventing an origin time', () => {
  const parsed = parseJmaStrongMotionFile('jma.csv', [
    'SITE CODE = 999 Test Station,35.0,139.0,10.0,5.0',
    'LAT. = 35.1',
    'LON. = 139.1',
    'SAMPLING RATE = 100Hz',
    'UNIT = gal',
    'INITIAL TIME = 2026 1 2 3 4 5.0',
    'NS,EW,UD',
    '1,2,3',
    '4,5,6',
  ].join('\n'));

  assert.equal(parsed.records.length, 3);
  parsed.records.forEach((record) => {
    assert.equal(record.metadata.recordTime, '2026-01-02 03:04:05');
    assert.equal(record.metadata.originTime, undefined);
    assert.equal(record.metadata.jmaIntensityWindowSec, 60);
  });
});

test('JMA parser accepts the official gal(cm/s/s) unit spelling', () => {
  const parsed = parseJmaStrongMotionFile('official-unit.csv', [
    'SITE CODE = 999 Test Station,35.0,139.0,10.0,5.0',
    'SAMPLING RATE = 100Hz',
    'UNIT  = gal(cm/s/s),,,,,,,',
    'INITIAL TIME = 2026 1 2 3 4 5.0',
    'NS,EW,UD',
    '1,2,3',
    '4,5,6',
  ].join('\n'));

  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.warnings.length, 0);
});

test('JMA parser accepts archived two-digit years and trailing empty CSV columns', () => {
  const parsed = parseJmaStrongMotionFile('H1171931.csv', [
    'SITE CODE = H117 Test Station,34.6,135.0,16.0,7.3',
    'SAMPLING RATE = 50Hz',
    'UNIT  = gal(cm/s/s),,,,,,,',
    'INITIAL TIME = 95 01 17 05 47 31',
    'NS,EW,UD,,,,,',
    '0,0.03,0,,,,,',
    '0.01,0.04,-0.01,,,,,',
  ].join('\n'));

  assert.equal(parsed.records.length, 3);
  parsed.records.forEach((record) => {
    assert.equal(record.values.length, 2);
    assert.equal(record.metadata.recordTime, '1995-01-17 05:47:31');
  });
  assert.equal(parsed.warnings.length, 0);
});

test('JMA parser rejects a row with a missing component sample', () => {
  const parsed = parseJmaStrongMotionFile('broken-jma.csv', [
    'SITE CODE = 999 Test Station,35.0,139.0,10.0,5.0',
    'LAT. = 35.1',
    'LON. = 139.1',
    'SAMPLING RATE = 100Hz',
    'UNIT = gal',
    'INITIAL TIME = 2026 1 2 3 4 5.0',
    'NS,EW,UD',
    '1,,3',
    '4,5,6',
  ].join('\n'));

  assert.equal(parsed.records.length, 0);
  assert.ok(parsed.warnings.some((warning) => /missing|invalid/i.test(warning)));
});

test('JMA parser rejects an unknown acceleration unit', () => {
  const parsed = parseJmaStrongMotionFile('unknown-unit.csv', [
    'SITE CODE = 999 Test Station,35.0,139.0,10.0,5.0',
    'SAMPLING RATE = 100Hz',
    'UNIT = furlong/hour²',
    'INITIAL TIME = 2026 1 2 3 4 5.0',
    'NS,EW,UD',
    '1,2,3',
    '4,5,6',
  ].join('\n'));

  assert.equal(parsed.records.length, 0);
  assert.ok(parsed.warnings.some((warning) => /unit/i.test(warning)));
});

test('particle orbit resamples components to a shared time grid', () => {
  const orbits = computeParticleOrbits([
    derivedWaveform({ id: 'ew', component: 'EW', values: [0, 0.02, 0.04], dt: 0.02 }),
    derivedWaveform({ id: 'ns', component: 'NS', values: [0, 0.1, 0.2, 0.3, 0.4], dt: 0.01 }),
  ], 'EW_NS', 'acceleration');

  assert.equal(orbits.length, 1);
  assert.equal(orbits[0].time.length, 5);
  assert.ok(maxAbsoluteDifference(orbits[0].time, [0, 0.01, 0.02, 0.03, 0.04]) < 1e-12);
  assert.ok(maxAbsoluteDifference(orbits[0].x, [0, 0.01, 0.02, 0.03, 0.04]) < 1e-12);
  assert.ok(maxAbsoluteDifference(orbits[0].y, [0, 0.1, 0.2, 0.3, 0.4]) < 1e-12);
});

test('particle orbit aligns different record start times on their physical overlap', () => {
  const orbits = computeParticleOrbits([
    derivedWaveform({
      id: 'ew-offset',
      component: 'EW',
      values: [0, 1, 2, 3],
      dt: 1,
      recordTime: '2026-01-01 00:00:00',
      originTime: '2026-01-01 00:00:00',
    }),
    derivedWaveform({
      id: 'ns-offset',
      component: 'NS',
      values: [10, 15, 20, 25, 30],
      dt: 0.5,
      recordTime: '2026-01-01 00:00:01',
      originTime: '2026-01-01 00:00:00',
    }),
  ], 'EW_NS', 'acceleration');

  assert.equal(orbits.length, 1);
  assert.ok(maxAbsoluteDifference(orbits[0].time, [1, 1.5, 2, 2.5, 3]) < 1e-12);
  assert.ok(maxAbsoluteDifference(orbits[0].x, [1, 1.5, 2, 2.5, 3]) < 1e-12);
  assert.ok(maxAbsoluteDifference(orbits[0].y, [10, 15, 20, 25, 30]) < 1e-12);
});

test('particle orbit keeps different events at one station separated', () => {
  const eventA = '2026-01-01 00:00:00';
  const eventB = '2026-01-02 00:00:00';
  const orbits = computeParticleOrbits([
    derivedWaveform({ id: 'a-ew', component: 'EW', values: [90, 90, 90], originTime: eventA }),
    derivedWaveform({ id: 'b-ns', component: 'NS', values: [0, 1, 2], originTime: eventB }),
    derivedWaveform({ id: 'b-ew', component: 'EW', values: [0, 10, 20], originTime: eventB }),
  ], 'EW_NS', 'acceleration');

  assert.equal(orbits.length, 1);
  assert.deepEqual(orbits[0].x, [0, 10, 20]);
  assert.deepEqual(orbits[0].y, [0, 1, 2]);
});

test('particle orbit ignores duplicate components outside the selected projection', () => {
  const orbits = computeParticleOrbits([
    derivedWaveform({ id: 'ew', component: 'EW', values: [0, 10, 20] }),
    derivedWaveform({ id: 'ns', component: 'NS', values: [0, 1, 2] }),
    derivedWaveform({ id: 'ud-a', component: 'UD', values: [0, 3, 6] }),
    derivedWaveform({ id: 'ud-b', component: 'UD', values: [0, 4, 8] }),
  ], 'EW_NS', 'acceleration');

  assert.equal(orbits.length, 1);
  assert.deepEqual(orbits[0].x, [0, 10, 20]);
  assert.deepEqual(orbits[0].y, [0, 1, 2]);
});

test('pseudo spectral velocity equals circular frequency times spectral displacement', () => {
  const dt = 0.01;
  const acceleration = Array.from({ length: 1200 }, (_, index) => {
    const time = index * dt;
    return 80 * Math.sin(2 * Math.PI * 1.2 * time) * Math.exp(-0.12 * time);
  });
  const periods = [0.25, 0.5, 1, 2];
  const spectrum = computeSingleResponseSpectrum(acceleration, dt, periods, 0.05);

  spectrum.forEach((point) => {
    const expected = (2 * Math.PI / point.period) * point.sd;
    assert.ok(Math.abs(point.psv - expected) < Math.max(1e-12, Math.abs(expected) * 1e-12));
  });
});

test('response spectrum captures oscillator peaks between coarse input samples', () => {
  const coarse = [100, 100, 0];
  const fine = Array.from({ length: 201 }, (_, index) => (
    index <= 100 ? 100 : 100 * (200 - index) / 100
  ));
  const coarsePoint = computeSingleResponseSpectrum(coarse, 1, [1], 0)[0];
  const finePoint = computeSingleResponseSpectrum(fine, 0.01, [1], 0)[0];
  const expectedSd = 200 / ((2 * Math.PI) ** 2);

  assert.ok(Math.abs(coarsePoint.sd - expectedSd) < 1e-10);
  assert.ok(Math.abs(coarsePoint.psa - 200) < 1e-10);
  assert.ok(Math.abs(coarsePoint.sd - finePoint.sd) < 1e-10);
  assert.ok(Math.abs(coarsePoint.psa - finePoint.psa) < 1e-8);
});

test('response spectrum resolves high-damping peaks inside each input interval', () => {
  const coarseAcceleration = [0, 100, -50, 0];
  const subdivisions = 100;
  const fineAcceleration = refinePiecewiseLinear(coarseAcceleration, subdivisions);
  const coarsePoint = computeSingleResponseSpectrum(coarseAcceleration, 0.05, [1], 0.99)[0];
  const finePoint = computeSingleResponseSpectrum(fineAcceleration, 0.05 / subdivisions, [1], 0.99)[0];

  assert.ok(Math.abs(coarsePoint.sd - finePoint.sd) / finePoint.sd < 0.02);
  assert.ok(Math.abs(coarsePoint.psa - finePoint.psa) / finePoint.psa < 0.02);
});

test('response spectrum omits unsupported periods instead of looping or underestimating silently', () => {
  const spectrum = computeSingleResponseSpectrum([100, 100, 0], 1, [0.001, 1e9, Infinity, 1], 0);

  assert.equal(Number.isNaN(spectrum[0].psa), true);
  assert.equal(Number.isNaN(spectrum[1].psa), true);
  assert.equal(Number.isNaN(spectrum[2].psa), true);
  assert.ok(Number.isFinite(spectrum[3].psa));
  assert.deepEqual(computeSingleResponseSpectrum([0, 1, 0], Number.NaN, [1], 0.05), []);

  const generated = generateLogPeriods(0.02, Infinity, Infinity);
  assert.equal(generated.length, 500);
  assert.ok(generated.every((period) => Number.isFinite(period) && period <= 100));
});

test('response spectrum includes the free-vibration peak after the record ends', () => {
  const short = computeSingleResponseSpectrum([0, 100, 0], 0.01, [1], 0.05)[0];
  const explicitlyPadded = computeSingleResponseSpectrum(
    [0, 100, 0, ...Array(200).fill(0)],
    0.01,
    [1],
    0.05,
  )[0];

  assert.ok(short.sd > 0.1);
  assert.ok(Math.abs(short.sd - explicitlyPadded.sd) / explicitlyPadded.sd < 0.001);
  assert.ok(Math.abs(short.psa - explicitlyPadded.psa) / explicitlyPadded.psa < 0.001);
});

test('zero acceleration produces zero response at every period', () => {
  const spectrum = computeSingleResponseSpectrum(Array(500).fill(0), 0.01, [0.1, 1, 5], 0.05);
  spectrum.forEach((point) => {
    assert.equal(point.sd, 0);
    assert.equal(point.psv, 0);
    assert.equal(point.psa, 0);
  });
});
