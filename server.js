const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Stripe = require('stripe');
const { Resend } = require('resend');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── STRIPE lazy ────────────────────────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return Stripe(key);
}

// ─── RESEND lazy ─────────────────────────────────────────────────
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️  RESEND_API_KEY fehlt'); return null; }
  return new Resend(key);
}

// ─── CORS ────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://ararat-grill.com',
  'https://www.ararat-grill.com',
].filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, origin);
    console.warn('CORS blockiert:', origin);
    return callback(new Error('CORS nicht erlaubt für: ' + origin));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.options('*', cors());

// ─── RAW BODY for Stripe Webhook (must be before express.json) ──
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

// ─── JSON BODY ───────────────────────────────────────────────────
app.use(express.json());

// ─── MONGODB ─────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB verbunden'))
  .catch(err => console.error('❌ MongoDB Fehler:', err));

// ─── ORDER SCHEMA ────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  orderNum: { type: Number, unique: true },
  mode: { type: String, enum: ['lieferung','abholung'], required: true },
  status: { type: String, default: 'confirmed',
    enum: ['awaiting_payment','pending','confirmed','preparing','ready','delivered','cancelled'] },
  payment: { type: String, enum: ['bar','stripe','karte'], required: true },
  paymentStatus: { type: String, default: 'unpaid', enum: ['unpaid','paid','pending','refunded'] },
  source:               { type: String, default: 'web', enum: ['web','pos','admin'] },
  stripeSessionId: String,
  stripePaymentIntentId: String,
  customer: {
    first: String, last: String, email: String,
    phone: String, city: String, street: String, house: String
  },
  items: [{ num: String, name: String, price: Number, qty: Number, note: String, extraDetails: [{ name: String, price: Number }] }],
  subtotal: Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee: { type: Number, default: 0.50 },
  total: Number,
  note: String,
  prepTime: { type: Number, default: null },
  cancelReason: { type: String, default: '' },
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

// ─── COUNTER für orderNum + rechnungNum ──────────────────────────
const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', counterSchema);

async function getNextOrderNum() {
  const result = await Counter.findByIdAndUpdate(
    'orderNum',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return result.seq + 1000; // Starts at 1001
}

async function getNextRechnungNum() {
  const c = await Counter.findByIdAndUpdate('rechnungNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `RE-${new Date().getFullYear()}-${String(c.seq).padStart(4,'0')}`;
}

// ─── PDF-HELPER ───────────────────────────────────────────────────
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

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Nicht autorisiert' });
  }
  const token = auth.split(' ')[1];
  if (token !== process.env.ADMIN_TOKEN_SECRET) {
    return res.status(401).json({ message: 'Ungültiger Token' });
  }
  next();
}

// ─── RESTAURANT STATUS SCHEMA ────────────────────────────────────
const statusSchema = new mongoose.Schema({
  _id: { type: String, default: 'main' },
  mode: { type: String, enum: ['online','neutral','geschlossen'], default: 'online' },
  manualOverride: { type: Boolean, default: false }
});
const RestaurantStatus = mongoose.model('RestaurantStatus', statusSchema);

// ─── AVAILABILITY SCHEMA ─────────────────────────────────────────
const availabilitySchema = new mongoose.Schema({
  itemName: { type: String, required: true, unique: true },
  available: { type: Boolean, default: false } // false = ausverkauft
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Health Check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', restaurant: 'Ararat Grill Beckum', time: new Date() });
});

// ── WhatsApp Nummer (PUBLIC) ───────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: process.env.WHATSAPP_NUMBER || ''
  });
});

// ── Restaurant-Status abrufen (PUBLIC) ───────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const s = await RestaurantStatus.findById('main');
    res.json({ mode: s ? s.mode : 'online', manualOverride: s ? s.manualOverride : false });
  } catch (err) {
    res.json({ mode: 'online', manualOverride: false });
  }
});

// ── Verfügbarkeit abrufen (PUBLIC) ────────────────────────────────
// Gibt Liste der DEAKTIVIERTEN Artikel zurück
app.get('/api/availability', async (req, res) => {
  try {
    const disabled = await Availability.find({ available: false }).select('itemName -_id');
    res.json({ disabled: disabled.map(d => d.itemName) });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden' });
  }
});

// ── Neue Bestellung → IMMER als pending speichern ─────────────────
// Keine E-Mail, kein Druck – erst nach Bestätigung durch Admin!
app.post('/api/orders', async (req, res) => {
  try {
    const orderNum = await getNextOrderNum();
    // Manuelle Admin-Bestellungen (source:'admin') direkt confirmen
    const isPOS = req.body.source === 'pos' || req.body.source === 'admin';
    const order = new Order({
      ...req.body,
      orderNum,
      status: isPOS ? 'confirmed' : 'pending'
    });
    await order.save();

    if (isPOS) {
      await sendConfirmationEmail(order, order.prepTime || 20);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }

    res.status(201).json({ orderNum: order.orderNum, order });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ message: 'Fehler beim Speichern der Bestellung' });
  }
});

