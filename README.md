# StockFlow MVP

A small multi-tenant inventory management app built with Node.js, Express, SQLite, EJS and plain CSS. It is intentionally scoped to the supplied six-hour MVP PRD.

## Features
- Email/password signup and login (passwords hashed with bcryptjs)
- One organization created per account
- Organization-scoped product CRUD and SKU uniqueness
- Product search by name or SKU
- Quantity, cost price, selling price, optional product-level low-stock threshold
- Dashboard totals and low-stock list
- Organization-level default low-stock threshold
- SQLite-backed sessions and database persistence
- Responsive desktop-first interface

## Requirements
- Node.js 20+
- npm

## Run locally
```bash
npm install
cp .env.example .env
# Set SESSION_SECRET in .env to a long random value
npm run dev
```
Open http://localhost:3000 and create an account. The SQLite database is created automatically in `data/`.

## Production deployment
This is a standard Node web service. Deploy to Render, Railway, Fly.io, or another Node host that supports a persistent disk/volume. Set:
- `NODE_ENV=production`
- `SESSION_SECRET` to a strong random secret
- `PORT` is normally provided by the host

Mount a persistent disk at the app's `data/` directory. Both the inventory database and session database are stored there; without persistent storage, data may be lost on redeploy/restart. Use HTTPS in production. For a public production SaaS, add CSRF protection, rate limiting, email verification/password reset, automated backups, migrations, and stronger operational monitoring before real customer use.

## GitHub submission
```bash
git init
git add .
git commit -m "chore: initialize StockFlow MVP"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/stockflow-mvp.git
git push -u origin main
```
Continue making focused commits as features are completed. Keep `.env`, database files, and `node_modules` out of Git.

## Tenant isolation
Every product read, update, and delete query includes the authenticated user's `organization_id`. SKU uniqueness is enforced by a composite database constraint `(organization_id, sku)`. Signup creates the organization and user in one database transaction. The MVP assumes one user per organization as specified.

## Notes / limitations
- No password reset, email verification, invites, roles, stock movement history, imports, integrations, billing, or warehouse support.
- Product deletion is hard delete, permitted by the PRD.
- SQLite is appropriate for a demo/small internal MVP. For multi-instance production SaaS, use PostgreSQL and a managed session store.
