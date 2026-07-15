const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const {
  computeStationDistanceRows,
  sourceLocationFromRecords,
} = require('../.test-dist/src/analysis/distance.js');
const { computePlotGeometry } = require('../.test-dist/src/visualization/plotGeometry.js');
const { computeHorizontalVerticalRatios } = require('../.test-dist/src/analysis/horizontalVerticalRatio.js');
const { JournalPlatePanel } = require('../.test-dist/src/components/JournalPlatePanel.js');
const { ReportFigurePanel } = require('../.test-dist/src/components/ReportFigurePanel.js');
const { WaveletPanel } = require('../.test-dist/src/components/WaveletPanel.js');
const { FourierPanel } = require('../.test-dist/src/components/FourierPanel.js');
const { ResponseSpectrumPanel, responseDomains } = require('../.test-dist/src/components/ResponseSpectrumPanel.js');
const { StackedTimeHistoryFigure } = require('../.test-dist/src/components/StackedTimeHistoryFigure.js');
const {
  buildPublicationFigureContext,
  publicationContextCaption,
  publicationSymmetricLimit,
} = require('../.test-dist/src/visualization/publicationContext.js');
const {
  buildFigureProvenance,
  datasetLabel,
  preprocessingLabel,
} = require('../.test-dist/src/visualization/provenance.js');

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

test('publication shared ordinate retains 10 to 15 percent headroom across scales', () => {
  [0.00123, 0.091, 1, 12.34, 99.9, 1234].forEach((maximum) => {
    const limit = publicationSymmetricLimit(maximum);
    const headroom = limit / maximum - 1;
    assert.ok(headroom >= 0.1, `${maximum} has at least ten percent headroom`);
    assert.ok(headroom <= 0.15, `${maximum} has no more than fifteen percent headroom`);
  });
  assert.equal(publicationSymmetricLimit(Number.NaN), 1);
  assert.equal(publicationSymmetricLimit(0), 1);
});

test('publication context records station, event and preprocessing provenance', () => {
  const waveform = {
    sourceRecordId: 'context-ns',
    fileName: 'context.NS',
    component: 'NS',
    componentLabel: 'NS',
    dt: 0.01,
    samplingHz: 100,
    time: [0, 0.01],
    acceleration: [0, 1],
    velocity: [0, 0],
    displacement: [0, 0],
    metadata: {
      stationCode: 'TEST01',
      stationLat: 35,
      stationLon: 139,
      originTime: '2026/01/01 00:00:00',
      magnitude: 6.5,
      eventLat: 35.2,
      eventLon: 139.3,
      depthKm: 12,
    },
  };
  const context = buildPublicationFigureContext([waveform], 'mean removal; 0.1 Hz high-pass');
  assert.deepEqual(context.stations, ['TEST01 (35.0000\u00b0N, 139.0000\u00b0E)']);
  assert.ok(context.events[0].includes('2026/01/01 00:00:00'));
  assert.equal(context.preprocessing, 'mean removal; 0.1 Hz high-pass');
  const caption = publicationContextCaption(context);
  assert.match(caption, /Station: TEST01/);
  assert.match(caption, /Event: 2026\/01\/01/);
  assert.match(caption, /Preprocessing: mean removal/);
});

test('figure provenance preserves the exact derived-waveform preprocessing recipe', () => {
  const waveform = publicationWaveform('NS');
  const provenance = buildFigureProvenance([waveform]);
  assert.equal(provenance.schema, 'strong-motion-figure-provenance/1.0');
  assert.deepEqual(provenance.records.sourceFiles, ['plate.NS']);
  assert.deepEqual(provenance.records.stationCodes, ['PLATE01']);
  assert.deepEqual(provenance.records.components, ['NS']);
  assert.deepEqual(provenance.records.samplingRatesHz, [50]);
  assert.deepEqual(provenance.preprocessing, waveform.preprocessing);
  assert.match(preprocessingLabel(waveform.preprocessing), /mean removed/);
  assert.match(preprocessingLabel(waveform.preprocessing), /FFT cosine HP 0\.1 Hz/);
  assert.match(datasetLabel([waveform]), /station PLATE01/);
  assert.match(datasetLabel([waveform]), /50 Hz/);
});