// ── Stripe Checkout Session erstellen ─────────────────────────────
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const { items, subtotal, deliveryFee, serviceFee, total, customer, mode, note, ...rest } = req.body;
    const orderNum = await getNextOrderNum();

    // Stripe line items
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: { name: `${item.qty}× ${item.name}${item.note ? ' ('+item.note+')' : ''}` },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));

    // Liefergebühr als extra Line Item
    if (deliveryFee && deliveryFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Liefergebühr' },
          unit_amount: Math.round(deliveryFee * 100),
        },
        quantity: 1,
      });
    }

    // Servicegebühr
    if (serviceFee && serviceFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Servicegebühr' },
          unit_amount: Math.round(serviceFee * 100),
        },
        quantity: 1,
      });
    }

    // Stripe Connect: Provision berechnen
    const appFee = Math.round(((serviceFee||0) + (subtotal * 0.05)) * 100);

    const sessionOpts = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      ...(customer.email ? { customer_email: customer.email } : {}),
      locale: 'de',
      metadata: { orderNum: String(orderNum) },
      success_url: `${process.env.FRONTEND_URL || 'https://ararat-grill.com'}?order=${orderNum}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL || 'https://ararat-grill.com'}?payment=cancelled`,
    };
    if (process.env.STRIPE_CONNECT_ACCOUNT) {
      sessionOpts.payment_intent_data = {
        application_fee_amount: appFee,
        transfer_data: { destination: process.env.STRIPE_CONNECT_ACCOUNT }
      };
    }
    const session = await getStripe().checkout.sessions.create(sessionOpts);

    // Pending order in DB – status 'awaiting_payment' bis Zahlung bestätigt
    const order = new Order({
      ...rest, items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum,
      payment: 'stripe', paymentStatus: 'pending',
      stripeSessionId: session.id, status: 'awaiting_payment'
    });
    await order.save();

    res.json({ url: session.url, orderNum });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ message: 'Stripe-Fehler: ' + err.message });
  }
});

// ── Stripe Webhook ────────────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const order = await Order.findOne({ stripeSessionId: session.id });
      if (order) {
        order.paymentStatus = 'paid';
        // Stripe-Zahlung: Status bleibt 'pending' – Admin muss noch bestätigen
        order.status = 'pending';
        order.stripePaymentIntentId = session.payment_intent;
        await order.save();
        // Kein E-Mail, kein Druck – erst nach Admin-Bestätigung
        console.log(`💳 Stripe Zahlung erhalten: Bestellung #${order.orderNum} → wartet auf Admin-Bestätigung`);
      }
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    await Order.findOneAndUpdate({ stripeSessionId: session.id }, { status: 'cancelled' });
  }

  res.json({ received: true });
});

// ── Stripe Zahlung manuell prüfen (Fallback wenn Webhook nicht feuert) ─
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ message: 'session_id fehlt' });
    const session = await getStripe().checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.json({ success: false, message: 'Noch nicht bezahlt' });
    }
    const order = await Order.findOne({ stripeSessionId: session_id });
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });
    if (order.status === 'pending' && order.paymentStatus === 'paid') {
      return res.json({ success: true, message: 'Bereits verarbeitet', orderNum: order.orderNum });
    }
    order.paymentStatus = 'paid';
    order.status = 'pending';
    if (session.payment_intent) order.stripePaymentIntentId = session.payment_intent;
    await order.save();
    console.log(`💳 verify-payment: Bestellung #${order.orderNum} → pending`);
    res.json({ success: true, orderNum: order.orderNum });
  } catch (err) {
    console.error('verify-payment Fehler:', err);
    res.status(500).json({ message: 'Fehler: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES (alle durch Auth geschützt)
// ═══════════════════════════════════════════════════════════════════

// ── Restaurant-Status setzen (Admin) ─────────────────────────────
app.get('/api/admin/status', authMiddleware, async (req, res) => {
  try {
    const s = await RestaurantStatus.findById('main');
    res.json({ mode: s ? s.mode : 'online', manualOverride: s ? s.manualOverride : false });
  } catch (err) {
    res.status(500).json({ message: 'Fehler' });
  }
});

app.patch('/api/admin/status', authMiddleware, async (req, res) => {
  try {
    const { mode, manualOverride } = req.body;
    const update = {};
    if (mode !== undefined) update.mode = mode;
    if (manualOverride !== undefined) update.manualOverride = manualOverride;
    // Auto-Modus: sofort berechnen wenn manualOverride auf false gesetzt wird
    if (manualOverride === false && mode === undefined) update.mode = calcAutoMode();
    const s = await RestaurantStatus.findByIdAndUpdate('main', update, { upsert: true, new: true });
    res.json({ mode: s.mode, manualOverride: s.manualOverride });
  } catch (err) {
    res.status(500).json({ message: 'Fehler' });
  }
});

// ── Admin Login ────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ token: process.env.ADMIN_TOKEN_SECRET });
  } else {
    res.status(401).json({ message: 'Falsches Passwort' });
  }
});

// ── Verfügbarkeit verwalten (nur Admin) ────────────────────────────
// Alle deaktivierten Artikel abrufen
app.get('/api/admin/availability', authMiddleware, async (req, res) => {
  try {
    const all = await Availability.find();
    res.json({ items: all });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden' });
  }
});

// Artikel ein- oder ausschalten
app.patch('/api/admin/availability', authMiddleware, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    if (!itemName) return res.status(400).json({ message: 'itemName fehlt' });
    const doc = await Availability.findOneAndUpdate(
      { itemName },
      { available },
      { upsert: true, new: true }
    );
    console.log(`${available ? '✅' : '❌'} Verfügbarkeit: "${itemName}" → ${available ? 'verfügbar' : 'ausverkauft'}`);
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Aktualisieren' });
  }
});

// ── Pending Bestellungen abrufen (für schnelles Polling) ───────────
app.get('/api/admin/orders/pending', authMiddleware, async (req, res) => {
  try {
    const pending = await Order.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.json({ pending });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden' });
  }
});

