// Impression des tickets. Réglages propres à CHAQUE appareil (localStorage).
//
// Modes :
//  - usb     : imprimante USB branchée sur la tablette, pilotée directement
//              par Chrome (WebUSB). Recommandé sur Android.
//  - rawbt   : passe par l'application Android « RawBT » (secours si WebUSB
//              ne reconnaît pas l'imprimante).
//  - browser : boîte d'impression Android/Chrome (pilote d'impression système).
//  - preview : affiche le ticket à l'écran (test sans imprimante).

import { toEscPos, toHTML, buildTestTicket } from './ticket.js';
import { modal, esc, toast } from './ui.js';

const KEY = 'caisse_printer_v1';

export const PRINT_MODES = {
  usb: 'USB direct (recommandé)',
  rawbt: 'Application RawBT',
  browser: 'Impression Android / Chrome',
  preview: "Aperçu à l'écran (sans imprimante)",
};

export function getPrinterSettings() {
  const def = { mode: navigator.usb ? 'usb' : 'preview', width: 32, cut: true, copies: 1 };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return def;
  }
}

export function savePrinterSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

// ── WebUSB ───────────────────────────────────────────────────
let dev = null;
let epOut = null;

async function setupDevice(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  let found = null;
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      // On préfère l'interface de classe « imprimante » (7)
      if (out && (!found || alt.interfaceClass === 7)) {
        found = { iface: iface.interfaceNumber, alt: alt.alternateSetting, ep: out.endpointNumber };
      }
    }
  }
  if (!found) throw new Error("Aucune sortie d'impression trouvée sur cet appareil USB.");
  const iface = device.configuration.interfaces.find((i) => i.interfaceNumber === found.iface);
  if (!iface.claimed) await device.claimInterface(found.iface);
  if (found.alt) await device.selectAlternateInterface(found.iface, found.alt);
  dev = device;
  epOut = found.ep;
}

export async function connectUsbPrinter() {
  if (!navigator.usb) throw new Error('WebUSB indisponible : utilisez Chrome sur Android, sur une adresse https://');
  const device = await navigator.usb.requestDevice({ filters: [] });
  await setupDevice(device);
  return device.productName || 'Imprimante USB';
}

async function ensureUsb() {
  if (dev?.opened) return;
  const devices = (await navigator.usb?.getDevices()) || [];
  if (!devices.length) throw new Error('Aucune imprimante USB autorisée. Ouvrez « Imprimante » puis « Connecter l’imprimante USB ».');
  await setupDevice(devices[0]);
}

export const usbPrinterName = () => (dev?.opened ? dev.productName || 'Imprimante USB' : null);

if (navigator.usb) {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (e.device === dev) dev = null;
  });
  navigator.usb.addEventListener('connect', () => {
    if (getPrinterSettings().mode === 'usb') ensureUsb().catch(() => {});
  });
  // Reconnexion silencieuse au démarrage (appareil déjà autorisé)
  if (getPrinterSettings().mode === 'usb') ensureUsb().catch(() => {});
}

async function sendUsb(bytes) {
  const CHUNK = 1024;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureUsb();
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const r = await dev.transferOut(epOut, bytes.slice(i, i + CHUNK));
        if (r.status !== 'ok') throw new Error(`Transfert USB : ${r.status}`);
      }
      return;
    } catch (err) {
      try { await dev?.close(); } catch {}
      dev = null;
      if (attempt === 1) throw err;
    }
  }
}

// ── RawBT ────────────────────────────────────────────────────
function sendRawbt(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  window.location.href = `intent:base64,${b64}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
}

// ── Impression navigateur ────────────────────────────────────
function printBrowser(doc, width) {
  const paperMm = width >= 48 ? 72 : 48;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${paperMm + 10}mm auto; margin: 0 }
    body { margin: 0; padding: 2mm 5mm; font-family: 'Courier New', monospace; font-size: ${(paperMm / (width * 0.6)).toFixed(2)}mm; color: #000 }
    .rcpt { white-space: pre; line-height: 1.25 }
  </style></head><body>${toHTML(doc, width)}</body></html>`;
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(f);
  f.contentDocument.open();
  f.contentDocument.write(html);
  f.contentDocument.close();
  setTimeout(() => {
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => f.remove(), 2000);
  }, 200);
}

