# HackAlem API

Node.js 20+ / Fastify. The default mode uses a fully synthetic catalog. The cart is an in-memory **prototype cart**, not an ekt.kz cart or order.

## Run

From `apps/api`:

```sh
npm ci
npm run dev
```

The API listens on `http://127.0.0.1:3001` by default. `npm run build` compiles to `dist/`; `npm start` runs the compiled server. `npm test` exercises the contract scenarios without credentials or network calls.

No `.env` is needed for demo mode. For approved live catalog reads, copy `.env.example` to the ignored local `.env` file and set `CATALOG_MODE=live`, the catalog URL, and its Basic Auth fields locally. The app loads `.env` without printing values. Live mode only permits the supplied ekt.kz host over HTTPS; no catalog or cart write call exists.

## Browser integration

Use a same-origin development proxy from the web app: browser `/api/*` to `http://127.0.0.1:3001/api/*`. The browser should stay on one host (for example `localhost:5173`) for chat and `/cart`. Set `WEB_ORIGIN` to that exact browser origin. A direct cross-origin browser request is not supported; no CORS credentials are enabled. On HTTPS deployments, set `API_ORIGIN`, `WEB_ORIGIN`, and `COOKIE_SECURE=true` for the actual origins and serve the API behind the same site.

1. `GET /api/cart` creates the server session and returns `csrfToken`, `items`, `itemCount`, `cartUrl`, and `mode: "demo"`. The session cookie is `HttpOnly; SameSite=Lax` and gains `Secure` on HTTPS.
2. For each `POST /api/chat`, send JSON `{ "message": "Добавь 2 ABC-123", "locale": "ru" }`, the returned token in `X-CSRF-Token`, and browser credentials. The browser supplies `Origin` automatically. The first add request returns `proposal` and `cartChanged: false`.
3. Show the proposed item and quantity. Only a separate user action calls `POST /api/cart/confirm` with `{ "proposalId": "...", "idempotencyKey": "<fresh random UUID>" }` and the same headers. Reuse the same key only when retrying that confirmation. A text message exactly confirming the current proposal also uses the same server-side confirmation checks.
4. `GET /api/cart` and `/cart` show that session's current cart. The API includes a minimal `/cart` fallback page until the web app owns the route.

Demo SKUs: `ABC-123` (4 in stock), `ABC-000` (out of stock), and `ABC-124` (available candidate matching the four known critical fields of `ABC-000`). Prices and certificate URLs are absent from the demo data. The chat says so explicitly; it never fabricates a certificate or amount. `GET /api/health` exposes only mode and fallback status.

## Limits

- Public payment/delivery terms are summarized from `docs/BUYING_TERMS_SOURCES.md` with source URL and check date. Minimum purchase quantity and the disputed free-delivery threshold are unconfirmed. Recheck the partner page before a public demonstration.
- Live SKU search is intentionally bounded to five list pages and six seconds because no documented exact-search endpoint was supplied. An incomplete search returns an error instead of a false absence claim. A live compatible analog may be unavailable when the partner response lacks a confirmed category or critical properties.
- Live prices and certificate URLs stay unknown until their units and source fields are verified. The case's certificate-link demonstration therefore remains open.
- Sessions and carts live in one process and disappear on restart. A persistent store and multi-instance coordination are required before deployment. The current cart has no ekt.kz write integration.
- File attachments and a generative model are not connected yet. No partner catalog or user data are sent to OpenAI/NVIDIA.