// ── Alle Bestellungen abrufen ──────────────────────────────────────
app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  try {
    // Confirmed+ und awaiting_payment (für Stripe-Übersicht)
    const orders = await Order.find({ status: { $nin: ['pending'] } })
      .sort({ createdAt: -1 })
      .limit(200);

    // Pending separat (für Alarm-Modal)
    const pending = await Order.find({ status: 'pending' }).sort({ createdAt: 1 });

    // Stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOrders = orders.filter(o => new Date(o.createdAt) >= today);
    const todayRevenue = todayOrders
      .filter(o => o.status !== 'cancelled')
      .reduce((sum, o) => sum + (o.total || 0), 0);

    res.json({
      orders,
      pending,
      stats: {
        todayCount:   todayOrders.length,
        todayRevenue,
        totalRevenue: orders.reduce((s,o) => s+(o.total||0), 0),
        active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
        done:         todayOrders.filter(o=>['ready','delivered'].includes(o.status)).length,
        cancelled:    todayOrders.filter(o=>o.status==='cancelled').length,
        unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled').length,
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden der Bestellungen' });
  }
});

// ── Bestellung BESTÄTIGEN (Admin drückt Annehmen + Zeit) ───────────
app.patch('/api/admin/orders/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const { estimatedMinutes } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'confirmed', prepTime: estimatedMinutes || 45 },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    // JETZT E-Mail + Druck auslösen
    await sendConfirmationEmail(order, estimatedMinutes);
    await sendRestaurantEmail(order);
    await triggerPrint(order);

    console.log(`✅ Bestellung #${order.orderNum} bestätigt – ${estimatedMinutes} Min.`);
    res.json(order);
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ message: 'Fehler beim Bestätigen' });
  }
});

// ── Status ändern ──────────────────────────────────────────────────
app.patch('/api/admin/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id, { status }, { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    // Bei Stornierung: E-Mail an Kunden
    if (status === 'cancelled') {
      await sendCancellationEmail(order);
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Statuswechsel' });
  }
});

// ── Bezahlstatus ändern ────────────────────────────────────────────
app.patch('/api/admin/orders/:id/payment', authMiddleware, async (req, res) => {
  try {
    const { paymentStatus } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id, { paymentStatus }, { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Aktualisieren' });
  }
});

// ── Bestellung stornieren (mit Grund) ─────────────────────────────
app.delete('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    const cancelReason = req.body?.cancelReason || '';
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'cancelled', cancelReason },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    // ── Automatische Stripe-Rückerstattung ──────────────────────────
    let refundStatus = null;
    if (order.payment === 'stripe' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
      try {
        const refund = await getStripe().refunds.create({
          payment_intent: order.stripePaymentIntentId,
        });
        refundStatus = refund.status; // 'succeeded' oder 'pending'
        await Order.findByIdAndUpdate(order._id, { paymentStatus: 'refunded' });
        console.log(`💸 Stripe-Rückerstattung für Bestellung #${order.orderNum}: ${refund.status}`);
      } catch (stripeErr) {
        console.error(`❌ Stripe-Refund Fehler für #${order.orderNum}:`, stripeErr.message);
        refundStatus = 'failed';
      }
    }

    await sendCancellationEmail(order, cancelReason, refundStatus);
    res.json({ success: true, order, refundStatus });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Stornieren' });
  }
});

// ── Stripe-Einbuchung: stuck awaiting_payment Bestellungen recovern ──
app.post('/api/admin/recover-stripe-orders', authMiddleware, async (_req, res) => {
  try {
    const stuck = await Order.find({ status: 'awaiting_payment', payment: 'stripe' });
    let recovered = 0;
    for (const order of stuck) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(order.stripeSessionId);
        if (session.payment_status === 'paid') {
          order.paymentStatus = 'paid';
          order.status = 'pending';
          if (session.payment_intent) order.stripePaymentIntentId = session.payment_intent;
          await order.save();
          recovered++;
          console.log(`🔁 recover: Bestellung #${order.orderNum} → pending`);
        }
      } catch (e) { console.warn(`recover skip #${order.orderNum}:`, e.message); }
    }
    res.json({ success: true, checked: stuck.length, recovered });
  } catch (err) {
    res.status(500).json({ message: 'Fehler: ' + err.message });
  }
});

