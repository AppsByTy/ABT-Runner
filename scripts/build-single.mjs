// Builds the game into ONE self-contained HTML file (JS, CSS, fonts, model inlined).
// usage: node scripts/build-single.mjs OUT.html "build label"
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const [out, label = 'dev'] = process.argv.slice(2);
execSync('npx vite build', { stdio: 'inherit' });
const assets = readdirSync('dist/assets');
const js = readFileSync(`dist/assets/${assets.find((f) => f.endsWith('.js'))}`, 'utf8');
const css = readFileSync(`dist/assets/${assets.find((f) => f.endsWith('.css'))}`, 'utf8');
// A literal "</script>" inside the bundle would end the inline tag early.
if (/<\/script/i.test(js)) throw new Error('bundle contains </script>');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no" />
<meta name="theme-color" content="#020a18" />
<meta name="build" content="${label.replace(/"/g, '')}" />
<title>AppsByTy Code Runner</title>
<style>:root{color-scheme:dark}</style>
<style>${css}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">${js}</script>
</body>
</html>`;
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1e6).toFixed(2)} MB`);
