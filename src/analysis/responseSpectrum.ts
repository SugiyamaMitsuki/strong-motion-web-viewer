import type { DerivedWaveform, ResponseSpectrumResult, ResponseSpectrumSettings } from '../types/waveform';

export function generateLogPeriods(minPeriod: number, maxPeriod: number, count: number): number[] {
  const minT = Math.max(minPeriod, 1e-4);
  const maxT = Math.max(maxPeriod, minT * 1.01);
  const n = Math.max(2, Math.floor(count));
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
  if (accelerationGal.length === 0 || dt <= 0) return [];

  const h = Math.max(0, Math.min(0.999999, dampingRatio));

  return periods.map((period) => {
    const t = Math.max(period, 1e-8);
    const omega = (2 * Math.PI) / t;
    const hPrime = Math.sqrt(1 - h * h);
    const dampedOmega = hPrime * omega;
    const expTerm = Math.exp(-h * omega * dt);
    const hOverHPrime = h / hPrime;
    const sinTerm = Math.sin(dampedOmega * dt);
    const cosTerm = Math.cos(dampedOmega * dt);
    const hw1 = (2 * h * h - 1) / (omega * omega * dt);
    const hw2 = h / omega;
    const hw3 = (2 * h) / (omega * omega * omega * dt);
    const omegaInv2 = 1 / (omega * omega);

    const a11 = expTerm * (hOverHPrime * sinTerm + cosTerm);
    const a12 = expTerm / dampedOmega * sinTerm;
    const a21 = -omega / hPrime * expTerm * sinTerm;
    const a22 = expTerm * (cosTerm - hOverHPrime * sinTerm);
    const b11 = expTerm * ((hw1 + hw2) * sinTerm / dampedOmega + (hw3 + omegaInv2) * cosTerm) - hw3;
    const b12 = -expTerm * (hw1 * sinTerm / dampedOmega + hw3 * cosTerm) - omegaInv2 + hw3;
    const b21 = expTerm * (
      (hw1 + hw2) * (cosTerm - hOverHPrime * sinTerm)
      - (hw3 + omegaInv2) * (dampedOmega * sinTerm + h * omega * cosTerm)
    ) + omegaInv2 / dt;
    const b22 = -expTerm * (
      hw1 * (cosTerm - hOverHPrime * sinTerm)
      - hw3 * (dampedOmega * sinTerm + h * omega * cosTerm)
    ) - omegaInv2 / dt;

    let displacement = 0;
    let velocity = 0;
    let maxSd = 0;
    let maxSa = 0;

    for (let i = 1; i < accelerationGal.length; i += 1) {
      const previousAcceleration = accelerationGal[i - 1];
      const currentAcceleration = accelerationGal[i];
      const nextDisplacement = a11 * displacement + a12 * velocity + b11 * previousAcceleration + b12 * currentAcceleration;
      const nextVelocity = a21 * displacement + a22 * velocity + b21 * previousAcceleration + b22 * currentAcceleration;
      const absoluteAcceleration = -2 * h * omega * nextVelocity - omega * omega * nextDisplacement;

      displacement = nextDisplacement;
      velocity = nextVelocity;
      maxSd = Math.max(maxSd, Math.abs(displacement));
      maxSa = Math.max(maxSa, Math.abs(absoluteAcceleration));
    }

    return {
      period: t,
      sd: maxSd,
      psv: maxSa / omega,
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
