# HackAlem API

Node.js 20.16+ / Fastify. The default mode uses a fully synthetic catalog. The cart is an in-memory **prototype cart**, not an ekt.kz cart or order.

## Run

From `apps/api`:

```sh
npm ci
npm run dev
```

The API listens on `http://127.0.0.1:3001` by default. `npm run build` compiles to `dist/`; `npm start` runs the compiled server. `npm test` exercises the contract scenarios without credentials or network calls. For the Vite web app, start the API with `WEB_ORIGIN=http://localhost:5173 npm run dev` and open that exact browser host. Use `WEB_ORIGIN=http://127.0.0.1:5173` if that is the host you open instead.

No `.env` is needed for demo mode. For approved live catalog reads, copy `.env.example` to the ignored local `.env` file and set `CATALOG_MODE=live`, the catalog URL, and its Basic Auth fields locally. The app loads `.env` without printing values. Live mode only permits the supplied ekt.kz host over HTTPS; no catalog or cart write call exists. Never put credentials in the browser or commit the local file.

For an authorized, bounded catalog sync, run this from `apps/api` after entering live credentials locally:

```sh
npx tsx src/catalogSync.ts --authorized --max-pages=80
```

The read-only sync requests at most two pages at once, 200 list rows per page, and saves a private, Git-ignored snapshot at `apps/api/.local/catalog-index.json` after each two-page batch. It can resume. The partner API has been observed to repeat the first page after the last page, so the snapshot records `stalledAtPage` rather than claiming complete coverage. In one local authorized run it indexed 15,037 distinct rows and stopped at page 77. The snapshot is only a search locator; every displayed stock, property, and certificate field comes from a fresh detail request.

To enable bounded OpenAI assistance, set `AI_PROVIDER=openai`, `EXTERNAL_AI_ALLOWED=true`, and a local `OPENAI_API_KEY`. Known SKU, terms, and cart paths use deterministic code. Ambiguous searches use `gpt-6-luna`, multi-category questions use `gpt-6-sol`, and whole-house projects use `gpt-6-astra` to rank a few current catalog candidates. Photo analysis starts with Sol and escalates once to Astra when no catalog match is found. Model output cannot remove verified candidates. The returned user-facing product facts are rendered from those verified details, not model prose. Missing or failed model calls fall back to code. The gateway caps calls at 8 per session, 30 per minute, 2 concurrently, and 100 per process lifetime. A caller can rotate anonymous sessions and consume the process budget, so public deployment needs a trusted-user/edge rate gate and durable account-level spending budget. Restarting resets process-local budgets. The optional NVIDIA key is not required or called by this prototype.

## Browser integration

Use a same-origin development proxy from the web app: browser `/api/*` to `http://127.0.0.1:3001/api/*`. The browser should stay on one host (for example `localhost:5173`) for chat and `/cart`. Set `WEB_ORIGIN` to that exact browser origin. A direct cross-origin browser request is not supported; no CORS credentials are enabled. On HTTPS deployments, set `API_ORIGIN`, `WEB_ORIGIN`, and `COOKIE_SECURE=true` for the actual origins and serve the API behind the same site.

1. `GET /api/cart` creates the server session and returns `csrfToken`, `items`, `itemCount`, `cartUrl`, and `mode: "demo"`. Wait for this response before the first POST. The session cookie `ha_sid` is `HttpOnly; SameSite=Lax`; a separate readable `csrf_token` cookie mirrors the JSON token for the current web client. Both gain `Secure` when the public API origin is HTTPS or the process runs in production.
2. For each `POST /api/chat`, send JSON `{ "message": "Добавь 2 ABC-123", "locale": "ru" }`, the CSRF token in `X-CSRF-Token`, and browser credentials. The browser supplies `Origin` automatically. `locale: "kk"` also gives Kazakh API replies; the current web UI sends Russian. The first add request returns `proposal` and `cartChanged: false`.
3. Show the proposed item and quantity. Only a separate user action calls `POST /api/cart/confirm` with `{ "proposalId": "...", "idempotencyKey": "<fresh random UUID>" }` and the same headers. Reuse the same key only when retrying that confirmation. A text message exactly confirming the current proposal also uses the same server-side confirmation checks.
4. `GET /api/cart` and `/cart` show that session's current cart. The API includes a minimal `/cart` fallback page until the web app owns the route.

