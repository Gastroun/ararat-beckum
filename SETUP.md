# 🔥 Ararat Grill Beckum – Setup Anleitung

## Projektdateien

| Datei | Beschreibung |
|---|---|
| `ararat-beckum.html` | Speisekarte + Checkout (Kundenwebseite) |
| `ararat-admin.html` | Admin Dashboard für den Wirt |
| `server.js` | Backend (Node.js/Express/MongoDB) |
| `printnode-helper.js` | Bondrucker-Logik (ESC/POS) |
| `package.json` | Node.js Abhängigkeiten |
| `.env.example` | Vorlage für Umgebungsvariablen |
| `.gitignore` | Schützt .env vor GitHub |

---

## Schritt 1 – GitHub Repository erstellen

1. Gehe auf **github.com** → New Repository
2. Name: `ararat-grill-beckum`
3. Sichtbarkeit: **Privat**
4. `.gitignore`: Node auswählen
5. „Repository erstellen" klicken
6. Alle Dateien hochladen (**OHNE `.env`!**):
   - `ararat-beckum.html`
   - `ararat-admin.html`
   - `server.js`
   - `printnode-helper.js`
   - `package.json`
   - `.env.example`
   - `.gitignore`
   - `SETUP.md`

---

## Schritt 2 – MongoDB Atlas

1. **mongodb.com/atlas** → Kostenlos registrieren (einmalig)
2. Cluster0 → „Browse Collections" → „Add My Own Data"
3. Database Name: `ararat-grill`
4. Collection Name: `orders`
5. „Create" klicken
6. Connection String holen:
   - Cluster0 → „Connect" → „Drivers"
   - Node.js Version wählen
   - String kopieren: `mongodb+srv://...`
   - `/ararat-grill` am Ende eintragen

---

## Schritt 3 – Stripe einrichten

1. **stripe.com** → Registrieren (Konto des Restaurants)
2. Dashboard → Entwickler → **API-Schlüssel**
   - `pk_live_...` → in `ararat-beckum.html` eintragen (Stripe Public Key)
   - `sk_live_...` → in Render als `STRIPE_SECRET_KEY`
3. Dashboard → Entwickler → **Webhooks** → „Endpunkt hinzufügen"
   - URL: `https://DEIN-BACKEND.onrender.com/api/stripe-webhook`
   - Events: `checkout.session.completed` + `checkout.session.expired`
   - Webhook Secret `whsec_...` → in Render als `STRIPE_WEBHOOK_SECRET`

> ⚠️ Stripe berechnet: 1,5 % + 0,25 € pro Kartenzahlung. Geld geht direkt an den Wirt.

---

## Schritt 4 – Resend (E-Mail) einrichten

1. **resend.com** → Kostenlos registrieren (3.000 E-Mails/Monat gratis)
2. API Key erstellen → in Render als `RESEND_API_KEY`
3. Domain verifizieren (z.B. `ararat-grill.de`) oder Testdomain nutzen
4. `EMAIL_FROM` = Absender z.B. `bestellungen@ararat-grill.de`
5. `RESTAURANT_EMAIL` = E-Mail des Wirts für Kopie jeder Bestellung

---

## Schritt 5 – Render Web Service (Backend)

1. **render.com** → New → Web Service
2. GitHub verbinden → `ararat-grill-beckum` auswählen
3. Einstellungen:
   - **Name**: `ararat-grill-backend`
   - **Language**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
   - **Health Check Path**: `/api/health`
4. Environment Variables eintragen (alle aus `.env.example`):

| Variable | Wert |
|---|---|
| `MONGODB_URI` | Von MongoDB Atlas |
| `STRIPE_SECRET_KEY` | Von stripe.com |
| `STRIPE_WEBHOOK_SECRET` | Von stripe.com Webhooks |
| `RESEND_API_KEY` | Von resend.com |
| `EMAIL_FROM` | z.B. bestellungen@ararat-grill.de |
| `RESTAURANT_EMAIL` | E-Mail des Wirts |
| `PRINTNODE_API_KEY` | Von printnode.com (optional) |
| `PRINTNODE_PRINTER_ID` | Von printnode.com (optional) |
| `ADMIN_PASSWORD` | Passwort für den Wirt |
| `ADMIN_TOKEN_SECRET` | Langer geheimer Text (40+ Zeichen) |
| `WHATSAPP_NUMBER` | z.B. `4915123456789` (ohne + oder Leerzeichen) |
| `FRONTEND_URL` | URL der Speisekarte (nach Deploy eintragen) |
| `PORT` | `3001` |

