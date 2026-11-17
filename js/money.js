// Les montants sont stockés en MILLIMES (entiers) : 1 DT = 1000 millimes.
// Cela évite toute erreur d'arrondi.

export function fmt(m, withCurrency = true) {
  const v = Math.round(Number(m) || 0);
  const neg = v < 0;
  const a = Math.abs(v);
  const dinars = Math.floor(a / 1000)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const s = `${neg ? '-' : ''}${dinars},${String(a % 1000).padStart(3, '0')}`;
  return withCurrency ? `${s} DT` : s;
}

// "3,5" / "3.500" / "12" → millimes. Renvoie NaN si invalide.
export function parseMoney(str) {
  const s = String(str ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (s === '') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
}

// Valeur à mettre dans un champ de saisie (ex. 3500 → "3,500")
export const toInput = (m) => fmt(m, false).replace(/\s/g, '');