Demo SKUs: `ABC-123` (4 in stock), `ABC-000` (out of stock), and `ABC-124` (available candidate matching the four known critical fields of `ABC-000`). Prices and certificate URLs are absent from the demo data. The chat says so explicitly; it never fabricates a certificate or amount. `GET /api/health` exposes only catalog mode and whether an AI gateway is configured; `ready` does not prove upstream availability.

## Limits

- Public payment/delivery terms are summarized from `docs/BUYING_TERMS_SOURCES.md` with source URL and check date. Minimum purchase quantity and the disputed free-delivery threshold are unconfirmed. Recheck the partner page before a public demonstration.
- Indexed live SKU lookup uses the local list snapshot only to locate an ID, then rereads its current detail. If an SKU is absent from the partial snapshot, the live fallback searches at most five list pages and six seconds because no documented exact-search endpoint was supplied. An incomplete search returns an error instead of a false absence claim. A live compatible analog may be unavailable when the partner response lacks a confirmed category or critical properties.
- Live prices and certificate URLs stay unknown until their units and source fields are verified. The case's certificate-link demonstration therefore remains open.
- Sessions and carts live in one process and disappear on restart. A persistent store and multi-instance coordination are required before deployment. The current cart has no ekt.kz write integration.
- For `409 INSUFFICIENT_STOCK`, the available quantity is returned as `error.available` and as a top-level `available` alias for the current web client. A browser holding cookies from a restarted API needs a fresh `GET /api/cart` before its next POST; the frontend should handle this automatically before final integration.
- New sessions are limited to 120 per transport IP and 300 globally per minute. Existing sessions remain usable during that limit; when 5,000 sessions are stored, an expired or empty-cart session is removed before accepting a newcomer. A live catalog adapter permits at most eight concurrent operations and 60 operations per minute per process; excess reads return `429 CATALOG_BUSY` without changing the cart. These process-local limits supplement, but do not replace, an edge rate limit for public exposure. Behind a shared reverse proxy, many visitors may share one transport IP; configure and test the proxy and edge limits before a public launch.
- `POST /api/attachments` accepts one PDF, DOCX, XLSX, JPEG, or PNG up to 2 MiB with the same session/CSRF rules. Text PDFs and DOCX/XLSX tables are parsed locally with page, row, cell, decompression, and time limits. Only explicit SKU plus quantity pairs become `candidates`; up to four are reread from current catalog detail and returned as `products`. Scanned PDFs need manual entry. No document content goes to an external model and no attachment changes the cart. The browser must send `X-Photo-Consent: true` after the customer explicitly opts into external photo analysis; the server must also have `EXTERNAL_AI_ALLOWED=true`. Without both gates, photo bytes are not decoded or sent externally. Consented JPEG/PNG files are fully decoded and re-encoded with metadata removed. Send optional `X-Image-Locale: kk` for Kazakh photo replies. A consented photo is analyzed by Sol first. When it has no exact SKU match, Astra may make one stronger visual call within the same budgets. All observations remain unverified until a fresh catalog detail matches. Any upload cancels a pending cart proposal. At most four attachments are admitted concurrently, with two image and two document jobs at once; each session may submit eight attachments per minute and the process 120 per minute.
- The assistant retains at most six recent product IDs and categories per session to resolve follow-up questions and comparisons. It rereads current details, answers known-item questions by rules, and skips a model when two products are visibly from different categories. It does not send raw conversation history to a model. An unverified price is stated as unknown.

## Work in progress

The partner list shape does not guarantee category data, so category filtering is based only on rows that actually supply it. Natural-language candidate matching remains approximate and limited to a few fresh detail reads. The live catalog has no confirmed certificate URL, price currency/scale, or real cart API; these remain unconfirmed rather than inferred. Whole-house requests return a small verified candidate set and ask for the necessary project details; this is not a completed electrical design.