function publicationWaveform(component, phase = 0) {
  const dt = 0.02;
  const sampleCount = 240;
  const time = Array.from({ length: sampleCount }, (_, index) => index * dt);
  const acceleration = time.map((value) => 80 * Math.sin(2 * Math.PI * 2 * value + phase) * Math.exp(-value / 3));
  return {
    sourceRecordId: `plate-${component}`,
    fileName: `plate.${component}`,
    component,
    componentLabel: component,
    dt,
    samplingHz: 1 / dt,
    time,
    acceleration,
    velocity: acceleration.map(() => 0),
    displacement: acceleration.map(() => 0),
    metadata: {
      stationCode: 'PLATE01',
      stationLat: 35,
      stationLon: 139,
      originTime: '2026/01/01 00:00:00',
      eventLat: 35.2,
      eventLon: 139.3,
      depthKm: 12,
    },
    preprocessing: {
      removeMean: true,
      detrend: true,
      applyHighpass: true,
      highpassHz: 0.1,
      applyLowpass: false,
      lowpassHz: 20,
      correctIntegrationDrift: true,
    },
  };
}

function significantDigitCount(label) {
  return label
    .toLowerCase()
    .split('e')[0]
    .replace(/[+\-.]/g, '')
    .replace(/^0+/, '')
    .length;
}

test('journal composite renders PGA, response peaks and reproducibility metadata', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const responseSettings = { dampingRatio: 0.05, minPeriod: 0.05, maxPeriod: 3, periodCount: 36 };
  const markup = renderToStaticMarkup(React.createElement(JournalPlatePanel, { waveforms, responseSettings }));
  assert.match(markup, /PGA =/);
  assert.match(markup, /Sa =/);
  assert.match(markup, /panelWidthRatio/);
  assert.match(markup, /mean removed/);
  assert.match(markup, /Methods · JSON/);

  assert.match(markup, /data-response-legend-placement="outside-plot"/);
  const legendBottom = Number(markup.match(/data-response-legend-bottom="([^"]+)"/)?.[1]);
  const plotTop = Number(markup.match(/data-response-plot-top="([^"]+)"/)?.[1]);
  assert.ok(Number.isFinite(legendBottom));
  assert.ok(Number.isFinite(plotTop));
  assert.ok(legendBottom < plotTop, `response legend must end above the plot (${legendBottom} < ${plotTop})`);

  const pgaLabels = [...markup.matchAll(/PGA = ([^ ]+) cm\/s² at t = ([^ ]+) s/g)];
  const responsePeakLabels = [...markup.matchAll(/T = ([^ ]+) s, Sa = ([^< ]+)/g)];
  assert.equal(pgaLabels.length, 3);
  assert.equal(responsePeakLabels.length, 3);
  pgaLabels.forEach((match) => {
    assert.ok(significantDigitCount(match[1]) <= 3, `PGA label has excess precision: ${match[1]}`);
    assert.ok((match[2].split('.')[1]?.length ?? 0) <= 2, `PGA time exceeds sample precision: ${match[2]}`);
  });
  responsePeakLabels.forEach((match) => {
    assert.ok(significantDigitCount(match[1]) <= 3, `peak period has excess precision: ${match[1]}`);
    assert.ok(significantDigitCount(match[2]) <= 3, `peak Sa has excess precision: ${match[2]}`);
  });
});