// ── Bon nachdrucken ────────────────────────────────────────────────
app.post('/api/admin/orders/:id/print', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Druckfehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// E-MAIL FUNKTIONEN (via Resend)
// ═══════════════════════════════════════════════════════════════════

async function sendConfirmationEmail(order, estimatedMinutes) {
  if (!order.customer || !order.customer.email) return;
  try {
    const mins = estimatedMinutes || order.prepTime || (order.mode === 'lieferung' ? 45 : 20);
    const modeText = order.mode === 'lieferung' ? '🛵 Lieferung' : '🏃 Abholung';
    const addrText = order.mode === 'lieferung'
      ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
      : 'Nordwall 45, 59269 Beckum';
    const itemsHtml = (order.items || [])
      .map(i => `<tr><td>${i.qty}×</td><td>${i.name}${i.note ? ' <em>('+i.note+')</em>' : ''}</td><td style="text-align:right">${(i.price*i.qty).toFixed(2).replace('.',',')} €</td></tr>`)
      .join('');

    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@ararat-grill.de',
      to: order.customer.email,
      subject: `✅ Bestellung #${order.orderNum} bestätigt – Ararat Grill Beckum`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;">
          <div style="background:#3d1a08;color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:24px;">🔥 Ararat Grill</h1>
            <p style="margin:4px 0 0;opacity:.8;font-size:14px;">Beckum · Nordwall 45</p>
          </div>
          <div style="padding:28px 24px;">
            <h2 style="color:#3d1a08;">Bestellung #${order.orderNum} bestätigt ✅</h2>
            <p>Hallo <strong>${order.customer.first}</strong>,<br>deine Bestellung wurde bestätigt!</p>
            <div style="background:#f7f3ee;border-radius:8px;padding:16px;margin:16px 0;">
              <p style="margin:0 0 6px;font-weight:bold;">${modeText}</p>
              <p style="margin:0;font-size:14px;color:#666;">${addrText}</p>
              <p style="margin:4px 0 0;font-size:16px;font-weight:bold;color:#c0281a;">⏱ Voraussichtlich ~${mins} Minuten</p>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead><tr style="border-bottom:2px solid #e0d8ce;">
                <th style="text-align:left;padding:6px 0;">Menge</th>
                <th style="text-align:left;padding:6px 0;">Artikel</th>
                <th style="text-align:right;padding:6px 0;">Preis</th>
              </tr></thead>
              <tbody>${itemsHtml}</tbody>
            </table>
            <div style="border-top:1px solid #e0d8ce;margin-top:12px;padding-top:10px;">
              <div style="display:flex;justify-content:space-between;font-size:13px;color:#666;margin:3px 0;"><span>Zwischensumme</span><span>${(order.subtotal||0).toFixed(2).replace('.',',')} €</span></div>
              ${order.deliveryFee?`<div style="display:flex;justify-content:space-between;font-size:13px;color:#666;margin:3px 0;"><span>Liefergebühr</span><span>${order.deliveryFee.toFixed(2).replace('.',',')} €</span></div>`:''}
              <div style="display:flex;justify-content:space-between;font-size:13px;color:#666;margin:3px 0;"><span>Servicegebühr</span><span>${(order.serviceFee||0.50).toFixed(2).replace('.',',')} €</span></div>
              <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:16px;margin-top:8px;border-top:2px solid #3d1a08;padding-top:8px;"><span>Gesamt</span><span style="color:#c0281a;">${(order.total||0).toFixed(2).replace('.',',')} €</span></div>
            </div>
            <p style="font-size:13px;color:#666;margin-top:16px;">Zahlung: ${order.payment==='bar'?'Barzahlung':order.payment==='stripe'?'Kreditkarte (Stripe)':'EC-Karte'} · ${order.paymentStatus==='paid'?'✅ Bezahlt':'💵 Bei Lieferung/Abholung'}</p>
            ${order.note?`<p style="font-size:13px;background:#fff3ea;padding:10px;border-radius:6px;">📝 Anmerkung: ${order.note}</p>`:''}
          </div>
          <div style="background:#f7f3ee;padding:16px 24px;text-align:center;font-size:12px;color:#999;">
            Ararat Grill · Nordwall 45 · 59269 Beckum · Tel: 02521-9009414<br>
            Alle Preise inkl. 19 % MwSt.
          </div>
        </div>`
    });
    console.log(`📧 Bestätigungs-E-Mail gesendet an ${order.customer.email}`);
  } catch (err) {
    console.error('E-Mail Fehler (Kunde):', err);
  }
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  try {
    const itemsList = (order.items || [])
      .map(i => `${i.qty}× ${i.name}${i.note?' ('+i.note+')':''}`)
      .join('\n');
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@ararat-grill.de',
      to: process.env.RESTAURANT_EMAIL,
      subject: `🔔 Neue Bestellung #${order.orderNum} – ${order.mode==='lieferung'?'Lieferung':'Abholung'}`,
      html: `<pre style="font-family:monospace;font-size:14px;">
NEUE BESTELLUNG #${order.orderNum}
══════════════════════════════
Art: ${order.mode === 'lieferung' ? '🛵 LIEFERUNG' : '🏃 ABHOLUNG'}
Kunde: ${order.customer?.first} ${order.customer?.last}
Tel: ${order.customer?.phone || '–'}
${order.mode==='lieferung'?`Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}`:''}

ARTIKEL:
${itemsList}

Zwischensumme: ${(order.subtotal||0).toFixed(2)} €
${order.deliveryFee?`Liefergebühr: ${order.deliveryFee.toFixed(2)} €`:''}
Servicegebühr: ${(order.serviceFee||0.50).toFixed(2)} €
GESAMT: ${(order.total||0).toFixed(2)} €

Zahlung: ${order.payment==='bar'?'BAR':order.payment==='stripe'?'KREDITKARTE':'EC-KARTE'} – ${order.paymentStatus==='paid'?'✅ BEZAHLT':'❌ NOCH OFFEN'}
${order.note?`Anmerkung: ${order.note}`:''}
══════════════════════════════</pre>`
    });
  } catch (err) {
    console.error('E-Mail Fehler (Restaurant):', err);
  }
}

