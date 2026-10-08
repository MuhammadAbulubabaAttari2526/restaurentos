# RestaurantOS

RestaurantOS is a React/Vite restaurant workspace using Firebase Authentication, Cloud Firestore and Firebase Hosting. Its production setup targets Firebase's no-cost Spark plan: it does not deploy Cloud Functions or use Cloud Storage. Public owner signup is disabled; an administrator provisions the first owner, and invited team members join through an email-verified link.

## Included

- Email/password sign-in and password reset, plus email-verified staff invitations.
- Dashboard, POS, order tracking, bills/printable invoices, payments/refunds, tables, reservations, menu, inventory, purchases, expenses, customers, settings and CSV reports.
- Clearly marked sample workspace with temporary in-memory records for trying the interface without changing Firebase data.
- Tenant-scoped Firestore rules with owner, manager, cashier and waiter roles.
- Optional menu images by public HTTPS URL. Image upload to Firebase Storage is not used.

## Requirements

- Node.js 22 or later and npm.
- A Firebase project with Email/Password Authentication, Cloud Firestore and Hosting enabled.
- Spark has no payment method requirement. Firebase free quotas and limits still apply.
- Java 21 only if you choose to run Firestore emulator rules checks.

## Local Setup

```sh
npm install
cp .env.example .env.local
npm run dev
```

Copy the Firebase web app configuration from Firebase Console into `.env.local`. These values identify the project; Firestore Rules and verified authentication provide access control. Never put service-account keys in `.env.local` or frontend code. Restart Vite after changing environment variables.

## First Owner Setup

Public `/signup` does not create accounts or grant ownership. First create and verify the user in Firebase Authentication, then run the trusted Admin SDK script from an environment with Google Application Default Credentials:

```sh
npm --prefix functions install
npm --prefix functions run provision-owner -- restaurant-id "Restaurant Name" owner@example.com
```

The script assigns the owner claim and creates the restaurant, membership, settings and audit entry. Sign out and back in after provisioning. Owners invite staff from Staff. Each invitation is tied to the invited email, expires after seven days, and is copied as a link for the owner to share; invitation emails are not sent automatically.

## Sample Workspace

Choose **Open sample workspace** on the sign-in screen. Sample menu, orders, tables, customers, inventory, staff, purchases, expenses and payments are held in browser memory. The sample workspace is visibly labeled and bypasses Firebase reads and writes. Changes reset when you refresh or leave the demo session. It is for interface exploration only; it does not seed records into your restaurant.

## Spark Trust Boundaries

Tenant membership and roles are checked by Firestore Rules. The Spark version runs restaurant transactions in the signed-in browser because deployed Cloud Functions require a paid Firebase plan. Rules restrict writes by tenant and role and validate document shapes, but they cannot independently certify prices or financial calculations against a modified browser client. Use the app with trusted team accounts; choose a trusted server backend if you need server-enforced financial integrity.

