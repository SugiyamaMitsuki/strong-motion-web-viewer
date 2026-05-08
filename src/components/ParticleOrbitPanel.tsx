import { useMemo, useState } from 'react';
import { computeParticleOrbits, projectionComponents, projectionLabel, quantityLabel, type OrbitProjection } from '../analysis/orbit';
import type { DerivedWaveform, Quantity } from '../types/waveform';
import { formatNumber } from '../utils/file';
import { SvgChart, type ChartSeries } from './SvgChart';

interface ParticleOrbitPanelProps {
  waveforms: DerivedWaveform[];
}

function orbitDomain(series: readonly ChartSeries[]): [number, number] {
  let maxAbs = 0;

  for (const item of series) {
    for (const value of item.x) if (Number.isFinite(value)) maxAbs = Math.max(maxAbs, Math.abs(value));
    for (const value of item.y) if (Number.isFinite(value)) maxAbs = Math.max(maxAbs, Math.abs(value));
  }

  const limit = maxAbs > 0 ? maxAbs * 1.08 : 1;
  return [-limit, limit];
}

export function ParticleOrbitPanel({ waveforms }: ParticleOrbitPanelProps): JSX.Element {
  const [quantity, setQuantity] = useState<Quantity>('displacement');
  const [projection, setProjection] = useState<OrbitProjection>('EW_NS');

  const orbits = useMemo(
    () => computeParticleOrbits(waveforms, projection, quantity),
    [waveforms, projection, quantity],
  );
  const series = useMemo<ChartSeries[]>(() => orbits.map((orbit) => ({
    name: orbit.label,
    x: orbit.x,
    y: orbit.y,
  })), [orbits]);
  const domain = useMemo(() => orbitDomain(series), [series]);
  const components = projectionComponents(projection);
  const unit = orbits[0]?.unit ?? (quantity === 'acceleration' ? 'cm/s²' : quantity === 'velocity' ? 'cm/s' : 'cm');

  if (waveforms.length === 0) return <p className="empty-state">No data is available for particle orbits.</p>;

  return (
    <div className="chart-stack">
      <div className="inline-controls">
        <label>
          Quantity
          <select value={quantity} onChange={(event) => setQuantity(event.target.value as Quantity)}>
            <option value="displacement">Displacement</option>
            <option value="velocity">Velocity</option>
            <option value="acceleration">Acceleration</option>
          </select>
        </label>
        <label>
          Projection
          <select value={projection} onChange={(event) => setProjection(event.target.value as OrbitProjection)}>
            <option value="EW_NS">EW-NS</option>
            <option value="EW_UD">EW-UD</option>
            <option value="NS_UD">NS-UD</option>
          </select>
        </label>
        <span className="note">The plot uses equal X/Y scale so the orbit shape is not distorted.</span>
      </div>

      {orbits.length > 0 ? (
        <>
          <SvgChart
            title={`Particle Orbit: ${quantityLabel(quantity)} ${projectionLabel(projection)}`}
            xLabel={`${components.x} [${unit}]`}
            yLabel={`${components.y} [${unit}]`}
            series={series}
            xScale="linear"
            yScale="linear"
            domainX={domain}
            domainY={domain}
            width={680}
            height={680}
            fileNameBase={`particle_orbit_${quantity}_${projection}`}
          />

          <section className="panel summary-card">
            <h2>Orbit Data</h2>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>X Component</th>
                    <th>Y Component</th>
                    <th>Samples</th>
                    <th>Time Span [s]</th>
                    <th>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {orbits.map((orbit) => {
                    const firstTime = orbit.time[0] ?? 0;
                    const lastTime = orbit.time[orbit.time.length - 1] ?? firstTime;
                    return (
                      <tr key={orbit.id}>
                        <td>{orbit.label}</td>
                        <td>{orbit.xComponent}</td>
                        <td>{orbit.yComponent}</td>
                        <td>{orbit.x.length.toLocaleString()}</td>
                        <td>{formatNumber(firstTime, 4)} - {formatNumber(lastTime, 4)}</td>
                        <td>{orbit.unit}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <p className="empty-state">The selected orbit requires both components in the selected projection for the same station/channel.</p>
      )}
    </div>
  );
}
