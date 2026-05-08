import type { WaveformRecord } from '../types/waveform';
import { formatNumber } from '../utils/file';

interface StationMapProps {
  records: WaveformRecord[];
}

interface MapPoint {
  id: string;
  kind: 'station' | 'event';
  label: string;
  detail: string;
  lat: number;
  lon: number;
}

interface PixelPoint {
  x: number;
  y: number;
}

interface MapTile {
  key: string;
  href: string;
  x: number;
  y: number;
}

const TILE_SIZE = 256;
const MAP_WIDTH = 960;
const MAP_HEIGHT = 420;
const MIN_ZOOM = 4;
const MAX_ZOOM = 13;
const MERCATOR_MAX_LAT = 85.05112878;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampLatitude(lat: number): number {
  return Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
}

function project(lat: number, lon: number, zoom: number): PixelPoint {
  const worldSize = TILE_SIZE * 2 ** zoom;
  const clampedLat = clampLatitude(lat);
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);

  return {
    x: ((lon + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize,
  };
}

function unproject(point: PixelPoint, zoom: number): { lat: number; lon: number } {
  const worldSize = TILE_SIZE * 2 ** zoom;
  const lon = (point.x / worldSize) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * point.y) / worldSize;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

function chooseZoom(points: readonly MapPoint[]): number {
  if (points.length <= 1) return 11;

  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom -= 1) {
    const projected = points.map((point) => project(point.lat, point.lon, zoom));
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    if (spanX <= MAP_WIDTH - 180 && spanY <= MAP_HEIGHT - 140) return zoom;
  }

  return MIN_ZOOM;
}

function buildMapPoints(records: readonly WaveformRecord[]): MapPoint[] {
  const stationMap = new Map<string, MapPoint & { components: Set<string> }>();
  const eventMap = new Map<string, MapPoint>();

  for (const record of records) {
    const {
      stationCode,
      stationLat,
      stationLon,
      eventLat,
      eventLon,
      magnitude,
      originTime,
    } = record.metadata;

    if (isFiniteNumber(stationLat) && isFiniteNumber(stationLon)) {
      const label = stationCode || 'Station';
      const key = `${label}:${stationLat.toFixed(5)}:${stationLon.toFixed(5)}`;
      const existing = stationMap.get(key);

      if (existing) {
        existing.components.add(record.componentLabel);
      } else {
        stationMap.set(key, {
          id: key,
          kind: 'station',
          label,
          detail: record.componentLabel,
          lat: stationLat,
          lon: stationLon,
          components: new Set([record.componentLabel]),
        });
      }
    }

    if (isFiniteNumber(eventLat) && isFiniteNumber(eventLon)) {
      const key = `${eventLat.toFixed(5)}:${eventLon.toFixed(5)}:${originTime ?? ''}`;
      if (!eventMap.has(key)) {
        const magnitudeText = isFiniteNumber(magnitude) ? `M ${formatNumber(magnitude, 2)}` : 'Epicenter';
        eventMap.set(key, {
          id: key,
          kind: 'event',
          label: 'Epicenter',
          detail: magnitudeText,
          lat: eventLat,
          lon: eventLon,
        });
      }
    }
  }

  const stations = Array.from(stationMap.values()).map(({ components, ...point }) => ({
    ...point,
    detail: Array.from(components).join('/'),
  }));

  return [...Array.from(eventMap.values()), ...stations];
}

function mapTiles(center: PixelPoint, zoom: number): MapTile[] {
  const tileCount = 2 ** zoom;
  const minTileX = Math.floor((center.x - MAP_WIDTH / 2) / TILE_SIZE);
  const maxTileX = Math.floor((center.x + MAP_WIDTH / 2) / TILE_SIZE);
  const minTileY = Math.floor((center.y - MAP_HEIGHT / 2) / TILE_SIZE);
  const maxTileY = Math.floor((center.y + MAP_HEIGHT / 2) / TILE_SIZE);
  const tiles: MapTile[] = [];

  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    if (tileY < 0 || tileY >= tileCount) continue;

    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        href: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
        x: tileX * TILE_SIZE - (center.x - MAP_WIDTH / 2),
        y: tileY * TILE_SIZE - (center.y - MAP_HEIGHT / 2),
      });
    }
  }

  return tiles;
}

