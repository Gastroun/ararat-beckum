/**
 * Lokaler Generator: Ararat Grill – Monatsbericht (nachträglich erzeugen)
 * Datenquelle: bevorzugt Admin-API (ADMIN_PASSWORD, HTTPS – keine Atlas-Allowlist
 * nötig); Fallback MongoDB direkt (MONGODB_URI). Gleiche Abfrage/Berechnung wie
 * der Monatsbericht-Cron in ../server.js.
 *
 * Aufruf:   node berichte/generate_monatsbericht_ararat.js [YYYY-MM] [RG-NR]
 * Beispiel: node berichte/generate_monatsbericht_ararat.js 2026-07 AR-2026-07
 * Default:  Vormonat, RG-NR "AR-<monat>"
 *
 * Benötigt: ararat-beckum/.env mit ADMIN_PASSWORD (empfohlen) ODER MONGODB_URI
 * (dann muss die aktuelle IP in der Atlas-Network-Access-Allowlist stehen).
 *
 * WICHTIG: Layout/Berechnung spiegeln 1:1 den Monatsbericht-Cron in ../server.js
 * (Funktion "MONATSBERICHT"). Bei Änderungen an server.js hier nachziehen.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Windows/c-ares kann bei mongodb+srv gelegentlich keinen SRV-Lookup (querySrv ECONNREFUSED);
// öffentliche Resolver als Fallback erzwingen.
try { require('dns').setServers(['8.8.8.8', '1.1.1.1']); } catch {}
const mongoose    = require('mongoose');
const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');

const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const API_BASE    = (process.env.API_BASE || 'https://ararat-grill-backend.onrender.com/api').trim();
const ADMIN_PW    = (process.env.ADMIN_PASSWORD || '').trim();

// Loses Schema – liest die bestehende "orders"-Collection (Model "Order" → orders)
const Order = mongoose.model('Order', new mongoose.Schema({}, { strict: false, collection: 'orders' }));

// ── Parameter: Monat (YYYY-MM) + Rechnungsnummer ──────────────────
const arg = (process.argv[2] || '').trim();
const now = new Date();
const defMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1); // Vormonat
const MONTH = /^\d{4}-\d{2}$/.test(arg)
  ? arg
  : `${defMonth.getFullYear()}-${String(defMonth.getMonth() + 1).padStart(2, '0')}`;
const RG_NR = (process.argv[3] || `AR-${MONTH}`).trim();

// ── PDF-Konstanten (wie server.js) ────────────────────────────────
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 810;
const PDF_SV = 1.00;
const PDF_PR = 0.05;
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';

// ── PDF-Helfer (1:1 aus server.js) ────────────────────────────────
function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

function getWeekNum(d) {
  const dt = new Date(d); dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate()+3-(dt.getDay()+6)%7);
  const w1 = new Date(dt.getFullYear(),0,4);
  return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7);
}

function pdfColorBox(doc, title, sub, color = '#1a1a2e', h = 70) {
  doc.rect(0, 0, PDF_PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text(title, PDF_M, 18);
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)').text(sub, PDF_M, 44);
  doc.y = h + 12;
}

function pdfHr(doc, color = '#ddd', lw = 0.5) {
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M + PDF_W, doc.y).strokeColor(color).lineWidth(lw).stroke();
  doc.y += lw + 3;
}

function pdfKacheln(doc, items) {
  const kW = Math.floor((PDF_W - (items.length - 1) * 8) / items.length);
  const top = doc.y;
  items.forEach(([label, value, color], i) => {
    const x = PDF_M + i * (kW + 8);
    doc.rect(x, top, kW, 46).fill(color);
    doc.font('Helvetica').fontSize(7.5).fillColor('rgba(255,255,255,0.72)').text(label, x + 8, top + 8, { width: kW - 12 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff').text(value, x + 8, top + 22, { width: kW - 12 });
  });
  doc.y = top + 54;
}

function pdfTableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(PDF_M, top, PDF_W, 20).fill('#f5f7fa');
  cells.forEach(([txt, x, w, align]) => {
    const opts = align ? { width: w, align } : { width: w };
    (bold ? doc.font('Helvetica-Bold') : doc.font('Helvetica'))
      .fontSize(9.5).fillColor('#222').text(txt, x, top + 5, opts);
  });
  doc.y = top + 20;
}

function pdfKundenliste(doc, orders) {
  function drawGroup(label, color, list) {
    if (!list.length) return;
    const gy = doc.y;
    doc.rect(PDF_M, gy, PDF_W, 22).fill(color);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(label, PDF_M + 8, gy + 6, { width: PDF_W - 16 });
    doc.y = gy + 22 + 2;
    const hy = doc.y;
    doc.rect(PDF_M, hy, PDF_W, 16).fill('#eaeef3');
    [['#', PDF_M+2, 30, 'left'], ['Datum', PDF_M+34, 40, 'left'], ['Kunde', PDF_M+76, 190, 'left'],
     ['Art', PDF_M+268, 80, 'left'], ['Betrag', PDF_M+2, PDF_W-4, 'right']
    ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(h, x, hy+4, { width:w, align:a }));
    doc.y = hy + 16 + 2;
    let sub = 0;
    list.forEach((o, i) => {
      if (doc.y > PDF_FT - 24) { doc.addPage(); doc.y = PDF_M; }
      const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
      const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim().substring(0, 28);
      const modeStr = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
      const ry = doc.y;
      if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 18).fill('#fafafa');
      doc.font('Helvetica').fontSize(9).fillColor('#222')
        .text(`${o.orderNum}`, PDF_M+2,   ry+4, { width:30 })
        .text(date,            PDF_M+34,  ry+4, { width:40 })
        .text(name,            PDF_M+76,  ry+4, { width:188 })
        .text(modeStr,         PDF_M+268, ry+4, { width:80 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
        .text(pdfFmt(o.total||0), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
      doc.y = ry + 18;
      sub += (o.total||0);
    });
    const sy = doc.y;
    doc.rect(PDF_M, sy, PDF_W, 20).fill(color + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, PDF_M+8, sy+5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(sub), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
    doc.y = sy + 20 + 10;
  }
  drawGroup('Barzahlung', '#2c5282', orders.filter(o => o.payment === 'bar'));
  drawGroup('Online-Zahlung (Stripe)', '#276749', orders.filter(o => o.payment !== 'bar'));
}

function pdfBarRechnung(doc, barOrders, barStats, zeitraum, rgnr) {
  if (!barOrders.length) return;
  doc.addPage(); doc.y = PDF_M;
  doc.rect(0, 0, PDF_PW, 50).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text('Bar-Rechnung', PDF_M, 14);
  doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.7)').text(`FlueVate Online-Bestellsystem  ·  ${zeitraum}`, PDF_M, 33);
  doc.y = 62;
  const addrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Rechnungssteller:', PDF_M, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Abed Rachman Falah · FlueVate', PDF_M, addrY+12).text('Zur Goldbrede 30, 59269 Beckum', PDF_M, addrY+22);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Rechnungsempfänger:', PDF_M+270, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Ararat Grill Beckum', PDF_M+270, addrY+12).text('Nordwall 45, 59269 Beckum', PDF_M+270, addrY+22);
  doc.y = addrY + 38;
  doc.font('Helvetica').fontSize(8.5).fillColor('#888').text(`Zeitraum: ${zeitraum}  ·  Rg.-Nr.: ${rgnr}`, PDF_M, doc.y);
  doc.y += 12;
  const hy = doc.y;
  doc.rect(PDF_M, hy, PDF_W, 16).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('ℹ  Nur Barzahlungen – Stripe-Gebühren wurden bereits automatisch beim Checkout einbehalten.', PDF_M+6, hy+4, { width:PDF_W-12 });
  doc.y = hy + 16 + 6;
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const th = doc.y;
  doc.rect(PDF_M, th, PDF_W, 16).fill('#1a1a2e');
  [['#', PDF_M+2, 34, 'left'], ['Datum', PDF_M+38, 40, 'left'], ['Kunde', PDF_M+80, 170, 'left'],
   ['Umsatz', PDF_M+252, 64, 'right'], ['Gebühr', PDF_M+318, 60, 'right'], ['5% Prov', PDF_M+380, 58, 'right'], ['Gesamt', PDF_M+2, PDF_W-4, 'right']
  ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th+4, { width:w, align:a }));
  doc.y = th + 16;
  barOrders.forEach((o, i) => {
    if (doc.y > PDF_FT - 20) { doc.addPage(); doc.y = PDF_M; }
    const sf   = o.serviceFee || PDF_SV;
    const prov = (o.total - sf) * PDF_PR;
    const ges  = sf + prov;
    const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
    const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim().substring(0, 24);
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 16).fill('#f8f9fc');
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
      .text(`${o.orderNum}`, PDF_M+2,  ry+4, { width:34 })
      .text(date,            PDF_M+38, ry+4, { width:40 })
      .text(name,            PDF_M+80, ry+4, { width:168 })
      .text(pdfFmt(o.total), PDF_M+252, ry+4, { width:64,  align:'right' })
      .text(pdfFmt(sf),      PDF_M+318, ry+4, { width:60,  align:'right' })
      .text(pdfFmt(prov),    PDF_M+380, ry+4, { width:58,  align:'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e').text(pdfFmt(ges), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
    doc.y = ry + 16;
  });
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const s1y = doc.y;
  doc.rect(PDF_M, s1y, PDF_W, 18).fill('#f0f4f8');
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Servicegebühren', PDF_M+8, s1y+5).text(`${barOrders.length} Bestellungen`, PDF_M+200, s1y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barSvc), PDF_M+2, s1y+5, { width:PDF_W-4, align:'right' });
  doc.y = s1y + 18;
  const s2y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Systemprovision (5 %)', PDF_M+8, s2y+5).text(`5 % von ${pdfFmt(barStats.barNetto)}`, PDF_M+200, s2y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barProv), PDF_M+2, s2y+5, { width:PDF_W-4, align:'right' });
  doc.y = s2y + 18 + 4;
  const gy = doc.y;
  doc.rect(PDF_M, gy, PDF_W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('RECHNUNGSBETRAG (netto)', PDF_M+10, gy+9, { width:PDF_W*0.6 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffd700').text(pdfFmt(barStats.barBetrag), PDF_M+2, gy+8, { width:PDF_W-4, align:'right' });
  doc.y = gy + 30 + 8;
  const uy = doc.y;
  doc.rect(PDF_M, uy, PDF_W, 14).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen (Kleinunternehmerregelung).', PDF_M+6, uy+3, { width:PDF_W-12 });
  doc.y = uy + 14;
}

// ── Datenabruf über Admin-API (HTTPS, keine Atlas-Allowlist nötig) ─
async function loginApi() {
  const r = await fetch(API_BASE + '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PW })
  });
  if (!r.ok) throw new Error(`Login fehlgeschlagen (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.token) throw new Error('Kein Token erhalten');
  return j.token;
}
async function fetchOrdersApi(mStart, mEnd) {
  const token = await loginApi();
  const monthStr = `${mStart.getFullYear()}-${String(mStart.getMonth()+1).padStart(2,'0')}`;
  const r = await fetch(`${API_BASE}/admin/orders?month=${monthStr}`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) throw new Error(`Monatsabruf fehlgeschlagen (HTTP ${r.status})`);
  const j = await r.json();
  const raw = Array.isArray(j.orders) ? j.orders : [];
  // gleiche Filterung wie der Cron (der month-Endpoint liefert alle Status außer pending/awaiting)
  return raw
    .filter(o => ['confirmed','preparing','ready','delivered'].includes(o.status))
    .filter(o => new Date(o.createdAt) >= mStart && new Date(o.createdAt) <= mEnd)
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
}
async function fetchOrdersDb(mStart, mEnd) {
  await mongoose.connect(MONGODB_URI);
  const orders = await Order.find({
    status:    { $in: ['confirmed','preparing','ready','delivered'] },
    createdAt: { $gte: mStart, $lte: mEnd }
  }).sort({ createdAt: 1 }).lean();
  return orders;
}

// ── Hauptprogramm ─────────────────────────────────────────────────
async function main() {
  if (!ADMIN_PW && !MONGODB_URI) {
    console.error('❌ Weder ADMIN_PASSWORD noch MONGODB_URI in ararat-beckum/.env gesetzt');
    process.exit(1);
  }

  const [y, m] = MONTH.split('-').map(Number);
  const mStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const mEnd   = new Date(y, m, 0, 23, 59, 59, 999); // letzter Tag des Monats
  const monat  = mStart.toLocaleDateString('de-DE', { month:'long', year:'numeric' });
  const datum  = mEnd.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
  const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;

  console.log(`📅 Lade Bestellungen für ${monat} (${vonBis})…`);
  let orders;
  if (ADMIN_PW) {
    console.log(`🔐 Admin-API (${API_BASE})…`);
    orders = await fetchOrdersApi(mStart, mEnd);
  } else {
    console.log('🔌 MongoDB direkt…');
    orders = await fetchOrdersDb(mStart, mEnd);
  }
  console.log(`📦 ${orders.length} gültige Bestellungen`);

  const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
  const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const nettoBase  = brutto - svcFees;
  const provision  = nettoBase * PDF_PR;
  const meinBetrag = svcFees + provision;
  const auszahlung = brutto - meinBetrag;
  const barOrdersM = orders.filter(o => o.payment === 'bar');
  const barSvcM    = barOrdersM.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const barNettoM  = barOrdersM.reduce((s,o) => s+(o.total||0), 0) - barSvcM;
  const barProvM   = barNettoM * PDF_PR;
  const barBetragM = barSvcM + barProvM;

  const weeksMap = {};
  orders.forEach(o => {
    const kw2 = getWeekNum(new Date(o.createdAt));
    if (!weeksMap[kw2]) weeksMap[kw2] = { n: 0, brutto: 0 };
    weeksMap[kw2].n++;
    weeksMap[kw2].brutto += o.total || 0;
  });
  const weekRows = Object.entries(weeksMap).sort((a, b) => +a[0] - +b[0]);

  console.log(`💶 Brutto: ${pdfFmt(brutto)} | Mein Betrag: ${pdfFmt(meinBetrag)} | Auszahlung: ${pdfFmt(auszahlung)}`);

  const monatsPdf = await generatePdf(doc => {
    pdfColorBox(doc, `Monatsbericht ${monat}`, `Ararat Grill Beckum  ·  ${vonBis}`, '#1a1a2e');
    pdfKacheln(doc, [
      ['Bestellungen gesamt', `${orders.length}`,                              '#1a1a2e'],
      ['Davon Bar',           `${barOrdersM.length}`,                          '#2c5282'],
      ['Davon Stripe',        `${orders.filter(o=>o.payment!=='bar').length}`, '#276749'],
      ['Brutto-Umsatz',       pdfFmt(brutto),                                  '#744210'],
    ]);
    doc.moveDown(0.4);
    pdfHr(doc);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
    doc.y += 14;
    pdfTableRow(doc, [[`Servicegebühren  (${orders.length} Bestellungen)`,          PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees),    PDF_M+2, PDF_W-4, 'right']], false);
    pdfTableRow(doc, [[`Systemprovision  (5 % auf ${pdfFmt(nettoBase)})`,          PDF_M+8, PDF_W-80, 'left'], [pdfFmt(provision),  PDF_M+2, PDF_W-4, 'right']], true);
    pdfTableRow(doc, [['Mein Gesamtbetrag',                                        PDF_M+8, PDF_W-80, 'left'], [pdfFmt(meinBetrag), PDF_M+2, PDF_W-4, 'right']], false, true);
    doc.y += 4;
    const ay = doc.y;
    doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Ararat Grill Beckum', PDF_M+10, ay+8, { width: PDF_W*0.65 });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
    doc.y = ay + 28 + 16;
    pdfHr(doc, '#bbb');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('WOCHENÜBERSICHT', PDF_M, doc.y);
    doc.y += 14;
    weekRows.forEach(([kw2, d], i) => {
      pdfTableRow(doc, [
        [`KW ${kw2}`,           PDF_M+8,  70,        'left'],
        [`${d.n} Bestellungen`, PDF_M+90, PDF_W-170, 'left'],
        [pdfFmt(d.brutto),      PDF_M+2,  PDF_W-4,   'right'],
      ], i % 2 === 1);
    });
    doc.y += 8;
    pdfHr(doc, '#bbb');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
    doc.y += 12;
    pdfKundenliste(doc, orders);
    if (barOrdersM.length > 0) {
      pdfBarRechnung(doc, barOrdersM, { barSvc: barSvcM, barNetto: barNettoM, barProv: barProvM, barBetrag: barBetragM }, vonBis, `${RG_NR}-BAR`);
    }
    doc.font('Helvetica').fontSize(7).fillColor('#bbb')
      .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`, PDF_M, 820, { width: PDF_W, align: 'center' });
  });

  const outDir = path.join(__dirname, '..', 'PDFs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const monLabel = mStart.toLocaleDateString('de-DE', { month:'long' });
  const file1 = path.join(outDir, `Ararat_Monatsbericht_${monLabel}_${y}.pdf`);
  fs.writeFileSync(file1, monatsPdf);

  console.log(`\n✅ Fertig!`);
  console.log(`   📄 ${file1}`);
}

main()
  .then(() => mongoose.connection.close())
  .catch(async e => { console.error('❌ Fehler:', e.message); try { await mongoose.connection.close(); } catch {} process.exit(1); });
