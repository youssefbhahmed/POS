// Écran CAISSE (tablette) : plan des tables, prise de commande, encaissement.

import { db, listIn, uid, nowIso } from './db.js';
import { esc, modal, confirmDlg, toast, debounce, fmtTime, since, startOfDay } from './ui.js';
import { fmt, parseMoney, toInput } from './money.js';
import { loadSettings, orderTotal, fetchClosed, computeStats, PAY_LABELS, bySortName } from './data.js';
import { buildOrderTicket, buildReport } from './ticket.js';
import { printDoc, openPrinterSettings, printerBadge, previewTicket } from './printer.js';
import { icon } from './icons.js';

const S = {
  cats: [], products: [], tables: [], orders: [], items: [], settings: {},
  view: 'tables', sel: null, catId: null, pending: 0, dirty: false, lastTicket: null, root: null,
};

// Toutes les écritures passent par une file : l'ordre est garanti même
// si l'on tape vite, et l'écran est mis à jour immédiatement.
let queue = Promise.resolve();
function enqueue(fn) {
  S.pending++;
  const p = queue.then(fn);
  p.catch(() => {});
  queue = p
    .catch((err) => {
      console.error(err);
      toast(`Erreur : ${err?.message || err}`, 'error', 6000);
      S.dirty = true;
    })
    .finally(() => {
      S.pending--;
      if (S.pending === 0 && S.dirty) {
        S.dirty = false;
        refresh();
      }
    });
  return p;
}

export async function mountPOS(root) {
  S.root = root;
  S.view = 'tables';
  S.sel = null;
  await loadAll();
  render();
  const unsub = db.subscribe(
    debounce(() => {
      if (S.pending > 0) S.dirty = true;
      else refresh();
    }, 300),
  );
  const onClick = (e) => handleClick(e).catch((err) => toast(err.message || String(err), 'error'));
  root.addEventListener('click', onClick);
  const timer = setInterval(() => {
    if (S.view === 'tables') render();
    else { const c = S.root.querySelector('.clock'); if (c) c.textContent = fmtTime(new Date()); }
  }, 20000);
  return () => {
    unsub();
    root.removeEventListener('click', onClick);
    clearInterval(timer);
  };
}

async function refresh() {
  try {
    await loadAll();
    render();
  } catch (e) {
    console.error(e);
  }
}

async function loadAll() {
  const [cats, products, tables, orders, settings] = await Promise.all([
    db.list('categories'),
    db.list('products'),
    db.list('cafe_tables'),
    db.list('orders', { eq: { status: 'open' }, order: ['opened_at', 'asc'] }),
    loadSettings(),
  ]);
  S.cats = cats.sort(bySortName);
  S.products = products.sort(bySortName);
  S.tables = tables.filter((t) => t.active !== false).sort(bySortName);
  S.orders = orders;
  S.items = orders.length ? await listIn('order_items', 'order_id', orders.map((o) => o.id), { order: ['created_at', 'asc'] }) : [];
  S.settings = settings;
  if (!S.catId || !S.cats.some((c) => c.id === S.catId)) S.catId = S.cats[0]?.id || null;
}

const itemsOf = (o) => (o ? S.items.filter((i) => i.order_id === o.id) : []);

function currentOrder(sel = S.sel) {
  if (!sel) return null;
  if (sel.orderId) return S.orders.find((o) => o.id === sel.orderId) || null;
  if (sel.tableId) return S.orders.find((o) => o.table_id === sel.tableId) || null;
  return null;
}

// ── Rendu ────────────────────────────────────────────────────
function render() {
  if (S.view === 'order' && S.sel?.orderId && !currentOrder()) {
    // Commande clôturée ailleurs (autre appareil)
    if (S.sel.tableId) S.sel = { tableId: S.sel.tableId, orderId: null };
    else { S.view = 'tables'; S.sel = null; }
  }
  const keep = {};
  for (const sel of ['.prod-grid', '.lines', '.tables-scroll']) keep[sel] = S.root.querySelector(sel)?.scrollTop;
  S.root.innerHTML = `<div class="pos">${topbar()}${S.view === 'order' ? orderView() : tablesView()}</div>`;
  for (const [sel, top] of Object.entries(keep)) {
    const el = S.root.querySelector(sel);
    if (el && top != null) el.scrollTop = top;
  }
}

