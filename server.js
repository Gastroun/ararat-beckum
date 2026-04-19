const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Stripe = require('stripe');
const { Resend } = require('resend');
const cron = require('node-cron');
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
  items: [{ name: String, price: Number, qty: Number, note: String }],
  subtotal: Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee: { type: Number, default: 0.50 },
  total: Number,
  note: String,
  prepTime: { type: Number, default: null },
  cancelReason: { type: String, default: '' },
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

// ─── COUNTER für orderNum ─────────────────────────────────────────
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
  if (!resend || !order.customer?.email) return;
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

// ─── STATIC + ROOT ───────────────────────────────────────────────
app.use(express.static('.'));
app.get('/', (req, res) => res.sendFile(__dirname + '/ararat-beckum.html'));

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Ararat Grill Backend läuft auf Port ${PORT}`);
});