test('wavelet publication plate defaults to three corrected Morlet-6 components with shared scales', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const markup = renderToStaticMarkup(React.createElement(WaveletPanel, { waveforms }));

  assert.match(markup, /data-wavelet-layout="three-component"/);
  assert.match(markup, /data-wavelet-quantity="scale-corrected-amplitude"/);
  assert.match(markup, /data-wavelet-component-count="3"/);
  assert.match(markup, /data-wavelet-shared-time-axis="true"/);
  assert.match(markup, /data-wavelet-shared-frequency-axis="true"/);
  assert.match(markup, /data-wavelet-shared-colour-scale="true"/);
  assert.match(markup, /data-wavelet-morlet-omega0="6"/);
  assert.match(markup, /Morlet-6 Balanced/);
  assert.match(markup, /exact Fourier mapping/);
  assert.match(markup, /C\(ω₀\) \|W\| \/ √scale/);
  assert.match(markup, /strong-motion-wavelet-methods\/2\.0/);
  assert.match(markup, /one aggregate per displayed time-frequency bin containing one or more COI-valid samples/);
  assert.match(markup, /commonTimeAxis/);
  assert.match(markup, /commonFrequencyAxis/);
  assert.match(markup, /commonColourScale/);
  assert.match(markup, /plate\.NS/);
  assert.match(markup, /plate\.EW/);
  assert.match(markup, /plate\.UD/);

  const components = [...markup.matchAll(/data-wavelet-component="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(components, ['NS', 'EW', 'UD']);
  const heatmapPathCounts = [...markup.matchAll(/data-wavelet-heatmap-paths="(\d+)"/g)]
    .map((match) => Number(match[1]));
  assert.equal(heatmapPathCounts.length, 3);
  assert.ok(heatmapPathCounts.every((count) => count <= 257), `heatmap paths are bounded: ${heatmapPathCounts.join(', ')}`);
  const svgMarkup = markup.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
  const svgElementCount = (svgMarkup.match(/<(?:g|path|rect|line|text)\b/g) ?? []).length;
  assert.ok(svgElementCount < 1000, `publication SVG element count is bounded (${svgElementCount})`);
});

test('wavelet fixed-dB power mode uses a 10 log10 transform and squared physical units', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const amplitudeMarkup = renderToStaticMarkup(React.createElement(WaveletPanel, {
    waveforms,
    initialColorMode: 'fixed-db',
  }));
  const markup = renderToStaticMarkup(React.createElement(WaveletPanel, {
    waveforms,
    initialDisplayQuantity: 'rectified-power',
    initialColorMode: 'fixed-db',
  }));

  assert.match(markup, /data-wavelet-quantity="rectified-power"/);
  assert.match(markup, /data-wavelet-decibel-factor="10"/);
  assert.match(markup, /Rectified power/);
  assert.match(markup, /10\*log10\(power\/reference\)/);
  assert.match(markup, /10 log10 transform/);
  assert.match(markup, /\(cm\/s²\)²/);
  assert.doesNotMatch(markup, /20\*log10\(amplitude\/reference\)/);
  assert.match(amplitudeMarkup, /data-wavelet-decibel-factor="20"/);
  assert.match(amplitudeMarkup, /20\*log10\(amplitude\/reference\)/);
  assert.match(amplitudeMarkup, /20 log10 transform/);
  assert.doesNotMatch(amplitudeMarkup, /10\*log10\(power\/reference\)/);
});

test('wavelet plate selects one record set and preserves component start-time alignment', () => {
  const first = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)]
    .map((waveform, index) => ({
      ...waveform,
      metadata: {
        ...waveform.metadata,
        recordTime: `2026/01/01 00:00:0${index}`,
      },
    }));
  const second = first.map((waveform) => ({
    ...waveform,
    sourceRecordId: `second-${waveform.component}`,
    fileName: `second.${waveform.component}`,
    metadata: {
      ...waveform.metadata,
      stationCode: 'PLATE02',
      stationLat: 36,
      stationLon: 140,
      originTime: '2026/01/02 00:00:00',
      eventLat: 36.2,
      eventLon: 140.3,
    },
  }));
  const markup = renderToStaticMarkup(React.createElement(WaveletPanel, { waveforms: [...first, ...second] }));
  const recordSetSelect = markup.match(/Record set<select[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';

  assert.equal((recordSetSelect.match(/<option/g) ?? []).length, 2);
  assert.match(markup, /elapsed time from earliest record start/);
  assert.match(markup, /plate\.NS/);
  assert.doesNotMatch(markup, /second\.NS/);
  assert.deepEqual(
    [...markup.matchAll(/data-wavelet-component="([^"]+)"/g)].map((match) => match[1]),
    ['NS', 'EW', 'UD'],
  );
});

