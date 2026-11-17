// Logique métier partagée : paramètres, chargements, calcul des statistiques.

import { db, listIn, nowIso } from './db.js';
import { dayKey, pad, startOfDay, addDays, fmtDate } from './ui.js';

export const DEFAULT_SETTINGS = {
  shopName: 'Mon Café',
  address: '',
  phone: '',
  taxId: '',
  footer: 'Merci de votre visite !',
  adminPin: '',
};

export const PAY_LABELS = { cash: 'Espèces', card: 'Carte', other: 'Autre' };

export async function loadSettings() {
  const r = await db.get('settings', 'main');
  return { ...DEFAULT_SETTINGS, ...(r?.data || {}) };
}

export async function saveSettings(data) {
  await db.upsert('settings', { id: 'main', data, updated_at: nowIso() });
}

export const bySortName = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name), 'fr');

export const orderTotal = (items) => items.reduce((s, i) => s + i.qty * i.unit_price, 0);

// Commandes clôturées (encaissées ou annulées) dans [from, to[
export async function fetchClosed(from, to) {
  const orders = await db.list('orders', {
    gte: { closed_at: from.toISOString() },
    lt: { closed_at: to.toISOString() },
    order: ['closed_at', 'asc'],
  });
  const items = orders.length ? await listIn('order_items', 'order_id', orders.map((o) => o.id)) : [];
  return { orders, items };
}

export async function fetchOpen() {
  const orders = await db.list('orders', { eq: { status: 'open' }, order: ['opened_at', 'asc'] });
  const items = orders.length
    ? await listIn('order_items', 'order_id', orders.map((o) => o.id), { order: ['created_at', 'asc'] })
    : [];
  return { orders, items };
}

export function computeStats(orders, items, from, to) {
  const paid = orders.filter((o) => o.status === 'paid');
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const paidSet = new Set(paid.map((o) => o.id));
  const revenue = paid.reduce((s, o) => s + (o.total || 0), 0);

  const prod = new Map();
  const cat = new Map();
  let itemsSold = 0;
  const cancelledLines = { qty: 0, amount: 0 };
  for (const it of items) {
    if (!paidSet.has(it.order_id)) continue;
    if (it.qty > 0) {
      const key = it.product_id || it.product_name;
      const p = prod.get(key) || { name: it.product_name, category: it.category_name || '—', qty: 0, amount: 0 };
      p.qty += it.qty;
      p.amount += it.qty * it.unit_price;
      prod.set(key, p);
      const ck = it.category_name || '—';
      const c = cat.get(ck) || { name: ck, qty: 0, amount: 0 };
      c.qty += it.qty;
      c.amount += it.qty * it.unit_price;
      cat.set(ck, c);
      itemsSold += it.qty;
    }
    if (it.cancelled_qty > 0) {
      cancelledLines.qty += it.cancelled_qty;
      cancelledLines.amount += it.cancelled_qty * it.unit_price;
    }
  }

  const payments = {};
  for (const o of paid) {
    const m = o.payment_method || 'other';
    payments[m] ||= { count: 0, amount: 0 };
    payments[m].count++;
    payments[m].amount += o.total || 0;
  }

  // Découpage temporel : par heure si la période fait ≤ 48 h, sinon par jour
  const span = to - from;
  const buckets = [];
  let unit;
  if (span <= 48 * 3600e3) {
    unit = 'hour';
    const idx = new Map();
    for (let t = new Date(from); t < to; t = new Date(t.getTime() + 3600e3)) {
      const k = `${dayKey(t)} ${t.getHours()}`;
      idx.set(k, buckets.length);
      buckets.push({ label: `${pad(t.getHours())}h`, title: `${fmtDate(t)} · ${pad(t.getHours())}h–${pad((t.getHours() + 1) % 24)}h`, value: 0, count: 0 });
    }
    for (const o of paid) {
      const t = new Date(o.closed_at);
      const b = buckets[idx.get(`${dayKey(t)} ${t.getHours()}`)];
      if (b) { b.value += o.total || 0; b.count++; }
    }
  } else {
    unit = 'day';
    const idx = new Map();
    for (let t = startOfDay(from); t < to && buckets.length < 400; t = addDays(t, 1)) {
      idx.set(dayKey(t), buckets.length);
      buckets.push({ label: `${pad(t.getDate())}/${pad(t.getMonth() + 1)}`, title: t.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), value: 0, count: 0 });
    }
    for (const o of paid) {
      const b = buckets[idx.get(dayKey(o.closed_at))];
      if (b) { b.value += o.total || 0; b.count++; }
    }
  }

  return {
    revenue,
    tickets: paid.length,
    avg: paid.length ? Math.round(revenue / paid.length) : 0,
    itemsSold,
    products: [...prod.values()].sort((a, b) => b.amount - a.amount),
    categories: [...cat.values()].sort((a, b) => b.amount - a.amount),
    payments,
    buckets,
    unit,
    cancelledOrders: { count: cancelled.length, amount: cancelled.reduce((s, o) => s + (o.total || 0), 0) },
    cancelledLines,
  };
}
