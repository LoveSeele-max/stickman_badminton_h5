import type { Vec2 } from './types';

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;

export const sideDirection = (side: 'left' | 'right'): number =>
  side === 'left' ? 1 : -1;

export const length = (vector: Vec2): number =>
  Math.hypot(vector.x, vector.y);

export const distance = (a: Vec2, b: Vec2): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const distancePointToSegment = (
  point: Vec2,
  start: Vec2,
  end: Vec2,
): number => {
  return projectPointToSegment(point, start, end).distance;
};

export const projectPointToSegment = (
  point: Vec2,
  start: Vec2,
  end: Vec2,
): { distance: number; point: Vec2; t: number } => {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (lengthSquared === 0) {
    return {
      distance: distance(point, start),
      point: start,
      t: 0,
    };
  }

  const t = clamp(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
      lengthSquared,
    0,
    1,
  );
  const projectedPoint = {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t,
  };

  return {
    distance: distance(point, projectedPoint),
    point: projectedPoint,
    t,
  };
};

export const rectangleContainsCircle = (
  circle: Vec2,
  radius: number,
  rect: { x: number; y: number; width: number; height: number },
): boolean => {
  const nearestX = clamp(circle.x, rect.x, rect.x + rect.width);
  const nearestY = clamp(circle.y, rect.y, rect.y + rect.height);
  const dx = circle.x - nearestX;
  const dy = circle.y - nearestY;

  return dx * dx + dy * dy <= radius * radius;
};
