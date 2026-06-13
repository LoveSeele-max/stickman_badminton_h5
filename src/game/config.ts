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
  maxSpeed: 420,
  acceleration: 2050,
  groundFriction: 7.2,
  airControl: 0.72,
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
  recoveryCancel: 0.56,
  assistForwardMin: 2,
  assistForwardMax: 176,
  assistHeightMin: 44,
  assistHeightMax: 268,
};

export const shuttleConfig = {
  radius: 15,
  gravity: 1180,
  linearDrag: 0.32,
  quadraticDrag: 0.00042,
  postHitDragGrace: 0.12,
  initialDragScale: 0.22,
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
