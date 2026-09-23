import { useEffect, useRef, useState } from 'react';
import { api, ApiFailure, isDemo } from './api';
import type { Analog, Cart, ChatResponse, Product, Proposal } from './types';

type Message = { id: string; kind: 'user'; text: string } | { id: string; kind: 'assistant'; data: ChatResponse };
type Pending = { proposal: Proposal; products: Product[]; key: string; error?: string; errorCode?: string; available?: number };

const demo = isDemo();
const examples = demo
  ? ['Есть ли DEMO-LED-12?', 'Покажи DEMO-LED-OLD', 'Какая оплата, доставка и минимальная партия?']
  : ['Какая оплата, доставка и минимальная партия?', 'Как узнать наличие по артикулу?', 'Помогите подобрать аналог'];

function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; }
  catch { return null; }
}

function ProductCard({ product }: { product: Product }) {
  const certificate = safeExternalUrl(product.certificateUrl);
  const stock = product.stock;
  return <article className="product-card">
    <div className="card-top"><span className="eyebrow">Артикул {product.sku}</span><span className={`status ${stock.status}`}>
      {stock.status === 'in_stock' ? (stock.available === null ? 'Остаток уточняется' : `В наличии: ${stock.available} шт.`) : stock.status === 'out_of_stock' ? 'Нет в наличии' : 'Остаток неизвестен'}
    </span></div>
    <h3>{product.name}</h3>
    {product.source === 'catalog_demo' && <span className="demo-chip">Демонстрационные данные</span>}
    {Object.keys(product.characteristics || {}).length > 0 && <dl className="specs">{Object.entries(product.characteristics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
    <div className="card-footer">
      {product.price && <strong>{product.price.amount} {product.price.currency}</strong>}
      {certificate && <a href={certificate} target="_blank" rel="noopener noreferrer">Сертификат ↗ <span className="sr-only">Откроется в новой вкладке</span></a>}
    </div>
  </article>;
}

function AnalogCard({ analog, onChoose }: { analog: Analog; onChoose: (sku: string) => void }) {
  return <div className="analog-card">
    <div className="eyebrow">Возможный аналог</div>
    <ProductCard product={analog.product} />
    <p><strong>Почему подходит:</strong> {analog.reason}</p>
    {analog.matchedCharacteristics?.length > 0 && <p className="muted">Совпадают: {analog.matchedCharacteristics.join(', ')}</p>}
    <button type="button" className="secondary small" onClick={() => onChoose(analog.product.sku)}>Подготовить предложение</button>
  </div>;
}

function ProposalCard({ pending, busy, onConfirm, onRetry }: { pending: Pending; busy: boolean; onConfirm: () => void; onRetry: (message: string) => void }) {
  const found = pending.proposal.items.map((item) => ({ item, product: pending.products.find((p) => p.id === item.productId) }));
  const unverifiable = found.some(({ item, product }) => !product || product.stock.available === null || product.stock.available < item.quantity);
  const expired = Number.isFinite(Date.parse(pending.proposal.expiresAt)) && Date.parse(pending.proposal.expiresAt) <= Date.now();
  return <section className="proposal-card" aria-label="Предложение для корзины">
    <div className="proposal-head"><span className="eyebrow">Шаг 1 из 2</span><h3>Проверьте предложение</h3></div>
    <ul>{found.map(({ item, product }) => <li key={item.productId}><span>{product?.name || `ID ${item.productId}`}</span><strong>{item.quantity} шт.</strong></li>)}</ul>
    <p className="proposal-note">Корзина пока не изменена. После подтверждения сервер повторно проверит остаток.</p>
    {unverifiable && <p className="inline-error">Недостаточно проверенных данных об остатке для подтверждения. Подготовьте другое количество.</p>}
    {expired && <p className="inline-error">Срок предложения истёк. Подготовьте новое.</p>}
    {pending.error && <p role="alert" className="inline-error">{pending.error}</p>}
    {pending.available !== undefined && pending.available > 0 && found[0]?.product && <button type="button" className="secondary small" onClick={() => onRetry(`Добавь ${pending.available} шт. ${found[0].product!.sku}`)}>Подготовить {pending.available} шт. для нового подтверждения</button>}
    <button type="button" className="primary confirm" disabled={busy || unverifiable || expired || Boolean(pending.error && pending.errorCode !== 'NETWORK' && pending.errorCode !== 'TIMEOUT')} onClick={onConfirm}>{busy ? 'Проверяем остаток…' : pending.error ? 'Повторить подтверждение' : 'Подтвердить и добавить'}</button>
  </section>;
}

function CartPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = () => { setLoading(true); setError(''); api.cart().then(setCart).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Не удалось открыть корзину.')).finally(() => setLoading(false)); };
  useEffect(refresh, []);
  return <div className="page-shell"><header className="topbar"><a className="brand" href="/">ЭКТ <span>ассистент</span></a><span className="header-note">Прототип консультанта</span></header>
    <main className="cart-page"><a className="back-link" href="/">← Вернуться к чату</a><div className="section-heading"><span className="eyebrow">Текущая сессия</span><h1>Корзина прототипа</h1><p>Это демонстрационная корзина приложения, не корзина сайта ekt.kz.</p></div>
      {loading && <p role="status">Загружаем корзину…</p>}
      {error && <div className="error-panel" role="alert">{error}<button type="button" className="secondary small" onClick={refresh}>Повторить</button></div>}
      {!loading && cart && (cart.items.length ? <div className="cart-list">{cart.items.map((item) => <div className="cart-row" key={item.productId}><div><strong>{item.name}</strong><span>Артикул {item.sku}</span></div><b>{item.quantity} шт.</b></div>)}<div className="cart-total">Всего товаров <strong>{cart.itemCount} шт.</strong></div></div> : <div className="empty-cart"><span aria-hidden="true">□</span><h2>Здесь пока пусто</h2><p>Сначала подготовьте предложение в чате, затем подтвердите добавление.</p><a className="primary link-button" href="/">Перейти к чату</a></div>)}
    </main></div>;
}

function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [cartCount, setCartCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [success, setSuccess] = useState<Cart | null>(null);
  const confirmLock = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api.cart().then((cart) => setCartCount(cart.itemCount)).catch(() => {}); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, pending, success, error]);

  async function send(value = input) {
    const message = value.trim();
    if (!message || busy || confirming) return;
    setBusy(true); setInput(''); setError(''); setSuccess(null);
    setMessages((current) => [...current, { id: crypto.randomUUID(), kind: 'user', text: message }]);
    try {
      const data = await api.chat(message);
      setMessages((current) => [...current, { id: crypto.randomUUID(), kind: 'assistant', data }]);
      if (data.proposal) setPending({ proposal: data.proposal, products: [...(data.products || []), ...(data.analogs || []).map((a) => a.product)], key: crypto.randomUUID() });
      else setPending(null);
      if (data.cartChanged && data.cart) { setCartCount(data.cart.itemCount); setSuccess(data.cart); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось получить ответ. Повторите запрос.');
      setInput(message);
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (!pending || confirmLock.current || confirming) return;
    confirmLock.current = true; setConfirming(true); setError('');
    try {
      const result = await api.confirm(pending.proposal.id, pending.key);
      setCartCount(result.cart.itemCount); setSuccess(result.cart); setPending(null);
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : new ApiFailure('Не удалось подтвердить. Попробуйте ещё раз.', 'UNKNOWN');
      setPending((current) => current ? { ...current, error: failure.message, errorCode: failure.code, available: failure.available } : current);
    } finally { setConfirming(false); confirmLock.current = false; }
  }

  return <div className="page-shell"><header className="topbar"><a className="brand" href="/">ЭКТ <span>ассистент</span></a><div className="top-actions"><span className="header-note">Подбор электротоваров</span><a className="cart-link" href="/cart">Корзина {cartCount !== null && <span>{cartCount}</span>}</a></div></header>
    <main className="chat-layout"><section className="chat-panel" aria-label="Диалог с консультантом">
      <div className="chat-heading"><div><span className="eyebrow">Консультант · прототип</span><h1>Найдём подходящий товар</h1><p>Проверьте артикул, сравните аналоги и подтвердите корзину только после проверки.</p></div><span className="online-dot" aria-label="Чат доступен" /></div>
      {demo && <div className="demo-banner" role="note"><strong>Демонстрационные данные</strong><span>Товары и остатки ниже синтетические. Корзина не связана с ekt.kz.</span></div>}
      <div className="conversation" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && <div className="welcome"><div className="welcome-symbol" aria-hidden="true">◇</div><h2>Что хотите найти?</h2><p>Спросите о товаре по артикулу или об условиях покупки.</p><div className="prompts">{examples.map((example) => <button type="button" key={example} onClick={() => { setInput(example); void send(example); }}>{example}<span aria-hidden="true">↗</span></button>)}</div></div>}
        {messages.map((message) => message.kind === 'user' ? <div className="message user-message" key={message.id}><span className="message-label">Вы</span><p>{message.text}</p></div> : <div className="message assistant-message" key={message.id}><span className="message-label">Консультант</span><p>{message.data.reply}</p>{message.data.factsSource === 'catalog_demo' && (message.data.products?.length > 0 || message.data.analogs?.length > 0) && <span className="source-note">Источник: синтетический каталог</span>}{message.data.factsSource === 'catalog_live' && message.data.products?.length > 0 && <span className="source-note">Источник: каталог партнёра</span>}{message.data.factsSource === 'partner_policy' && <span className="source-note">Источник: публичные условия{message.data.checkedAt ? ` · проверено ${message.data.checkedAt}` : ''}{safeExternalUrl(message.data.sourceUrl) && <> · <a href={safeExternalUrl(message.data.sourceUrl)!} target="_blank" rel="noopener noreferrer">открыть страницу ↗</a></>}</span>}{message.data.products?.length > 0 && <div className="result-grid">{message.data.products.map((product) => <ProductCard key={product.id} product={product} />)}</div>}{message.data.analogs?.length > 0 && <div className="result-grid">{message.data.analogs.map((analog) => <AnalogCard key={analog.product.id} analog={analog} onChoose={(sku) => void send(`Добавь 1 шт. ${sku}`)} />)}</div>}</div>)}
        {busy && <div className="message assistant-message loading" role="status"><span className="message-label">Консультант</span><p>Проверяем запрос…</p></div>}
        {pending && <ProposalCard pending={pending} busy={confirming} onConfirm={() => void confirm()} onRetry={(message) => void send(message)} />}
        {success && <div className="success-panel" role="status"><strong>Добавлено после подтверждения</strong><p>В корзине сейчас {success.itemCount} шт. Проверьте актуальный состав на отдельной странице.</p><a className="primary link-button" href="/cart">Открыть корзину →</a></div>}
        {error && <div className="error-panel" role="alert">{error}<button type="button" className="secondary small" onClick={() => void send()}>Повторить запрос</button></div>}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><label htmlFor="question" className="sr-only">Ваш вопрос о товаре</label><input id="question" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Артикул или вопрос о покупке…" maxLength={500} autoComplete="off" /><button className="primary" type="submit" disabled={!input.trim() || busy || confirming}>{busy ? 'Отправляем…' : 'Отправить'}<span aria-hidden="true">↗</span></button></form>
      <p className="composer-footnote">Не отправляйте платёжные данные в чат. Все добавления требуют отдельного подтверждения.</p>
    </section><aside className="side-panel"><span className="eyebrow">Как это работает</span><h2>Выбор под контролем</h2><ol><li><b>01</b><span>Найдите товар и проверьте факты в карточке.</span></li><li><b>02</b><span>Сравните предложенный аналог и причину совместимости.</span></li><li><b>03</b><span>Подтвердите количество отдельной кнопкой.</span></li></ol><div className="aside-note">Корзина прототипа хранится в сессии этого приложения.</div></aside></main>
  </div>;
}

export function App() { return window.location.pathname === '/cart' ? <CartPage /> : <ChatPage />; }
