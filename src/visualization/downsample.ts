export interface SampledSeries {
  x: number[];
  y: number[];
}

export type PointValidator = (x: number, y: number) => boolean;

/**
 * Reduces a polyline while retaining the x/y extrema in each time-ordered
 * bucket. Unlike fixed-stride sampling, this cannot silently discard a narrow
 * acceleration pulse or an orbit extremum from an exported figure.
 */
export function downsampleExtrema(
  x: readonly number[],
  y: readonly number[],
  maxPoints = 2400,
): SampledSeries {
  const length = Math.min(x.length, y.length);
  const limit = Math.max(0, Math.floor(maxPoints));
  if (length === 0 || limit === 0) return { x: [], y: [] };
  if (length <= limit) return { x: x.slice(0, length), y: y.slice(0, length) };
  if (limit === 1) return { x: [x[0]], y: [y[0]] };

  const middleLength = length - 2;
  const bucketCount = Math.floor((limit - 2) / 4);
  const selected = new Set<number>([0, length - 1]);

  // With fewer than six available points, retaining both endpoints is more
  // important than overflowing the caller's strict point budget.
  if (bucketCount === 0) {
    return {
      x: [x[0], x[length - 1]],
      y: [y[0], y[length - 1]],
    };
  }

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * middleLength) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * middleLength) / bucketCount);
    if (end <= start) continue;

    let minXIndex = start;
    let maxXIndex = start;
    let minYIndex = start;
    let maxYIndex = start;

    for (let index = start + 1; index < end; index += 1) {
      if (x[index] < x[minXIndex]) minXIndex = index;
      if (x[index] > x[maxXIndex]) maxXIndex = index;
      if (y[index] < y[minYIndex]) minYIndex = index;
      if (y[index] > y[maxYIndex]) maxYIndex = index;
    }

    selected.add(minXIndex);
    selected.add(maxXIndex);
    selected.add(minYIndex);
    selected.add(maxYIndex);
  }

  const indices = [...selected].sort((a, b) => a - b);
  return {
    x: indices.map((index) => x[index]),
    y: indices.map((index) => y[index]),
  };
}

function allocateSegmentBudgets(lengths: readonly number[], maxPoints: number): number[] {
  const budgets = Array(lengths.length).fill(0);
  const limit = Math.max(0, Math.floor(maxPoints));
  if (limit === 0 || lengths.length === 0) return budgets;

  const baseDemand = lengths.reduce((sum, length) => sum + Math.min(length, 2), 0);
  if (baseDemand > limit) {
    // A pathological sequence can contain more finite fragments than the
    // entire point budget. Keep the longest fragments deterministically; a
    // renderer cannot draw every fragment without violating the hard cap.
    const retained = lengths
      .map((length, index) => ({ index, length }))
      .filter(({ length }) => length > 0)
      .sort((left, right) => right.length - left.length || left.index - right.index)
      .slice(0, limit);
    retained.forEach(({ index }) => { budgets[index] = 1; });
    return budgets;
  }

  lengths.forEach((length, index) => { budgets[index] = Math.min(length, 2); });
  let remaining = limit - baseDemand;
  const capacities = lengths.map((length, index) => Math.max(0, length - budgets[index]));
  const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
  if (remaining === 0 || totalCapacity === 0) return budgets;

  const fractional: Array<{ index: number; fraction: number }> = [];
  capacities.forEach((capacity, index) => {
    if (capacity === 0) return;
    const ideal = (remaining * capacity) / totalCapacity;
    const whole = Math.min(capacity, Math.floor(ideal));
    budgets[index] += whole;
    fractional.push({ index, fraction: ideal - whole });
  });

  remaining = limit - budgets.reduce((sum, budget) => sum + budget, 0);
  fractional.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of fractional) {
    if (remaining === 0) break;
    if (budgets[index] >= lengths[index]) continue;
    budgets[index] += 1;
    remaining -= 1;
  }

  return budgets;
}

/**
 * Splits invalid gaps before decimation so a plotted path can never bridge
 * them, then shares one strict point budget across all finite segments.
 */
export function downsampleSegments(
  x: readonly number[],
  y: readonly number[],
  maxPoints = 2400,
  isValid: PointValidator = (xValue, yValue) => Number.isFinite(xValue) && Number.isFinite(yValue),
): SampledSeries[] {
  const rawSegments: SampledSeries[] = [];
  let segmentX: number[] = [];
  let segmentY: number[] = [];
  const flush = (): void => {
    if (segmentX.length > 0) rawSegments.push({ x: segmentX, y: segmentY });
    segmentX = [];
    segmentY = [];
  };

  const length = Math.min(x.length, y.length);
  for (let index = 0; index < length; index += 1) {
    if (!isValid(x[index], y[index])) flush();
    else {
      segmentX.push(x[index]);
      segmentY.push(y[index]);
    }
  }
  flush();

  const budgets = allocateSegmentBudgets(rawSegments.map((segment) => segment.x.length), maxPoints);
  return rawSegments.flatMap((segment, index) => {
    const budget = budgets[index];
    return budget > 0 ? [downsampleExtrema(segment.x, segment.y, budget)] : [];
  });
}
