import type { MusicMode } from './HipHopEngine';

/**
 * Drop-in soundtrack files. Put .mp3 / .ogg / .wav / .m4a files in
 * `assets/music/` and rebuild - they are picked up automatically.
 *
 * The filename decides where a track plays:
 *   *menu*      -> main menu
 *   *boss*      -> virus boss fight
 *   *debug*     -> DEBUG MODE / ADMIN power-ups
 *   *gameover*  -> SYSTEM FAILURE screen
 *   anything else -> gameplay rotation (tracks auto-switch when one ends)
 *
 * Any mode without a file keeps using the procedural hip-hop engine.
 */
const found = import.meta.glob('../../assets/music/*.{mp3,ogg,wav,m4a}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface MusicTrack {
  name: string;
  url: string;
  mode: MusicMode;
}

function classify(name: string): MusicMode {
  const n = name.toLowerCase();
  if (n.includes('menu')) return 'menu';
  if (n.includes('boss')) return 'boss';
  if (n.includes('debug')) return 'debug';
  if (n.includes('gameover') || n.includes('game-over') || n.includes('game_over')) return 'gameover';
  return 'run';
}

export const MUSIC_FILES: MusicTrack[] = Object.entries(found)
  .map(([path, url]) => {
    const name = path.split('/').pop()!.replace(/\.[^.]+$/, '');
    return { name, url, mode: classify(name) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

export function tracksFor(mode: MusicMode): MusicTrack[] {
  const list = MUSIC_FILES.filter((t) => t.mode === mode);
  // DEBUG falls back to the gameplay files when there is no dedicated debug track.
  if (!list.length && mode === 'debug') return MUSIC_FILES.filter((t) => t.mode === 'run');
  return list;
}
