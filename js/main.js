// Point d'entrée de la version compilée (dist/app.js).
// Ajoute aux vieux navigateurs les fonctions JavaScript modernes qui leur
// manquent (polyfills), puis lance l'appli.
import 'core-js/stable';
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch';
import './app.js';
