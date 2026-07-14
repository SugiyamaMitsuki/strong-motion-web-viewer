const test = require('node:test');
const assert = require('node:assert/strict');

const { fftComplex } = require('../.test-dist/src/analysis/fft.js');
const {
  computeFourierAnalysis,
  computeFourierSpectrum,
  parzenWindowWeight,
  smoothFourierSpectrumKonnoOhmachi,
  smoothFourierSpectrumParzen,
} = require('../.test-dist/src/analysis/fourier.js');
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
const {
  computeDominantWaveletRidge,
  computeMorletWavelet,
  waveletMagnitudeToDecibels,
} = require('../.test-dist/src/analysis/wavelet.js');
const { parseJmaStrongMotionFile } = require('../.test-dist/src/parsers/jma.js');
const { downsampleExtrema, downsampleSegments } = require('../.test-dist/src/visualization/downsample.js');
const {
  journalRasterSize,
  millimetresToPixels,
  pointsToUserUnits,
  userUnitsToPoints,
} = require('../.test-dist/src/visualization/journal.js');
const {
  alignWaveformTimes,
  buildWaveformRecordSets,
} = require('../.test-dist/src/visualization/waveformGroups.js');
const {
  resolveSvgPhysicalSize,
  setPngResolutionMetadata,
} = require('../.test-dist/src/export/exportImage.js');

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

function minimalPngHeader() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  return bytes;
}

function pngChunks(bytes) {
  const chunks = [];
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length);
    chunks.push({
      offset,
      length,
      type: String.fromCharCode(...bytes.slice(offset + 4, offset + 8)),
    });
    offset = end;
  }
  assert.equal(offset, bytes.length);
  return chunks;
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

test('Fourier spectra do not apply a hidden frequency taper by default', () => {
  const dt = 0.01;
  const values = Array.from({ length: 1024 }, (_, index) => Math.sin(2 * Math.PI * 25 * index * dt));
  const plain = computeFourierSpectrum(values, dt, 'cm/s²');
  const tapered = computeFourierSpectrum(values, dt, 'cm/s²', { applyFrequencyTaper: true });
  const index = plain.frequency.reduce(
    (best, frequency, candidate) => Math.abs(frequency - 25) < Math.abs(plain.frequency[best] - 25) ? candidate : best,
    0,
  );

  assert.ok(plain.amplitude[index] > tapered.amplitude[index] * 1.8);
});

test('Fourier analysis reports its positive-frequency scaling and physical frequency limits', () => {
  const dt = 0.02;
  const values = Array.from({ length: 1000 }, (_, index) => Math.cos(2 * Math.PI * 2.5 * index * dt));
  const result = computeFourierAnalysis(values, dt, 'cm/s²', {
    applyFrequencyTaper: false,
    applyTimeTaper: true,
    timeTaperFraction: 0.05,
  });

  assert.equal(result.metadata.sampleCount, 1000);
  assert.equal(result.metadata.recordDurationSec, 20);
  assert.equal(result.metadata.independentResolutionHz, 0.05);
  assert.equal(result.metadata.nyquistFrequencyHz, 25);
  assert.equal(result.metadata.timeWindow, 'cosine-edge-taper');
  assert.equal(result.metadata.timeTaperFraction, 0.05);
  assert.equal(result.metadata.sidedness, 'positive-frequency-half-spectrum');
  assert.equal(result.metadata.amplitudeNormalization, 'absolute-dft-times-dt');
  assert.equal(result.metadata.oneSidedFactor, 1);
  assert.equal(result.metadata.windowGainCorrected, false);
  assert.ok(result.metadata.windowCoherentGain > 0.89 && result.metadata.windowCoherentGain < 0.96);
  assert.equal(result.spectrum.frequency[0], result.metadata.fftBinSpacingHz);
  assert.equal(result.spectrum.frequency.at(-1), 25);
  assert.ok(Number.isFinite(result.metadata.dcAmplitude));
});

