import { describe, expect, it } from 'vitest';
import { distancePointToSegment, rectangleContainsCircle, sideDirection } from './math';

describe('math helpers', () => {
  it('maps court sides to net-facing directions', () => {
    expect(sideDirection('left')).toBe(1);
    expect(sideDirection('right')).toBe(-1);
  });

  it('computes point-to-segment distance', () => {
    expect(
      distancePointToSegment(
        { x: 5, y: 4 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ),
    ).toBeCloseTo(4);
  });

  it('detects circle overlap with a rectangle', () => {
    expect(
      rectangleContainsCircle(
        { x: 12, y: 12 },
        5,
        { x: 0, y: 0, width: 10, height: 10 },
      ),
    ).toBe(true);
    expect(
      rectangleContainsCircle(
        { x: 22, y: 22 },
        5,
        { x: 0, y: 0, width: 10, height: 10 },
      ),
    ).toBe(false);
  });
});
