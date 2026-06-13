import { shuttleConfig } from './config';
import { clamp, lerp } from './math';
import type { ShuttleFlightProfile } from './types';

export interface FlightState {
  dragGraceTimer: number;
  flightProfile: ShuttleFlightProfile;
  flightTimer: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

interface FlightTuning {
  descentDragScale: number;
  graceDuration: number;
  initialDragScale: number;
  lateDuration: number;
  lateHorizontalScale: number;
  lateStart: number;
  maxFallSpeed: number;
}

export const getFlightDragGrace = (profile: ShuttleFlightProfile): number =>
  getFlightTuning(profile).graceDuration;

export const stepFlightState = (state: FlightState, dt: number): FlightState => {
  const tuning = getFlightTuning(state.flightProfile);
  const dragProgress = clamp(
    1 - state.dragGraceTimer / Math.max(tuning.graceDuration, 0.001),
    0,
    1,
  );
  const smoothProgress = smoothstep(dragProgress);
  const lateProgress = smoothstep(
    clamp((state.flightTimer - tuning.lateStart) / tuning.lateDuration, 0, 1),
  );
  const startDragScale = lerp(
    tuning.initialDragScale,
    1,
    smoothProgress,
  );
  const horizontalDragScale = lerp(
    startDragScale,
    tuning.lateHorizontalScale,
    lateProgress,
  );
  const verticalDragScale =
    state.vy > 0
      ? lerp(startDragScale, tuning.descentDragScale, lateProgress)
      : startDragScale;
  const horizontalDrag =
    1 -
    Math.min(
      0.84,
      (shuttleConfig.horizontalLinearDrag +
        shuttleConfig.horizontalQuadraticDrag * Math.abs(state.vx)) *
        horizontalDragScale *
        dt,
    );
  const verticalDrag =
    1 -
    Math.min(
      0.72,
      (shuttleConfig.verticalLinearDrag +
        shuttleConfig.verticalQuadraticDrag * Math.abs(state.vy)) *
        verticalDragScale *
        dt,
    );
  let vx = state.vx * horizontalDrag;
  let vy = Math.min(
    state.vy * verticalDrag + shuttleConfig.gravity * dt,
    tuning.maxFallSpeed,
  );
  const speed = Math.hypot(vx, vy);

  if (speed > shuttleConfig.maxSpeed) {
    const scale = shuttleConfig.maxSpeed / speed;
    vx *= scale;
    vy *= scale;
  }

  return {
    ...state,
    dragGraceTimer: Math.max(0, state.dragGraceTimer - dt),
    flightTimer: state.flightTimer + dt,
    vx,
    vy,
    x: state.x + vx * dt,
    y: state.y + vy * dt,
  };
};

const getFlightTuning = (profile: ShuttleFlightProfile): FlightTuning => {
  if (profile === 'serve') {
    return {
      descentDragScale: shuttleConfig.serveDescentDragScale,
      graceDuration: shuttleConfig.serveDragGrace,
      initialDragScale: shuttleConfig.initialDragScale,
      lateDuration: 0.82,
      lateHorizontalScale: shuttleConfig.serveLateHorizontalDragScale,
      lateStart: 0.5,
      maxFallSpeed: shuttleConfig.maxFallSpeed,
    };
  }

  if (profile === 'rally-fast') {
    return {
      descentDragScale: shuttleConfig.rallyFastDescentDragScale,
      graceDuration: shuttleConfig.rallyFastDragGrace,
      initialDragScale: shuttleConfig.rallyFastInitialDragScale,
      lateDuration: 0.42,
      lateHorizontalScale: shuttleConfig.rallyFastLateHorizontalDragScale,
      lateStart: 0.36,
      maxFallSpeed: shuttleConfig.rallyFastMaxFallSpeed,
    };
  }

  return {
    descentDragScale: shuttleConfig.rallyArcDescentDragScale,
    graceDuration: shuttleConfig.postHitDragGrace,
    initialDragScale: shuttleConfig.rallyArcInitialDragScale,
    lateDuration: 0.66,
    lateHorizontalScale: shuttleConfig.rallyArcLateHorizontalDragScale,
    lateStart: 0.46,
    maxFallSpeed: shuttleConfig.rallyArcMaxFallSpeed,
  };
};

const smoothstep = (value: number): number => {
  const t = clamp(value, 0, 1);

  return t * t * (3 - 2 * t);
};