test('Fourier amplitude uses the documented |DFT| times dt normalization', () => {
  const dt = 0.01;
  const sampleCount = 1024;
  const amplitude = 3;
  const cycleCount = 52;
  const frequencyHz = cycleCount / (sampleCount * dt);
  const values = Array.from(
    { length: sampleCount },
    (_, index) => amplitude * Math.cos(2 * Math.PI * frequencyHz * index * dt),
  );
  const result = computeFourierAnalysis(values, dt, 'cm/s²', {
    applyFrequencyTaper: false,
    applyTimeTaper: false,
  });
  const bin = result.spectrum.frequency.findIndex((value) => Math.abs(value - frequencyHz) < 1e-12);

  assert.ok(bin >= 0);
  assert.ok(Math.abs(result.spectrum.amplitude[bin] - amplitude * sampleCount * dt / 2) < 1e-11);
  assert.ok(result.metadata.dcAmplitude < 1e-12);
});

function referenceParzenCircular(amplitude, dcAmplitude, df, bandwidthHz) {
  const half = amplitude.length;
  const n = half * 2;
  const power = Array(n).fill(0);
  power[0] = dcAmplitude ** 2;
  for (let k = 1; k < half; k += 1) {
    power[k] = amplitude[k - 1] ** 2;
    power[n - k] = power[k];
  }
  power[half] = amplitude[half - 1] ** 2;
  const u = 280 / (151 * bandwidthHz);
  const kernel = Array.from({ length: n }, (_, index) => {
    const signedBin = index <= half ? index : index - n;
    const argument = Math.PI * u * Math.abs(signedBin * df) / 2;
    const sinc = argument < 1e-12 ? 1 : Math.sin(argument) / argument;
    return (3 * u / 4) * sinc ** 4 * df;
  });
  const kernelSum = kernel.reduce((sum, value) => sum + value, 0);
  const normalized = kernel.map((value) => value / kernelSum);
  const smoothedPower = Array.from({ length: n }, (_, target) => power.reduce(
    (sum, value, source) => sum + value * normalized[(target - source + n) % n],
    0,
  ));
  return {
    amplitude: Array.from({ length: half }, (_, index) => Math.sqrt(smoothedPower[index + 1])),
    smoothedPower,
    normalized,
    power,
  };
}

test('Parzen window uses the ViewWave bandwidth definition in Hz', () => {
  const bandwidthHz = 0.1;
  const u = 280 / (151 * bandwidthHz);
  const firstZero = 2 / u;

  assert.ok(Math.abs(parzenWindowWeight(0, bandwidthHz) - 3 * u / 4) < 1e-12);
  assert.ok(parzenWindowWeight(firstZero, bandwidthHz) < 1e-55);
  assert.equal(parzenWindowWeight(0, 0), 0);
});

test('Parzen smoothing is a normalized circular convolution of squared amplitude', () => {
  const df = 0.05;
  const frequency = Array.from({ length: 8 }, (_, index) => (index + 1) * df);
  const amplitude = [0.4, 1, 3, 0.8, 1.7, 0.2, 2.2, 0.6];
  const dcAmplitude = 0.3;
  const bandwidthHz = 0.2;
  const reference = referenceParzenCircular(amplitude, dcAmplitude, df, bandwidthHz);
  const actual = smoothFourierSpectrumParzen(
    { frequency, amplitude, unit: 'cm/s' },
    { bandwidthHz, dcAmplitude },
  );

  assert.deepEqual(actual.frequency, frequency);
  assert.ok(maxAbsoluteDifference(actual.amplitude, reference.amplitude) < 2e-12);
  assert.equal(actual.smoothing.domain, 'squared-amplitude-power');
  assert.equal(actual.smoothing.outputGrid, 'original-positive-fft-bin-grid');
  const target = 3;
  const n = amplitude.length * 2;
  const twoSidedAmplitude = reference.power.map((value) => Math.sqrt(value));
  const incorrectlyAveragedAmplitude = twoSidedAmplitude.reduce(
    (sum, value, source) => sum + value * reference.normalized[(target - source + n) % n],
    0,
  );
  assert.ok(Math.abs(actual.amplitude[target - 1] - incorrectlyAveragedAmplitude) > 1e-3);
});

