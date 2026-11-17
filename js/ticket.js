// Construction des tickets (document abstrait) puis rendu en
//  - octets ESC/POS (imprimante thermique), ou
//  - HTML (aperçu écran / impression navigateur).
//
// Un document est une liste d'opérations :
//   { t:'text', s, align, bold, size }   { t:'lr', l, r, bold, size }
//   { t:'line' }   { t:'feed', n }   { t:'cut' }

import { fmt } from './money.js';
import { fmtDateTime } from './ui.js';
import { PAY_LABELS } from './data.js';

// Imprimantes thermiques : on reste en ASCII pour un rendu fiable.
export const toAscii = (s) =>
  String(s ?? '')
    .replace(/[  ]/g, ' ')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
    .replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"')
    .replace(/[–—−]/g, '-').replace(/°/g, 'o').replace(/€/g, 'EUR')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '?');

function wrap(text, w) {
  const indent = text.match(/^ */)[0];
  if (indent && indent.length < w / 2) return wrap(text.slice(indent.length), w - indent.length).map((l) => indent + l);
  const out = [];
  let cur = '';
  for (let word of text.split(' ').filter((x, i) => x || i === 0)) {
    while (word.length > w) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else { out.push(cur); cur = word; }
  }
  out.push(cur);
  return out;
}

// Document → lignes prêtes à imprimer (largeur en caractères : 32 pour 58mm, 48 pour 80mm)
export function layout(doc, W = 32) {
  const rows = [];
  for (const op of doc) {
    const size = op.size === 2 ? 2 : 1;
    const w = Math.floor(W / size);
    const base = { align: op.align || 'left', bold: !!op.bold, size };
    if (op.t === 'text') {
      for (const l of toAscii(op.s).split('\n')) for (const x of wrap(l, w)) rows.push({ ...base, text: x });
    } else if (op.t === 'line') {
      rows.push({ text: (op.ch || '-').repeat(W), align: 'left', bold: false, size: 1 });
    } else if (op.t === 'lr') {
      const l = toAscii(op.l), r = toAscii(op.r);
      const line = (a, b) => a + ' '.repeat(Math.max(1, w - a.length - b.length)) + b;
      if (l.length + 1 + r.length <= w) rows.push({ ...base, align: 'left', text: line(l, r) });
      else {
        const ls = wrap(l, w);
        const last = ls.pop();
        ls.forEach((x) => rows.push({ ...base, align: 'left', text: x }));
        if (last.length + 1 + r.length <= w) rows.push({ ...base, align: 'left', text: line(last, r) });
        else {
          rows.push({ ...base, align: 'left', text: last });
          rows.push({ ...base, align: 'left', text: r.padStart(w) });
        }
      }
    } else if (op.t === 'feed') {
      for (let i = 0; i < (op.n || 1); i++) rows.push({ text: '', align: 'left', bold: false, size: 1 });
    } else if (op.t === 'cut') {
      rows.push({ cut: true });
    }
  }
  return rows;
}

export function toEscPos(doc, { width = 32, cut = true } = {}) {
  const out = [0x1b, 0x40, 0x1b, 0x74, 0x00]; // init + page de code PC437
  const ALIGN = { left: 0, center: 1, right: 2 };
  for (const r of layout(doc, width)) {
    if (r.cut) {
      if (cut) out.push(0x1d, 0x56, 0x42, 0x00); // coupe partielle (ignorée sans massicot)
      continue;
    }
    out.push(0x1b, 0x61, ALIGN[r.align] ?? 0);
    out.push(0x1b, 0x45, r.bold ? 1 : 0);
    out.push(0x1d, 0x21, r.size === 2 ? 0x11 : 0x00);
    for (let i = 0; i < r.text.length; i++) out.push(r.text.charCodeAt(i));
    out.push(0x0a);
  }
  out.push(0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00);
  return new Uint8Array(out);
}

export function toHTML(doc, width = 32) {
  const e = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = layout(doc, width)
    .filter((r) => !r.cut)
    .map((r) => `<div class="r" style="text-align:${r.align};${r.bold ? 'font-weight:700;' : ''}${r.size === 2 ? 'font-size:2em;line-height:1.1;' : ''}">${e(r.text) || '&nbsp;'}</div>`)
    .join('');
  return `<div class="rcpt" style="width:${width}ch">${rows}</div>`;
}

// ── Modèles de tickets ───────────────────────────────────────
function header(d, s) {
  d.push({ t: 'text', s: s.shopName || 'Mon Café', align: 'center', bold: true, size: 2 });
  if (s.address) d.push({ t: 'text', s: s.address, align: 'center' });
  if (s.phone) d.push({ t: 'text', s: `Tel : ${s.phone}`, align: 'center' });
  if (s.taxId) d.push({ t: 'text', s: `MF : ${s.taxId}`, align: 'center' });
}

