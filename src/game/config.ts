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
  acceleration: 2800,
  groundFriction: 18,
  airControl: 0.46,
  jumpSpeed: 720,
  gravity: 1950,
  coyoteTime: 0.08,
  jumpBuffer: 0.12,
};

export const racketConfig = {
  length: 108,
  hitRadius: 34,
  normalWindup: 0.07,
  normalActive: 0.12,
  normalRecovery: 0.18,
  powerWindup: 0.11,
  powerActive: 0.1,
  powerRecovery: 0.34,
};

export const shuttleConfig = {
  radius: 15,
  gravity: 1040,
  linearDrag: 0.28,
  quadraticDrag: 0.00046,
  maxSpeed: 1250,
};

export const matchConfig = {
  targetScore: 7,
  pointPause: 1.15,
};

export const aiConfig = {
  reactionInterval: 0.12,
  targetError: 34,
  serveDelay: 0.85,
};