test('Parzen smoothing preserves constants and total two-sided power', () => {
  const df = 0.01;
  const constant = 7.5;
  const frequency = Array.from({ length: 512 }, (_, index) => (index + 1) * df);
  const actual = smoothFourierSpectrumParzen(
    { frequency, amplitude: frequency.map(() => constant), unit: 'cm/s' },
    { bandwidthHz: 0.1, dcAmplitude: constant },
  );

  assert.ok(actual.amplitude.every((value) => Math.abs(value - constant) < 2e-11));
  assert.ok(Math.abs(actual.smoothing.smoothedDcAmplitude - constant) < 2e-11);
  assert.ok(actual.smoothing.relativePowerConservationError < 2e-12);
  assert.equal(actual.smoothing.bandwidthHz, 0.1);
  assert.ok(Math.abs(actual.smoothing.bandwidthParameterUSeconds - 280 / 15.1) < 1e-12);
  assert.ok(Math.abs(actual.smoothing.firstZeroOffsetHz - 151 * 0.1 / 140) < 1e-12);
});

test('Parzen smoothing treats isolated DC and Nyquist power like direct two-sided convolution', () => {
  const df = 0.02;
  const frequency = Array.from({ length: 64 }, (_, index) => (index + 1) * df);
  const cases = [
    { amplitude: frequency.map(() => 0), dcAmplitude: 5 },
    { amplitude: frequency.map((_, index) => index === frequency.length - 1 ? 5 : 0), dcAmplitude: 0 },
  ];

  cases.forEach(({ amplitude, dcAmplitude }) => {
    const reference = referenceParzenCircular(amplitude, dcAmplitude, df, 0.1);
    const actual = smoothFourierSpectrumParzen(
      { frequency, amplitude, unit: 'cm/s' },
      { bandwidthHz: 0.1, dcAmplitude },
    );
    assert.ok(maxAbsoluteDifference(
      actual.amplitude.map((value) => value ** 2),
      reference.smoothedPower.slice(1, frequency.length + 1),
    ) < 2e-12);
    assert.ok(Math.abs(actual.smoothing.smoothedDcAmplitude ** 2 - reference.smoothedPower[0]) < 2e-12);
    assert.ok(actual.smoothing.relativePowerConservationError < 2e-12);
  });
});

test('Parzen zero width returns raw ordinates and amplitude scaling remains linear', () => {
  const frequency = Array.from({ length: 16 }, (_, index) => (index + 1) * 0.1);
  const amplitude = frequency.map((value, index) => 0.2 + value + (index % 3));
  const raw = smoothFourierSpectrumParzen(
    { frequency, amplitude, unit: 'cm/s' },
    { bandwidthHz: 0, dcAmplitude: 0.25 },
  );
  const original = smoothFourierSpectrumParzen(
    { frequency, amplitude, unit: 'cm/s' },
    { bandwidthHz: 0.2, dcAmplitude: 0.25 },
  );
  const scaled = smoothFourierSpectrumParzen(
    { frequency, amplitude: amplitude.map((value) => value * 4), unit: 'cm/s' },
    { bandwidthHz: 0.2, dcAmplitude: 1 },
  );

  assert.deepEqual(raw.amplitude, amplitude);
  assert.equal(raw.smoothing.applied, false);
  assert.ok(maxAbsoluteDifference(scaled.amplitude, original.amplitude.map((value) => value * 4)) < 2e-12);
});

