// BACK-OFFICE : suivi en direct, chiffre d'affaires, historique,
// gestion des produits / tables / paramètres.

import { db, uid, isCloud, nowIso } from './db.js';
import { esc, modal, confirmDlg, promptDlg, toast, debounce, fmtDate, fmtDateTime, fmtTime, since, startOfDay, addDays, toLocalInput, dayKey, download } from './ui.js';
import { fmt, parseMoney, toInput } from './money.js';
import { loadSettings, saveSettings, fetchClosed, fetchOpen, computeStats, orderTotal, PAY_LABELS, PAY_STATS_LABELS, bySortName } from './data.js';
import { buildOrderTicket, buildTestTicket, toHTML } from './ticket.js';
import { printDoc, previewTicket } from './printer.js';
import { icon } from './icons.js';

const TABS = [
  ['live', 'En direct', 'activity', 'Suivi en temps réel', 'berry'],
  ['stats', "Chiffre d'affaires", 'chart', 'Ventes & performances', 'orange'],
  ['history', 'Historique', 'history', 'Tickets', 'violet'],
  ['products', 'Produits', 'package', 'Carte', 'mint'],
  ['tables', 'Tables', 'grid', 'Salle', 'blue'],
  ['settings', 'Paramètres', 'sliders', 'Ticket & sécurité', 'sun'],
];
const PAY_ICON = { cash: ['wallet', 'mint'], card: ['card', 'violet'], other: ['dots', 'sun'], legacy: ['history', 'blue'] };

