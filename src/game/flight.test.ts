import { describe, expect, it } from 'vitest';
import { getFlightDragGrace, stepFlightState, type FlightState } from './flight';
import type { ShuttleFlightProfile } from './types';

const simulate = (flightProfile: ShuttleFlightProfile): FlightState => {
  let state: FlightState = {
    dragGraceTimer: getFlightDragGrace(flightProfile),
    flightProfile,
    flightTimer: 0,
    vx: 1280,
    vy: -140,
    x: 400,
    y: 420,
  };

  for (let i = 0; i < 90; i += 1) {
    state = stepFlightState(state, 1 / 120);
  }

  return state;
};

describe('flight profiles', () => {
  it('uses separate drag grace for fast rally, arc rally, and serve flights', () => {
    expect(getFlightDragGrace('rally-fast')).toBeLessThan(getFlightDragGrace('rally-arc'));
    expect(getFlightDragGrace('serve')).toBeGreaterThan(getFlightDragGrace('rally-arc'));
  });

  it('keeps fast and arc rally trajectories distinct under the shared simulator', () => {
    const fast = simulate('rally-fast');
    const arc = simulate('rally-arc');

    expect(Number.isFinite(fast.x)).toBe(true);
    expect(Number.isFinite(arc.x)).toBe(true);
    expect(Math.abs(fast.x - arc.x)).toBeGreaterThan(12);
  });
});