function topbar() {
  const left = S.view === 'order'
    ? `<button class="btn ghost" data-a="back">${icon('back')} Tables</button>`
    : `<a class="brand" href="#/"><span class="logo">${icon('coffee', 22)}</span><span><span class="brand-name">${esc(S.settings.shopName)}</span><span class="brand-sub">Caisse</span></span></a>`;
  const pb = printerBadge();
  return `<header class="topbar">${left}<div class="spacer"></div>
    <span class="clock">${fmtTime(new Date())}</span>
    ${S.lastTicket ? `<button class="btn ghost hide-sm" data-a="reprint">${icon('reprint', 18)} Réimprimer</button>` : ''}
    <button class="btn ghost hide-sm" data-a="report">${icon('report', 18)} Rapport du jour</button>
    <button class="status-chip" data-a="printer"><span class="led ${pb.ok ? 'ok' : ''}"></span>${icon('printer', 16)}<span class="hide-sm">${esc(pb.label)}</span></button>
    <a class="btn ghost" href="#/admin" aria-label="Back-office">${icon('chart', 18)}<span class="hide-sm">Back-office</span></a></header>`;
}

const GUEST = 'Client passager';
// Nom affiché pour une commande : la table, ou « Client passager »
const whoLabel = (o) => (o?.table_id ? o.table_name : GUEST);

function tablesView() {
  const activeIds = new Set(S.tables.map((t) => t.id));
  const tableCards = S.tables.map((t) => {
    const o = S.orders.find((x) => x.table_id === t.id);
    if (!o) return `<button class="table-card" data-a="table" data-id="${t.id}"><span class="t-name">${esc(t.name)}</span><span class="t-meta"><span class="led"></span>Libre</span></button>`;
    const its = itemsOf(o).filter((i) => i.qty > 0);
    return `<button class="table-card busy" data-a="table" data-id="${t.id}">
      <span class="t-name">${esc(t.name)}</span>
      <span class="t-meta">${icon('clock', 13)} ${since(o.opened_at)} · ${its.reduce((s, i) => s + i.qty, 0)} art.</span>
      <span class="t-total">${fmt(orderTotal(its))}</span></button>`;
  });
  const counter = S.orders.filter((o) => !o.table_id || !activeIds.has(o.table_id));
  const counterCards = counter.map((o) => {
    const its = itemsOf(o).filter((i) => i.qty > 0);
    return `<button class="table-card busy counter" data-a="counter-open" data-id="${o.id}">
      <span class="t-name">${esc(whoLabel(o))} N° ${o.number ?? ''}</span>
      <span class="t-meta">${icon('clock', 13)} ${since(o.opened_at)} · ${its.reduce((s, i) => s + i.qty, 0)} art.</span>
      <span class="t-total">${fmt(orderTotal(its))}</span></button>`;
  });
  const busy = S.orders.length;
  const pendingTotal = S.orders.reduce((s, o) => s + orderTotal(itemsOf(o)), 0);
  const freeCount = S.tables.filter((t) => !S.orders.some((o) => o.table_id === t.id)).length;
  return `<main class="tables-scroll">
    <section class="who">
      <h2 class="who-title">Nouvelle commande : pour qui ?</h2>
      <div class="who-grid">
        <button class="who-card c-violet" data-a="counter-new">
          <span class="who-ic">${icon('bag', 34)}</span>
          <span class="who-txt"><b>Client passager</b><span>Sans table · à emporter ou au comptoir</span></span>
          <span class="who-go">${icon('arrow', 22)}</span></button>
        <button class="who-card c-orange" data-a="scroll-tables">
          <span class="who-ic">${icon('grid', 34)}</span>
          <span class="who-txt"><b>Client à une table</b><span>Touchez la table dans la liste ci-dessous</span></span>
          <span class="who-go down">${icon('arrow', 22)}</span></button>
      </div>
    </section>
    <div class="summary">
      <div class="stat c-berry"><span class="s-ic">${icon('receipt')}</span><div><small>En cours</small><b>${busy} commande${busy > 1 ? 's' : ''}</b></div></div>
      <div class="stat c-violet"><span class="s-ic">${icon('wallet')}</span><div><small>Non encaissé</small><b>${fmt(pendingTotal)}</b></div></div>
      <div class="stat c-mint"><span class="s-ic">${icon('grid')}</span><div><small>Tables libres</small><b>${freeCount} / ${S.tables.length}</b></div></div>
    </div>
    ${counterCards.length ? `<h2 class="section-title">Clients passagers en cours <small>non encaissés</small></h2>
    <div class="table-grid">${counterCards.join('')}</div>` : ''}
    <h2 class="section-title" id="tables-sec">Tables <small>orange = occupée · blanc = libre</small></h2>
    <div class="table-grid">${tableCards.join('') || '<p class="muted">Aucune table. Ajoutez-en dans le back-office.</p>'}</div>
  </main>`;
}

