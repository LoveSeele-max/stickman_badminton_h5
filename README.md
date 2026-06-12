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
