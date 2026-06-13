export const worldConfig = {
  width: 1600,
  height: 900,
  groundY: 780,
  netX: 800,
  netWidth: 18,
  netHeight: 245,
  sidePadding: 54,
};

export const playerConfig = {
  height: 170,
  radius: 38,
  maxSpeed: 455,
  groundAcceleration: 18000,
  groundDeceleration: 22000,
  airAcceleration: 11800,
  jumpSpeed: 725,
  gravity: 1950,
  coyoteTime: 0.08,
  jumpBuffer: 0.14,
};

export const racketConfig = {
  length: 124,
  hitRadius: 44,
  windup: 0.035,
  active: 0.16,
  recovery: 0.16,
  hitBuffer: 0.15,
  recoveryCancel: 0.42,
  assistForwardMin: 2,
  assistForwardMax: 176,
  assistHeightMin: 44,
  assistHeightMax: 268,
};

export const shuttleConfig = {
  radius: 15,
  gravity: 1180,
  horizontalLinearDrag: 0.36,
  horizontalQuadraticDrag: 0.0005,
  verticalLinearDrag: 0.18,
  verticalQuadraticDrag: 0.00024,
  postHitDragGrace: 0.34,
  serveDragGrace: 0.72,
  initialDragScale: 0.22,
  rallyArcInitialDragScale: 0.28,
  rallyArcLateHorizontalDragScale: 0.98,
  rallyArcDescentDragScale: 1.22,
  rallyArcMaxFallSpeed: 860,
  rallyFastDragGrace: 0.34,
  rallyFastInitialDragScale: 0.12,
  rallyFastLateHorizontalDragScale: 1.12,
  rallyFastDescentDragScale: 1.08,
  rallyFastMaxFallSpeed: 960,
  serveLateHorizontalDragScale: 0.72,
  serveDescentDragScale: 1.16,
  maxFallSpeed: 900,
  maxSpeed: 2100,
};

export const matchConfig = {
  targetScore: 7,
  pointPause: 1.15,
};

export const aiConfig = {
  reactionInterval: 0.2,
  targetError: 72,
  serveDelay: 0.95,
};
