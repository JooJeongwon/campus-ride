export type VirtualMapMarker = {
  id: string;
  label: string;
  kind: 'self' | 'peer';
  lat: number;
  lng: number;
  accuracyM: number;
};

export function isLocationFresh(receivedAt: number, now = Date.now()) {
  const age = now - receivedAt;
  return age >= 0 && age <= 30_000;
}

export function projectVirtualMap(
  stop: { lat: number; lng: number },
  markers: VirtualMapMarker[],
) {
  // shortcut: the equirectangular projection fits campus scale; use a geospatial projection if the map spans farther.
  const longitudeScale = 111_320 * Math.max(0.000001, Math.cos(stop.lat * Math.PI / 180));
  const points = [
    { id: 'stop', label: '지정 승차 지점', kind: 'stop' as const, x: 0, y: 0, accuracyM: 0 },
    ...markers.map((marker) => ({
      id: marker.id,
      label: marker.label,
      kind: marker.kind,
      x: (marker.lng - stop.lng) * longitudeScale,
      y: (marker.lat - stop.lat) * 110_540,
      accuracyM: marker.accuracyM,
    })),
  ];
  const bounds = points.reduce((result, point) => ({
    minX: Math.min(result.minX, point.x - point.accuracyM),
    maxX: Math.max(result.maxX, point.x + point.accuracyM),
    minY: Math.min(result.minY, point.y - point.accuracyM),
    maxY: Math.max(result.maxY, point.y + point.accuracyM),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const scale = Math.min(
    264 / Math.max(120, bounds.maxX - bounds.minX + 40),
    156 / Math.max(90, bounds.maxY - bounds.minY + 40),
  );

  return points.map((point) => ({
    ...point,
    x: 160 + (point.x - centerX) * scale,
    y: 110 - (point.y - centerY) * scale,
    radius: point.accuracyM * scale,
  }));
}
