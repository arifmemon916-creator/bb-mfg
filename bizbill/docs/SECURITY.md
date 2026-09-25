# BizBill security design

BizBill holds business data (invoices, customers, products, purchases, GST,
payments). The design goal is: **data stays on the phone, the app cannot be
turned into a browser, and only the official publisher can update it.**

## 1. WebView

| Setting | Value | Why |
|---|---|---|
| Content source | `https://appassets.androidplatform.net/assets/www/` via `WebViewAssetLoader` | Serves files **only from the APK assets**. Google's recommended secure replacement for `file:///android_asset/`; lets file access be switched off entirely and gives a proper origin for IndexedDB and ES modules. |
| `setJavaScriptEnabled` | `true` | The app is JavaScript. All of it is local. |
| `setDomStorageEnabled` | `true` | Small UI preferences (localStorage). Business data is in IndexedDB. |
| `setAllowFileAccess` / `...FromFileURLs` / `setAllowUniversalAccessFromFileURLs` | `false` | Nothing is loaded from `file://`. |
| `setAllowContentAccess` | `false` | No `content://` loading. |
| Mixed content | never | |
| Multiple windows / auto-open windows | off | |
| Geolocation, camera/microphone permission requests | denied | |
| Safe Browsing | on (API 26+) | |
| Remote debugging | debug builds only | |

Request and navigation policy (`MainActivity`, `SafeUrl`):

- `shouldInterceptRequest`: every request that is not an app asset is answered
  with **403** — the page cannot load remote scripts, images or frames.
- `shouldOverrideUrlLoading`: the WebView never navigates away from the app.
  A user-tapped link is passed to another app only if it matches the allowlist:
  `tel:`, `mailto:`, `upi://pay`, and `https://` on `wa.me`,
  `api.whatsapp.com`, `github.com`, `www.gst.gov.in`, `services.gst.gov.in`.
  `javascript:`, `file:`, `content:`, `intent:`, `data:`, `http:`,
  credentials in URLs, non-standard ports and all other schemes are blocked.
- External intents are created with `CATEGORY_BROWSABLE`, no component and no
  selector, so a URL cannot target an arbitrary activity.
- The page has a strict Content-Security-Policy (`default-src 'self'`,
  `connect-src 'self'`, `object-src 'none'`).
- Renderer crash / low-memory kill (`onRenderProcessGone`) recreates the
  WebView; data is on disk in IndexedDB. Repeated crashes show a safe message.

## 2. JavaScript bridge (`NativeBridge`)

Exposed as `window.BizBillNative`. Every method:

- answers only while BizBill's own asset page is loaded (`isTrustedPage`),
- validates all input (`InputGuard`): callback ids `^cb\d{1,9}$`, routes
  `^#/[A-Za-z0-9/_?=&.%-]{0,200}$`, colours, backup names, e-mail addresses,
- **files**: MIME allowlist (PDF, JPEG, PNG, WebP, JSON, CSV, text),
  base64 alphabet/length checked *before* decoding, 30 MB limit, the decoded
  bytes must match the declared type (magic numbers), file names sanitised
  (no path separators, no leading dots, bounded length, extension forced),
- never executes commands, never accepts intents, URIs, class names or paths.

Async results are passed back with `JSONObject.quote()`, never by string
concatenation of raw input.

## 3. Files

- `FileProvider` exposes **only** `cache/shared/` and `cache/camera/`.
  Databases, WebView storage, `files/backups/` and `files/legacy/` are not
  reachable.
- Shared files get a temporary read grant for the chosen app only; temporary
  share / print / camera / update files older than one hour are deleted.
- "Save" uses the Storage Access Framework (the user picks the location).
  No storage permission is requested.
- Product images and payment attachments are checked by content (not by file
  name), resized and re-encoded (which strips EXIF/GPS metadata) and stored in
  the app database. Payment attachments: max 4, photo or PDF (≤ 5 MB).

## 4. Data at rest

- All business data lives in the app's private sandbox (WebView IndexedDB),
  protected by Android's file-based encryption and the app sandbox.
- App lock: PIN (PBKDF2-SHA256, 150 000 iterations, random salt; the PIN is
  never stored), optional biometric, lock on start / after background time /
  after inactivity, optional `FLAG_SECURE` (hides content in recents, blocks
  screenshots). The PIN hash is never written to backups.
- Encrypting IndexedDB records with a key held by the same WebView would not
  add real protection (any code able to read the database could read the key),
  so BizBill relies on the sandbox for live data and offers **strong
  encryption for backups**, which leave the device.