export function previewTicket(doc, width = getPrinterSettings().width, title = 'Aperçu du ticket') {
  return modal({ title, body: `<div class="rcpt-wrap">${toHTML(doc, width)}</div>`, buttons: [{ label: 'Fermer', value: true }] });
}

// Point d'entrée unique
export async function printDoc(doc) {
  const s = getPrinterSettings();
  const copies = Math.max(1, Math.min(3, +s.copies || 1));
  if (s.mode === 'preview') return previewTicket(doc, s.width);
  if (s.mode === 'browser') return printBrowser(doc, s.width);
  const bytes = toEscPos(doc, { width: s.width, cut: s.cut });
  let all = bytes;
  if (copies > 1) {
    all = new Uint8Array(bytes.length * copies);
    for (let i = 0; i < copies; i++) all.set(bytes, i * bytes.length);
  }
  if (s.mode === 'rawbt') return sendRawbt(all);
  return sendUsb(all);
}

export function printerBadge() {
  const s = getPrinterSettings();
  if (s.mode === 'usb') return usbPrinterName() ? { label: 'Imprimante USB', ok: true } : { label: 'USB non connectée', ok: false };
  if (s.mode === 'preview') return { label: 'Aperçu écran', ok: false };
  return { label: PRINT_MODES[s.mode].split(' (')[0], ok: true };
}

// Fenêtre de réglage de l'imprimante (sur la tablette)
export async function openPrinterSettings(settings) {
  const s = getPrinterSettings();
  const body = `
    <div class="form">
      <label class="field"><span>Mode d'impression</span>
        <select class="input" id="pm">${Object.entries(PRINT_MODES)
          .map(([k, l]) => `<option value="${k}" ${k === s.mode ? 'selected' : ''}>${esc(l)}</option>`)
          .join('')}</select></label>
      <div class="usb-zone">
        <p class="hint">Branchez l'imprimante (câble OTG), puis touchez le bouton et choisissez-la dans la liste.</p>
        <button class="btn" type="button" id="pusb">Connecter l'imprimante USB</button>
        <span class="muted" id="pusb-st">${esc(usbPrinterName() || (navigator.usb ? 'Non connectée' : 'WebUSB indisponible sur ce navigateur'))}</span>
      </div>
      <p class="hint rawbt-zone">Installez « RawBT » depuis le Play Store, réglez-y votre imprimante USB, puis revenez ici.</p>
      <div class="row2">
        <label class="field"><span>Largeur du papier</span>
          <select class="input" id="pw"><option value="32" ${s.width == 32 ? 'selected' : ''}>58 mm (32 caractères)</option><option value="48" ${s.width == 48 ? 'selected' : ''}>80 mm (48 caractères)</option></select></label>
        <label class="field"><span>Exemplaires</span>
          <select class="input" id="pc">${[1, 2, 3].map((n) => `<option ${s.copies == n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" id="pcut" ${s.cut ? 'checked' : ''}> Couper le papier (si l'imprimante a un massicot)</label>
    </div>`;
  const read = (w) => ({
    mode: w.querySelector('#pm').value,
    width: +w.querySelector('#pw').value,
    copies: +w.querySelector('#pc').value,
    cut: w.querySelector('#pcut').checked,
  });
  return modal({
    title: 'Imprimante',
    body,
    buttons: [
      {
        label: 'Imprimer un test',
        onClick: async (w) => {
          savePrinterSettings(read(w));
          try {
            await printDoc(buildTestTicket(settings));
          } catch (e) {
            toast(`Impression impossible : ${e.message}`, 'error', 6000);
          }
          return false;
        },
      },
      { label: 'Enregistrer', cls: 'primary', onClick: (w) => (savePrinterSettings(read(w)), true) },
    ],
    onMount: (w) => {
      const sync = () => {
        const m = w.querySelector('#pm').value;
        w.querySelector('.usb-zone').hidden = m !== 'usb';
        w.querySelector('.rawbt-zone').hidden = m !== 'rawbt';
      };
      sync();
      w.querySelector('#pm').addEventListener('change', sync);
      w.querySelector('#pusb').addEventListener('click', async () => {
        try {
          const name = await connectUsbPrinter();
          w.querySelector('#pusb-st').textContent = `Connectée : ${name}`;
          toast('Imprimante connectée', 'ok');
        } catch (e) {
          if (e.name !== 'NotFoundError') toast(e.message, 'error', 6000);
        }
      });
    },
  });
}
