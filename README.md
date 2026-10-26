# RestaurantOS

RestaurantOS is a React and Node restaurant workspace. The Node API stores shared restaurant records and accounts in MongoDB Atlas. The Windows POS uses SQLite while offline and syncs changes to the same MongoDB API when connected.

## Features

- POS, orders, tables, reservations, payments, refunds and receipts.
- Menu, inventory, purchases, expenses, customers, staff access and reports.
- MongoDB backed email/password accounts, invitation links and role checks.
- Offline-first Electron desktop storage with queued MongoDB synchronization.
- A sample workspace that does not write to Atlas.

## Requirements

- Node.js 22 or later and npm.
- A MongoDB Atlas cluster and database user with access to the `restaurantos` database.
- Add each server or development computer's outbound IP to the Atlas Network Access list.

## Local setup

```powershell
npm.cmd install
npm.cmd --prefix functions install
Copy-Item .env.example .env.local
```

Put the Atlas URI in the ignored `functions/.secret.local` file:

```text
MONGODB_URI=mongodb+srv://<database-user>:<encoded-password>@<cluster-host>/restaurantos
MONGODB_DB=restaurantos
```

Never put the URI in a `VITE_*` variable, renderer code, or a commit. Run the API and Vite app together:

```powershell
npm.cmd run dev
```

The API listens on port `8787`, Vite on `5173`, and Vite forwards `/api` requests to the API. The API health endpoint is `/api/health` and confirms an Atlas connection.

## MongoDB Shell and Compass

Use the same Atlas connection URI in `mongosh` and Compass. The application stores restaurant records in `restaurantDocuments`, accounts in `authUsers`, and session token hashes in `authSessions`. See [MongoDB Atlas setup](docs/mongodb-atlas-setup.md).

## Existing Firestore data and accounts

The app no longer uses Firebase Authentication, Cloud Functions, Hosting, or the Firebase client SDK. The Firestore importer is retained temporarily as a one-time source reader so old restaurant records can be copied to MongoDB without changing the source. It is the only remaining Firebase-dependent utility; remove it and its Admin SDK dependency after the import is finished.

Run the import dry-run first, then apply it while old clients are not writing:

```powershell
gcloud auth application-default login
npm.cmd --prefix functions run migrate:firestore -- --project <old-project-id>
npm.cmd --prefix functions run migrate:firestore -- --project <old-project-id> --apply
```

The import preserves document paths in `restaurantDocuments` and does not delete source records. If an import stops partway through, resume with `--apply --resume`. Review the imported record count before starting the new app against the Atlas database.

Firebase passwords cannot be exported. Provision the owner with a new password; the tool reuses the old Mongo-imported membership ID when the owner email matches:

```powershell
npm.cmd --prefix functions run provision-owner -- <restaurant-id> "Restaurant Name" owner@example.com
```

The password is entered without echoing to the terminal. Existing staff can be assigned new MongoDB passwords by the trusted administrator:

```powershell
npm.cmd --prefix functions run set-password -- staff@example.com
```

Owners can also issue new invitation links for staff. Invitation links must be shared directly with the intended team member; RestaurantOS does not send email automatically.

## Run and deploy

For local production preview:

```powershell
npm.cmd run build
npm.cmd start
```

The Node server serves the built web app and the MongoDB API on the same origin. Deploy that Node server to a host that can reach your Atlas cluster, provide `MONGODB_URI` and `MONGODB_DB` as server secrets, and allowlist the host's outbound IP in Atlas. The API uses `PORT` when provided by the host.

For a packaged Electron app that connects to a remote Node API, set `VITE_API_BASE_URL` to the API origin before building to override the default RestaurantOS Vercel API. The value is public and contains no database credential. The desktop app keeps working offline and synchronizes when it can reach that server.

## Operational notes

- Session records contain only a hash of the bearer token. Passwords are stored as salted scrypt hashes.
- The app records payments but does not process cards or verify bank transfers.
- Restaurant records are shared through MongoDB. Electron keeps a local SQLite copy and sync queue for offline work.
- Preserve the existing Electron `appId` and `productName`; changing them changes the desktop data directory.

## Desktop releases and mobile

- Every push to `main` runs the Windows release workflow. It tests and builds the app, increments the desktop patch version, and publishes a Windows installer and update metadata to GitHub Releases using the repository's `GITHUB_TOKEN`.
- Installed Windows apps check for releases, download updates in the background, and install them when RestaurantOS closes. The normal shutdown path creates an on-close database backup. Users can also choose the in-app restart action after an update is downloaded.
- Android/Google Play distribution is not configured yet. The current offline POS and durable sync queue are Electron/SQLite-specific and are not available in the web app; Android needs its own native local-storage and synchronization implementation before it can safely support offline orders. Play Console listing and signing setup also require the publisher's account.
