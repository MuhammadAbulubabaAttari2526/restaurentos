# MongoDB Atlas setup

MongoDB Shell (`mongosh`), Compass, and the RestaurantOS Node server can inspect the same Atlas cluster and database.

## Atlas access

1. Create a database user with read and write access to the `restaurantos` database.
2. Add the development computer or deployed API host's outbound IP to Atlas **Network Access**.
3. Copy the URI from the cluster's **Connect → Drivers** flow. Replace the password placeholder and URL-encode reserved characters.

Keep the Atlas access list restricted. Do not use `0.0.0.0/0` for a production database.

## Shell

Use Atlas's generated command or run `mongosh` with the same URI configured for the app:

```powershell
mongosh "mongodb+srv://<database-user>:<encoded-password>@<cluster-host>/restaurantos?retryWrites=true&w=majority"
```

Then:

```javascript
db.getName()
show collections
```

RestaurantOS records are in `restaurantDocuments`. Filter to one restaurant's orders with:

```javascript
db.restaurantDocuments.find({ collectionPath: "restaurants/<restaurant-id>/orders" })
```

Accounts are in `authUsers`; `authSessions` stores hashes of active session tokens, not the original tokens.

## Compass

1. Install MongoDB Compass.
2. Create a new connection and paste the Atlas URI.
3. Select the `restaurantos` database and open `restaurantDocuments`, `authUsers`, or `authSessions`.

## RestaurantOS server

For local development, put these values in the ignored `functions/.secret.local` file:

```text
MONGODB_URI=<your Atlas URI>
MONGODB_DB=restaurantos
```

Run `npm run dev`; the Node API reads that file and serves `/api/health` for a database connection check. In production, configure `MONGODB_URI` and `MONGODB_DB` as server-side environment secrets. The Node host must be reachable by app clients and its outbound IP must be on the Atlas access list. Firebase Hosting and Functions are not part of the active app deployment.

`VITE_API_BASE_URL` is only the public API origin used by packaged Electron clients. Never put MongoDB credentials in a `VITE_*` variable.

## One-time Firestore import

The old Firestore importer remains available only to copy existing data. It does not run as part of the app. Authenticate the import machine, run its dry-run, and apply only after reviewing the source and destination counts:

```powershell
gcloud auth application-default login
npm --prefix functions run migrate:firestore -- --project <old-project-id>
npm --prefix functions run migrate:firestore -- --project <old-project-id> --apply
```

Keep the source read-only during import. Use `--apply --resume` if a started import is interrupted. Firebase passwords cannot be exported; create new account passwords with the trusted provisioning commands documented in the project README.
