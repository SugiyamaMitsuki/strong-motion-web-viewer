import type { DerivedWaveform, ResponseSpectrumResult, ResponseSpectrumSettings } from '../types/waveform';

const LOW_DAMPING_MIN_SUBSTEPS = 4;
const HIGH_DAMPING_MIN_SUBSTEPS = 10;
const LOW_DAMPING_STEPS_PER_PERIOD = 50;
const HIGH_DAMPING_STEPS_PER_PERIOD = 100;
const MAX_INTERVAL_SUBSTEPS = 200;
const FREE_VIBRATION_STEPS = 200;
const MAX_RESPONSE_PERIOD_SEC = 100;
const MAX_PERIOD_COUNT = 1000;

interface RecurrenceCoefficients {
  a11: number;
  a12: number;
  a21: number;
  a22: number;
  b11: number;
  b12: number;
  b21: number;
  b22: number;
}

function recurrenceCoefficients(omega: number, dampingRatio: number, intervalDt: number): RecurrenceCoefficients {
  const hPrime = Math.sqrt(1 - dampingRatio * dampingRatio);
  const dampedOmega = hPrime * omega;
  const expTerm = Math.exp(-dampingRatio * omega * intervalDt);
  const hOverHPrime = dampingRatio / hPrime;
  const sinTerm = Math.sin(dampedOmega * intervalDt);
  const cosTerm = Math.cos(dampedOmega * intervalDt);
  const hw1 = (2 * dampingRatio * dampingRatio - 1) / (omega * omega * intervalDt);
  const hw2 = dampingRatio / omega;
  const hw3 = (2 * dampingRatio) / (omega * omega * omega * intervalDt);
  const omegaInv2 = 1 / (omega * omega);

  return {
    a11: expTerm * (hOverHPrime * sinTerm + cosTerm),
    a12: expTerm / dampedOmega * sinTerm,
    a21: -omega / hPrime * expTerm * sinTerm,
    a22: expTerm * (cosTerm - hOverHPrime * sinTerm),
    b11: expTerm * ((hw1 + hw2) * sinTerm / dampedOmega + (hw3 + omegaInv2) * cosTerm) - hw3,
    b12: -expTerm * (hw1 * sinTerm / dampedOmega + hw3 * cosTerm) - omegaInv2 + hw3,
    b21: expTerm * (
      (hw1 + hw2) * (cosTerm - hOverHPrime * sinTerm)
      - (hw3 + omegaInv2) * (dampedOmega * sinTerm + dampingRatio * omega * cosTerm)
    ) + omegaInv2 / intervalDt,
    b22: -expTerm * (
      hw1 * (cosTerm - hOverHPrime * sinTerm)
      - hw3 * (dampedOmega * sinTerm + dampingRatio * omega * cosTerm)
    ) - omegaInv2 / intervalDt,
  };
}

export function generateLogPeriods(minPeriod: number, maxPeriod: number, count: number): number[] {
  const requestedMin = Number.isFinite(minPeriod) && minPeriod > 0 ? minPeriod : 0.02;
  const requestedMax = Number.isFinite(maxPeriod) && maxPeriod > 0 ? maxPeriod : 10;
  const minT = Math.min(MAX_RESPONSE_PERIOD_SEC / 1.01, Math.max(requestedMin, 1e-4));
  const maxT = Math.min(MAX_RESPONSE_PERIOD_SEC, Math.max(requestedMax, minT * 1.01));
  const n = Number.isFinite(count)
    ? Math.min(MAX_PERIOD_COUNT, Math.max(2, Math.floor(count)))
    : 500;
  const logMin = Math.log10(minT);
  const logMax = Math.log10(maxT);

  return Array.from({ length: n }, (_, i) => {
    const r = i / (n - 1);
    return 10 ** (logMin + (logMax - logMin) * r);
  });
}

