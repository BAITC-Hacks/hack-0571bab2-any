# HackAlem API

Node.js 20+ / Fastify. The default mode uses a fully synthetic catalog. The cart is an in-memory **prototype cart**, not an ekt.kz cart or order.

## Run

From `apps/api`:

```sh
npm ci
npm run dev
```

The API listens on `http://127.0.0.1:3001` by default. `npm run build` compiles to `dist/`; `npm start` runs the compiled server. `npm test` exercises the contract scenarios without credentials or network calls. For the Vite web app, start the API with `WEB_ORIGIN=http://localhost:5173 npm run dev` and open that exact browser host. Use `WEB_ORIGIN=http://127.0.0.1:5173` if that is the host you open instead.

No `.env` is needed for demo mode. For approved live catalog reads, copy `.env.example` to the ignored local `.env` file and set `CATALOG_MODE=live`, the catalog URL, and its Basic Auth fields locally. The app loads `.env` without printing values. Live mode only permits the supplied ekt.kz host over HTTPS; no catalog or cart write call exists.

## Browser integration

Use a same-origin development proxy from the web app: browser `/api/*` to `http://127.0.0.1:3001/api/*`. The browser should stay on one host (for example `localhost:5173`) for chat and `/cart`. Set `WEB_ORIGIN` to that exact browser origin. A direct cross-origin browser request is not supported; no CORS credentials are enabled. On HTTPS deployments, set `API_ORIGIN`, `WEB_ORIGIN`, and `COOKIE_SECURE=true` for the actual origins and serve the API behind the same site.

1. `GET /api/cart` creates the server session and returns `csrfToken`, `items`, `itemCount`, `cartUrl`, and `mode: "demo"`. Wait for this response before the first POST. The session cookie is `HttpOnly; SameSite=Lax` and gains `Secure` when the public API origin is HTTPS or the process runs in production.
2. For each `POST /api/chat`, send JSON `{ "message": "Добавь 2 ABC-123", "locale": "ru" }`, the returned token in `X-CSRF-Token`, and browser credentials. The browser supplies `Origin` automatically. The first add request returns `proposal` and `cartChanged: false`.
3. Show the proposed item and quantity. Only a separate user action calls `POST /api/cart/confirm` with `{ "proposalId": "...", "idempotencyKey": "<fresh random UUID>" }` and the same headers. Reuse the same key only when retrying that confirmation. A text message exactly confirming the current proposal also uses the same server-side confirmation checks.
4. `GET /api/cart` and `/cart` show that session's current cart. The API includes a minimal `/cart` fallback page until the web app owns the route.

Demo SKUs: `ABC-123` (4 in stock), `ABC-000` (out of stock), and `ABC-124` (available candidate matching the four known critical fields of `ABC-000`). Prices and certificate URLs are absent from the demo data. The chat says so explicitly; it never fabricates a certificate or amount. `GET /api/health` exposes only mode and fallback status.

## Limits

- Public payment/delivery terms are summarized from `docs/BUYING_TERMS_SOURCES.md` with source URL and check date. Minimum purchase quantity and the disputed free-delivery threshold are unconfirmed. Recheck the partner page before a public demonstration.
- Live SKU search is intentionally bounded to five list pages and six seconds because no documented exact-search endpoint was supplied. An incomplete search returns an error instead of a false absence claim. A live compatible analog may be unavailable when the partner response lacks a confirmed category or critical properties.
- Live prices and certificate URLs stay unknown until their units and source fields are verified. The case's certificate-link demonstration therefore remains open.
- Sessions and carts live in one process and disappear on restart. A persistent store and multi-instance coordination are required before deployment. The current cart has no ekt.kz write integration.
- New sessions are limited to 120 per transport IP and 300 globally per minute. Existing sessions remain usable during that limit; when 5,000 sessions are stored, an expired or empty-cart session is removed before accepting a newcomer. A live catalog adapter permits at most eight concurrent operations and 60 operations per minute per process; excess reads return `429 CATALOG_BUSY` without changing the cart. These process-local limits supplement, but do not replace, an edge rate limit for public exposure. Behind a shared reverse proxy, many visitors may share one transport IP; configure and test the proxy and edge limits before a public launch.
- `POST /api/attachments` accepts one PDF, DOCX, XLSX, or JPEG up to 2 MB with the same session/CSRF rules. It validates only extension, MIME and file signature; it does not parse text, tables, or images yet and always returns an empty candidate list with a manual-entry warning. It never changes the cart. A generative model is not connected. No partner catalog or user data are sent to OpenAI/NVIDIA.