test('Konno-Ohmachi smoothing preserves a constant spectrum on a log-frequency grid', () => {
  const frequency = Array.from({ length: 4000 }, (_, index) => 0.01 + index * 0.025);
  const spectrum = { frequency, amplitude: frequency.map(() => 7.5), unit: 'cm/s' };
  const smoothed = smoothFourierSpectrumKonnoOhmachi(spectrum, {
    bandwidth: 40,
    minFrequencyHz: 0.05,
    maxFrequencyHz: 50,
    outputCount: 181,
  });

  assert.equal(smoothed.frequency.length, 181);
  assert.equal(smoothed.amplitude.length, 181);
  assert.ok(Math.abs(smoothed.frequency[0] - 0.05) < 1e-12);
  assert.ok(Math.abs(smoothed.frequency.at(-1) - 50) < 1e-10);
  assert.ok(smoothed.amplitude.every((value) => Math.abs(value - 7.5) < 1e-10));
  assert.equal(smoothed.smoothing.method, 'Konno-Ohmachi');
  assert.equal(smoothed.smoothing.bandwidth, 40);
});

test('Konno-Ohmachi smoothing uses the published fourth-power log-frequency kernel', () => {
  const spectrum = { frequency: [1, 2, 4], amplitude: [2, 5, 11], unit: 'cm/s' };
  const bandwidth = 10;
  const centre = 2;
  const weights = spectrum.frequency.map((frequency) => {
    const argument = bandwidth * Math.log10(frequency / centre);
    const ratio = Math.abs(argument) < 1e-12 ? 1 : Math.sin(argument) / argument;
    return ratio ** 4;
  });
  const expected = spectrum.amplitude.reduce((sum, value, index) => sum + value * weights[index], 0)
    / weights.reduce((sum, value) => sum + value, 0);
  const smoothed = smoothFourierSpectrumKonnoOhmachi(spectrum, {
    bandwidth,
    minFrequencyHz: centre,
    maxFrequencyHz: centre,
    outputCount: 2,
  });

  assert.equal(smoothed.frequency.length, 1);
  assert.ok(Math.abs(smoothed.amplitude[0] - expected) < 1e-12);
});

test('Konno-Ohmachi smoothing suppresses isolated raw-bin spikes without shifting the peak band', () => {
  const frequency = Array.from({ length: 5000 }, (_, index) => 0.01 + index * 0.01);
  const amplitude = frequency.map((value) => 1 + 9 * Math.exp(-((Math.log(value / 5) / 0.08) ** 2)));
  const spikeIndex = frequency.findIndex((value) => value >= 16);
  amplitude[spikeIndex] = 1000;
  const smoothed = smoothFourierSpectrumKonnoOhmachi(
    { frequency, amplitude, unit: 'cm/s' },
    { bandwidth: 40, minFrequencyHz: 0.1, maxFrequencyHz: 30, outputCount: 360 },
  );
  const smoothSpikeIndex = smoothed.frequency.reduce(
    (best, value, index) => Math.abs(value - 16) < Math.abs(smoothed.frequency[best] - 16) ? index : best,
    0,
  );
  const physicalPeakIndex = smoothed.frequency.reduce(
    (best, value, index) => Math.abs(value - 5) < Math.abs(smoothed.frequency[best] - 5) ? index : best,
    0,
  );

  assert.ok(smoothed.amplitude[smoothSpikeIndex] < 100);
  assert.ok(smoothed.amplitude[physicalPeakIndex] > 7);
  assert.ok(smoothed.frequency.every((value, index) => index === 0 || value > smoothed.frequency[index - 1]));
});

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

test('figure decimation preserves narrow positive and negative pulses', () => {
  const x = Array.from({ length: 10000 }, (_, index) => index * 0.01);
  const y = Array(10000).fill(0);
  y[5432] = 127.5;
  y[6789] = -91.25;

  const sampled = downsampleExtrema(x, y, 240);
  assert.ok(sampled.x.length <= 240);
  assert.ok(sampled.y.includes(127.5));
  assert.ok(sampled.y.includes(-91.25));
  assert.equal(sampled.x[0], x[0]);
  assert.equal(sampled.x[sampled.x.length - 1], x[x.length - 1]);
});