export function computeSingleResponseSpectrum(
  accelerationGal: readonly number[],
  dt: number,
  periods: readonly number[],
  dampingRatio: number,
): { period: number; sd: number; psv: number; psa: number }[] {
  if (accelerationGal.length === 0 || !Number.isFinite(dt) || dt <= 0) return [];

  const h = Number.isFinite(dampingRatio) ? Math.max(0, Math.min(0.999999, dampingRatio)) : 0.05;
  const finiteAcceleration = accelerationGal.every(Number.isFinite);

  return periods.map((period) => {
    const t = Number.isFinite(period) && period > 0 ? period : Number.NaN;
    const minimumSubsteps = h >= 0.5 ? HIGH_DAMPING_MIN_SUBSTEPS : LOW_DAMPING_MIN_SUBSTEPS;
    const stepsPerPeriod = h >= 0.5 ? HIGH_DAMPING_STEPS_PER_PERIOD : LOW_DAMPING_STEPS_PER_PERIOD;
    const requiredSubsteps = Number.isFinite(t)
      ? Math.max(minimumSubsteps, Math.ceil((stepsPerPeriod * dt) / t))
      : Number.POSITIVE_INFINITY;
    if (
      !finiteAcceleration
      || !Number.isFinite(t)
      || t > MAX_RESPONSE_PERIOD_SEC
      || requiredSubsteps > MAX_INTERVAL_SUBSTEPS
    ) {
      return { period: t, sd: Number.NaN, psv: Number.NaN, psa: Number.NaN };
    }

    const omega = (2 * Math.PI) / t;
    const substeps = requiredSubsteps;
    const stepDt = dt / substeps;
    const coefficients = recurrenceCoefficients(omega, h, stepDt);

    let displacement = 0;
    let velocity = 0;
    let maxSd = 0;
    let maxSa = 0;

    const advance = (
      stepCoefficients: RecurrenceCoefficients,
      previousAcceleration: number,
      currentAcceleration: number,
    ) => {
      const nextDisplacement = stepCoefficients.a11 * displacement + stepCoefficients.a12 * velocity
        + stepCoefficients.b11 * previousAcceleration + stepCoefficients.b12 * currentAcceleration;
      const nextVelocity = stepCoefficients.a21 * displacement + stepCoefficients.a22 * velocity
        + stepCoefficients.b21 * previousAcceleration + stepCoefficients.b22 * currentAcceleration;
      const absoluteAcceleration = -2 * h * omega * nextVelocity - omega * omega * nextDisplacement;

      displacement = nextDisplacement;
      velocity = nextVelocity;
      maxSd = Math.max(maxSd, Math.abs(displacement));
      maxSa = Math.max(maxSa, Math.abs(absoluteAcceleration));
    };

    for (let i = 1; i < accelerationGal.length; i += 1) {
      const previousAcceleration = accelerationGal[i - 1];
      const currentAcceleration = accelerationGal[i];
      for (let step = 1; step <= substeps; step += 1) {
        const startRatio = (step - 1) / substeps;
        const endRatio = step / substeps;
        advance(
          coefficients,
          previousAcceleration + (currentAcceleration - previousAcceleration) * startRatio,
          previousAcceleration + (currentAcceleration - previousAcceleration) * endRatio,
        );
      }
    }

    if (accelerationGal.length > 1) {
      const finalAcceleration = accelerationGal[accelerationGal.length - 1];
      if (finalAcceleration !== 0) {
        for (let step = 1; step <= substeps; step += 1) {
          advance(
            coefficients,
            finalAcceleration * (1 - (step - 1) / substeps),
            finalAcceleration * (1 - step / substeps),
          );
        }
      }

      const freeVibrationCoefficients = recurrenceCoefficients(omega, h, t / FREE_VIBRATION_STEPS);
      for (let step = 0; step < FREE_VIBRATION_STEPS; step += 1) {
        advance(freeVibrationCoefficients, 0, 0);
      }
    }

    return {
      period: t,
      sd: maxSd,
      psv: omega * maxSd,
      psa: maxSa,
    };
  });
}

export function computeResponseSpectra(
  waveforms: DerivedWaveform[],
  settings: ResponseSpectrumSettings,
): ResponseSpectrumResult[] {
  const periods = generateLogPeriods(settings.minPeriod, settings.maxPeriod, settings.periodCount);
  return waveforms.map((waveform) => ({
    component: waveform.component,
    componentLabel: waveform.componentLabel,
    points: computeSingleResponseSpectrum(waveform.acceleration, waveform.dt, periods, settings.dampingRatio),
  }));
}