async function sendCancellationEmail(order, cancelReason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const reasonText = cancelReason || order.cancelReason || '';

  let refundHtml = '';
  if (order.payment === 'stripe' && order.paymentStatus === 'refunded') {
    if (refundStatus === 'succeeded') {
      refundHtml = `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px;margin:16px 0;">
        <strong style="color:#2e7d32;">💸 Rückerstattung erfolgreich</strong>
        <p style="color:#555;margin:6px 0 0;font-size:13px;">Der Betrag von <strong>${(order.total||0).toFixed(2).replace('.',',')} €</strong> wird innerhalb von 5–10 Werktagen auf deine Karte zurückgebucht.</p>
      </div>`;
    } else if (refundStatus === 'pending') {
      refundHtml = `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px;margin:16px 0;">
        <strong style="color:#2e7d32;">💸 Rückerstattung wird bearbeitet</strong>
        <p style="color:#555;margin:6px 0 0;font-size:13px;">Der Betrag von <strong>${(order.total||0).toFixed(2).replace('.',',')} €</strong> wird in Kürze zurückgebucht.</p>
      </div>`;
    } else {
      refundHtml = `<div style="background:#ffebee;border:1px solid #ef9a9a;border-radius:8px;padding:14px;margin:16px 0;">
        <strong style="color:#c62828;">⚠️ Rückerstattung fehlgeschlagen</strong>
        <p style="color:#555;margin:6px 0 0;font-size:13px;">Bitte kontaktiere uns direkt: <strong>02521-9009414</strong></p>
      </div>`;
    }
  }

  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@ararat-grill.de',
      to: order.customer.email,
      subject: `❌ Bestellung #${order.orderNum} storniert – Ararat Grill`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
          <div style="background:#3d1a08;color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;">🔥 Ararat Grill</h1>
          </div>
          <div style="padding:28px 24px;">
            <h2>Bestellung #${order.orderNum} wurde storniert</h2>
            <p>Hallo <strong>${order.customer.first}</strong>,<br>
            deine Bestellung wurde leider storniert.</p>
            ${reasonText ? `<div style="background:#fff3ea;border-radius:8px;padding:14px;margin:16px 0;">
              <strong>Grund:</strong> ${reasonText}
            </div>` : ''}
            ${refundHtml}
            <p>Bei Fragen erreichst du uns unter <strong>02521-9009414</strong>.</p>
            <p>Wir entschuldigen uns für die Unannehmlichkeiten.</p>
          </div>
        </div>`
    });
  } catch (err) {
    console.error('E-Mail Fehler (Storno):', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PRINTNODE (Bondruck)
// ═══════════════════════════════════════════════════════════════════

async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try {
    const printHelper = require('./printnode-helper');
    await printHelper.printOrder(order);
  } catch (err) {
    console.error('PrintNode Fehler:', err);
  }
}

// ─── AUTO-STATUS (Öffnungszeiten) ────────────────────────────────
function calcAutoMode() {
  const deTime = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const parts  = deTime.match(/(\d+)\.(\d+)\.(\d+),\s*(\d+):(\d+)/);
  if (!parts) return 'geschlossen';
  const day  = parseInt(parts[1]);
  const mon  = parseInt(parts[2]);
  const year = parseInt(parts[3]);
  const h    = parseInt(parts[4]);
  const m    = parseInt(parts[5]);
  const mins = h * 60 + m;
  const wd   = new Date(year, mon - 1, day).getDay(); // 0=So, 1=Mo, ..., 6=Sa

  // Dienstag = Ruhetag
  if (wd === 2) return 'geschlossen';

  // Samstag: 17:00–22:00
  if (wd === 6) return (mins >= 17*60 && mins < 22*60) ? 'online' : 'geschlossen';

  // Sonntag: 12:00–14:00 & 16:00–22:00
  if (wd === 0) {
    return (mins >= 12*60 && mins < 14*60) || (mins >= 16*60 && mins < 22*60)
      ? 'online' : 'geschlossen';
  }

  // Mo, Mi, Do, Fr: 11:30–14:00 & 17:00–22:00
  return (mins >= 11*60+30 && mins < 14*60) || (mins >= 17*60 && mins < 22*60)
    ? 'online' : 'geschlossen';
}

// Cron: jede Minute Auto-Modus aktualisieren (wenn nicht manuell)
cron.schedule('* * * * *', async () => {
  try {
    const s = await RestaurantStatus.findById('main');
    if (s && s.manualOverride) return;
    const autoMode = calcAutoMode();
    await RestaurantStatus.findByIdAndUpdate('main',
      { mode: autoMode }, { upsert: true, new: true }
    );
  } catch(e) { console.error('Auto-Status Fehler:', e); }
});

// ─── TAGESBERICHT (täglich um 22:00 Uhr) ─────────────────────────
cron.schedule('0 22 * * *', async () => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0,0,0,0);
    const end   = new Date(now); end.setHours(23,59,59,999);
    const label = now.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' });

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $nin: ['cancelled','awaiting_payment'] }
    }).sort({ orderNum: 1 });

    if (orders.length === 0) {
      console.log('[Tagesbericht] Keine Bestellungen heute – kein PDF versendet.');
      return;
    }

    const total       = orders.reduce((s,o) => s+(o.total||0), 0);
    const totalBar    = orders.filter(o=>o.payment==='bar').reduce((s,o)=>s+(o.total||0),0);
    const totalStripe = orders.filter(o=>o.payment==='stripe').reduce((s,o)=>s+(o.total||0),0);
    const nLief       = orders.filter(o=>o.mode==='lieferung').length;
    const nAbh        = orders.filter(o=>o.mode==='abholung').length;

    const tagespdf = await generatePdf(doc => {
      const W = 495;
      const fmt = n => n.toFixed(2).replace('.',',')+' €';

      doc.rect(0,0,595,70).fill('#c0392b');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Tagesbericht', 50, 16);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
        .text(`Ararat Grill Beckum  ·  ${label}`, 50, 44);

      doc.moveDown(3.5);

      const sumRows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Lieferung', `${nLief}`, true],
        ['davon Abholung', `${nAbh}`, false],
        ['Umsatz Barzahlung', fmt(totalBar), true],
        ['Umsatz Kreditkarte (Stripe)', fmt(totalStripe), false],
      ];
      sumRows.forEach(([lbl, val, shade]) => {
        const y = doc.y;
        if (shade) doc.rect(50,y,W,26).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(11).fillColor('#222').text(lbl, 58, y+7);
        doc.text(val, 50, y+7, { width: W-8, align:'right' });
        doc.y = y+26;
      });

      const ty = doc.y;
      doc.rect(50,ty,W,36).fill('#c0392b');
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff')
        .text('GESAMTUMSATZ', 58, ty+11);
      doc.text(fmt(total), 50, ty+11, { width:W-8, align:'right' });
      doc.y = ty+50;

      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#c0392b').text('Alle Bestellungen');
      doc.moveDown(0.4);

      orders.forEach((o, i) => {
        if (doc.y > 730) doc.addPage();
        const rowY = doc.y;
        if (i % 2 === 0) doc.rect(50,rowY,W,0).fill('#f9f9f9');

        const kunde   = `${o.customer && o.customer.first||''} ${o.customer && o.customer.last||''}`.trim() || '–';
        const telefon = (o.customer && o.customer.phone) || '–';
        const email   = (o.customer && o.customer.email) || '–';
        const adresse = o.mode==='lieferung'
          ? `${o.customer && o.customer.street||''} ${o.customer && o.customer.house||''}, ${o.customer && o.customer.city||''}`.trim()
          : 'Abholung';
        const zahlung = o.payment==='stripe'?'Kreditkarte':o.payment==='karte'?'EC-Karte':'Bar';
        const bezahlt = o.paymentStatus==='paid'?'✓ Bezahlt':'✗ Offen';
        const items   = (o.items||[]).map(it=>`${it.qty}× ${it.name}${it.note?' ('+it.note+')':''}`).join(', ');

        doc.rect(50, rowY, W, 0.5).fill('#e0e0e0');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#c0392b')
          .text(`#${o.orderNum}  ${new Date(o.createdAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}  ${o.mode==='lieferung'?'LIEFERUNG':'ABHOLUNG'}`, 50, rowY+6, { width: W/2 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#222')
          .text(fmt(o.total||0), 50, rowY+6, { width:W, align:'right' });
        doc.font('Helvetica').fontSize(9).fillColor('#333')
          .text(`Kunde: ${kunde}  |  Tel: ${telefon}  |  ${email}`, 50, rowY+20, { width: W });
        doc.text(`Adresse: ${adresse}  |  Zahlung: ${zahlung}  |  ${bezahlt}`, 50, rowY+32, { width: W });
        doc.text(`Artikel: ${items}`, 50, rowY+44, { width: W });
        doc.y = rowY + 60;
      });

      doc.fontSize(8).fillColor('#aaa')
        .text(`Ararat Grill Beckum  ·  Tagesbericht ${label}  ·  Erstellt: ${now.toLocaleTimeString('de-DE')}`, 50, 790, { width: W, align:'center' });
    });

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@ararat-grill.com',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📋 Tagesbericht ${label} · Ararat Grill Beckum`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
          <div style="background:#c0392b;padding:22px 28px;color:#fff">
            <h2 style="margin:0;font-size:20px">Tagesbericht</h2>
            <p style="margin:4px 0 0;opacity:.8;font-size:13px">${label}</p>
          </div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
              <tr><td style="padding:8px">davon Lieferung</td><td style="padding:8px;text-align:right">${nLief}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">davon Abholung</td><td style="padding:8px;text-align:right">${nAbh}</td></tr>
              <tr><td style="padding:8px">Umsatz Barzahlung</td><td style="padding:8px;text-align:right">${totalBar.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">Umsatz Kreditkarte (Stripe)</td><td style="padding:8px;text-align:right">${totalStripe.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#c0392b"><td style="padding:10px;font-weight:bold;color:#fff;font-size:15px">Gesamtumsatz</td><td style="padding:10px;text-align:right;font-weight:bold;color:#fff;font-size:15px">${total.toFixed(2).replace('.',',')} €</td></tr>
            </table>
            <p style="font-size:12px;color:#888;margin-top:12px">Die vollständige Bestellliste mit Kundendaten finden Sie im beigefügten PDF.</p>
          </div>
        </div>`,
        attachments: [{ filename: `Tagesbericht_${now.toISOString().slice(0,10)}.pdf`, content: tagespdf.toString('base64') }]
      });
    }
    console.log(`📋 Tagesbericht versendet: ${orders.length} Bestellungen, ${total.toFixed(2)} €`);
  } catch(e) { console.error('Tagesbericht Fehler:', e); }
});

// ─── WOCHENBERICHT (Sonntag 23:59) ────────────────────────────────
cron.schedule('59 23 * * 0', async () => {
  try {
    const now    = new Date();
    const wStart = new Date(now); wStart.setDate(now.getDate()-6); wStart.setHours(0,0,0,0);
    const wEnd   = new Date(now); wEnd.setHours(23,59,59,999);
    const kw     = getWeekNum(now);
    const datum  = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${wStart.toLocaleDateString('de-DE')} – ${datum}`;

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: wStart, $lte: wEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||0.99), 0);
    const nettoBase  = brutto - svcFees;
    const provision  = nettoBase * 0.05;
    const meinBetrag = svcFees + provision;
    const auszahlung = brutto - meinBetrag;
    const web        = orders.filter(o=>o.source!=='pos').length;
    const pos        = orders.filter(o=>o.source==='pos').length;

    const rechnungNr = await getNextRechnungNum();

    const rechnungPdf = await generatePdf(doc => {
      const W = 495;
      doc.rect(0, 0, 595, 70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('FlueVate', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text('Online-Bestellsystem · Abrechnung', 50, 46);

      doc.moveDown(3).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`RECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`KW ${kw} / ${now.getFullYear()}  ·  ${vonBis}`);
      doc.moveDown(1.5);

      const addrY = doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER', 50, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah / FlueVate', 50, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Zur Goldbrede 30', 50, addrY+30)
        .text('59269 Beckum', 50, addrY+44)
        .text('Deutschland', 50, addrY+58);
      if (process.env.STEUERNUMMER) doc.text(`St.-Nr.: ${process.env.STEUERNUMMER}`, 50, addrY+72);

      doc.fontSize(8).fillColor('#999').text('RECHNUNGSEMPFÄNGER', 310, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Ararat Grill Beckum', 310, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Nordwall 45', 310, addrY+30)
        .text('59269 Beckum', 310, addrY+44)
        .text('Deutschland', 310, addrY+58);

      doc.y = addrY + 95;
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(1).stroke();
      doc.moveDown(0.8);

      doc.fontSize(9).fillColor('#555')
        .text(`Rechnungsnummer: ${rechnungNr}`, 50, doc.y, { continued: true })
        .text(`Datum: ${datum}`, { align: 'right' });
      doc.text(`Leistungszeitraum: ${vonBis}`, 50);
      doc.moveDown(1);

      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222')
        .text('Leistung', 50, doc.y)
        .text('Betrag', 50, doc.y-14, { width: W, align: 'right' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Servicegebühren Online-Bestellsystem', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`0,99 € × ${orders.length} Bestellungen (KW ${kw})`);
      const sfY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${svcFees.toFixed(2).replace('.',',')} €`, 50, sfY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eee').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Systemprovision (5 % auf Speisenumsatz)', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`5 % von ${nettoBase.toFixed(2).replace('.',',')} € Speisenumsatz`);
      const pvY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${provision.toFixed(2).replace('.',',')} €`, 50, pvY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e').text('RECHNUNGSBETRAG (netto)', 50);
      const totY = doc.y - 18;
      doc.text(`${meinBetrag.toFixed(2).replace('.',',')} €`, 50, totY, { width: W, align: 'right' });
      doc.moveDown(1.5);

      doc.rect(50, doc.y, W, 26).fill('#fff8e1');
      doc.fontSize(9).font('Helvetica').fillColor('#7a5c00')
        .text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).', 56, doc.y-20);
      doc.moveDown(2);

      doc.fontSize(8).fillColor('#aaa')
        .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  ${rechnungNr} · KW ${kw}/${now.getFullYear()}`, 50, 780, { width: W, align: 'center' });
    });

    const berichtPdf = await generatePdf(doc => {
      const W = 495;
      doc.rect(0, 0, 595, 70).fill('#c0392b');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Wochenbericht', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
        .text(`Ararat Grill Beckum  ·  KW ${kw} / ${now.getFullYear()}  ·  ${vonBis}`, 50, 46);

      doc.moveDown(4);

      const rows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Online', `${web}`, true],
        ['davon Telefon / POS', `${pos}`, false],
        ['Gesamtumsatz (Brutto)', `${brutto.toFixed(2).replace('.',',')} €`, true],
        ['Einbehaltene Gebühren (FlueVate)', `− ${meinBetrag.toFixed(2).replace('.',',')} €`, false],
      ];
      rows.forEach(([lbl, value, shade]) => {
        const rowY = doc.y;
        if (shade) doc.rect(50, rowY, W, 28).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(11).fillColor('#222').text(lbl, 58, rowY+8);
        doc.text(value, 50, rowY+8, { width: W-8, align: 'right' });
        doc.y = rowY + 28;
      });

      const ay = doc.y;
      doc.rect(50, ay, W, 38).fill('#e8f5e9');
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#2e7d32')
        .text('Ihr Auszahlungsbetrag', 58, ay+12);
      doc.text(`${auszahlung.toFixed(2).replace('.',',')} €`, 50, ay+12, { width: W-8, align: 'right' });
      doc.y = ay + 52;

      doc.moveDown(0.5);
      doc.fontSize(8).font('Helvetica').fillColor('#aaa')
        .text('* Auszahlung erfolgt automatisch über Stripe Connect auf das hinterlegte Bankkonto.');

      doc.fontSize(8).fillColor('#aaa')
        .text(`Ararat Grill Beckum  ·  KW ${kw} / ${now.getFullYear()}`, 50, 780, { width: W, align: 'center' });
    });

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@ararat-grill.com',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📊 Wochenbericht KW ${kw} / ${now.getFullYear()} · Ararat Grill Beckum`,
        html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
          <div style="background:#c0392b;padding:24px 28px;color:#fff">
            <h2 style="margin:0;font-size:20px">Wochenbericht KW ${kw} / ${now.getFullYear()}</h2>
            <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
          </div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
              <tr><td style="padding:8px">davon Online</td><td style="padding:8px;text-align:right">${web}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">davon Telefon / POS</td><td style="padding:8px;text-align:right">${pos}</td></tr>
              <tr><td style="padding:8px">Gesamtumsatz (Brutto)</td><td style="padding:8px;text-align:right">${brutto.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">Einbehaltene Gebühren (FlueVate)</td><td style="padding:8px;text-align:right">− ${meinBetrag.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihr Auszahlungsbetrag</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${auszahlung.toFixed(2).replace('.',',')} €</td></tr>
            </table>
            <p style="font-size:11px;color:#aaa;margin-top:8px">* Auszahlung erfolgt automatisch über Stripe Connect.</p>
          </div>
        </div>`,
      });
    }

    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@ararat-grill.com',
        to: process.env.OWNER_EMAIL,
        subject: `🧾 ${rechnungNr} + Wochenbericht KW ${kw} · Ararat Grill Beckum`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei die Rechnung <b>${rechnungNr}</b> sowie der Wochenbericht KW ${kw} / ${now.getFullYear()} für Ararat Grill Beckum.</p>
               <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Dein Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €</p>`,
        attachments: [
          { filename: `${rechnungNr}_FlueVate_Rechnung.pdf`, content: rechnungPdf.toString('base64') },
          { filename: `KW${kw}_${now.getFullYear()}_Ararat_Wochenbericht.pdf`, content: berichtPdf.toString('base64') },
        ],
      });
    }

    console.log(`📊 Wochenbericht + Rechnung ${rechnungNr} KW ${kw} versendet`);
  } catch(e) { console.error('Wochenbericht Fehler:', e); }
});

