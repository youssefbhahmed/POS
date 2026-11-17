// Couche de données : même interface pour le mode LOCAL (localStorage)
// et le mode CLOUD (Supabase + temps réel).
//
//   db.list(table, { eq, neq, in, gte, lt, order: [col, 'asc'|'desc'], limit })
//   db.get(table, id) · db.insert(table, row) · db.update(table, id, patch)
//   db.upsert(table, row) · db.remove(table, id)
//   db.subscribe(fn) → unsubscribe   (fn appelée à chaque changement)

import { CONFIG } from './config.js';

export const isCloud = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

export const uid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export const nowIso = () => new Date().toISOString();

function cmp(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function applyLocal(rows, q = {}) {
  let r = rows.filter((row) => {
    for (const [k, v] of Object.entries(q.eq || {})) if ((row[k] ?? null) !== v) return false;
    for (const [k, v] of Object.entries(q.neq || {})) if ((row[k] ?? null) === v) return false;
    for (const [k, v] of Object.entries(q.in || {})) if (!v.includes(row[k])) return false;
    for (const [k, v] of Object.entries(q.gte || {})) if (row[k] == null || row[k] < v) return false;
    for (const [k, v] of Object.entries(q.lt || {})) if (row[k] == null || row[k] >= v) return false;
    return true;
  });
  if (q.order) {
    const [col, dir = 'asc'] = q.order;
    r.sort((a, b) => cmp(a[col], b[col]) * (dir === 'desc' ? -1 : 1));
  }
  if (q.limit) r = r.slice(0, q.limit);
  return r.map((x) => ({ ...x }));
}

class Emitter {
  constructor() {
    this.subs = new Set();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._notify({ table: '*', type: 'resync' });
    });
  }
  _notify(evt) {
    for (const f of this.subs) {
      try {
        f(evt);
      } catch (e) {
        console.error(e);
      }
    }
  }
  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

// ── MODE LOCAL ───────────────────────────────────────────────
class LocalDB extends Emitter {
  constructor() {
    super();
    this.KEY = 'caisse_local_db_v1';
    try {
      this.bc = new BroadcastChannel('caisse_local');
      this.bc.onmessage = (e) => this._notify(e.data);
    } catch {}
  }
  async init() {}
  _read() {
    const raw = localStorage.getItem(this.KEY);
    if (raw) return JSON.parse(raw);
    const d = seedData();
    this._write(d);
    return d;
  }
  _write(d) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(d));
    } catch (e) {
      throw new Error('Stockage local plein : passez en mode cloud (voir README).');
    }
  }
  _emit(evt) {
    this._notify(evt);
    this.bc?.postMessage(evt);
  }
  async list(table, q) {
    return applyLocal(this._read()[table] || [], q);
  }
  async get(table, id) {
    const r = (this._read()[table] || []).find((x) => x.id === id);
    return r ? { ...r } : null;
  }
  async insert(table, row) {
    const d = this._read();
    const r = { id: uid(), created_at: nowIso(), ...row };
    if (table === 'orders' && r.number == null) {
      d._seq = (d._seq || 0) + 1;
      r.number = d._seq;
    }
    (d[table] ||= []).push(r);
    this._write(d);
    this._emit({ table, type: 'INSERT' });
    return { ...r };
  }
  async update(table, id, patch) {
    const d = this._read();
    const r = (d[table] || []).find((x) => x.id === id);
    if (!r) throw new Error('Élément introuvable');
    Object.assign(r, patch);
    this._write(d);
    this._emit({ table, type: 'UPDATE' });
    return { ...r };
  }
  async upsert(table, row) {
    const d = this._read();
    const list = (d[table] ||= []);
    const i = list.findIndex((x) => x.id === row.id);
    if (i >= 0) list[i] = { ...list[i], ...row };
    else list.push({ created_at: nowIso(), ...row });
    this._write(d);
    this._emit({ table, type: 'UPSERT' });
    return { ...row };
  }
  async remove(table, id) {
    const d = this._read();
    d[table] = (d[table] || []).filter((x) => x.id !== id);
    if (table === 'orders') d.order_items = (d.order_items || []).filter((x) => x.order_id !== id);
    this._write(d);
    this._emit({ table, type: 'DELETE' });
  }
  // Pas d'authentification en mode local
  async getSession() {
    return { user: { email: 'local' } };
  }
  async signOut() {}
  exportAll() {
    return this._read();
  }
  reset() {
    localStorage.removeItem(this.KEY);
    this._emit({ table: '*', type: 'reset' });
  }
}