function mapView(points: readonly MapPoint[]): {
  center: PixelPoint;
  centerLat: number;
  centerLon: number;
  zoom: number;
  tiles: MapTile[];
} {
  const zoom = chooseZoom(points);
  const projected = points.map((point) => project(point.lat, point.lon, zoom));
  const xs = projected.map((point) => point.x);
  const ys = projected.map((point) => point.y);
  const center = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  const centerGeo = unproject(center, zoom);

  return {
    center,
    centerLat: centerGeo.lat,
    centerLon: centerGeo.lon,
    zoom,
    tiles: mapTiles(center, zoom),
  };
}

function osmUrl(point: MapPoint, zoom: number): string {
  return `https://www.openstreetmap.org/?mlat=${point.lat.toFixed(6)}&mlon=${point.lon.toFixed(6)}#map=${zoom}/${point.lat.toFixed(6)}/${point.lon.toFixed(6)}`;
}

export function StationMap({ records }: StationMapProps): JSX.Element | null {
  const points = buildMapPoints(records);
  const stationPoints = points.filter((point) => point.kind === 'station');

  if (points.length === 0 || stationPoints.length === 0) return null;

  const view = mapView(points);
  const renderedPoints = points.map((point) => {
    const pixel = project(point.lat, point.lon, view.zoom);
    return {
      ...point,
      x: MAP_WIDTH / 2 + pixel.x - view.center.x,
      y: MAP_HEIGHT / 2 + pixel.y - view.center.y,
    };
  });

  const firstStation = stationPoints[0];
  const centerUrl = firstStation
    ? osmUrl(firstStation, Math.max(view.zoom, 11))
    : `https://www.openstreetmap.org/#map=${view.zoom}/${view.centerLat.toFixed(6)}/${view.centerLon.toFixed(6)}`;

  return (
    <section className="panel map-panel full-width">
      <div className="panel-header">
        <h2>Station Map</h2>
        <a className="map-link" href={centerUrl} target="_blank" rel="noreferrer">Open in OpenStreetMap</a>
      </div>

      <div className="map-layout">
        <div className="map-view" aria-label="Observation station map">
          <svg className="map-svg" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Observation station locations">
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} className="map-fallback" />
            {view.tiles.map((tile) => (
              <image
                key={tile.key}
                href={tile.href}
                x={tile.x}
                y={tile.y}
                width={TILE_SIZE}
                height={TILE_SIZE}
                preserveAspectRatio="none"
              />
            ))}
            {renderedPoints.map((point) => (
              <g key={point.id} transform={`translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`} className={`map-marker map-marker-${point.kind}`}>
                {point.kind === 'station' ? (
                  <>
                    <path d="M0 -23C-13 -23 -22 -13 -22 -1C-22 15 0 31 0 31C0 31 22 15 22 -1C22 -13 13 -23 0 -23Z" />
                    <circle r="7" />
                  </>
                ) : (
                  <>
                    <path d="M0 -18L18 0L0 18L-18 0Z" />
                    <path d="M-10 0H10M0 -10V10" className="map-epicenter-cross" />
                  </>
                )}
                <text x="0" y={point.kind === 'station' ? -31 : -25} textAnchor="middle" className="map-marker-label">{point.label}</text>
              </g>
            ))}
          </svg>
          <div className="map-attribution">
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
          </div>
        </div>

        <div className="map-location-list">
          {renderedPoints.map((point) => (
            <a key={`list-${point.id}`} href={osmUrl(point, Math.max(view.zoom, 11))} target="_blank" rel="noreferrer" className={`map-location-item ${point.kind}`}>
              <strong>{point.label}</strong>
              <span>{point.kind === 'station' ? 'Station' : 'Event'} · {point.detail}</span>
              <code>{formatNumber(point.lat, 6)}, {formatNumber(point.lon, 6)}</code>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