test('figure decimation splits invalid gaps before sampling', () => {
  const segments = downsampleSegments(
    [0, 1, 2, 3, 4, 5],
    [0, 1, Number.NaN, 3, 4, 5],
    4,
  );

  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { x: [0, 1], y: [0, 1] });
  assert.deepEqual(segments[1], { x: [3, 5], y: [3, 5] });
  assert.equal(segments.reduce((sum, segment) => sum + segment.x.length, 0), 4);
});

test('figure decimation enforces one total budget across many finite segments', () => {
  const x = [];
  const y = [];
  for (let segment = 0; segment < 12; segment += 1) {
    x.push(segment * 2, segment * 2 + 0.5, segment * 2 + 1);
    y.push(segment, segment + 0.25, segment + 0.5);
    if (segment < 11) {
      x.push(segment * 2 + 1.5);
      y.push(Number.NaN);
    }
  }

  const budget = 17;
  const segments = downsampleSegments(x, y, budget);
  assert.ok(segments.length > 1);
  assert.ok(segments.reduce((sum, segment) => sum + segment.x.length, 0) <= budget);

  const fragmented = downsampleSegments(
    Array.from({ length: 39 }, (_, index) => index),
    Array.from({ length: 39 }, (_, index) => index % 2 === 0 ? index : Number.NaN),
    5,
  );
  assert.equal(fragmented.reduce((sum, segment) => sum + segment.x.length, 0), 5);
});

test('L2-normalized Morlet coefficients report input units multiplied by square-root seconds', () => {
  const dt = 0.02;
  const values = Array.from({ length: 128 }, (_, index) => Math.sin(2 * Math.PI * index * dt));
  const result = computeMorletWavelet(values, dt, 'cm/s²', {
    minFrequency: 0.5,
    maxFrequency: 5,
    frequencyCount: 8,
    maxSamples: 128,
  });

  assert.equal(result.inputUnit, 'cm/s²');
  assert.equal(result.unit, 'cm/s²·√s');
  assert.equal(result.normalization, 'L2');
  assert.ok(result.amplitude.length > 0);
  assert.equal(result.resampling.applied, false);
});

function centralWaveletPeak(result) {
  const start = Math.floor(result.time.length * 0.15);
  const end = Math.ceil(result.time.length * 0.85);
  let peak = { amplitude: 0, frequency: Number.NaN };
  result.amplitude.forEach((row, frequencyIndex) => {
    for (let timeIndex = start; timeIndex < end; timeIndex += 1) {
      if (row[timeIndex] > peak.amplitude) {
        peak = { amplitude: row[timeIndex], frequency: result.frequency[frequencyIndex] };
      }
    }
  });
  return peak;
}

test('wavelet downsampling suppresses aliases and records its anti-alias design', () => {
  const dt = 0.001;
  const sampleCount = 10000;
  const maxSamples = 4096;
  const options = { minFrequency: 1, maxFrequency: 10, frequencyCount: 36, maxSamples };
  const highFrequency = 405;
  const duration = (sampleCount - 1) * dt;
  const effectiveSamplingHz = (maxSamples - 1) / duration;
  const aliasedFrequency = Math.abs(highFrequency - effectiveSamplingHz);
  const high = computeMorletWavelet(
    Array.from({ length: sampleCount }, (_, index) => Math.sin(2 * Math.PI * highFrequency * index * dt)),
    dt,
    'cm/s²',
    options,
  );
  const aliasReference = computeMorletWavelet(
    Array.from({ length: sampleCount }, (_, index) => Math.sin(2 * Math.PI * aliasedFrequency * index * dt)),
    dt,
    'cm/s²',
    options,
  );
  const highPeak = centralWaveletPeak(high);
  const aliasPeak = centralWaveletPeak(aliasReference);

  assert.equal(high.resampling.applied, true);
  assert.equal(high.resampling.method, 'Kaiser-windowed sinc polyphase anti-alias resampling');
  assert.equal(high.resampling.inputSamples, sampleCount);
  assert.equal(high.resampling.computedSamples, maxSamples);
  assert.ok(high.resampling.passbandEndHz < high.resampling.stopbandStartHz);
  assert.ok(highPeak.amplitude < aliasPeak.amplitude * 0.01);
});