// Résumé de l'ancienne caisse (importé) : totaux par produit sur toute la période
function legacyCard(L) {
  if (!L) return '';
  const max = Math.max(1, ...L.products.map((p) => p.amount));
  return `<section class="card"><div class="card-head"><h3>Ancienne caisse <small class="muted">· du ${fmtDate(L.from)} au ${fmtDate(L.to)}</small></h3>
      <span class="badge">${L.days} jours importés</span></div>
    <div class="kpis small4">
      ${kpi("CA net", fmt(L.net))}${kpi('Commandes', L.orders.toLocaleString('fr-FR'))}${kpi('Panier moyen', fmt(L.avg))}${kpi('Remises', fmt(L.discounts))}
    </div>
    <p class="hint mt">L'ancienne caisse n'exporte que des totaux : le chiffre par jour est dans les graphiques ci-dessus, le détail par produit ci-dessous (sur toute la période).</p>
    <div class="table-wrap mt"><table class="data"><thead><tr><th>Produit</th><th>Catégorie</th><th class="num">Quantité</th><th class="num">CA net</th><th class="num">% du CA</th></tr></thead>
    <tbody>${L.products.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.category)}</td><td class="num">${p.qty.toLocaleString('fr-FR')}</td><td class="num"><b>${fmt(p.amount)}</b></td>
      <td class="num"><span class="share">${L.net ? ((p.amount / L.net) * 100).toFixed(1) : 0} %<i style="--w:${(p.amount / max) * 100}%"></i></span></td></tr>`).join('')}</tbody></table></div></section>`;
}

export async function mountAdmin(root, hash) {
  if (db.role !== 'manager') {
    location.replace('#/caisse');
    return () => {};
  }
  const settings = await loadSettings();
  let ok = false;
  try { ok = sessionStorage.getItem('admin_ok') === '1'; } catch {}
  if (settings.adminPin && !ok) {
    const pin = await promptDlg('Back-office', 'Code PIN', '', 'password');
    if (pin !== settings.adminPin) {
      if (pin !== null) toast('Code incorrect', 'error');
      location.hash = '#/';
      return () => {};
    }
    try { sessionStorage.setItem('admin_ok', '1'); } catch {}
  }
  const tab = TABS.some(([k]) => k === hash.split('/')[2]) ? hash.split('/')[2] : 'live';
  const cur = TABS.find(([k]) => k === tab);
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  root.innerHTML = `<div class="admin">
    <aside class="side">
      <a class="brand" href="#/"><span class="logo">${icon('coffee', 22)}</span><span><span class="brand-name">${esc(settings.shopName)}</span><span class="brand-sub">Back-office</span></span></a>
      <nav class="nav">${TABS.map(([k, l, ic, , col]) => `<a class="nav-item ${k === tab ? 'on' : ''}" style="--c:var(--${col})" href="#/admin/${k}" title="${l}"><span class="ni">${icon(ic, 18)}</span><span>${l}</span></a>`).join('')}</nav>
      <div class="side-foot">
        <span class="live-dot ${isCloud ? 'on' : ''}">${isCloud ? 'Synchronisé en temps réel' : 'Mode local (démo)'}</span>
        <a class="btn sm" href="#/caisse">${icon('receipt', 16)}<span class="hide-sm">Ouvrir la caisse</span></a>
      </div>
    </aside>
    <div class="admin-body">
      <header class="page-head"><div><span class="eyebrow">${cur[3]}</span><h1>${cur[1]}</h1></div><span class="date">${today}</span></header>
      <main id="admin-main" class="admin-main"></main>
    </div></div>`;
  const ctx = { main: root.querySelector('#admin-main'), settings, cleanups: [] };
  await PAGES[tab](ctx);
  return () => ctx.cleanups.forEach((f) => f());
}

const statusBadge = (s) =>
  ({ open: '<span class="badge warn">● En cours</span>', paid: '<span class="badge ok">✓ Encaissé</span>', cancelled: '<span class="badge danger">✕ Annulé</span>' })[s] || s;

const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

// ── Sélecteur de période (partagé) ───────────────────────────
const PRESETS = [
  ['today', "Aujourd'hui"], ['yesterday', 'Hier'], ['7d', '7 jours'], ['30d', '30 jours'],
  ['month', 'Ce mois'], ['lastmonth', 'Mois dernier'],
];
const R = { preset: 'today', from: null, to: null };
function presetRange(p) {
  const t = startOfDay();
  const y = t.getFullYear(), m = t.getMonth();
  switch (p) {
    case 'yesterday': return [addDays(t, -1), t];
    case '7d': return [addDays(t, -6), addDays(t, 1)];
    case '30d': return [addDays(t, -29), addDays(t, 1)];
    case 'month': return [new Date(y, m, 1), new Date(y, m + 1, 1)];
    case 'lastmonth': return [new Date(y, m - 1, 1), new Date(y, m, 1)];
    default: return [t, addDays(t, 1)];
  }
}
if (!R.from) [R.from, R.to] = presetRange('today');

function rangeBar() {
  return `<div class="rangebar">
    <div class="chips">${PRESETS.map(([k, l]) => `<button class="chip ${R.preset === k ? 'on' : ''}" data-preset="${k}">${l}</button>`).join('')}</div>
    <div class="range-custom">
      <label>Du <input type="datetime-local" class="input" id="r-from" value="${toLocalInput(R.from)}"></label>
      <label>au <input type="datetime-local" class="input" id="r-to" value="${toLocalInput(R.to)}"></label>
      <button class="btn" data-a="range-apply">Appliquer</button>
    </div></div>`;
}
function bindRange(main, onChange) {
  main.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) {
      R.preset = p.dataset.preset;
      [R.from, R.to] = presetRange(R.preset);
      return onChange();
    }
    if (e.target.closest('[data-a="range-apply"]')) {
      const f = new Date(main.querySelector('#r-from').value);
      const t = new Date(main.querySelector('#r-to').value);
      if (isNaN(f) || isNaN(t) || t <= f) return toast('Période invalide', 'error');
      R.preset = 'custom';
      R.from = f;
      R.to = t;
      onChange();
    }
  });
}

// ── Graphique en barres (une seule série) ────────────────────
function niceStep(max, n = 4) {
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
function drawBarChart(el, buckets) {
  const W = Math.max(300, el.clientWidth);
  const H = 240;
  const P = { l: 52, r: 8, t: 14, b: 26 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxV = Math.max(...buckets.map((b) => b.value), 0);
  const step = maxV > 0 ? niceStep(maxV) : 1000;
  const top = Math.max(step, Math.ceil(maxV / step) * step);
  const n = buckets.length || 1;
  const colW = iw / n;
  const bw = Math.max(2, Math.min(36, colW - 2));
  const y = (v) => P.t + ih - (v / top) * ih;
  const lab = (v) => `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}`;
  const every = Math.max(1, Math.ceil(n / Math.floor(iw / 44)));
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Chiffre d'affaires par période">
    <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F97316"/><stop offset="1" stop-color="#E11D48"/></linearGradient></defs>`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${lab(v)}</text>`;
  }
  buckets.forEach((b, i) => {
    const x = P.l + i * colW + (colW - bw) / 2;
    const h = Math.max(0, (b.value / top) * ih);
    const by = P.t + ih - h;
    const r = Math.min(4, h, bw / 2);
    const path = h > 0 ? `M${x},${by + h}V${by + r}Q${x},${by} ${x + r},${by}H${x + bw - r}Q${x + bw},${by} ${x + bw},${by + r}V${by + h}Z` : '';
    const tip = `${b.title}|${fmt(b.value)}|${b.count} ticket${b.count > 1 ? 's' : ''}`;
    svg += `<g class="col" data-tip="${esc(tip)}"><rect class="hit" x="${P.l + i * colW}" y="${P.t}" width="${colW}" height="${ih}"/>${path ? `<path class="bar" d="${path}"/>` : ''}</g>`;
    if (i % every === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  svg += `<line class="baseline" x1="${P.l}" x2="${W - P.r}" y1="${P.t + ih}" y2="${P.t + ih}"/></svg><div class="tooltip" hidden></div>`;
  el.innerHTML = svg;
  const tt = el.querySelector('.tooltip');
  el.addEventListener('pointermove', (e) => {
    const g = e.target.closest('[data-tip]');
    if (!g) return (tt.hidden = true);
    const [t, v, c] = g.dataset.tip.split('|');
    tt.innerHTML = `<div class="tt-t">${esc(t)}</div><div class="tt-v">${esc(v)}</div><div class="tt-s">${esc(c)}</div>`;
    tt.hidden = false;
    const box = el.getBoundingClientRect();
    const x = Math.min(e.clientX - box.left + 12, box.width - tt.offsetWidth - 4);
    tt.style.left = `${Math.max(4, x)}px`;
    tt.style.top = `${Math.max(4, e.clientY - box.top - tt.offsetHeight - 10)}px`;
  });
  el.addEventListener('pointerleave', () => (tt.hidden = true));
}

// ── Pages ────────────────────────────────────────────────────
const PAGES = {
  // EN DIRECT
  async live(ctx) {
    const draw = async () => {
      const t0 = startOfDay();
      const [open, today, tables] = await Promise.all([fetchOpen(), fetchClosed(t0, addDays(t0, 1)), db.list('cafe_tables')]);
      const st = computeStats(today.orders, today.items, t0, addDays(t0, 1));
      const itemsOf = (o) => open.items.filter((i) => i.order_id === o.id);
      const pending = open.orders.reduce((s, o) => s + orderTotal(itemsOf(o)), 0);
      const activeTables = tables.filter((t) => t.active !== false).sort(bySortName);
      const ids = new Set(activeTables.map((t) => t.id));

      const card = (name, o) => {
        if (!o) return `<div class="live-card free"><div class="lc-head"><b>${esc(name)}</b><span class="badge">Libre</span></div></div>`;
        const its = itemsOf(o).filter((i) => i.qty > 0);
        return `<div class="live-card busy"><div class="lc-head"><b>${esc(name)}</b><span class="badge warn">● ${since(o.opened_at)}</span></div>
          <ul>${its.map((i) => `<li><span>${i.qty} × ${esc(i.product_name)}</span><span>${fmt(i.qty * i.unit_price, false)}</span></li>`).join('') || '<li class="muted">Aucun article</li>'}</ul>
          <div class="lc-foot"><span>N° ${o.number ?? ''}</span><b>${fmt(orderTotal(its))}</b></div></div>`;
      };

      const orderById = new Map([...open.orders, ...today.orders].map((o) => [o.id, o]));
      const feed = [...open.items, ...today.items]
        .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))
        .slice(0, 40)
        .map((i) => {
          const o = orderById.get(i.order_id);
          const status = i.qty === 0 ? 'cancelled' : o?.status;
          return `<tr><td>${fmtTime(i.updated_at || i.created_at)}</td><td>${esc(o?.table_name || '')}</td>
            <td>${i.qty || i.cancelled_qty} × ${esc(i.product_name)}${i.qty && i.cancelled_qty ? ` <small class="muted">(${i.cancelled_qty} retiré)</small>` : ''}</td>
            <td class="num">${fmt((i.qty || i.cancelled_qty) * i.unit_price, false)}</td><td>${statusBadge(status)}</td></tr>`;
        });

      ctx.main.innerHTML = `
        <div class="kpis">
          ${kpi("CA encaissé aujourd'hui", fmt(st.revenue), `${st.itemsSold} articles vendus`, 'hero')}
          ${kpi('Tickets', st.tickets, `Panier moyen ${fmt(st.avg)}`)}
          ${kpi('En cours (non encaissé)', fmt(pending), `${open.orders.length} commande${open.orders.length > 1 ? 's' : ''} ouverte${open.orders.length > 1 ? 's' : ''}`)}
          ${kpi('Annulations', st.cancelledOrders.count + st.cancelledLines.qty, `${fmt(st.cancelledOrders.amount + st.cancelledLines.amount)} retirés`)}
        </div>
        <section class="card"><h3>Tables</h3><div class="live-grid">
          ${open.orders.filter((o) => !o.table_id || !ids.has(o.table_id)).map((o) => card(o.table_name || 'Comptoir', o)).join('')}
          ${activeTables.map((t) => card(t.name, open.orders.find((o) => o.table_id === t.id))).join('')}
        </div></section>
        <section class="card"><h3>Dernières commandes</h3>
          ${feed.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Heure</th><th>Table</th><th>Article</th><th class="num">Montant</th><th>Statut</th></tr></thead><tbody>${feed.join('')}</tbody></table></div>` : '<p class="muted">Rien pour le moment aujourd’hui.</p>'}
        </section>`;
    };
    await draw();
    const unsub = db.subscribe(debounce(() => draw().catch(console.error), 400));
    const timer = setInterval(() => draw().catch(console.error), 60000);
    ctx.cleanups.push(unsub, () => clearInterval(timer));
  },

  // CHIFFRE D'AFFAIRES
  async stats(ctx) {
    const { main } = ctx;
    let s = null;
    let sortKey = 'amount', sortDir = -1;
    let catColors = {};
    const FALLBACK = ['#EA580C', '#2563EB', '#DB2777', '#059669', '#7C3AED', '#F59E0B'];
    const colorOf = (name) => catColors[name] || FALLBACK[[...String(name)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % FALLBACK.length];
    const paint = () => {
      const prods = [...s.products].sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        return (typeof va === 'string' ? va.localeCompare(vb, 'fr') : va - vb) * sortDir;
      });
      const th = (k, l, num) => `<th class="${num ? 'num' : ''} sortable" data-sort="${k}">${l}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
      const maxCat = Math.max(1, ...s.categories.map((c) => c.amount));
      main.innerHTML = `${rangeBar()}
        <div class="kpis">
          ${kpi("Chiffre d'affaires", fmt(s.revenue), R.preset === 'custom' ? 'Période personnalisée' : PRESETS.find(([k]) => k === R.preset)?.[1], 'hero')}
          ${kpi('Tickets', s.tickets, s.legacyRevenue ? 'nouvelle caisse uniquement' : '')}
          ${kpi('Panier moyen', fmt(s.avg), s.legacyRevenue ? 'nouvelle caisse uniquement' : '')}
          ${kpi('Articles vendus', s.itemsSold, s.legacyRevenue ? `nouvelle caisse · ${fmt(s.legacyRevenue)} de CA importé` : '')}
        </div>
        <section class="card"><h3>Chiffre d'affaires par ${s.unit === 'hour' ? 'heure' : 'jour'} <small class="muted">(DT)</small></h3><div class="chart" id="chart"></div></section>
        <div class="two-col">
          <section class="card"><h3>Par catégorie</h3>${s.categories.map((c) => `
            <div class="hbar" style="--c:${esc(colorOf(c.name))}"><div class="hb-l"><span><span class="pdot" style="background:var(--c)"></span>${esc(c.name)}</span><span>${fmt(c.amount)} <small class="muted">· ${c.qty} art.</small></span></div>
            <div class="hb-track"><div class="hb-fill" style="width:${(c.amount / maxCat) * 100}%"></div></div></div>`).join('') || '<p class="muted">Aucune vente.</p>'}</section>
          <section class="card"><h3>Par mode de paiement</h3>
            ${Object.entries(s.payments).map(([m, v]) => `<div class="pay-row" style="--c:var(--${PAY_ICON[m]?.[1] || 'sun'})"><span class="pi">${icon(PAY_ICON[m]?.[0] || 'dots')}</span>
              <span class="pn">${PAY_STATS_LABELS[m] || m}<small>${v.count} ticket${v.count > 1 ? 's' : ''} · ${s.revenue ? Math.round((v.amount / s.revenue) * 100) : 0} %</small></span><b>${fmt(v.amount)}</b></div>`).join('') || '<p class="muted">Aucun encaissement.</p>'}
            <h3 class="mt">Annulations</h3>
            <table class="data"><tbody>
              <tr><td>Commandes annulées</td><td class="num">${s.cancelledOrders.count}</td><td class="num">${fmt(s.cancelledOrders.amount)}</td></tr>
              <tr><td>Articles retirés (commandes encaissées)</td><td class="num">${s.cancelledLines.qty}</td><td class="num">${fmt(s.cancelledLines.amount)}</td></tr>
            </tbody></table></section>
        </div>
        <section class="card"><div class="card-head"><h3>Par produit</h3><button class="btn sm" data-a="csv" ${prods.length ? '' : 'disabled'}>${icon('download', 16)} Exporter (CSV)</button></div>
          ${prods.length ? `<div class="table-wrap"><table class="data"><thead><tr>${th('name', 'Produit')}${th('category', 'Catégorie')}${th('qty', 'Quantité', 1)}${th('amount', 'CA', 1)}<th class="num">% du CA</th></tr></thead>
          <tbody>${prods.map((p) => { const pct = s.revenue ? (p.amount / s.revenue) * 100 : 0; return `<tr style="--c:${esc(colorOf(p.category))}"><td><b>${esc(p.name)}</b></td><td><span class="pdot" style="background:var(--c)"></span>${esc(p.category)}</td><td class="num">${p.qty}</td><td class="num"><b>${fmt(p.amount)}</b></td><td class="num"><span class="share">${pct.toFixed(1)} %<i style="--w:${Math.min(100, pct * 3)}%"></i></span></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">Aucune vente sur cette période.</p>'}
        </section>
        ${legacyCard(ctx.settings.legacy)}`;
      drawBarChart(main.querySelector('#chart'), s.buckets);
    };
    const draw = async (silent) => {
      if (!silent) main.innerHTML = `${rangeBar()}<div class="loading">Calcul…</div>`;
      const [{ orders, items }, cats] = await Promise.all([fetchClosed(R.from, R.to), db.list('categories')]);
      catColors = Object.fromEntries(cats.map((c) => [c.name, c.color]));
      s = computeStats(orders, items, R.from, R.to);
      paint();
    };
    bindRange(main, () => draw());
    main.addEventListener('click', (e) => {
      const h = e.target.closest('[data-sort]');
      if (h) {
        const k = h.dataset.sort;
        if (sortKey === k) sortDir *= -1;
        else { sortKey = k; sortDir = k === 'name' || k === 'category' ? 1 : -1; }
        paint();
      }
      if (e.target.closest('[data-a="csv"]')) {
        const rows = [['Produit', 'Catégorie', 'Quantité', 'CA (DT)'], ...s.products.map((p) => [p.name, p.category, p.qty, (p.amount / 1000).toFixed(3).replace('.', ',')])];
        const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
        download(`ventes_${dayKey(R.from)}_${dayKey(addDays(R.to, -0.0001))}.csv`, csv, 'text/csv');
      }
    });
    await draw();
    const unsub = db.subscribe(debounce(() => R.to > new Date() && draw(true).catch(console.error), 1500));
    ctx.cleanups.push(unsub);
  },

  // HISTORIQUE DES TICKETS
  async history(ctx) {
    const { main } = ctx;
    let data = null, filter = 'all', openId = null;
    const paint = () => {
      const list = data.orders.filter((o) => filter === 'all' || o.status === filter).reverse();
      const its = (o) => data.items.filter((i) => i.order_id === o.id);
      main.innerHTML = `${rangeBar()}
        <div class="chips mb">${[['all', 'Tous'], ['paid', 'Encaissés'], ['cancelled', 'Annulés']].map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
          <span class="muted">${list.length} ticket${list.length > 1 ? 's' : ''}</span></div>
        <section class="card flush">${list.map((o) => {
          const active = its(o).filter((i) => i.qty > 0);
          return `<div class="hist ${openId === o.id ? 'open' : ''}">
            <button class="hist-row" data-open="${o.id}"><span class="h-no">N° ${o.number ?? ''}</span><span>${fmtDateTime(o.closed_at)}</span><span>${esc(o.table_name || '')}</span>
              <span class="muted hide-sm">${o.status === 'paid' ? PAY_STATS_LABELS[o.payment_method] || '' : esc(o.cancel_reason || '')}</span>${statusBadge(o.status)}<b class="num">${fmt(o.total)}</b></button>
            ${openId === o.id ? `<div class="hist-detail">
              <table class="data"><tbody>${active.map((i) => `<tr><td>${i.qty} × ${esc(i.product_name)}</td><td class="num">${fmt(i.unit_price)}</td><td class="num">${fmt(i.qty * i.unit_price)}</td></tr>`).join('')}
              ${its(o).filter((i) => i.cancelled_qty).map((i) => `<tr class="muted"><td><s>${i.cancelled_qty} × ${esc(i.product_name)}</s> (retiré)</td><td></td><td class="num"><s>${fmt(i.cancelled_qty * i.unit_price)}</s></td></tr>`).join('')}</tbody></table>
              <p class="muted">Ouverte à ${fmtTime(o.opened_at)} · clôturée à ${fmtTime(o.closed_at)}${o.amount_received ? ` · reçu ${fmt(o.amount_received)}` : ''}</p>
              <div class="actions"><button class="btn sm" data-preview="${o.id}">Voir le ticket</button><button class="btn sm" data-print="${o.id}">Réimprimer</button>
              ${o.status === 'paid' ? `<button class="btn sm danger-ghost" data-cancel="${o.id}">Annuler ce ticket</button>` : ''}</div></div>` : ''}
          </div>`;
        }).join('') || '<p class="muted pad">Aucun ticket sur cette période.</p>'}</section>`;
    };
    const draw = async () => {
      data = await fetchClosed(R.from, R.to);
      paint();
    };
    bindRange(main, draw);
    main.addEventListener('click', async (e) => {
      const t = e.target;
      const find = (id) => data.orders.find((o) => o.id === id);
      const its = (id) => data.items.filter((i) => i.order_id === id);
      if (t.closest('[data-f]')) { filter = t.closest('[data-f]').dataset.f; return paint(); }
      if (t.closest('[data-open]')) { const id = t.closest('[data-open]').dataset.open; openId = openId === id ? null : id; return paint(); }
      const pv = t.closest('[data-preview]');
      if (pv) return previewTicket(buildOrderTicket({ settings: ctx.settings, order: find(pv.dataset.preview), items: its(pv.dataset.preview) }));
      const pr = t.closest('[data-print]');
      if (pr) {
        try { await printDoc(buildOrderTicket({ settings: ctx.settings, order: find(pr.dataset.print), items: its(pr.dataset.print) })); }
        catch (err) { toast(`Impression impossible : ${err.message}`, 'error'); }
        return;
      }
      const cc = t.closest('[data-cancel]');
      if (cc) {
        const o = find(cc.dataset.cancel);
        const why = await promptDlg(`Annuler le ticket N° ${o.number}`, `Motif de l'annulation (${fmt(o.total)} sera retiré du chiffre d'affaires)`);
        if (why === null) return;
        await db.update('orders', o.id, { status: 'cancelled', cancel_reason: `Après encaissement${why ? ` : ${why}` : ''}` });
        toast('Ticket annulé', 'ok');
        await draw();
      }
    });
    await draw();
    const unsub = db.subscribe(debounce(() => draw().catch(console.error), 1500));
    ctx.cleanups.push(unsub);
  },

  // PRODUITS & CATÉGORIES
  async products(ctx) {
    const { main } = ctx;
    let cats = [], prods = [], q = '', catFilter = '';
    const load = async () => {
      [cats, prods] = await Promise.all([db.list('categories'), db.list('products')]);
      cats.sort(bySortName);
      prods.sort(bySortName);
    };
    const paint = () => {
      const catName = Object.fromEntries(cats.map((c) => [c.id, c]));
      const list = prods.filter((p) => (!catFilter || p.category_id === catFilter) && (!q || p.name.toLowerCase().includes(q.toLowerCase())));
      main.innerHTML = `
        <section class="card"><div class="card-head"><h3>Catégories</h3><button class="btn sm primary" data-a="cat-new">+ Catégorie</button></div>
          <div class="cat-list">${cats.map((c) => `<div class="cat-item" style="--c:${esc(c.color)}"><span class="dot" style="background:${esc(c.color)}"></span><b>${esc(c.name)}</b>
            <small class="muted">${prods.filter((p) => p.category_id === c.id).length} produits</small>
            <button class="btn sm ghost" data-cat-edit="${c.id}">Modifier</button><button class="icon-btn danger" data-cat-del="${c.id}" aria-label="Supprimer">${icon('trash', 17)}</button></div>`).join('') || '<p class="muted">Aucune catégorie.</p>'}</div></section>
        <section class="card"><div class="card-head"><h3>Produits</h3><button class="btn sm primary" data-a="prod-new">+ Produit</button></div>
          <div class="filters"><input class="input" id="pq" placeholder="Rechercher…" value="${esc(q)}">
            <select class="input" id="pc"><option value="">Toutes catégories</option>${cats.map((c) => `<option value="${c.id}" ${c.id === catFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="table-wrap"><table class="data"><thead><tr><th>Produit</th><th>Catégorie</th><th class="num">Prix</th><th>En vente</th><th class="num">Ordre</th><th></th></tr></thead><tbody>
          ${list.map((p) => `<tr class="${p.active === false ? 'muted' : ''}"><td><b>${esc(p.name)}</b></td><td>${esc(catName[p.category_id]?.name || '—')}</td><td class="num">${fmt(p.price)}</td>
            <td><label class="switch"><input type="checkbox" data-toggle="${p.id}" ${p.active !== false ? 'checked' : ''}><span></span></label></td><td class="num">${p.sort ?? 0}</td>
            <td class="row-actions"><button class="btn sm ghost" data-prod-edit="${p.id}">Modifier</button><button class="icon-btn danger" data-prod-del="${p.id}" aria-label="Supprimer">${icon('trash', 17)}</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun produit.</td></tr>'}
          </tbody></table></div></section>`;
    };
    const reload = async () => { await load(); paint(); };

    const prodForm = async (p) => {
      const res = await modal({
        title: p ? 'Modifier le produit' : 'Nouveau produit',
        body: `<div class="form">
          <label class="field"><span>Nom</span><input class="input" id="f-n" value="${esc(p?.name || '')}"></label>
          <div class="row2"><label class="field"><span>Prix (DT)</span><input class="input" id="f-p" inputmode="decimal" value="${p ? toInput(p.price) : ''}" placeholder="2,500"></label>
          <label class="field"><span>Ordre d'affichage</span><input class="input" id="f-s" type="number" value="${p?.sort ?? prods.length}"></label></div>
          <label class="field"><span>Catégorie</span><select class="input" id="f-c">${cats.map((c) => `<option value="${c.id}" ${c.id === (p?.category_id || catFilter) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" id="f-a" ${p?.active === false ? '' : 'checked'}> En vente (visible sur la caisse)</label></div>`,
        buttons: [{ label: 'Annuler', value: null }, {
          label: 'Enregistrer', cls: 'primary', onClick: (w) => {
            const name = w.querySelector('#f-n').value.trim();
            const price = parseMoney(w.querySelector('#f-p').value);
            if (!name) return toast('Nom obligatoire', 'error'), false;
            if (!Number.isFinite(price) || price < 0) return toast('Prix invalide', 'error'), false;
            return { name, price, sort: +w.querySelector('#f-s').value || 0, category_id: w.querySelector('#f-c').value || null, active: w.querySelector('#f-a').checked };
          },
        }],
      });
      if (!res) return;
      if (p) await db.update('products', p.id, res);
      else await db.insert('products', { id: uid(), ...res });
      toast('Produit enregistré', 'ok');
      await reload();
    };
    const catForm = async (c) => {
      const res = await modal({
        title: c ? 'Modifier la catégorie' : 'Nouvelle catégorie',
        body: `<div class="form"><label class="field"><span>Nom</span><input class="input" id="f-n" value="${esc(c?.name || '')}"></label>
          <div class="row2"><label class="field"><span>Couleur</span><input class="input color" type="color" id="f-c" value="${esc(c?.color || '#6f4e37')}"></label>
          <label class="field"><span>Ordre</span><input class="input" type="number" id="f-s" value="${c?.sort ?? cats.length + 1}"></label></div></div>`,
        buttons: [{ label: 'Annuler', value: null }, {
          label: 'Enregistrer', cls: 'primary', onClick: (w) => {
            const name = w.querySelector('#f-n').value.trim();
            if (!name) return toast('Nom obligatoire', 'error'), false;
            return { name, color: w.querySelector('#f-c').value, sort: +w.querySelector('#f-s').value || 0 };
          },
        }],
      });
      if (!res) return;
      if (c) await db.update('categories', c.id, res);
      else await db.insert('categories', { id: uid(), ...res });
      await reload();
    };

    main.addEventListener('input', debounce((e) => {
      if (e.target.id === 'pq') { q = e.target.value; paint(); const i = main.querySelector('#pq'); i.focus(); i.setSelectionRange(q.length, q.length); }
    }, 200));
    main.addEventListener('change', async (e) => {
      if (e.target.id === 'pc') { catFilter = e.target.value; return paint(); }
      const tg = e.target.dataset.toggle;
      if (tg) { await db.update('products', tg, { active: e.target.checked }); const p = prods.find((x) => x.id === tg); if (p) p.active = e.target.checked; paint(); }
    });
    main.addEventListener('click', async (e) => {
      const d = (k) => e.target.closest(`[data-${k}]`)?.dataset[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())];
      if (e.target.closest('[data-a="prod-new"]')) return prodForm(null);
      if (e.target.closest('[data-a="cat-new"]')) return catForm(null);
      let id;
      if ((id = d('prod-edit'))) return prodForm(prods.find((p) => p.id === id));
      if ((id = d('cat-edit'))) return catForm(cats.find((c) => c.id === id));
      if ((id = d('prod-del'))) {
        const p = prods.find((x) => x.id === id);
        if (await confirmDlg('Supprimer le produit', `Supprimer « ${p.name} » ? L'historique des ventes est conservé. (Astuce : décochez « En vente » pour simplement le masquer.)`, 'Supprimer', true)) {
          await db.remove('products', id);
          await reload();
        }
      }
      if ((id = d('cat-del'))) {
        if (prods.some((p) => p.category_id === id)) return toast("Cette catégorie contient des produits : déplacez-les ou supprimez-les d'abord.", 'error', 5000);
        if (await confirmDlg('Supprimer la catégorie', 'Supprimer cette catégorie vide ?', 'Supprimer', true)) {
          await db.remove('categories', id);
          await reload();
        }
      }
    });
    await reload();
  },

  // TABLES
  async tables(ctx) {
    const { main } = ctx;
    let tables = [];
    const reload = async () => {
      tables = (await db.list('cafe_tables')).sort(bySortName);
      main.innerHTML = `<section class="card"><div class="card-head"><h3>Tables</h3><div class="actions"><button class="btn sm" data-a="bulk">+ Plusieurs tables</button><button class="btn sm primary" data-a="new">+ Table</button></div></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Nom</th><th class="num">Ordre</th><th>Active</th><th></th></tr></thead><tbody>
        ${tables.map((t) => `<tr class="${t.active === false ? 'muted' : ''}"><td><b>${esc(t.name)}</b></td><td class="num">${t.sort ?? 0}</td>
          <td><label class="switch"><input type="checkbox" data-toggle="${t.id}" ${t.active !== false ? 'checked' : ''}><span></span></label></td>
          <td class="row-actions"><button class="btn sm ghost" data-edit="${t.id}">Renommer</button><button class="icon-btn danger" data-del="${t.id}" aria-label="Supprimer">${icon('trash', 17)}</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucune table.</td></tr>'}
        </tbody></table></div></section>`;
    };
    main.addEventListener('change', async (e) => {
      if (e.target.dataset.toggle) { await db.update('cafe_tables', e.target.dataset.toggle, { active: e.target.checked }); await reload(); }
    });
    main.addEventListener('click', async (e) => {
      const g = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
      if (e.target.closest('[data-a="new"]')) {
        const name = await promptDlg('Nouvelle table', 'Nom de la table', `Table ${tables.length + 1}`);
        if (name?.trim()) { await db.insert('cafe_tables', { id: uid(), name: name.trim(), sort: tables.length, active: true }); await reload(); }
      }
      if (e.target.closest('[data-a="bulk"]')) {
        const res = await modal({
          title: 'Ajouter plusieurs tables',
          body: `<div class="form"><label class="field"><span>Préfixe</span><input class="input" id="b-p" value="Table"></label>
            <div class="row2"><label class="field"><span>De</span><input class="input" type="number" id="b-a" value="1"></label><label class="field"><span>À</span><input class="input" type="number" id="b-b" value="10"></label></div></div>`,
          buttons: [{ label: 'Annuler', value: null }, { label: 'Ajouter', cls: 'primary', onClick: (w) => ({ p: w.querySelector('#b-p').value.trim(), a: +w.querySelector('#b-a').value, b: +w.querySelector('#b-b').value }) }],
        });
        if (res && res.b >= res.a && res.b - res.a < 100) {
          for (let i = res.a; i <= res.b; i++) await db.insert('cafe_tables', { id: uid(), name: `${res.p} ${i}`.trim(), sort: tables.length + i, active: true });
          await reload();
        }
      }
      let id;
      if ((id = g('edit'))) {
        const t = tables.find((x) => x.id === id);
        const res = await modal({
          title: 'Modifier la table',
          body: `<div class="form row2"><label class="field"><span>Nom</span><input class="input" id="t-n" value="${esc(t.name)}"></label><label class="field"><span>Ordre</span><input class="input" type="number" id="t-s" value="${t.sort ?? 0}"></label></div>`,
          buttons: [{ label: 'Annuler', value: null }, { label: 'Enregistrer', cls: 'primary', onClick: (w) => ({ name: w.querySelector('#t-n').value.trim() || t.name, sort: +w.querySelector('#t-s').value || 0 }) }],
        });
        if (res) { await db.update('cafe_tables', id, res); await reload(); }
      }
      if ((id = g('del'))) {
        const open = await db.list('orders', { eq: { status: 'open', table_id: id } });
        if (open.length) return toast('Cette table a une commande en cours.', 'error');
        if (await confirmDlg('Supprimer la table', 'Supprimer cette table ? (L’historique est conservé.)', 'Supprimer', true)) {
          await db.remove('cafe_tables', id);
          await reload();
        }
      }
    });
    await reload();
  },

  // PARAMÈTRES
  async settings(ctx) {
    const { main } = ctx;
    const s = await loadSettings();
    const width = 32;
    main.innerHTML = `<div class="two-col">
      <section class="card"><h3>En-tête et pied du ticket</h3><div class="form" id="sf">
        <label class="field"><span>Nom du café</span><input class="input" name="shopName" value="${esc(s.shopName)}"></label>
        <label class="field"><span>Adresse</span><textarea class="input" name="address" rows="2">${esc(s.address)}</textarea></label>
        <div class="row2"><label class="field"><span>Téléphone</span><input class="input" name="phone" value="${esc(s.phone)}"></label>
        <label class="field"><span>Matricule fiscal</span><input class="input" name="taxId" value="${esc(s.taxId)}"></label></div>
        <label class="field"><span>Message en bas du ticket</span><textarea class="input" name="footer" rows="2">${esc(s.footer)}</textarea></label>
        <label class="field"><span>Code PIN du back-office (vide = aucun)</span><input class="input" name="adminPin" inputmode="numeric" value="${esc(s.adminPin)}"></label>
        <p class="hint">Le code PIN empêche le personnel d'ouvrir le back-office depuis la tablette de caisse.</p>
        <button class="btn primary" data-a="save">Enregistrer</button></div></section>
      <section class="card"><h3>Aperçu du ticket</h3><div class="rcpt-wrap" id="prev"></div>
        <p class="hint">L'imprimante se règle sur la tablette : Caisse → bouton 🖨 en haut.</p></section></div>
      <section class="card"><h3>Données</h3>
        ${isCloud ? '<p>Mode <b>cloud</b> (Supabase) : les données sont synchronisées en temps réel et sauvegardées en ligne.</p>'
          : `<p>Mode <b>local</b> : les données sont uniquement dans ce navigateur. Configurez Supabase pour le back-office à distance (voir README).</p>
             <div class="actions"><button class="btn" data-a="export">Exporter les données (JSON)</button><button class="btn danger-ghost" data-a="reset">Réinitialiser les données de démo</button></div>`}
      </section>`;
    const read = () => Object.fromEntries([...main.querySelectorAll('#sf [name]')].map((i) => [i.name, i.value.trim()]));
    const preview = () => { main.querySelector('#prev').innerHTML = toHTML(buildTestTicket(read()), width); };
    preview();
    main.addEventListener('input', debounce(preview, 150));
    main.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'save') {
        await saveSettings({ ...s, ...read() });
        toast('Paramètres enregistrés', 'ok');
      }
      if (a === 'export') download(`caisse_export_${dayKey(new Date())}.json`, JSON.stringify(db.exportAll(), null, 2), 'application/json');
      if (a === 'reset' && (await confirmDlg('Réinitialiser', 'Effacer toutes les données locales (ventes, produits, tables) et revenir aux données de démo ?', 'Tout effacer', true))) {
        db.reset();
        location.reload();
      }
    });
  },
};
