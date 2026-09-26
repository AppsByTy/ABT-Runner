export const GameState = {
  Ready: 'ready',
  Playing: 'playing',
  Paused: 'paused',
  Dying: 'dying',
  GameOver: 'gameover',
} as const;

export type GameState = (typeof GameState)[keyof typeof GameState];

/** Legal transitions. Anything not listed is rejected by the state machine. */
export const TRANSITIONS: Record<GameState, readonly GameState[]> = {
  ready: ['playing'],
  playing: ['paused', 'dying'],
  paused: ['playing', 'ready'],
  dying: ['gameover'],
  gameover: ['ready', 'playing'],
};