function footer(d, s) {
  if (s.footer) {
    d.push({ t: 'feed', n: 1 });
    d.push({ t: 'text', s: s.footer, align: 'center' });
  }
  d.push({ t: 'feed', n: 4 });
  d.push({ t: 'cut' });
}

// kind: 'receipt' (ticket client après encaissement) | 'bill' (addition)
export function buildOrderTicket({ settings, order, items, kind = 'receipt' }) {
  const d = [];
  const active = items.filter((i) => i.qty > 0);
  const total = active.reduce((s, i) => s + i.qty * i.unit_price, 0);
  header(d, settings);
  d.push({ t: 'line' });
  if (kind === 'bill') d.push({ t: 'text', s: 'ADDITION', align: 'center', bold: true });
  if (order.status === 'cancelled') d.push({ t: 'text', s: '*** TICKET ANNULE ***', align: 'center', bold: true });
  d.push({ t: 'lr', l: `${kind === 'bill' ? 'Commande' : 'Ticket'} N° ${order.number ?? ''}`, r: order.table_name || 'Comptoir' });
  d.push({ t: 'text', s: fmtDateTime(kind === 'bill' ? new Date() : order.closed_at || new Date()) });
  d.push({ t: 'line' });
  for (const it of active) {
    d.push({ t: 'lr', l: `${it.qty} x ${it.product_name}`, r: fmt(it.qty * it.unit_price, false) });
    if (it.qty > 1) d.push({ t: 'text', s: `    ${fmt(it.unit_price, false)} / u` });
  }
  d.push({ t: 'line' });
  d.push({ t: 'lr', l: 'TOTAL', r: fmt(total), bold: true, size: 2 });
  if (kind === 'receipt' && order.payment_method) {
    d.push({ t: 'lr', l: 'Paiement', r: PAY_LABELS[order.payment_method] || order.payment_method });
    if (order.payment_method === 'cash' && order.amount_received > 0) {
      d.push({ t: 'lr', l: 'Recu', r: fmt(order.amount_received) });
      d.push({ t: 'lr', l: 'Rendu', r: fmt(Math.max(0, order.amount_received - total)) });
    }
  }
  footer(d, settings);
  return d;
}

export function buildReport({ settings, stats, from, to }) {
  const d = [];
  d.push({ t: 'text', s: settings.shopName || 'Mon Café', align: 'center', bold: true });
  d.push({ t: 'text', s: 'RAPPORT DE CAISSE', align: 'center', bold: true, size: 2 });
  d.push({ t: 'text', s: `Du ${fmtDateTime(from)}` });
  d.push({ t: 'text', s: `Au ${fmtDateTime(to)}` });
  d.push({ t: 'line' });
  d.push({ t: 'lr', l: 'Tickets', r: String(stats.tickets) });
  d.push({ t: 'lr', l: 'Articles vendus', r: String(stats.itemsSold) });
  d.push({ t: 'lr', l: 'Panier moyen', r: fmt(stats.avg) });
  d.push({ t: 'lr', l: 'CA TOTAL', r: fmt(stats.revenue), bold: true });
  d.push({ t: 'line' });
  d.push({ t: 'text', s: 'PAIEMENTS', bold: true });
  for (const [m, v] of Object.entries(stats.payments)) d.push({ t: 'lr', l: `${PAY_LABELS[m] || m} (${v.count})`, r: fmt(v.amount, false) });
  d.push({ t: 'line' });
  d.push({ t: 'text', s: 'VENTES PAR PRODUIT', bold: true });
  for (const p of stats.products) d.push({ t: 'lr', l: `${p.qty} x ${p.name}`, r: fmt(p.amount, false) });
  d.push({ t: 'line' });
  d.push({ t: 'text', s: 'ANNULATIONS', bold: true });
  d.push({ t: 'lr', l: `Commandes (${stats.cancelledOrders.count})`, r: fmt(stats.cancelledOrders.amount, false) });
  d.push({ t: 'lr', l: `Articles retires (${stats.cancelledLines.qty})`, r: fmt(stats.cancelledLines.amount, false) });
  d.push({ t: 'line' });
  d.push({ t: 'text', s: `Imprime le ${fmtDateTime(new Date())}`, align: 'center' });
  d.push({ t: 'feed', n: 4 });
  d.push({ t: 'cut' });
  return d;
}

export function buildTestTicket(settings) {
  const d = [];
  header(d, settings);
  d.push({ t: 'line' });
  d.push({ t: 'text', s: "TEST D'IMPRESSION", align: 'center', bold: true });
  d.push({ t: 'lr', l: '2 x Express', r: '3,000' });
  d.push({ t: 'lr', l: '1 x Croissant', r: '1,500' });
  d.push({ t: 'line' });
  d.push({ t: 'lr', l: 'TOTAL', r: '4,500 DT', bold: true, size: 2 });
  d.push({ t: 'text', s: fmtDateTime(new Date()), align: 'center' });
  footer(d, settings);
  return d;
}
