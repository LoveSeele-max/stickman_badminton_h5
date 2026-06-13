import { describe, expect, it } from 'vitest';
import { getFlightDragGrace, stepFlightState, type FlightState } from './flight';
import type { ShuttleFlightProfile } from './types';

const simulate = (
  flightProfile: ShuttleFlightProfile,
  steps = 90,
): FlightState => {
  let state: FlightState = {
    dragGraceTimer: getFlightDragGrace(flightProfile),
    flightProfile,
    flightTimer: 0,
    vx: 1280,
    vy: -140,
    x: 400,
    y: 420,
  };

  for (let i = 0; i < steps; i += 1) {
    state = stepFlightState(state, 1 / 120);
  }

  return state;
};

describe('flight profiles', () => {
  it('keeps serve drag grace longer than rally flights', () => {
    expect(getFlightDragGrace('rally-fast')).toBeGreaterThanOrEqual(
      getFlightDragGrace('rally-arc'),
    );
    expect(getFlightDragGrace('serve')).toBeGreaterThan(getFlightDragGrace('rally-arc'));
  });

  it('keeps fast rally shots harder through the first flight segment', () => {
    const fast = simulate('rally-fast', 30);
    const arc = simulate('rally-arc', 30);

    expect(Number.isFinite(fast.x)).toBe(true);
    expect(Number.isFinite(arc.x)).toBe(true);
    expect(Math.abs(fast.vx)).toBeGreaterThan(Math.abs(arc.vx));
  });
});
