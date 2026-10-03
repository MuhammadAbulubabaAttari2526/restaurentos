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

Set `VITE_USE_FIREBASE_EMULATORS=true` in `.env.local`, provide syntactically valid Firebase web configuration, and run `npm run dev` in another terminal.

## Build And Deploy

```sh
npm run build
npx firebase-tools deploy --only firestore:rules,firestore:indexes,hosting --project restaurentos-846
```

The live project is `restaurentos-846`; its Hosting URL is <https://restaurentos-846.web.app>.