## 5. Android backup policy (intentional)

`allowBackup="false"`, `backup_rules.xml` and `data_extraction_rules.xml`
exclude **everything** (root, files, databases, shared preferences, external)
from Google cloud backup **and** device-to-device transfer.

| Data | Android backup | BizBill backup file |
|---|---|---|
| Invoices, quotations, purchases, payments, expenses | excluded | included |
| Customers, suppliers, products, stock adjustments | excluded | included |
| Product images, payment attachments, expense receipts | excluded | included (validated on restore) |
| Settings, company profile | excluded | included |
| App-lock PIN hash, device lock settings | excluded | **not included** |
| Notification center, activity history | excluded | included |
| WebView cache, temp PDFs / shares / camera / update files | excluded | not included |
| Local automatic backups (`files/backups`) | excluded | — |

Users move data with **Backup now** (optionally AES-256-GCM encrypted, key
from PBKDF2-SHA256 with 310 000 iterations). Restore validates format,
version, SHA-256 checksum and every record, shows date and record counts,
requires typing RESTORE, saves a safety copy, and replaces data in one atomic
transaction. Damaged attachments are skipped instead of failing the restore.

## 6. Network

- `usesCleartextTraffic="false"` and a network security config that trusts
  only **system** CAs (user-installed CAs cannot intercept update downloads).
- The only network use is the update check/download. No analytics, no ads,
  no crash reporting, no accounts. Business data is never sent anywhere.

## 7. Updates (`UpdateManager`)

`update.json` is accepted only from HTTPS on `github.com`,
`objects.githubusercontent.com` or `release-assets.githubusercontent.com`
(every redirect re-checked, 64 KB limit) and only if `packageName` equals
`tech.bbmfg.bizbill`, `latestVersionCode` is an integer, `sha256` is 64 hex
characters and `downloadUrl` is on an allowed host.

The APK is installed only if **all** checks pass:

1. complete download (Content-Length matched, ≤ 150 MB, enough free space),
2. SHA-256 equals `update.json`,
3. package name equals the app,
4. versionCode equals the metadata and is higher than the installed version,
5. signing certificate equals the installed app's (key rotation accepted only
   through an APK Signature Scheme v3 lineage that contains the current key).

Installation uses the official `PackageInstaller` session API; Android shows
its confirmation screen and re-verifies the signature. There is no silent or
hidden install and no bypass. If Android requires "Install unknown apps"
permission, BizBill explains it and opens the correct settings page. Offline,
the app never blocks; a mandatory update can be postponed after a failed
download attempt so users are never locked out of their data.

## 8. Notifications

Generated locally from the user's data; no push service. Lock-screen
notifications use a public version without amounts or names. Full-screen
alerts are opt-in, use `setFullScreenIntent` with `USE_FULL_SCREEN_INTENT`,
respect Android 14's per-app permission, and never dismiss or bypass the
keyguard (opening BizBill from the alert requires unlocking).

## 9. Permissions

| Permission | Purpose |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | Check / download official updates only |
| `POST_NOTIFICATIONS` | Payment, stock, backup and update alerts (asked with an explanation, when the user enables notifications) |
| `VIBRATE` | Notification vibration (user setting) |
| `RECEIVE_BOOT_COMPLETED` | Restore reminder alarms after restart |
| `USE_FULL_SCREEN_INTENT` | Optional full-screen payment alerts (user setting) |
| `REQUEST_INSTALL_PACKAGES` | Install verified official updates via the system installer |
| `USE_BIOMETRIC` | Optional fingerprint / face unlock |

Not requested: storage, camera (the system camera app / photo picker are
used), location, contacts, phone, SMS, accessibility, overlay.

## 10. Release build

R8 minification and resource shrinking, `debuggable false`, debug/info
logging stripped, no secrets in the repository (signing comes from GitHub
Actions secrets), dependency-info blob excluded from the APK.

## Legacy data migration

Older BizBill builds loaded from `file:///android_asset/` stored data under
the `file://` origin, which the secure asset origin cannot read. On first
launch the app opens a separate hidden WebView (file access enabled for that
WebView only, network blocked, no navigation), runs a read-only export page,
and writes a private copy to `files/legacy/legacy-data.json`. The original
storage is never modified or deleted. The user then reviews what was found and
imports it (existing records are never overwritten; a safety backup is taken
first). The raw copy can always be exported.