test('A4 report defaults to one integrated acceleration, velocity, FAS and pSv plate', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const peaks = waveforms.map((waveform) => ({
    sourceRecordId: waveform.sourceRecordId,
    fileName: waveform.fileName,
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    pga: Math.max(...waveform.acceleration.map(Math.abs)),
    pgv: 0,
    pgd: 0,
  }));
  const responseSettings = { dampingRatio: 0.03, minPeriod: 0.05, maxPeriod: 3, periodCount: 36 };
  const markup = renderToStaticMarkup(React.createElement(ReportFigurePanel, {
    waveforms,
    jmaWaveforms: waveforms,
    peaks,
    responseSettings,
  }));

  assert.equal((markup.match(/<svg\b/g) ?? []).length, 1);
  assert.match(markup, /data-report-page="integrated"/);
  assert.match(markup, /data-report-layout="acceleration-velocity-fas-tripartite"/);
  assert.match(markup, /data-report-shared-time-axis="true"/);
  assert.match(markup, /data-report-acceleration-shared-ordinate="true"/);
  assert.match(markup, /data-report-velocity-shared-ordinate="true"/);
  assert.match(markup, /data-report-panel-order="acceleration velocity Fourier-amplitude tripartite-pSv"/);
  assert.match(markup, /data-report-component-encoding="NS-vermillion-solid EW-blue-dashed UD-purple-dotted"/);
  const waveformGroups = [...markup.matchAll(/data-report-waveform-quantity="([^"]+)" data-report-time-min="([^"]+)" data-report-time-max="([^"]+)" data-report-symmetric-limit="([^"]+)"/g)];
  assert.deepEqual(waveformGroups.map((match) => match[1]), ['acceleration', 'velocity']);
  assert.equal(waveformGroups[0][2], waveformGroups[1][2], 'acceleration and velocity share the physical time minimum');
  assert.equal(waveformGroups[0][3], waveformGroups[1][3], 'acceleration and velocity share the physical time maximum');
  assert.ok(waveformGroups.every((match) => Number(match[4]) > 0), 'each quantity uses a finite symmetric ordinate');
  assert.deepEqual(
    [...markup.matchAll(/data-report-waveform-component="([^"]+)" data-report-waveform-row-quantity="([^"]+)"/g)]
      .map((match) => `${match[2]}:${match[1]}`),
    ['acceleration:NS', 'acceleration:EW', 'acceleration:UD', 'velocity:NS', 'velocity:EW', 'velocity:UD'],
  );
  const waveformOrdinateLabels = [...markup.matchAll(/data-report-waveform-ordinate-label="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(waveformOrdinateLabels.length, 18, 'each waveform row labels +limit, zero, and -limit');
  assert.equal(waveformOrdinateLabels.filter((label) => label === 'positive-limit').length, 6);
  assert.equal(waveformOrdinateLabels.filter((label) => label === 'zero').length, 6);
  assert.equal(waveformOrdinateLabels.filter((label) => label === 'negative-limit').length, 6);
  assert.match(markup, /width="1120"/);
  assert.match(markup, /height="1584"/);
  assert.match(markup, /viewBox="0 0 1120 1584"/);
  assert.match(markup, /data-min-font-pt="7\.6"/);
  assert.match(markup, /data-min-line-pt="0\.5"/);
  assert.match(markup, /Integrated strong-motion report/);
  assert.match(markup, /Three-component acceleration/);
  assert.match(markup, /Three-component velocity/);
  assert.match(markup, /Fourier amplitude spectrum/);
  assert.match(markup, /Parzen B=0\.10 Hz/);
  assert.match(markup, /Tripartite pSv response/);
  assert.match(markup, /h = 5\.0%/);
  assert.match(markup, /data-tripartite-equal-log-decades="true"/);
  assert.match(markup, /data-tripartite-geometry-preserved="true"/);
  assert.match(markup, /data-tripartite-guide-units="Sa:cm\/s²;Sd:cm"/);
  const saGuideLabelCount = Number(markup.match(/data-tripartite-sa-guide-labels="([^"]+)"/)?.[1]);
  const sdGuideLabelCount = Number(markup.match(/data-tripartite-sd-guide-labels="([^"]+)"/)?.[1]);
  assert.ok(saGuideLabelCount > 0, 'tripartite labels at least one constant-Sa guide');
  assert.ok(sdGuideLabelCount > 0, 'tripartite labels at least one constant-Sd guide');
  const saGuideLabelY = [...markup.matchAll(/<text[^>]*y="([^"]+)"[^>]*transform="rotate\(-45 [^"]+\)"[^>]*>Sa /g)].map((match) => match[1]);
  const sdGuideLabelY = [...markup.matchAll(/<text[^>]*y="([^"]+)"[^>]*transform="rotate\(45 [^"]+\)"[^>]*>Sd /g)].map((match) => match[1]);
  assert.equal(new Set(saGuideLabelY).size, saGuideLabelY.length, 'Sa guide labels use distinct vertical positions');
  assert.equal(new Set(sdGuideLabelY).size, sdGuideLabelY.length, 'Sd guide labels use distinct vertical positions');
  const tripartitePeriodMin = Number(markup.match(/data-tripartite-period-min="([^"]+)"/)?.[1]);
  const tripartitePeriodMax = Number(markup.match(/data-tripartite-period-max="([^"]+)"/)?.[1]);
  assert.ok(Number.isFinite(tripartitePeriodMin));
  assert.ok(Number.isFinite(tripartitePeriodMax));
  assert.ok(tripartitePeriodMin >= responseSettings.minPeriod * (1 - 1e-12), 'tripartite does not invent a shorter uncomputed period');
  assert.ok(tripartitePeriodMax <= responseSettings.maxPeriod * (1 + 1e-12), 'tripartite does not invent a longer uncomputed period');
  assert.match(markup, /Acceleration FAS \|A\(f\)\| \[cm\/s\]/);
  assert.match(markup, /data-spectrum-panel="report-integrated-fas-clip"/);
  assert.match(markup, /data-spectrum-y-domain-includes-positive-range="true"/);
  assert.match(markup, /displayUnitEquivalence/);
  assert.match(markup, /Guide labels: Sa \[cm\/s²\] \/ Sd \[cm\]/);
  assert.match(markup, /Acceleration:/);
  assert.match(markup, /Velocity: derived quantity; integration drift correction/);
  assert.doesNotMatch(markup, /<text[^>]*>\s*Acceleration:[^<]*integration drift/);
  assert.match(markup, /JMA: original acceleration/);
  assert.match(markup, /Common time axis:/);
  assert.match(markup, /FAS: mean removed; 5% cosine taper/);
  assert.match(markup, /equal-decade Sa\/Sd guides/);
  assert.match(markup, /1\s*\/\s*1/);
  assert.match(markup, /Grayscale check/);
  assert.match(markup, /Methods · JSON/);
  assert.match(markup, /strong-motion-engineering-report\/3\.0/);
  assert.match(markup, /reportSizeMm/);
  assert.match(markup, /integratedPanelOrder/);
  assert.match(markup, /renderedPanels/);
  assert.match(markup, /visibleOnSelectedPlate/);
  assert.match(markup, /displayedRecordInterval/);
  assert.match(markup, /componentDurationsSeconds/);
  assert.match(markup, /sharedTimeAxisAcrossAccelerationAndVelocity/);
  assert.match(markup, /componentEncoding/);
  assert.match(markup, /identificationDoesNotDependOnColourAlone/);
  assert.match(markup, /componentConsistency/);
  assert.match(markup, /circular convolution of Hermitian two-sided spectrum/);
  assert.match(markup, /Nigam–Jennings linear-SDOF exact recurrence/);
  assert.match(markup, /plate\.NS/);
  assert.match(markup, /PLATE01/);
  assert.doesNotMatch(markup, /Source–station locator/);
  assert.doesNotMatch(markup, />\(c\) Acceleration response spectrum</);
});

test('A4 report distinguishes optional acceleration centering from mandatory FAS centering', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)]
    .map((waveform) => ({
      ...waveform,
      preprocessing: { ...waveform.preprocessing, removeMean: false },
    }));
  const peaks = waveforms.map((waveform) => ({
    sourceRecordId: waveform.sourceRecordId,
    fileName: waveform.fileName,
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    pga: Math.max(...waveform.acceleration.map(Math.abs)),
    pgv: 0,
    pgd: 0,
  }));
  const markup = renderToStaticMarkup(React.createElement(ReportFigurePanel, {
    waveforms,
    jmaWaveforms: waveforms,
    peaks,
    responseSettings: { dampingRatio: 0.05, minPeriod: 0.05, maxPeriod: 3, periodCount: 36 },
  }));

  const accelerationFooter = markup.match(/<text[^>]*>\s*Acceleration:[^<]*<\/text>/)?.[0] ?? '';
  assert.ok(accelerationFooter, 'acceleration processing footer is visible');
  assert.doesNotMatch(accelerationFooter, /mean removed/);
  assert.match(markup, /FAS: mean removed; 5% cosine taper/);
  assert.match(markup, /&quot;meanRemoved&quot;:true/);
});

