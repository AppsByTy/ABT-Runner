# Drop-in music

Put your own **royalty-free / owned** tracks here (`.mp3`, `.ogg`, `.wav`, `.m4a`) and rebuild.
They are picked up automatically — no code changes.

Filename decides where a track plays:

| Filename contains | Plays during |
|---|---|
| `menu` | Main menu |
| `boss` | Virus boss fight |
| `debug` | DEBUG MODE / ADMIN ACCESS |
| `gameover` | SYSTEM FAILURE screen |
| anything else | Gameplay (tracks rotate automatically) |

Examples: `menu_chill.mp3`, `run_01.mp3`, `run_02.mp3`, `boss_kernel.ogg`.

Any mode without a file uses the built-in procedural hip-hop soundtrack.

## A long DJ mix

Split it into parts under ~14 MB each and name them `mix-1-<title>.mp3`, `mix-2-<title>.mp3`, … (use `--` for a
separator in the title, e.g. `mix-1-playgrnd-series--mike-nasty.mp3`). The mix then replaces all the music, plays
continuously and resumes where it stopped. Split without re-encoding:

```bash
ffmpeg -i mix.mp3 -f segment -segment_time 860 -reset_timestamps 1 -c copy part-%d.mp3
```

`mix-*` files are git-ignored (the repo is public).
Only use music you own or that is licensed royalty-free.
