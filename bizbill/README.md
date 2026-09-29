# BizBill

Offline-first GST billing, inventory, payments and accounts for small
businesses, delivered as a secure **Android app** (`tech.bbmfg.bizbill`).

```
bizbill/
├── www/                 The app UI and business logic (HTML/CSS/JS, no framework)
│   ├── js/core/         Money/GST engine, database, ledger, reports, backup, alerts…
│   ├── js/views/        Screens
│   ├── js/docs/         PDF / JPG document engine (invoice, receipt, ledger, reports, reminder card)
│   └── js/platform/     Bridge to the Android app (with browser fallbacks)
├── android/             Native Android shell (Java): WebView, notifications, updater
├── tests/               Unit / integration tests (node:test) + browser end-to-end tests
├── tools/               Version sync, release checks, update.json generator
├── docs/                Security, release and testing documentation
├── version.properties   THE version source (versionName / versionCode)
└── RELEASE_NOTES.md     Notes published with each release
```

## Modules

Dashboard (configurable cards, due today / overdue / collected / paid today) ·
Sales invoices · Quotations (→ invoice) · Purchases · Customers · Suppliers ·
Products (with images) · Inventory & stock movements · Payment In / Payment Out
(attachments, method details, allocation to bills) · Receivables / Payables with
aging · Ledgers · Expenses (receipt photos) · GST summary & reports · Profit &
Loss · 20 reports (PDF / CSV / print / share) · Notification Center · Backup &
restore (password-encrypted) · CSV import/export · Company profile · Billing
settings · App lock (PIN / biometric) · Notifications · Update Center ·
Activity history · Recycle bin · About / Help.

All money is calculated in integer paise with one rounding policy; every
invoice satisfies `gross − discount = taxable`, `taxable + tax = before round`,
`before round + round-off = grand total` (see `tests/calc.test.mjs`).

## Develop

```bash
npm ci
npm test              # unit + integration tests
npm run lint
npm run serve         # http://127.0.0.1:8080/  (browser preview of the app)
npm run test:e2e      # full UI flow in Chromium
```

Android (needs Android Studio / SDK 35, JDK 17):

```bash
cd android
./gradlew assembleDebug          # debug build (applicationId suffix .debug)
./gradlew lintRelease testReleaseUnitTest
```

The web app in `www/` is copied into the APK assets at build time.

## Releases

See [docs/RELEASE.md](docs/RELEASE.md). In short: bump `version.properties`,
add notes to `RELEASE_NOTES.md`, run `npm run version:sync`, push a tag
`vX.Y`. GitHub Actions builds, signs, checksums and publishes the APK, AAB and
`update.json`; installed apps pick the update up through the verified in-app
updater.

## Documentation

- [docs/SECURITY.md](docs/SECURITY.md): WebView hardening, bridge, permissions, data & backup policy, update verification
- [docs/RELEASE.md](docs/RELEASE.md): signing key, secrets, versioning, CI pipeline
- [docs/TESTING.md](docs/TESTING.md): automated coverage and the device test checklist
