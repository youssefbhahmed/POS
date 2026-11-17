// Point d'entrée : connexion (mode cloud), accueil, navigation.

import { db, isCloud } from './db.js';
import { mountPOS } from './pos.js';
import { mountAdmin } from './admin.js';
import { esc, toast } from './ui.js';
import { loadSettings } from './data.js';
import { icon } from './icons.js';

const root = document.getElementById('app');
let cleanup = null;
let routeId = 0;

async function route() {
  const my = ++routeId;
  if (cleanup) {
    try { cleanup(); } catch {}
    cleanup = null;
  }
  const h = location.hash || '#/';
  // Compte « caisse » : uniquement l'écran de caisse
  if (db.role !== 'manager' && !h.startsWith('#/caisse')) {
    if (h.startsWith('#/admin')) toast('Back-office réservé au gérant', 'error');
    location.replace('#/caisse');
    return;
  }
  root.innerHTML = '<div class="loading">Chargement…</div>';
  try {
    let c;
    if (h.startsWith('#/caisse')) c = await mountPOS(root);
    else if (h.startsWith('#/admin')) c = await mountAdmin(root, h);
    else c = await mountHome();
    if (my !== routeId) c?.();
    else cleanup = c;
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="center-page"><div class="card narrow"><h2>Erreur</h2><p>${esc(err.message || err)}</p>
      <button class="btn primary" onclick="location.reload()">Recharger</button></div></div>`;
  }
}

async function mountHome() {
  const s = await loadSettings();
  const session = await db.getSession();
  const hello = new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir';
  root.innerHTML = `<div class="center-page home">
    <div class="home-head"><div class="logo big">${icon('coffee', 34)}</div><span class="eyebrow">${hello}</span><h1>${esc(s.shopName)}</h1>
      <p class="muted">${isCloud ? `Connecté · ${esc(session?.user?.email || '')}` : 'Mode local (démo) · données stockées sur cet appareil'}</p></div>
    <div class="home-cards">
      <a class="home-card c-berry" href="#/caisse"><span class="hc-icon">${icon('receipt', 26)}</span><span class="hc-arrow">${icon('arrow')}</span><b>Caisse</b><span class="muted">Tables, commandes, encaissement et tickets</span></a>
      <a class="home-card c-violet" href="#/admin"><span class="hc-icon">${icon('chart', 26)}</span><span class="hc-arrow">${icon('arrow')}</span><b>Back-office</b><span class="muted">Suivi en direct, chiffre d'affaires, carte</span></a>
    </div>
    ${isCloud ? `<button class="btn ghost" id="logout">${icon('logout', 18)} Se déconnecter</button>` : ''}
  </div>`;
  root.querySelector('#logout')?.addEventListener('click', async () => {
    await db.signOut();
    location.hash = '#/';
    location.reload();
  });
}

function showLogin() {
  root.innerHTML = `<div class="center-page"><form class="card narrow form" id="login">
    <div class="logo big">${icon('coffee', 34)}</div><h2>Connexion</h2><p class="muted" style="text-align:center;margin:0 0 8px">Accès réservé à l'équipe</p>
    <label class="field"><span>Email</span><input class="input" type="email" id="em" autocomplete="username" required></label>
    <label class="field"><span>Mot de passe</span><input class="input" type="password" id="pw" autocomplete="current-password" required></label>
    <button class="btn primary big" type="submit">Se connecter</button></form></div>`;
  root.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await db.signIn(root.querySelector('#em').value.trim(), root.querySelector('#pw').value);
      start();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

let started = false;
async function start() {
  if (isCloud && !(await db.getSession())) return showLogin();
  db.role = await db.getRole();
  if (!started) {
    started = true;
    window.addEventListener('hashchange', route);
  }
  route();
}

(async () => {
  try {
    await db.init();
  } catch (e) {
    root.innerHTML = `<div class="center-page"><div class="card narrow"><h2>Connexion impossible</h2><p>Vérifiez la connexion internet puis rechargez.</p><p class="muted">${esc(e.message)}</p></div></div>`;
    return;
  }
  start();
})();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Mise à jour automatique : la caisse reste ouverte toute la journée, on vérifie
// toutes les 5 min si une nouvelle version a été publiée, et on recharge
// uniquement quand personne n'est en train de saisir (écran des tables, aucune fenêtre).
(function autoUpdate() {
  let initial = null;
  let pending = false;
  const stamp = async () => {
    const r = await fetch('index.html', { method: 'HEAD', cache: 'no-cache' });
    return r.headers.get('etag') || r.headers.get('last-modified');
  };
  const idle = () =>
    !document.querySelector('.modal-backdrop, .order-view, form#login') && document.visibilityState === 'visible';
  const tryReload = () => {
    if (pending && idle()) location.reload();
  };
  stamp().then((s) => (initial = s)).catch(() => {});
  setInterval(async () => {
    try {
      const s = await stamp();
      if (initial && s && s !== initial) pending = true;
      else if (!initial) initial = s;
    } catch {}
    tryReload();
  }, 5 * 60 * 1000);
  setInterval(tryReload, 10 * 1000);
})();
