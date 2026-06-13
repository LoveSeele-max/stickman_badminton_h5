import { describe, expect, it } from 'vitest';
import { createAiIntent } from './ai-controller';
import { Player, Shuttlecock } from './entities';

describe('ai controller difficulty', () => {
  it('lets boss AI serve sooner than normal AI', () => {
    const normalPlayer = new Player('right');
    const bossPlayer = new Player('right');
    const normalShuttle = new Shuttlecock();
    const bossShuttle = new Shuttlecock();
    const opponent = new Player('left');

    normalShuttle.attachTo(normalPlayer);
    bossShuttle.attachTo(bossPlayer);

    const normalIntent = createAiIntent(
      normalPlayer,
      opponent,
      normalShuttle,
      0.6,
      'normal',
    );
    const bossIntent = createAiIntent(
      bossPlayer,
      opponent,
      bossShuttle,
      0.6,
      'boss',
    );

    expect(normalIntent.hitPressed).toBe(false);
    expect(bossIntent.hitPressed).toBe(true);
  });
});