test('A4 report print CSS preserves the 210 by 297 mm export scale', () => {
  const css = readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  assert.match(css, /@page report\s*{[^}]*size:\s*A4 portrait;[^}]*margin:\s*0;[^}]*}/s);
  assert.match(css, /\.report-figure \.report-chart\s*{[^}]*width:\s*210mm;[^}]*max-width:\s*210mm;[^}]*max-height:\s*297mm;[^}]*}/s);
});

test('A4 report preserves the executive summary plate as an explicit legacy view', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const peaks = waveforms.map((waveform) => ({
    sourceRecordId: waveform.sourceRecordId,
    fileName: waveform.fileName,
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    pga: Math.max(...waveform.acceleration.map(Math.abs)),
    pgv: 0,
    pgd: 0,
  }));
  const responseSettings = { dampingRatio: 0.03, minPeriod: 0.05, maxPeriod: 3, periodCount: 36 };
  const markup = renderToStaticMarkup(React.createElement(ReportFigurePanel, {
    waveforms,
    jmaWaveforms: waveforms,
    peaks,
    responseSettings,
    initialPage: 'summary',
  }));

  assert.match(markup, /data-report-page="summary"/);
  assert.match(markup, /data-report-layout="summary"/);
  assert.match(markup, /data-min-font-pt="7\.6"/);
  assert.match(markup, /data-min-line-pt="0\.5"/);
  assert.match(markup, /Page 1 · Executive summary/);
  assert.match(markup, /Page 2 · Technical detail/);
  assert.match(markup, /Source–station locator/);
  assert.match(markup, /Three-component acceleration/);
  assert.match(markup, /Fourier amplitude spectrum/);
  assert.match(markup, /Parzen B=0\.10 Hz/);
  assert.match(markup, /FAS \[cm\/s²·s\]/);
  assert.match(markup, /Acceleration response spectrum/);
  assert.match(markup, /Sa · h = 5\.0%/);
  assert.match(markup, /Acceleration:/);
  assert.match(markup, /FAS: mean removed; 5% cosine taper/);
  assert.doesNotMatch(markup, /<text[^>]*>\s*Acceleration:[^<]*integration drift/);
  assert.doesNotMatch(markup, /Three-component velocity/);
  assert.doesNotMatch(markup, /Tripartite response spectrum/);
  assert.match(markup, /Methods · JSON/);
  assert.match(markup, /strong-motion-engineering-report\/3\.0/);
  assert.match(markup, /minimumTypographyPt/);
  assert.match(markup, /minimumLineWeightPt/);
  assert.match(markup, /peakLabelsOutsideDataRegion/);
  assert.match(markup, /componentConsistency/);
  assert.match(markup, /circular convolution of Hermitian two-sided spectrum/);
  assert.match(markup, /Nigam–Jennings linear-SDOF exact recurrence/);
  assert.match(markup, /finitePointsByComponent/);
  assert.match(markup, /technicalTripartiteDisplayDomains/);
  assert.match(markup, /local equirectangular/);
  assert.match(markup, /equalKilometreScale/);
  assert.match(markup, /plate\.NS/);
  assert.match(markup, /PLATE01/);
  assert.match(markup, /1\s*\/\s*2/);
});