// ── MODE CLOUD (Supabase) ────────────────────────────────────
class CloudDB extends Emitter {
  async init() {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm');
    this.sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  _apply(qb, q = {}) {
    for (const [k, v] of Object.entries(q.eq || {})) qb = v === null ? qb.is(k, null) : qb.eq(k, v);
    for (const [k, v] of Object.entries(q.neq || {})) qb = v === null ? qb.not(k, 'is', null) : qb.neq(k, v);
    for (const [k, v] of Object.entries(q.in || {})) qb = qb.in(k, v);
    for (const [k, v] of Object.entries(q.gte || {})) qb = qb.gte(k, v);
    for (const [k, v] of Object.entries(q.lt || {})) qb = qb.lt(k, v);
    if (q.order) qb = qb.order(q.order[0], { ascending: q.order[1] !== 'desc' });
    return qb;
  }
  async list(table, q = {}) {
    if (q.limit) {
      const { data, error } = await this._apply(this.sb.from(table).select('*'), q).limit(q.limit);
      if (error) throw error;
      return data;
    }
    // Pagination (Supabase renvoie 1000 lignes max par requête)
    const all = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this._apply(this.sb.from(table).select('*'), q).range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }
  async get(table, id) {
    const { data, error } = await this.sb.from(table).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async insert(table, row) {
    const { data, error } = await this.sb.from(table).insert(row).select().single();
    if (error) throw error;
    return data;
  }
  async update(table, id, patch) {
    const { data, error } = await this.sb.from(table).update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  async upsert(table, row) {
    const { data, error } = await this.sb.from(table).upsert(row).select().single();
    if (error) throw error;
    return data;
  }
  async remove(table, id) {
    const { error } = await this.sb.from(table).delete().eq('id', id);
    if (error) throw error;
  }
  subscribe(fn) {
    if (!this.channel) {
      this.channel = this.sb
        .channel('caisse-db')
        .on('postgres_changes', { event: '*', schema: 'public' }, (p) =>
          this._notify({ table: p.table, type: p.eventType }),
        )
        .subscribe();
    }
    return super.subscribe(fn);
  }
  async getSession() {
    const { data } = await this.sb.auth.getSession();
    return data.session;
  }
  async signIn(email, password) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect' : error.message);
  }
  async signOut() {
    await this.sb.auth.signOut();
  }
}

export const db = isCloud ? new CloudDB() : new LocalDB();

// Liste avec un filtre "in" découpé en paquets (URLs trop longues sinon)
export async function listIn(table, col, ids, q = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    out.push(...(await db.list(table, { ...q, in: { ...(q.in || {}), [col]: ids.slice(i, i + 150) } })));
  }
  return out;
}

// ── Données de démarrage (mode local) ────────────────────────
function seedData() {
  const cat = (name, color, sort) => ({ id: uid(), name, color, sort, created_at: nowIso() });
  const cats = [
    cat('Cafés & thés', '#EA580C', 1),
    cat('Boissons', '#2563EB', 2),
    cat('Jus', '#DB2777', 3),
    cat('À manger', '#059669', 4),
  ];
  const P = [
    [0, 'Express', 1500], [0, 'Capucin', 1800], [0, 'Direct', 2000], [0, 'Cappuccino', 3500],
    [0, 'Américain', 2500], [0, 'Thé à la menthe', 1500], [0, 'Thé aux pignons', 4500],
    [1, 'Eau 0,5 L', 1000], [1, 'Eau 1 L', 1500], [1, 'Soda', 2500], [1, 'Citronnade', 3000],
    [2, "Jus d'orange", 4000], [2, 'Jus de fraise', 4500], [2, 'Smoothie', 6000],
    [3, 'Croissant', 1500], [3, 'Pain au chocolat', 1800], [3, 'Cake', 2500],
    [3, 'Crêpe Nutella', 6000], [3, 'Sandwich thon', 6500], [3, 'Plat du jour', 12000],
  ];
  const products = P.map(([c, name, price], i) => ({
    id: uid(), name, price, category_id: cats[c].id, active: true, sort: i, created_at: nowIso(),
  }));
  const tables = [
    ...Array.from({ length: 8 }, (_, i) => `Table ${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `Terrasse ${i + 1}`),
  ].map((name, i) => ({ id: uid(), name, sort: i, active: true, created_at: nowIso() }));
  return {
    _seq: 0,
    categories: cats,
    products,
    cafe_tables: tables,
    orders: [],
    order_items: [],
    settings: [{ id: 'main', data: { shopName: 'Mon Café' } }],
  };
}