test('wavelet anti-alias resampling preserves an in-band sinusoid', () => {
  const dt = 0.001;
  const sampleCount = 10000;
  const values = Array.from({ length: sampleCount }, (_, index) => Math.sin(2 * Math.PI * 4 * index * dt));
  const common = { minFrequency: 1, maxFrequency: 10, frequencyCount: 36 };
  const full = computeMorletWavelet(values, dt, 'cm/s²', { ...common, maxSamples: sampleCount });
  const reduced = computeMorletWavelet(values, dt, 'cm/s²', { ...common, maxSamples: 4096 });
  const fullPeak = centralWaveletPeak(full);
  const reducedPeak = centralWaveletPeak(reduced);
  const adjacentLogRatio = (10 / 1) ** (1 / (common.frequencyCount - 1));

  assert.ok(Math.max(fullPeak.frequency, reducedPeak.frequency) / Math.min(fullPeak.frequency, reducedPeak.frequency) <= adjacentLogRatio * 1.001);
  assert.ok(Math.abs(reducedPeak.amplitude / fullPeak.amplitude - 1) < 0.05);
});

test('wavelet magnitude decibels use an explicit reusable amplitude reference', () => {
  assert.equal(waveletMagnitudeToDecibels(1, 1), 0);
  assert.ok(Math.abs(waveletMagnitudeToDecibels(10, 1) - 20) < 1e-12);
  assert.ok(Math.abs(waveletMagnitudeToDecibels(0.1, 1) + 20) < 1e-12);
  assert.equal(waveletMagnitudeToDecibels(0, 1), Number.NEGATIVE_INFINITY);
  assert.equal(waveletMagnitudeToDecibels(1, 0), Number.NEGATIVE_INFINITY);
});

test('descriptive wavelet ridge selects per-time maxima only inside the cone of influence', () => {
  const ridge = computeDominantWaveletRidge({
    time: [0, 1, 2, 3, 4],
    frequency: [1, 2],
    amplitude: [
      [100, 4, 3, 2, 100],
      [100, 2, 5, 1, 100],
    ],
    inputUnit: 'cm/s²',
    unit: 'cm/s²·√s',
    normalization: 'L2',
    effectiveDt: 1,
    inputSamples: 5,
    computedSamples: 5,
  }, {
    morletOmega0: 2,
    excludeOutsideConeOfInfluence: true,
  });

  assert.ok(Number.isNaN(ridge.frequency[0]));
  assert.deepEqual(ridge.frequency.slice(1, 4), [1, 2, 1]);
  assert.deepEqual(ridge.amplitude.slice(1, 4), [4, 5, 2]);
  assert.ok(Number.isNaN(ridge.frequency[4]));

  const zeroRidge = computeDominantWaveletRidge({
    time: [0, 1],
    frequency: [1],
    amplitude: [[0, 0]],
    inputUnit: 'cm/s²',
    unit: 'cm/s²·√s',
    normalization: 'L2',
    effectiveDt: 1,
    inputSamples: 2,
    computedSamples: 2,
  }, { excludeOutsideConeOfInfluence: false });
  assert.ok(zeroRidge.frequency.every(Number.isNaN));
});