test('A4 report technical plate keeps velocity and tripartite detail off the summary page', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const peaks = waveforms.map((waveform) => ({
    sourceRecordId: waveform.sourceRecordId,
    fileName: waveform.fileName,
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    pga: Math.max(...waveform.acceleration.map(Math.abs)),
    pgv: 0,
    pgd: 0,
  }));
  const markup = renderToStaticMarkup(React.createElement(ReportFigurePanel, {
    waveforms,
    jmaWaveforms: waveforms,
    peaks,
    responseSettings: { dampingRatio: 0.03, minPeriod: 0.05, maxPeriod: 3, periodCount: 36 },
    initialPage: 'technical',
  }));

  assert.match(markup, /data-report-page="technical"/);
  assert.match(markup, /Strong-motion technical detail/);
  assert.match(markup, /Three-component velocity/);
  assert.match(markup, /Tripartite response spectrum: pSv/);
  assert.match(markup, /major-decade guides/);
  assert.match(markup, /Velocity: derived quantity; integration drift correction/);
  assert.match(markup, /Guide labels: Sa \[cm\/s²\] \/ Sd \[cm\]/);
  assert.doesNotMatch(markup, /Three-component acceleration/);
  assert.doesNotMatch(markup, />\(b\) Fourier amplitude spectrum</);
  assert.match(markup, /strong-motion-engineering-report\/3\.0/);
  assert.match(markup, /2 \/ 2/);
});