Firebase Cloud Storage for Firebase requires the Blaze plan, so menu images use an optional existing public HTTPS URL. [Firebase's Storage billing FAQ](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024) explains the plan requirement. No Firebase Storage or Cloud Functions deployment is configured for this app.

Amounts are stored in integer cents. The app records payments but does not process cards or verify bank transfers. Recipe stock is deducted when an order is placed and is not automatically restored when an order is cancelled. Dashboard/report queries are bounded; large restaurants may need partitioned aggregates.

## Emulator

Start Authentication, Firestore and Hosting emulators:

```sh
npx firebase-tools emulators:start --project demo-restaurantos --only auth,firestore,hosting
```

---

## Windows Desktop POS & Data Safety Architecture

RestaurantOS includes an enterprise-grade Windows Desktop POS build running offline-first on Electron with a local SQLite database (`better-sqlite3`).

### 1. Data Safety & App Identity Locking (CRITICAL)
- **`appId`:** `"com.restaurantos.pos"`
- **`productName`:** `"RestaurantOS"`
- **RULE:** Never change `appId` or `productName` in `package.json`. Modifying either value alters Electron's `userData` directory path (`%APPDATA%/RestaurantOS`), which causes the app to generate a fresh, empty database and lose connection to existing restaurant sales and customer data.
- **Data Location:** All SQLite database files (`restaurantos.db`) and backups are stored exclusively in `%APPDATA%/RestaurantOS/database` and `%APPDATA%/RestaurantOS/backups`. No persistent data is ever written to `Program Files`.
- **NSIS Uninstaller Guard:** `deleteAppDataOnUninstall: false` is strictly enforced in `package.json`. Uninstalling or upgrading the app preserves restaurant database records and backups.

### 2. Migration Safety & Online Backups
- **Pre-Migration Backups:** Before any schema migration (`001`, `002`, `003`...) executes, an automatic online SQLite snapshot is created (`backups/backup-before-v<from>-to-v<to>-<timestamp>.db`) using SQLite's zero-lock backup API.
- **Atomic Transactions:** Each migration runs inside a strict SQLite transaction. Any error triggers an immediate rollback, leaving existing data untouched and valid.
- **Version Compatibility Guard:** If the database file version is newer than the application version (e.g. older app opened on a newer database), execution immediately halts with an upgrade warning to prevent schema downgrades or data corruption.
- **Restore Safety:** Restoring any backup creates a safety snapshot (`backup-before-restore-<timestamp>.db`) prior to applying the restored file.
- **Backup Retention:** The backup manager enforces an automatic retention policy (keeping the latest 14 backups) to protect disk space.

### 3. Auto-Updater (electron-updater)
- The GitHub Releases provider is configured in `package.json`; `package.json` is the version source used by Electron, the installer, and the app footer.
- Packaged apps check 10 seconds after startup and every four hours. Checks fail quietly when offline.
- A small banner offers **Update Now** or **Later**. The download starts only when requested, shows progress, and never installs automatically.
- Restart/install is explicit. It is blocked while a POS or print operation is active or an order/payment remains open. The app first attempts Firebase sync, checks SQLite integrity, and makes a database backup; any unsynced queue stays safely in SQLite and syncs after restart.
- Migrations run at startup in transactions, with a pre-migration backup before each schema change. Test SQL files are excluded from production migrations.

### 4. Building and Diagnosing the Windows App
- Before a production build, provide the required Firebase web-app values from `.env.example` in the build environment or an ignored `.env.local`. Vite embeds `VITE_*` values into the renderer during the build; the installed app does not read `.env` files. Production builds stop if required Firebase values are missing or the emulator flag is enabled.
  - Run `npm run dist:win` to create the standard x64 NSIS installer, or `npm run dist:win:unpacked` to create an unpacked x64 app for a clean-machine startup check.
  - The packager reuses the Electron runtime installed in `node_modules/electron/dist`, avoiding a second extraction step. `better-sqlite3` 13 uses a Node-API prebuild, so it does not depend on Electron's version-specific Node ABI. The `postinstall` and Windows package scripts verify that the Windows x64 prebuild exists and loads. The native `.node` file is unpacked from `app.asar`; migration SQL remains inside the app bundle.
  - Startup diagnostics are written to `%APPDATA%\RestaurantOS\logs\main.log`. Press **Ctrl+Shift+I** to open DevTools, or set `RESTAURANTOS_OPEN_DEVTOOLS=1` before launch.
  - For an isolated startup check, pass `--user-data-dir=<empty-folder>` to `RestaurantOS.exe`. The SQLite database and logs use that directory through Electron's `userData` path.


Set `VITE_USE_FIREBASE_EMULATORS=true` in `.env.local`, provide syntactically valid Firebase web configuration, and run `npm run dev` in another terminal.

## Build And Deploy

```sh
npm run build
npx firebase-tools deploy --only firestore:rules,firestore:indexes,hosting --project restaurentos-846
```

The live project is `restaurentos-846`; its Hosting URL is <https://restaurentos-846.web.app>.

## Windows Desktop Releases and Update Checks

The desktop updater reads public GitHub Releases from the `owner` and `repo` in `package.json`. Keep those values pointed at the repository clients can access. Published releases must include the installer and electron-builder metadata (`latest.yml` and its referenced assets); `npm run release:win` uploads them automatically.

To publish an update:

1. Commit the app changes and push them to the release branch.
2. Bump the version with `npm version patch` (or `minor` / `major`). This updates `package.json`, `package-lock.json`, and creates a matching `vX.Y.Z` Git tag. The app reads its version from `package.json`.
3. Push the commit and tag, for example `git push origin main --follow-tags`.
4. Set `GH_TOKEN` in your terminal to a GitHub token with permission to publish Releases in the configured repository. Do not put the token in source files.
5. Run `npm run release:win`. It builds the renderer, verifies the SQLite native dependency, creates the x64 NSIS installer, and publishes the installer and update metadata to that version's GitHub Release.
6. Remove the token from the terminal when publishing is finished. Installed apps check for the release after startup and then every four hours; they show the banner and wait for the user to choose when to download and restart.

To verify the update banner, use a test GitHub Releases repository if you do not want to notify production clients:

1. Point the test build's GitHub `owner` and `repo` in `package.json` at the test repository, set its version to `1.0.0`, then run `npm run release:win` and install that release on a test PC.
2. Bump the package version to `1.0.1` and publish it to the same test repository with `npm run release:win`.
3. Start the installed `1.0.0` app while online. Within about 10 seconds it should show **New update available (v1.0.1)**. Choose **Later** to dismiss it, or **Update Now** to see download progress.
4. After download, choose **Restart to install**. The app refuses while orders, payments, printing, or unsafe database state remain. After restart, check that the sidebar shows v1.0.1 and that the existing SQLite data is still present.
5. Restore the production GitHub `owner` and `repo` before building a client release. An offline check should leave POS available and retry on a later startup or scheduled check.
