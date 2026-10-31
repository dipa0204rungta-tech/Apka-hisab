# Apka Hisab – Voice Billing

Billing app for shops. Add items by speaking in Hindi or English, or type them in.
Check the bill, tap **Print Bill**, and the receipt prints on a 58 mm or 80 mm thermal printer.

**Open the app:** https://dipa0204rungta-tech.github.io/Apka-hisab/

## Use it on your phone

1. Open the link above in **Chrome** (Android) or **Safari** (iPhone).
2. Add it to your home screen:
   - Android Chrome: tap ⋮, then **Add to Home screen** (or **Install app**).
   - iPhone Safari: tap the Share button, then **Add to Home Screen**.
3. Open it from the home-screen icon. After the first visit it also works without internet.
4. Allow microphone access and tap the mic **once**. It keeps listening, so you can say
   the whole list (15-20 items) with a short pause after each item. Tap the mic again,
   or say “print the bill”, when you are done. For example
   “Add two kilos of rice at 60 rupees per kilo” or “दो किलो चावल 60 रुपये किलो”.
5. When the bill is ready, tap **Review & Print Bill** (or say “print the bill”),
   check it, and tap **Print Bill**.

Bills are saved only on your phone, in that browser. Clearing the browser's data deletes them.

`apka-hisab-billing.html` is a single-file copy that also works when opened directly
on a computer, without internet.

---

## For developers

The app is plain HTML, CSS and JavaScript with no dependencies. This repository
is both the source code and the published site: GitHub Pages serves it
from the `gh-pages` branch, which is kept identical to `main`.

```
npm start        # local server at http://localhost:8080/
npm test         # unit tests + check that apka-hisab-billing.html is up to date
npm run build    # regenerate apka-hisab-billing.html after changing the source
npm run test:e2e # browser tests (needs Playwright + Chromium and `npm start` running)
```

To publish a change: run the tests, commit to `main`, then push `main` to
both `main` and `gh-pages` (`git push origin main main:gh-pages`).

## Speaking a whole list

Tap the mic once; it keeps listening through pauses until you tap it again,
say “print the bill”, or stay silent for a minute. Several items can be said
in one breath, and “और” / “फिर” / “next” between them is optional:

> चावल 5 किलो 40 रुपये किलो, दाल 30 किलो का बोरा 2000 रुपये प्रति बोरा 3 करके,
> मिर्ची 500 ग्राम 200 रुपये किलो, चीनी 25 किलो का बोरा 4 बोरा 1200 रेट …

* Sacks: “30 किलो का बोरा … 3 करके” → *दाल (30 kg)*, 3 बोरा. “2 बोरा 25 किलो का, 40 रुपये किलो” → 50 kg at ₹40.
* Grams at a per-kilo rate are converted: “मिर्ची 500 ग्राम 200 रुपये किलो” → 0.5 kg × ₹200.
* **What I heard** lists every item: ✓ added (with **Remove**), or ⚠ to check (missing price, unclear rate or total, already on the bill) with **Fix**, **Add as new line** or **Skip**. Nothing is guessed.
* A list can also be typed or pasted into the “Heard” box, one item per line.
* **Size + count + rate:** “25 kg चावल का 4 बोरा ₹2,000 करके” → *चावल (25 kg)*, 4 बोरा × ₹2000. One weight plus one count means pack size and how many; “₹2000 करके” / “के हिसाब से” is the rate for each.
* **Items spoken in parts** are joined: “काजू” … “आधा किलो” … “800 रुपये किलो” → one item.
* **Talk near the phone** (no numbers, no units, several words) is shown greyed as “Not an item, ignored”.
* **Misheard names** of common kirana items, and of items on your saved bills, are corrected when one letter or matra is off (“जरा” → जीरा, “कंजू” → काजू), and the list shows what was heard.

## Voice commands

| Say | Result |
| --- | --- |
| “Add two kilos of rice at 60 rupees per kilo” | 2 kg Rice × ₹60 = ₹120 |
| “Add one litre of oil for 150 rupees” | 1 L Oil, ₹150 total |
| “Add 500 grams sugar at 40 per kilo” | 0.5 kg Sugar × ₹40 |
| “Change the rice quantity to three kilos” / “rice rate 65” | edits the Rice row |
| “Remove the oil” / “remove last item” | removes the row |
| “Apply a discount of 10 rupees” / “5 percent discount” | sets the discount |
| “दो किलो चावल 60 रुपये किलो” · “चावल की मात्रा तीन किलो कर दो” · “तेल हटा दो” · “10 रुपये छूट दो” | Hindi equivalents |
| “do kilo aloo 30 rupaye kilo” · “dedh kilo cheeni …” | Hinglish |

