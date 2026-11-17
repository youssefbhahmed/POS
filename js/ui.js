// Petits utilitaires d'interface : échappement HTML, modales, toasts, dates.
import { icon } from './icons.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ── Dates ────────────────────────────────────────────────────
export const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (d) => {
  d = new Date(d);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fmtDate = (d) => {
  d = new Date(d);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};
export const fmtDateTime = (d) => `${fmtDate(d)} ${fmtTime(d)}`;
export const dayKey = (d) => {
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const toLocalInput = (d) => {
  d = new Date(d);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function since(iso) {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad(min % 60)}`;
}

// ── Toasts ───────────────────────────────────────────────────
export function toast(msg, type = 'info', ms = 3500) {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── Modales ──────────────────────────────────────────────────
// buttons: [{ label, value, cls, onClick(wrap) }]
//  - onClick peut renvoyer false (reste ouvert) ou une valeur (résultat).
export function modal({ title, body = '', buttons = [], onMount, wide = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Fermer">${icon('x')}</button></div>
        <div class="modal-body">${body}</div>
        ${buttons.length ? `<div class="modal-foot">${buttons
          .map((b, i) => `<button class="btn ${b.cls || ''}" data-btn="${i}">${esc(b.label)}</button>`)
          .join('')}</div>` : ''}
      </div>`;
    document.body.appendChild(wrap);
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', async (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-btn]');
      if (!b) return;
      const def = buttons[+b.dataset.btn];
      if (def.onClick) {
        b.disabled = true;
        try {
          const r = await def.onClick(wrap);
          if (r === false) return;
          return close(r === undefined ? def.value : r);
        } finally {
          b.disabled = false;
        }
      }
      close(def.value);
    });
    onMount?.(wrap, close);
    const first = wrap.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
    if (first && !first.hasAttribute('data-noautofocus')) setTimeout(() => first.focus(), 30);
  });
}

export const confirmDlg = (title, text, okLabel = 'Confirmer', danger = false) =>
  modal({
    title,
    body: `<p>${esc(text)}</p>`,
    buttons: [
      { label: 'Retour', value: false },
      { label: okLabel, value: true, cls: danger ? 'danger' : 'primary' },
    ],
  });

export const promptDlg = (title, label, value = '', type = 'text') =>
  modal({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input class="input" type="${type}" id="pd-v" value="${esc(value)}"></label>`,
    buttons: [
      { label: 'Annuler', value: null },
      { label: 'OK', cls: 'primary', onClick: (w) => w.querySelector('#pd-v').value },
    ],
    onMount: (w, close) =>
      w.querySelector('#pd-v').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(e.target.value);
      }),
  });

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}
