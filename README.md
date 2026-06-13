# Stick Shuttle Duel

H5 2D stickman badminton prototype based on the project design document in this
repository.

## Current Scope

- Vite + TypeScript + Canvas 2D runtime.
- Fixed timestep update loop with responsive 16:9 world scaling.
- Single player mode: P1 on the left against a lightweight AI on the right.
- Local versus mode: two players on one keyboard.
- Core movement, jumping, serving, swinging, shuttle flight, net contact, scoring,
  pause, restart, and debug hitbox overlay.

## Controls

| Action | P1 | P2 |
|---|---|---|
| Move | A / D | Left / Right |
| Jump | W | Up |
| Hit / serve | S | Down |
| Pause | P / Esc | P / Esc |
| Restart | R | R |
| Menu | M | M |
| Debug overlay | H | H |

At the main menu, press `1` for single player or `2` for local versus.

Hit feel uses one clear swing per hit press. Simple key combinations shape the
shot:

- `S`: stable return.
- `D + S`: faster, flatter forward hit.
- `A + S`: higher defensive lift.
- `W + S`: jump hit, with stronger downward shots when the shuttle is high.

Combo direction is sampled when `S` is pressed. Hit inputs are queued by the
simulation step, so high refresh displays and late recovery presses do not eat
the next swing command.

Shot speed is impulse-first: racket motion, incoming shuttle speed, player
movement, contact zone, and a small aim correction are blended instead of fully
re-solving each hit from a fixed landing point.

Serves use a separate high-serve profile with a simulated target solve, safer
net clearance, and debug readouts for expected landing, net clearance, and
flight time.

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run test
npm run build
```

## Design Notes

The first playable pass keeps the implementation intentionally lean: programmatic
stickman rendering, configurable world constants, shared controller intent for
humans and AI, and data-oriented parameters for physics, racket timing, and
match rules.
