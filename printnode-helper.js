// PrintNode ESC/POS Bondrucker Helper
// Druckt automatisch bei jeder neuen Bestellung

const fetch = require('node-fetch');

async function printOrder(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) {
    console.log('PrintNode nicht konfiguriert – überspringe Druck');
    return;
  }

  const content = buildReceipt(order);
  const base64Content = Buffer.from(content).toString('base64');

  const response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      printer: parseInt(process.env.PRINTNODE_PRINTER_ID),
      title: `Ararat Grill Bestellung #${order.orderNum}`,
      contentType: 'raw_base64',
      content: base64Content,
      source: 'Ararat Grill Backend'
    })
  });

  if (response.ok) {
    console.log(`🖨️ Bon gedruckt: Bestellung #${order.orderNum}`);
  } else {
    const err = await response.text();
    console.error('PrintNode Fehler:', err);
  }
}

function buildReceipt(order) {
  const ESC = '\x1B';
  const GS  = '\x1D';

  // ESC/POS Commands
  const RESET        = ESC + '@';
  const BLACK        = ESC + 'r\x00';   // Druckfarbe: Schwarz
  const BOLD_ON      = ESC + 'E\x01';
  const BOLD_OFF     = ESC + 'E\x00';
  const CENTER       = ESC + 'a\x01';
  const LEFT         = ESC + 'a\x00';
  const DOUBLE_ON    = GS  + '!\x11';
  const DOUBLE_OFF   = GS  + '!\x00';
  const CUT          = GS  + 'V\x41\x03';
  const LF           = '\n';

  const SEPARATOR = '------------------------------------------------' + LF; // 48 Zeichen = 80mm

  const time = new Date(order.createdAt).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  let receipt = RESET + BLACK;

  // Header
  receipt += CENTER;
  receipt += DOUBLE_ON + BOLD_ON + 'ARARAT GRILL' + LF + DOUBLE_OFF + BOLD_OFF;
  receipt += 'Nordwall 45 · 59269 Beckum' + LF;
  receipt += 'Tel: 02521-9009414' + LF;
  receipt += SEPARATOR;

  // Bestellnummer + Zeit
  receipt += BOLD_ON + `BESTELLUNG #${order.orderNum}` + BOLD_OFF + LF;
  receipt += time + LF;
  receipt += SEPARATOR;

  // Art
  const modeText = order.mode === 'lieferung' ? '*** LIEFERUNG ***' : '*** ABHOLUNG ***';
  receipt += BOLD_ON + CENTER + modeText + LF + BOLD_OFF;
  receipt += LEFT;

  // Kundeninfos
  receipt += `Kunde: ${order.customer?.first || ''} ${order.customer?.last || ''}` + LF;
  if (order.customer?.phone) receipt += `Tel: ${order.customer.phone}` + LF;
  if (order.mode === 'lieferung' && order.customer?.street) {
    receipt += `Adresse: ${order.customer.street} ${order.customer.house}` + LF;
    receipt += `         ${order.customer.city}` + LF;
  }
  receipt += SEPARATOR;

  // Artikel
  (order.items || []).forEach(item => {
    const numPrefix = item.num ? `${item.num} ` : '';
    const name = (numPrefix + item.name).substring(0, 36);
    const price = (item.price * item.qty).toFixed(2).replace('.', ',') + ' EUR';
    const line = `${item.qty}x ${name}`;
    const spaces = 48 - line.length - price.length;
    receipt += BOLD_ON + line + ' '.repeat(Math.max(1, spaces)) + price + LF + BOLD_OFF;
    if (item.note) {
      item.note.split(', ').forEach(sel => {
        receipt += `   - ${sel}` + LF;
      });
    }
    if (item.extraDetails && item.extraDetails.length > 0) {
      item.extraDetails.forEach(extra => {
        receipt += BOLD_ON + `   • ${extra.name}` + (extra.price > 0 ? ` (+${extra.price.toFixed(2).replace('.', ',')} EUR)` : '') + BOLD_OFF + LF;
      });
    }
  });

  receipt += SEPARATOR;

  // Preise
  if (order.subtotal) {
    receipt += padLine('Zwischensumme:', order.subtotal.toFixed(2).replace('.', ',') + ' EUR') + LF;
  }
  if (order.deliveryFee && order.deliveryFee > 0) {
    receipt += padLine('Liefergebuehr:', order.deliveryFee.toFixed(2).replace('.', ',') + ' EUR') + LF;
  }
  if (order.serviceFee && order.serviceFee > 0) {
    receipt += padLine('Servicegebuehr:', order.serviceFee.toFixed(2).replace('.', ',') + ' EUR') + LF;
  }
  receipt += SEPARATOR;
  receipt += BOLD_ON + DOUBLE_ON;
  receipt += padLine('GESAMT:', (order.total || 0).toFixed(2).replace('.', ',') + ' EUR') + LF;
  receipt += DOUBLE_OFF + BOLD_OFF;
  receipt += SEPARATOR;

  // Zahlung
  const payText = order.payment === 'bar'
    ? 'Barzahlung'
    : order.payment === 'stripe' ? 'Kreditkarte (Stripe)' : 'EC-Karte';
  receipt += `Zahlung: ${payText}` + LF;
  receipt += `Bezahlt: ${order.paymentStatus === 'paid' ? 'JA' : 'NEIN – bitte kassieren!'}` + LF;

  // Anmerkung
  if (order.note) {
    receipt += SEPARATOR;
    receipt += BOLD_ON + 'ANMERKUNG:' + BOLD_OFF + LF;
    receipt += order.note + LF;
  }

  receipt += SEPARATOR;
  receipt += CENTER + 'Vielen Dank!' + LF;
  receipt += '~35 Min Lieferzeit' + LF;
  receipt += LF + LF + LF;
  receipt += CUT;

  return receipt;
}