test('publication SVG sizing preserves aspect ratio and accepts exact A4 dimensions', () => {
  const defaultSize = resolveSvgPhysicalSize(900, 430);
  assert.equal(defaultSize.widthMm, 180);
  assert.ok(Math.abs(defaultSize.heightMm - 180 * 430 / 900) < 1e-12);
  assert.deepEqual(resolveSvgPhysicalSize(1120, 1584, { widthMm: 210, heightMm: 297 }), {
    widthMm: 210,
    heightMm: 297,
  });
  assert.deepEqual(resolveSvgPhysicalSize(980, 620, { heightMm: 100 }), {
    widthMm: 100 * 980 / 620,
    heightMm: 100,
  });
});

test('journal line-art preset resolves physical size, pixels, and final typography', () => {
  assert.equal(millimetresToPixels(80, 800), 2520);
  assert.equal(millimetresToPixels(180, 800), 5669);
  assert.deepEqual(journalRasterSize(1000, 600, 180, 800), {
    widthPx: 5669,
    heightPx: 3401,
  });

  const eightPointUnits = pointsToUserUnits(8, 1000, 180);
  assert.ok(Math.abs(userUnitsToPoints(eightPointUnits, 1000, 180) - 8) < 1e-12);
  assert.ok(userUnitsToPoints(eightPointUnits, 1000, 180) >= 6);
});

test('journal figures keep separate events out of a shared time axis', () => {
  const firstEvent = derivedWaveform({
    id: 'event-a-ns',
    component: 'NS',
    values: [0, 1],
    originTime: '2026-01-01 00:00:00',
  });
  const secondEvent = derivedWaveform({
    id: 'event-b-ns',
    component: 'NS',
    values: [0, 2],
    originTime: '2026-01-02 00:00:00',
  });

  const groups = buildWaveformRecordSets([firstEvent, secondEvent]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.waveforms.map((waveform) => waveform.sourceRecordId)), [
    ['event-a-ns'],
    ['event-b-ns'],
  ]);
});

test('journal figures align component time axes to the earliest record start', () => {
  const early = derivedWaveform({
    id: 'early',
    component: 'NS',
    values: [0, 1],
    recordTime: '2026-01-01 00:00:00',
    time: [0, 1],
  });
  const late = derivedWaveform({
    id: 'late',
    component: 'EW',
    values: [0, 1],
    recordTime: '2026-01-01 00:00:01',
    time: [0, 1],
  });

  const alignment = alignWaveformTimes([early, late]);
  assert.deepEqual(alignment.values.get('early'), [0, 1]);
  assert.deepEqual(alignment.values.get('late'), [1, 2]);
  assert.match(alignment.reference, /earliest record start/);
});

test('publication PNG export stores 300 dpi physical resolution metadata', () => {
  const output = setPngResolutionMetadata(minimalPngHeader(), 300);
  const chunks = pngChunks(output);
  const resolution = chunks.find((chunk) => chunk.type === 'pHYs');
  assert.ok(resolution);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  assert.equal(output.length, 54);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'pHYs']);
  assert.equal(view.getUint32(resolution.offset + 8, false), 11811);
  assert.equal(view.getUint32(resolution.offset + 12, false), 11811);
  assert.equal(output[resolution.offset + 16], 1);
});

test('publication PNG export replaces an existing pHYs chunk instead of duplicating it', () => {
  const with300Dpi = setPngResolutionMetadata(minimalPngHeader(), 300);
  const with600Dpi = setPngResolutionMetadata(with300Dpi, 600);
  const chunks = pngChunks(with600Dpi);
  const resolutionChunks = chunks.filter((chunk) => chunk.type === 'pHYs');
  const view = new DataView(with600Dpi.buffer, with600Dpi.byteOffset, with600Dpi.byteLength);

  assert.equal(with600Dpi.length, with300Dpi.length);
  assert.equal(resolutionChunks.length, 1);
  assert.equal(view.getUint32(resolutionChunks[0].offset + 8, false), 23622);
  assert.equal(view.getUint32(resolutionChunks[0].offset + 12, false), 23622);
});
