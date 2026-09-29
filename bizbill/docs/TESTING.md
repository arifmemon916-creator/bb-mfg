# Testing BizBill

## Automated (run in CI on every push)

| Suite | Command | Covers |
|---|---|---|
| Calculation engine | `npm test` (`tests/calc.test.mjs`) | exclusive/inclusive GST, CGST/SGST/IGST, discounts, charges, round-off, fractional quantities, invariants of every total |
| Store / accounting | `tests/store.test.mjs` | invoices → stock/ledger/dues, purchases, partial & full payments, FIFO allocation, cancellation, quotations → invoice, validation & duplicates, stock adjustment, P&L, GST summary, reports, backup tamper detection, atomic restore, CSV import validation, PIN hashing, search, recycle bin |
| Alerts, files, backups, migration | `tests/alerts.test.mjs` | low stock (reaches minimum, below, restock, re-trigger, repeated launches, per-product switch); due reminders (before / today / overdue / snooze / partial amount / full payment closes / per-invoice offsets); file type sniffing; 4-attachment limit, invalid 5th, fake image, PDF, removal; product image de-duplication & corrupted image skipped on restore; encrypted backup wrong password / tampering; migration v1 → v2 on a live database keeps records and snapshot |
| Legacy data & update metadata | `tests/legacy.test.mjs` | old-format data recognised and imported without overwriting; update.json: wrong package, same/lower versionCode, http, foreign host, userinfo trick, bad checksum, mandatory & minimum version |
| Documents | `tests/docs.test.mjs` | multi-page invoice PDF (header repeated), JPG layout, receipt, ledger, every report, glyph safety |
| UI end-to-end | `npm run test:e2e` | company setup → product → customer → invoice with partial payment → dashboard figures → stock → PDF + JPG generation → Payment In with allocation → search → reports → cancel invoice (stock restored, excluded from reports) → backup round trip → dark mode → PIN lock/unlock |
| All screens | `node tests/e2e/smoke.mjs` | every route renders without console errors |
| Android security | `./gradlew testReleaseUnitTest` (`SecurityTest`) | file-name sanitising, MIME allowlist, base64 validation, content type checks, routes/callbacks, app-origin check, blocked schemes (`javascript:`, `file:`, `content:`, `intent:`, `data:`, `http:`), update metadata rules |
| Android lint | `./gradlew lintRelease` | API levels, manifest, resources |

## Device checklist (before each release)

Use a phone with the **previous** release installed plus a clean emulator.

Install & update
- [ ] Fresh install → onboarding, company profile, first invoice
- [ ] Previous version → new version: all invoices, customers, products, settings present
- [ ] Two consecutive updates (N-2 → N-1 → N)
- [ ] Older file:// build with data → "Previous version data" screen → import → figures match
- [ ] In-app update: optional (Later works, app usable), mandatory ("Security Update Required")
- [ ] Update rejected when: checksum wrong, package name different, signed with another key, versionCode equal or lower, download interrupted (airplane mode mid-download)
- [ ] "Install unknown apps" permission prompt explained and settings page opened

Offline
- [ ] Airplane mode: create/edit invoice, purchase, payment, reports, PDF, backup, restore
- [ ] No update prompt or blocking screen while offline; check happens after reconnecting

Documents & sharing
- [ ] Invoice PDF, JPG, reminder card; WhatsApp (PDF & image), email, other apps
- [ ] Print (PDF printer / real printer); Save to Drive / Downloads (SAF)
- [ ] Product image on invoice ON / OFF

Files
- [ ] Product image: camera, photo picker, large (> 10 MB) photo, non-image file rejected, replace, remove
- [ ] Payment attachments: 4 photos/PDFs, 5th blocked, preview, open, replace, remove
- [ ] CSV import with errors → preview → only valid rows imported

Backup
- [ ] Backup with password → restore on another phone; wrong password rejected
- [ ] Corrupted / edited backup file rejected with a clear message; nothing changed
- [ ] Restore shows date and counts, requires RESTORE, safety copy listed

Notifications
- [ ] Permission denied → in-app warning, billing unaffected
- [ ] Low stock: reach minimum, below, restock, drop again; no duplicates on relaunch
- [ ] Due reminder 3 days before / on due date at the chosen time (also after reboot)
- [ ] Partial payment updates reminder amount; full payment cancels reminders
- [ ] Overdue alert once; Snooze from notification and from full-screen alert
- [ ] Full-screen alert: screen off, locked (opening app asks to unlock), setting off, Android 14 permission revoked
- [ ] Sound / vibration switches

App behaviour
- [ ] Back button: closes dialogs → previous screen → app to background from Home
- [ ] Rotation / dark-light switch / font size change keep the current screen and form
- [ ] App lock: start, after background time, after inactivity, biometric, wrong PIN throttling
- [ ] Secure screen hides content in recents
- [ ] Kill WebView renderer (`adb shell am crash` on the renderer or low-memory) → app recovers
- [ ] Small phone (360×640) and large phone: no horizontal scrolling, keyboard does not cover inputs