// ─── MONATSBERICHT (letzter Tag des Monats, 23:58) ────────────────
cron.schedule('58 23 * * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);
  if (tomorrow.getDate() !== 1) return;

  try {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now); mEnd.setHours(23,59,59,999);
    const monat  = now.toLocaleDateString('de-DE', { month:'long', year:'numeric' });
    const datum  = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;
    const rechnungNr = await getNextRechnungNum();

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: mStart, $lte: mEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||0.99), 0);
    const nettoBase  = brutto - svcFees;
    const provision  = nettoBase * 0.05;
    const meinBetrag = svcFees + provision;
    const auszahlung = brutto - meinBetrag;
    const web        = orders.filter(o=>o.source!=='pos').length;
    const pos        = orders.filter(o=>o.source==='pos').length;

    const monatsPdf = await generatePdf(doc => {
      const W = 495;
      doc.rect(0, 0, 595, 70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('FlueVate', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text(`Monatsbericht · ${monat}`, 50, 46);

      doc.moveDown(3.5).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`MONATSABRECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`${monat}  ·  ${vonBis}`);
      doc.moveDown(1.5);

      const addrY = doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER', 50, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah / FlueVate', 50, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Zur Goldbrede 30', 50, addrY+30)
        .text('59269 Beckum', 50, addrY+44)
        .text('Deutschland', 50, addrY+58);
      if (process.env.STEUERNUMMER) doc.text(`Steuernummer: ${process.env.STEUERNUMMER}`, 50, addrY+72);

      doc.fontSize(8).fillColor('#999').text('RECHNUNGSEMPFÄNGER', 310, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Ararat Grill Beckum', 310, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Nordwall 45', 310, addrY+30)
        .text('59269 Beckum', 310, addrY+44)
        .text('Deutschland', 310, addrY+58);

      doc.y = addrY + 100;
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(1).stroke();
      doc.moveDown(0.8);

      doc.fontSize(9).fillColor('#555')
        .text(`Rechnungsnummer: ${rechnungNr}`, 50, doc.y, { continued: true })
        .text(`Datum: ${datum}`, { align: 'right' });
      doc.text(`Leistungszeitraum: ${vonBis}`, 50);
      doc.moveDown(1);

      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222')
        .text('Leistung', 50, doc.y)
        .text('Betrag', 50, doc.y-14, { width: W, align: 'right' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Servicegebühren Online-Bestellsystem', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`0,99 € × ${orders.length} Bestellungen (${monat})`);
      const sfY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${svcFees.toFixed(2).replace('.',',')} €`, 50, sfY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eee').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Systemprovision (5 % auf Speisenumsatz)', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`5 % von ${nettoBase.toFixed(2).replace('.',',')} € Speisenumsatz`);
      const pvY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${provision.toFixed(2).replace('.',',')} €`, 50, pvY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e').text('RECHNUNGSBETRAG (netto)', 50);
      const totY = doc.y - 18;
      doc.text(`${meinBetrag.toFixed(2).replace('.',',')} €`, 50, totY, { width: W, align: 'right' });
      doc.moveDown(1.5);

      doc.rect(50, doc.y, W, 26).fill('#fff8e1');
      doc.fontSize(9).font('Helvetica').fillColor('#7a5c00')
        .text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).', 56, doc.y-20);
      doc.moveDown(2);

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('MONATSÜBERSICHT');
      doc.moveDown(0.5);
      const rows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Online', `${web}`, true],
        ['davon Telefon / POS', `${pos}`, false],
        ['Gesamtumsatz (Brutto)', `${brutto.toFixed(2).replace('.',',')} €`, true],
        ['Einbehaltene Gebühren (FlueVate)', `− ${meinBetrag.toFixed(2).replace('.',',')} €`, false],
        ['Auszahlung an Restaurant', `${auszahlung.toFixed(2).replace('.',',')} €`, true],
      ];
      rows.forEach(([lbl, value, shade]) => {
        const rowY = doc.y;
        if (shade) doc.rect(50, rowY, W, 26).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(10).fillColor('#222').text(lbl, 58, rowY+8);
        doc.text(value, 50, rowY+8, { width: W-8, align: 'right' });
        doc.y = rowY + 26;
      });

      doc.fontSize(8).fillColor('#aaa')
        .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  ${rechnungNr} · ${monat}`, 50, 780, { width: W, align: 'center' });
    });

    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@ararat-grill.com',
        to: process.env.OWNER_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Ararat Grill Beckum`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei der Monatsbericht <b>${monat}</b> für Ararat Grill Beckum.<br><b>Dein Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €</p>`,
        attachments: [
          { filename: `${rechnungNr}_FlueVate_Monatsbericht_${monat.replace(' ','_')}.pdf`, content: monatsPdf.toString('base64') },
        ],
      });
    }
    console.log(`📅 Monatsbericht ${monat} versendet`);
  } catch(e) { console.error('Monatsbericht Fehler:', e); }
});

// ─── STATIC + ROOT ───────────────────────────────────────────────
app.use(express.static('.'));
app.get('/', (req, res) => res.sendFile(__dirname + '/ararat-beckum.html'));

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Ararat Grill Backend läuft auf Port ${PORT}`);
});