5. „Deploy Web Service" klicken
6. Warten bis „Live" erscheint (~3 Minuten)
7. Testen: `https://NAME.onrender.com/api/health` → muss `{"status":"ok"}` zeigen

---

## Schritt 6 – Render Static Site (Speisekarte)

1. render.com → New → **Static Site**
2. Gleiches GitHub Repository auswählen
3. Einstellungen:
   - **Publish Directory**: `.` (Punkt)
   - **Build Command**: leer lassen
4. „Deploy" klicken
5. Nach dem Deploy: URL in `FRONTEND_URL` in Render eintragen

---

## Schritt 7 – admin.html anpassen

Nur diese 3 Zeilen in `ararat-admin.html` ändern:

```javascript
const API_BASE           = 'https://DEIN-BACKEND.onrender.com/api';
const DASHBOARD_PASSWORD = 'DEIN_ADMIN_PASSWORT';       // mind. 12 Zeichen
const ADMIN_API_TOKEN    = 'DEIN_GEHEIMER_TOKEN';        // mind. 40 Zeichen, zufällig
```

> ⚠️ `ADMIN_API_TOKEN` muss **exakt gleich** sein wie `ADMIN_TOKEN_SECRET` in Render!
> ⚠️ Niemals echte Passwörter oder Tokens in diese Datei eintragen – diese Datei liegt auf GitHub!

---

## Schritt 8 – Test

1. Speisekarte öffnen → Artikel in Warenkorb
2. Checkout → Testbestellung mit Barzahlung aufgeben
3. admin.html öffnen → Bestellung muss erscheinen
4. Stripe Test: `pk_test_...` und `sk_test_...` Keys verwenden für Tests
5. Test-Storno: Ablehnen mit Grund → Storno-E-Mail prüfen (bei Stripe-Zahlung wird Betrag automatisch zurückerstattet)
6. Bon-Druck testen (falls PrintNode konfiguriert)

---

## Schritt 9 – PrintNode Bondrucker (optional)

1. **printnode.com** → Kostenlos registrieren
2. API Key erstellen → in Render als `PRINTNODE_API_KEY`
3. PrintNode Client-Software auf PC/Laptop im Restaurant installieren
   - Download: printnode.com/en/download
4. Mit PrintNode Account anmelden → Drucker wird automatisch erkannt
5. Drucker-ID im Dashboard ablesen → in Render als `PRINTNODE_PRINTER_ID`

**Empfohlene Drucker:**
- Epson TM-T20III (~150 €) – USB oder LAN
- Epson TM-T88VII (~300 €) – USB, LAN, Bluetooth

---

## Kosten-Übersicht

| Dienst | Kostenlos bis | Dann |
|---|---|---|
| MongoDB Atlas | 512 MB | ab 9 $/Monat |
| Render | 750h/Monat | ab 7 $/Monat |
| Resend | 3.000 E-Mails/Monat | ab 20 $/Monat |
| PrintNode | 50 Prints/Monat | ab 9 $/Monat |
| Stripe | Kostenlos | 1,5 % + 0,25 € / Zahlung |

> ✅ Start komplett kostenlos möglich!

---

## Häufige Fehler

**Backend startet nicht:**
→ `MONGODB_URI` prüfen – Datenbankname am Ende eintragen

**Login im Dashboard funktioniert nicht:**
→ `ADMIN_TOKEN_SECRET` in Render muss gleich sein wie `ADMIN_API_TOKEN` in `admin.html`

**Stripe Webhook funktioniert nicht:**
→ Webhook URL in Stripe Dashboard prüfen: `https://BACKEND.onrender.com/api/stripe-webhook`
→ Event `checkout.session.completed` muss aktiviert sein

**E-Mails kommen nicht an:**
→ Domain bei Resend verifizieren
→ `EMAIL_FROM` muss verifizierte Domain nutzen

**WhatsApp-Button erscheint nicht:**
→ `WHATSAPP_NUMBER` in Render eintragen (Format: `4915123456789` – Ländervorwahl 49, dann Nummer ohne führende 0)

---

*Ararat Grill Beckum · Nordwall 45 · 59269 Beckum*
