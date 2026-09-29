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
 *
 * A long DJ mix can be dropped in as numbered parts - `mix-1-<title>.mp3`,
 * `mix-2-<title>.mp3`, ... - and then it IS the soundtrack: one continuous
 * playlist for every screen (menu, run, boss, game over just colour it with
 * filters), played part after part and remembered between sessions. Parts
 * are streamed, never decoded whole, so an hour of music costs no memory.
 * Name: "mix-1-playgrnd-series--mike-nasty" shows as PLAYGRND SERIES · MIKE NASTY.
 */
const found = import.meta.glob('../../assets/music/*.{mp3,ogg,wav,m4a}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface MusicTrack {
  name: string;
  url: string;
  mode: MusicMode | 'mix';
}

const MIX_RE = /^mix[-_ ]?(\d+)[-_ ]?/i;

function classify(name: string): MusicMode | 'mix' {
  const n = name.toLowerCase();
  if (MIX_RE.test(n)) return 'mix';
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
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

/** The DJ mix parts in order (empty = no mix, use the per-mode files / engine). */
export const MIX: MusicTrack[] = MUSIC_FILES.filter((t) => t.mode === 'mix');

/** Display title of the mix, from the first part's file name. */
export const MIX_TITLE = MIX.length
  ? MIX[0].name
      .replace(MIX_RE, '')
      .split('--')
      .map((w) => w.replace(/[-_]+/g, ' ').trim().toUpperCase())
      .join(' · ')
  : '';

export function tracksFor(mode: MusicMode): MusicTrack[] {
  const list = MUSIC_FILES.filter((t) => t.mode === mode);
  // DEBUG falls back to the gameplay files when there is no dedicated debug track.
  if (!list.length && mode === 'debug') return MUSIC_FILES.filter((t) => t.mode === 'run');
  return list;
}