test('standalone response renders in-figure damping, peak annotations and method metadata', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const settings = { dampingRatio: 0.05, minPeriod: 0.05, maxPeriod: 3, periodCount: 36 };
  const markup = renderToStaticMarkup(React.createElement(ResponseSpectrumPanel, { waveforms, settings }));
  assert.match(markup, /h = 5\.0%/);
  assert.match(markup, /peak pSv/);
  assert.match(markup, /Nigam–Jennings linear-SDOF exact recurrence/);
  assert.match(markup, /computedPeriodRangeSeconds/);
  assert.match(markup, /PLATE01/);
});

test('equal response domain never invents uncomputed period margins', () => {
  const series = [{ name: 'NS', x: [0.02, 0.1, 1, 5], y: [2, 8, 4, 1] }];
  const settings = { dampingRatio: 0.05, minPeriod: 0.01, maxPeriod: 10, periodCount: 36 };
  const domain = responseDomains(series, settings, 'psv', 'equal');
  assert.deepEqual(domain.xDomain, [0.02, 5]);
  assert.equal(domain.equalAspect, true);
});

test('response disables 1:1 geometry when equal decades would require uncomputed periods', () => {
  const series = [{ name: 'NS', x: [0.1, 1], y: [1e-9, 1e3] }];
  const settings = { dampingRatio: 0.05, minPeriod: 0.1, maxPeriod: 1, periodCount: 2 };
  const domain = responseDomains(series, settings, 'psv', 'equal');
  assert.deepEqual(domain.xDomain, [0.1, 1]);
  assert.equal(domain.equalAspect, false);
  assert.ok(Math.log10(domain.yDomain[1] / domain.yDomain[0]) > Math.log10(domain.xDomain[1] / domain.xDomain[0]));
});