Safety rules built in:

* The recognised text is shown in an editable box. It can be corrected and re-applied, and every voice change has an **Undo**.
* Missing quantities, prices or item names are never guessed. The user is asked, and the manual form is pre-filled with what was understood.
* “2 kg rice 60 rupees” is ambiguous (rate or total?), so the app asks instead of choosing.
* Adding an item already on the bill (including `rice` vs `chawal` vs `चावल`) asks before creating a second line.
* Voice can never save or print. Saying “print the bill” only opens the review screen, and the shopkeeper must tap **Print Bill**.

Speech recognition uses the browser's Web Speech API (Chrome, Edge, Safari).
When it is unavailable, such as in Firefox, without https, or with the microphone denied, the mic button is disabled with an explanation. Manual entry and typed commands keep working.

## Code layout

| File | Purpose |
| --- | --- |
| `index.html`, `assets/css/billing.css` | Page, mobile layout, thermal-receipt print styles |
| `assets/js/billing/bill.js` | Pure bill model: items, validation, duplicate detection, totals (summed in paise), discounts, unit conversion |
| `assets/js/billing/numbers.js` | Spoken numbers → digits (English, Hindi, Devanagari digits, डेढ़/ढाई/साढ़े/सवा) |
| `assets/js/billing/voice-parser.js` | Sentence → `add` / `change` / `remove` / `discount` command, or an error that asks the user |
| `assets/js/billing/speech.js` | Web Speech API wrapper with feature detection and error messages |
| `assets/js/billing/storage.js` | Bill/draft/settings persistence and bill numbering |
| `assets/js/billing/receipt.js` | Receipt model, HTML (browser print) and fixed-width text (ESC/POS) renderers |
| `assets/js/billing/printers.js` | Printer adapters: phone print dialog and Bluetooth LE thermal printer |
| `assets/js/billing/escpos.js`, `receipt-image.js` | Receipt as an ESC/POS raster image (prints Hindi and ₹) |
| `sw.js`, `manifest.webmanifest` | Offline support and Add to Home Screen |
| `apka-hisab-billing.html` | Generated single-file copy that opens by double-click |
| `assets/js/billing/app.js` | UI controller |

## Saving

Bills are stored in `localStorage` through `LocalBillStore`. The API is
async, so it can be swapped for a server-backed store with the same methods
(`saveBill`, `listBills`, `getBill`, `saveDraft`, `loadDraft`, `clearDraft`,
`getSettings`, `saveSettings`).

* Each bill gets a UUID when it is started. Saving the same bill again (double tap, retry) returns the existing record instead of creating a second transaction.
* Bill numbers are sequential (`AH-00001`, prefix set in Settings) and never reused.
* The bill in progress is auto-saved as a draft, so a refresh does not lose it. Storage failures are shown to the user, never ignored.
* Each saved bill keeps a snapshot of the shop details and totals, so reprints match the original.

Note that `localStorage` belongs to one browser on one device. Use a server-backed store for multi-device access or backups.

## Printing

There are two ways to print:

* **Bluetooth thermal printer (direct, hands-free).** Tap **Connect Bluetooth printer** in the Printer section and choose the printer. Receipts are sent straight to it as an image, so Hindi item names and ₹ print correctly. This needs Chrome on Android (or a computer), and a printer that supports **Bluetooth Low Energy (BLE, Bluetooth 4.0+)**. Printers that only have "Classic" Bluetooth cannot be reached from a web app.
* **Phone/computer print dialog.** Used when no Bluetooth printer is connected, for Wi-Fi printers or "Save as PDF".

**Review, then print.** When the bill is ready, tap **Review & Print Bill** or say **“print the bill”** (“bill print kar do” / “बिल प्रिंट करो”). The bill opens on a review screen with every item, rate and the total, and the total is read out when opened by voice. Nothing is saved or printed until the shopkeeper taps **Print Bill**, which saves the bill once and prints it. **Save without printing** and **Back to bill** are also on that screen. After printing, **Print Again** makes another copy, and speaking the next item starts a new bill. If the printer fails, the bill stays saved and a **Print again** button appears.

Printing code lives in `printers.js` (adapters), `escpos.js` (ESC/POS raster commands) and `receipt-image.js` (draws the receipt at 384 dots for 58 mm or 576 dots for 80 mm). A USB printer could be added as another adapter using Web Serial or WebUSB.