function padLine(label, value) {
  const total = 48;
  const spaces = total - label.length - value.length;
  return label + ' '.repeat(Math.max(1, spaces)) + value;
}

async function printDailyReport(data) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) {
    console.log('PrintNode nicht konfiguriert – überspringe Druck');
    return;
  }
  const content = buildDailyReport(data);
  const base64Content = Buffer.from(content).toString('base64');
  const response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      printer: parseInt(process.env.PRINTNODE_PRINTER_ID),
      title: `Ararat Grill Tagesabschluss ${data.label}`,
      contentType: 'raw_base64',
      content: base64Content,
      source: 'Ararat Grill Backend'
    })
  });
  if (response.ok) {
    console.log(`🖨️ Tagesabschluss gedruckt: ${data.label}`);
  } else {
    const err = await response.text();
    console.error('PrintNode Fehler:', err);
  }
}

function buildDailyReport(data) {
  const ESC = '\x1B';
  const GS  = '\x1D';
  const RESET     = ESC + '@';
  const BLACK     = ESC + 'r\x00';
  const BOLD_ON   = ESC + 'E\x01';
  const BOLD_OFF  = ESC + 'E\x00';
  const CENTER    = ESC + 'a\x01';
  const LEFT      = ESC + 'a\x00';
  const DOUBLE_ON = GS  + '!\x11';
  const DOUBLE_OFF= GS  + '!\x00';
  const CUT       = GS  + 'V\x41\x03';
  const LF        = '\n';
  const SEP       = '------------------------------------------------' + LF;

  const { label, orders, total, nBar, nCard, nDel, nPick, printedAt } = data;

  let r = RESET + BLACK;

  r += CENTER;
  r += DOUBLE_ON + BOLD_ON + 'ARARAT GRILL' + LF + DOUBLE_OFF + BOLD_OFF;
  r += 'Tagesabschluss' + LF;
  r += label + LF;
  r += SEP;

  r += LEFT;
  r += padLine('Bestellungen gesamt:', `${orders.length}`) + LF;
  r += padLine('  davon Lieferung:', `${nDel}`) + LF;
  r += padLine('  davon Abholung:', `${nPick}`) + LF;
  r += padLine('  Barzahlung:', `${nBar}`) + LF;
  r += padLine('  Karte / Online:', `${nCard}`) + LF;
  r += SEP;

  if (orders.length > 0) {
    orders.forEach(o => {
      const time = new Date(o.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const name = ((o.customer?.first || '') + ' ' + (o.customer?.last || '')).trim() || '–';
      const art  = o.mode === 'lieferung' ? 'Lief.' : 'Abh.';
      const betrag = (o.total || 0).toFixed(2).replace('.', ',') + ' EUR';
      const left = `#${o.orderNum} ${time} ${art} ${name}`.substring(0, 36);
      r += padLine(left, betrag) + LF;
    });
    r += SEP;
  }

  r += BOLD_ON + DOUBLE_ON;
  r += padLine('GESAMTUMSATZ:', total.toFixed(2).replace('.', ',') + ' EUR') + LF;
  r += DOUBLE_OFF + BOLD_OFF;
  r += SEP;

  r += CENTER + `Gedruckt: ${printedAt}` + LF;
  r += LF + LF + LF;
  r += CUT;

  return r;
}

module.exports = { printOrder, printDailyReport };