function orderView() {
  const o = currentOrder();
  const items = itemsOf(o);
  const active = items.filter((i) => i.qty > 0);
  const cancelled = items.filter((i) => i.cancelled_qty > 0);
  const total = orderTotal(active);
  const table = S.sel.tableId ? S.tables.find((t) => t.id === S.sel.tableId) : null;
  const isTable = o ? !!o.table_id : !!table;
  const title = o ? whoLabel(o) : table?.name || GUEST;
  const catColor = Object.fromEntries(S.cats.map((c) => [c.id, c.color || '#6f4e37']));
  const products = S.products.filter((p) => p.active !== false && (!S.catId || p.category_id === S.catId));

  const line = (i) => `
    <div class="line">
      <div class="l-main"><div class="l-name">${esc(i.product_name)}</div>
        <div class="l-unit">${fmt(i.unit_price)}${i.cancelled_qty ? ` · <span class="muted">${i.cancelled_qty} retiré${i.cancelled_qty > 1 ? 's' : ''}</span>` : ''}</div></div>
      <div class="qty"><button class="qbtn" data-a="minus" data-id="${i.id}" aria-label="Retirer un">${icon('minus', 16)}</button><span>${i.qty}</span><button class="qbtn" data-a="plus" data-id="${i.id}" aria-label="Ajouter un">${icon('plus', 16)}</button></div>
      <div class="l-amt">${fmt(i.qty * i.unit_price, false)}</div>
      <button class="icon-btn danger" data-a="del" data-id="${i.id}" aria-label="Supprimer la ligne">${icon('trash', 17)}</button>
    </div>`;

  return `<main class="order-view">
    <section class="catalog">
      <nav class="cat-tabs">${S.cats.map((c) => `<button class="cat-tab ${c.id === S.catId ? 'on' : ''}" style="--c:${esc(c.color || '#6f4e37')}" data-a="cat" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</nav>
      <div class="prod-grid">${products.map((p) => `
        <button class="prod" data-a="add" data-id="${p.id}" style="--c:${esc(catColor[p.category_id] || '#6f4e37')}">
          <span class="p-name">${esc(p.name)}</span><span class="p-price">${fmt(p.price)}</span></button>`).join('') || '<p class="muted pad">Aucun produit dans cette catégorie.</p>'}</div>
    </section>
    <aside class="ticket">
      <div class="for-banner ${isTable ? 'c-orange' : 'c-violet'}">
        <span class="fb-ic">${icon(isTable ? 'grid' : 'bag', 28)}</span>
        <div class="fb-txt"><small>Commande pour</small><div class="t-title">${esc(title)}</div>
          <div class="t-sub">${o ? `N° ${o.number ?? '…'} · ouverte à ${fmtTime(o.opened_at)}` : 'Nouvelle commande'}</div></div>
        <button class="btn fb-btn" data-a="transfer">${icon('move', 18)} ${isTable ? 'Changer de table' : 'Mettre à une table'}</button>
      </div>
      <div class="lines">
        ${active.length ? active.map(line).join('') : `<div class="empty">${icon('coffee', 40)}<span>Touchez un produit pour l’ajouter</span></div>`}
        ${cancelled.length ? `<div class="cancelled"><div class="c-head">Retirés de la commande</div>${cancelled.map((i) => `<div class="c-line"><s>${i.cancelled_qty} × ${esc(i.product_name)}</s><span>${fmt(i.cancelled_qty * i.unit_price, false)}</span></div>`).join('')}</div>` : ''}
      </div>
      <div class="ticket-total"><span>Total</span><strong>${fmt(total)}</strong></div>
      <div class="ticket-actions">
        <div class="ta-sec">
          <button class="btn danger-ghost" data-a="cancel-order" ${o ? '' : 'disabled'}>${icon('ban', 18)} Annuler</button>
          <button class="btn" data-a="bill" ${active.length ? '' : 'disabled'}>${icon('receipt', 18)} Addition</button>
        </div>
        <div class="ta-main">
          <button class="btn validate big" data-a="validate" ${active.length ? '' : 'disabled'}>${icon('check')} Valider<small>payer plus tard</small></button>
          <button class="btn cta big" data-a="pay" ${active.length ? '' : 'disabled'}>${icon('wallet')} Encaisser<small>payé maintenant</small></button>
        </div>
      </div>
    </aside>
  </main>`;
}

// ── Actions ──────────────────────────────────────────────────
async function handleClick(e) {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const { a, id } = { a: el.dataset.a, id: el.dataset.id };
  switch (a) {
    case 'table': S.sel = { tableId: id, orderId: null }; S.view = 'order'; return render();
    case 'counter-new': S.sel = { tableId: null, orderId: null }; S.view = 'order'; return render();
    case 'counter-open': S.sel = { tableId: null, orderId: id }; S.view = 'order'; return render();
    case 'back': return leaveOrder();
    case 'scroll-tables': {
      const sec = S.root.querySelector('#tables-sec');
      sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const grid = sec?.nextElementSibling;
      grid?.classList.remove('flash');
      void grid?.offsetWidth;
      grid?.classList.add('flash');
      return;
    }
    case 'cat': S.catId = id; return render();
    case 'add': return addProduct(id);
    case 'plus': return changeQty(id, +1);
    case 'minus': return changeQty(id, -1);
    case 'del': return removeLine(id);
    case 'pay': return payFlow();
    case 'validate': return validateOrder();
    case 'bill': return printBill();
    case 'cancel-order': return cancelOrder();
    case 'transfer': return transferOrder();
    case 'printer': await openPrinterSettings(S.settings); return render();
    case 'report': return reportFlow();
    case 'reprint': return safePrint(S.lastTicket);
  }
}

async function safePrint(doc) {
  try {
    await printDoc(doc);
  } catch (e) {
    toast(`Impression impossible : ${e.message}`, 'error', 7000);
  }
}

function leaveOrder() {
  const o = currentOrder();
  if (o && itemsOf(o).length === 0) {
    // commande ouverte sans aucun article : on la supprime
    S.orders = S.orders.filter((x) => x.id !== o.id);
    enqueue(() => db.remove('orders', o.id));
  }
  S.view = 'tables';
  S.sel = null;
  render();
}

async function ensureOrder(sel) {
  const cur = currentOrder(sel);
  if (cur) return cur;
  const t = sel.tableId ? S.tables.find((x) => x.id === sel.tableId) : null;
  const o = await db.insert('orders', {
    id: uid(), table_id: t?.id ?? null, table_name: t?.name ?? GUEST,
    status: 'open', opened_at: nowIso(), total: 0,
  });
  S.orders.push(o);
  sel.orderId = o.id;
  return o;
}

function addProduct(pid) {
  const p = S.products.find((x) => x.id === pid);
  if (!p) return;
  const sel = S.sel;
  enqueue(async () => {
    const o = await ensureOrder(sel);
    const now = nowIso();
    const ex = S.items.find((i) => i.order_id === o.id && i.product_id === p.id && i.qty > 0 && i.unit_price === p.price);
    if (ex) {
      ex.qty++;
      ex.updated_at = now;
      render();
      await db.update('order_items', ex.id, { qty: ex.qty, updated_at: now });
    } else {
      const cat = S.cats.find((c) => c.id === p.category_id);
      const it = {
        id: uid(), order_id: o.id, product_id: p.id, product_name: p.name, category_name: cat?.name || '',
        unit_price: p.price, qty: 1, cancelled_qty: 0, created_at: now, updated_at: now,
      };
      S.items.push(it);
      render();
      await db.insert('order_items', it);
    }
  });
}

function changeQty(itemId, delta) {
  enqueue(async () => {
    const it = S.items.find((i) => i.id === itemId);
    if (!it) return;
    if (delta > 0) it.qty++;
    else if (it.qty > 0) { it.qty--; it.cancelled_qty++; }
    it.updated_at = nowIso();
    render();
    await db.update('order_items', it.id, { qty: it.qty, cancelled_qty: it.cancelled_qty, updated_at: it.updated_at });
  });
}

function removeLine(itemId) {
  enqueue(async () => {
    const it = S.items.find((i) => i.id === itemId);
    if (!it || it.qty === 0) return;
    it.cancelled_qty += it.qty;
    it.qty = 0;
    it.updated_at = nowIso();
    render();
    await db.update('order_items', it.id, { qty: 0, cancelled_qty: it.cancelled_qty, updated_at: it.updated_at });
  });
}

function closeLocally(o) {
  S.orders = S.orders.filter((x) => x.id !== o.id);
  S.items = S.items.filter((i) => i.order_id !== o.id);
  S.view = 'tables';
  S.sel = null;
  render();
}

async function payFlow() {
  await queue; // attendre les écritures en cours
  const o = currentOrder();
  if (!o) return;
  const items = itemsOf(o);
  const total = orderTotal(items.filter((i) => i.qty > 0));
  const quick = [5000, 10000, 20000, 50000].filter((v) => v > total).slice(0, 3);

  const collect = (w, print) => {
    const method = w.querySelector('.seg-btn.on').dataset.m;
    let received = null;
    if (method === 'cash') {
      const raw = w.querySelector('#recv').value;
      if (raw.trim()) {
        received = parseMoney(raw);
        if (!Number.isFinite(received) || received < total) {
          toast('Le montant reçu est inférieur au total', 'error');
          return false;
        }
      }
    }
    return { method, received, print };
  };

  const res = await modal({
    title: `Encaisser · ${whoLabel(o)}`,
    body: `
      <div class="pay-total">${fmt(total)}</div>
      <div class="seg">${Object.entries(PAY_LABELS).map(([k, l], i) => `<button type="button" class="seg-btn ${i === 0 ? 'on' : ''}" data-m="${k}">${icon({ cash: 'wallet', card: 'card', other: 'dots' }[k], 18)}${l}</button>`).join('')}</div>
      <div class="cash-zone">
        <label class="field"><span>Montant reçu (facultatif)</span><input class="input big" inputmode="decimal" id="recv" placeholder="${toInput(total)}" data-noautofocus></label>
        <div class="quick"><button type="button" class="chip" data-v="${total}">Montant exact</button>${quick.map((v) => `<button type="button" class="chip" data-v="${v}">${v / 1000} DT</button>`).join('')}</div>
        <div class="change"><span>Rendu monnaie</span><strong id="chg">—</strong></div>
      </div>`,
    buttons: [
      { label: 'Valider sans ticket', onClick: (w) => collect(w, false) },
      { label: 'Valider & imprimer', cls: 'cta', onClick: (w) => collect(w, true) },
    ],
    onMount: (w) => {
      const recv = w.querySelector('#recv');
      const upd = () => {
        const v = parseMoney(recv.value);
        w.querySelector('#chg').textContent = Number.isFinite(v) && v >= total ? fmt(v - total) : '—';
      };
      recv.addEventListener('input', upd);
      w.querySelector('.seg').addEventListener('click', (e) => {
        const b = e.target.closest('.seg-btn');
        if (!b) return;
        w.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
        w.querySelector('.cash-zone').hidden = b.dataset.m !== 'cash';
      });
      w.querySelector('.quick').addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        recv.value = toInput(+b.dataset.v);
        upd();
      });
    },
  });
  if (!res) return;

  const patch = {
    status: 'paid', closed_at: nowIso(), total,
    payment_method: res.method, amount_received: res.received,
  };
  try {
    await enqueue(() => db.update('orders', o.id, patch));
  } catch {
    return;
  }
  const doc = buildOrderTicket({ settings: S.settings, order: { ...o, ...patch }, items, kind: 'receipt' });
  S.lastTicket = doc;
  closeLocally(o);
  toast(`Encaissé : ${fmt(total)}${res.received ? ` · rendu ${fmt(res.received - total)}` : ''}`, 'ok');
  if (res.print) await safePrint(doc);
}

// Valider sans encaisser : la commande reste ouverte (non payée) sur sa table
async function validateOrder() {
  await queue;
  const o = currentOrder();
  if (!o) return;
  const total = orderTotal(itemsOf(o).filter((i) => i.qty > 0));
  S.view = 'tables';
  S.sel = null;
  render();
  toast(`Commande validée · ${whoLabel(o)} · ${fmt(total)} à encaisser`, 'ok');
}

async function printBill() {
  await queue;
  const o = currentOrder();
  if (!o) return;
  await safePrint(buildOrderTicket({ settings: S.settings, order: o, items: itemsOf(o), kind: 'bill' }));
}

async function cancelOrder() {
  await queue;
  const o = currentOrder();
  if (!o) return;
  const items = itemsOf(o);
  const total = orderTotal(items.filter((i) => i.qty > 0));
  const reason = await modal({
    title: 'Annuler la commande',
    body: `<p>Annuler toute la commande de <b>${esc(whoLabel(o))}</b> (${fmt(total)}) ? Elle restera visible dans l'historique comme annulée.</p>
      <label class="field"><span>Motif (facultatif)</span><input class="input" id="why" placeholder="Ex. client parti, erreur de saisie…"></label>`,
    buttons: [
      { label: 'Retour', value: null },
      { label: 'Annuler la commande', cls: 'danger', onClick: (w) => w.querySelector('#why').value.trim() || '' },
    ],
  });
  if (reason === null) return;
  try {
    await enqueue(() =>
      items.length
        ? db.update('orders', o.id, { status: 'cancelled', closed_at: nowIso(), total, cancel_reason: reason || null })
        : db.remove('orders', o.id),
    );
  } catch {
    return;
  }
  closeLocally(o);
  toast('Commande annulée', 'ok');
}

async function transferOrder() {
  await queue;
  const o = currentOrder();
  const curTable = o ? o.table_id : S.sel.tableId;
  const busy = new Set(S.orders.filter((x) => x.id !== o?.id).map((x) => x.table_id).filter(Boolean));
  const choice = await modal({
    title: 'Pour qui est cette commande ?',
    wide: true,
    body: `
      <button class="who-card c-violet sm ${!curTable ? 'current' : ''}" data-pick="__guest">
        <span class="who-ic">${icon('bag', 26)}</span><span class="who-txt"><b>Client passager</b><span>Sans table</span></span>
        ${!curTable ? '<span class="badge">Actuel</span>' : ''}</button>
      <h4 class="pick-title">Ou choisissez une table</h4>
      <div class="pick-grid">
        ${S.tables.map((t) => {
          if (t.id === curTable) return `<button class="table-card current" disabled><span class="t-name">${esc(t.name)}</span><span class="t-meta">Actuelle</span></button>`;
          if (busy.has(t.id)) return `<button class="table-card taken" disabled><span class="t-name">${esc(t.name)}</span><span class="t-meta">Occupée</span></button>`;
          return `<button class="table-card" data-pick="${t.id}"><span class="t-name">${esc(t.name)}</span><span class="t-meta"><span class="led"></span>Libre</span></button>`;
        }).join('')}
      </div>`,
    onMount: (w, close) => w.querySelector('.modal-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) close(b.dataset.pick);
    }),
  });
  if (!choice) return;
  const t = choice === '__guest' ? null : S.tables.find((x) => x.id === choice);
  if ((t?.id ?? null) === (curTable ?? null)) return;
  const label = t?.name ?? GUEST;
  if (!o) {
    // Pas encore d'article : on change simplement la destination
    S.sel = { tableId: t?.id ?? null, orderId: null };
    render();
    return toast(`Commande pour : ${label}`, 'ok');
  }
  const patch = { table_id: t?.id ?? null, table_name: label };
  Object.assign(o, patch);
  S.sel = { tableId: t?.id ?? null, orderId: o.id };
  render();
  enqueue(() => db.update('orders', o.id, patch));
  toast(`Commande déplacée vers : ${label}`, 'ok');
}

async function reportFlow() {
  const from = startOfDay();
  const to = new Date(Date.now() + 60000);
  const { orders, items } = await fetchClosed(from, to);
  const stats = computeStats(orders, items, from, to);
  const doc = buildReport({ settings: S.settings, stats, from, to });
  const pending = S.orders.reduce((s, o) => s + orderTotal(itemsOf(o)), 0);
  const res = await modal({
    title: 'Rapport du jour',
    body: `
      <div class="kpis small">
        <div class="kpi"><span>Chiffre d'affaires</span><b>${fmt(stats.revenue)}</b></div>
        <div class="kpi"><span>Tickets</span><b>${stats.tickets}</b></div>
        <div class="kpi"><span>Panier moyen</span><b>${fmt(stats.avg)}</b></div>
        <div class="kpi"><span>En cours (non encaissé)</span><b>${fmt(pending)}</b></div>
      </div>
      <p class="muted">${Object.entries(stats.payments).map(([m, v]) => `${PAY_LABELS[m] || m} : ${fmt(v.amount)} (${v.count})`).join(' · ') || 'Aucun encaissement aujourd’hui.'}</p>`,
    buttons: [
      { label: 'Aperçu', value: 'preview' },
      { label: 'Imprimer le rapport', cls: 'primary', value: 'print' },
    ],
  });
  if (res === 'print') await safePrint(doc);
  if (res === 'preview') await previewTicket(doc, undefined, 'Rapport du jour');
}