test('response and journal metadata never claim a computed range when every period is unsupported', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const settings = { dampingRatio: 0.05, minPeriod: 0.0001, maxPeriod: 0.001, periodCount: 12 };
  const responseMarkup = renderToStaticMarkup(React.createElement(ResponseSpectrumPanel, { waveforms, settings }));
  const journalMarkup = renderToStaticMarkup(React.createElement(JournalPlatePanel, { waveforms, responseSettings: settings }));
  assert.match(responseMarkup, /No finite response ordinates were computed/);
  assert.match(responseMarkup, /no-finite-response/);
  assert.match(journalMarkup, /No finite response ordinates were computed/);
  assert.match(journalMarkup, /no-finite-response/);
});

test('Fourier and response figures select one event-station record set at a time', () => {
  const first = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const second = first.map((waveform) => ({
    ...waveform,
    sourceRecordId: `second-${waveform.component}`,
    fileName: `second.${waveform.component}`,
    metadata: {
      ...waveform.metadata,
      stationCode: 'PLATE02',
      stationLat: 36,
      stationLon: 140,
      originTime: '2026/01/02 00:00:00',
      eventLat: 36.2,
      eventLon: 140.3,
    },
  }));
  const waveforms = [...first, ...second];
  const settings = { dampingRatio: 0.05, minPeriod: 0.05, maxPeriod: 3, periodCount: 16 };
  const fourierMarkup = renderToStaticMarkup(React.createElement(FourierPanel, { waveforms }));
  const responseMarkup = renderToStaticMarkup(React.createElement(ResponseSpectrumPanel, { waveforms, settings }));
  assert.match(fourierMarkup, /Record set/);
  assert.match(responseMarkup, /Record set/);
  const recordSetOptionCount = (markup) => {
    const select = markup.match(/Record set<select[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
    return (select.match(/<option/g) ?? []).length;
  };
  assert.equal(recordSetOptionCount(fourierMarkup), 2);
  assert.equal(recordSetOptionCount(responseMarkup), 2);
  assert.match(fourierMarkup, /data-export-base="fourier_acceleration_smoothed-raw_parzen0p10hz_taper5_journal_PLATE01"/);
  assert.match(fourierMarkup, /Parzen · power-domain/);
  assert.match(fourierMarkup, /Parzen B=0\.10 Hz on squared amplitude \(power\)/);
  assert.match(fourierMarkup, /square-root amplitude recovery on the original FFT-bin grid/);
  assert.match(fourierMarkup, /Konno–Ohmachi · log-frequency/);
  assert.match(fourierMarkup, /strong-motion-fourier-spectrum\/1\.1/);
  assert.match(fourierMarkup, /circular convolution of Hermitian two-sided spectrum/);
  assert.match(fourierMarkup, /ordinate based on the smoothed peak minus four decades/);
  assert.match(responseMarkup, /data-export-base="response_spectrum_psv_equal_PLATE01"/);
});

test('stacked time history exposes padded shared ordinate and event context', () => {
  const waveforms = [publicationWaveform('NS'), publicationWaveform('EW', 0.4), publicationWaveform('UD', 0.8)];
  const markup = renderToStaticMarkup(React.createElement(StackedTimeHistoryFigure, {
    waveforms,
    quantity: 'acceleration',
    label: 'Acceleration',
    shortLabel: 'PGA',
    unit: 'cm/s²',
    fileNameBase: 'stacked-test',
    contextLabel: 'PLATE01',
  }));
  assert.match(markup, /sharedOrdinate/);
  assert.match(markup, /10\u201315% headroom/);
  assert.match(markup, /2026\/01\/01 00:00:00/);
  assert.match(markup, /Methods · JSON/);
  const peakLabels = [...markup.matchAll(/PGA = ([^ ]+) cm\/s² at ([^ ]+) s/g)];
  assert.equal(peakLabels.length, 3);
  peakLabels.forEach((match) => {
    assert.ok(significantDigitCount(match[1]) <= 3, `stacked PGA label has excess precision: ${match[1]}`);
    assert.ok((match[2].split('.')[1]?.length ?? 0) <= 2, `stacked PGA time exceeds sample precision: ${match[2]}`);
  });
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
