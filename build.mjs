// Compile l'appli en un seul fichier compatible avec les vieux navigateurs.
//   npm install   (une fois)
//   npm run build (après chaque modification de js/ ou css/)
// Résultat : dist/app.js et dist/style.css, chargés par index.html.
import * as esbuild from 'esbuild';

// Navigateurs visés : Chrome 51+ (2016, tablettes Android 6/7 et plus), Safari 11+, Firefox 54+
const target = ['chrome51', 'safari11', 'firefox54', 'edge79'];

await esbuild.build({
  entryPoints: ['js/main.js'],
  bundle: true,
  format: 'iife',
  target,
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  outfile: 'dist/app.js',
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: ['css/style.css'],
  bundle: true,
  target,
  minify: true,
  charset: 'utf8',
  outfile: 'dist/style.css',
  logLevel: 'info',
});
