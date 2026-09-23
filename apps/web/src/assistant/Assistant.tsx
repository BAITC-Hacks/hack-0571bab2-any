import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, ChevronRight, Database, FileText, Maximize2, Minimize2, Paperclip, PanelRight, Search, Send, ShieldCheck, ShoppingCart, Sparkles, Truck, X } from 'lucide-react';
import { api, publishCart } from '../api';
import { ApiFailure } from '../errors';
import type { AttachmentResponse, ChatResponse, Locale, Product, Proposal } from '../types';
import { errorText, readLocale, strings } from './i18n';
import { ProductCard, Quantity, safeLink } from './Cards';
import { AttachmentReview, initialRows, type CandidateReviewRow } from './AttachmentReview';

export type WidgetMode = 'quick' | 'panel' | 'full';
type Line = { id: string; role: 'user' | 'assistant'; text: string; response?: ChatResponse; attachment?: AttachmentResponse; cartUrl?: string; locale: Locale };
type Pending = { proposal: Proposal; products: Product[]; key: string };
type Retry = { kind: 'chat'; message: string; locale: Locale } | { kind: 'file'; file: File; consent: boolean; locale: Locale } | { kind: 'confirm' };
const historyKey = 'ekt_assistant_history_v2';
function loadHistory(): Line[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(historyKey) || 'null');
    return saved?.at > Date.now() - 30 * 60_000 && Array.isArray(saved.lines) ? saved.lines.slice(-40) : [];
  } catch { return []; }
}

export function Assistant({ initialLocale }: { initialLocale?: Locale }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<WidgetMode>('quick');
  const [locale, setLocale] = useState<Locale>(initialLocale || readLocale);
  const [lines, setLines] = useState<Line[]>(loadHistory);
  const [reviewRows, setReviewRows] = useState<Record<string, CandidateReviewRow[]>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'chat' | 'file' | 'confirm' | null>(null);
  const busyRef = useRef(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState<Retry | null>(null);
  const [source, setSource] = useState<'live' | 'demo' | 'unavailable' | 'checking'>('checking');
  const [pending, setPending] = useState<Pending | null>(null);
  const [proposalQuantity, setProposalQuantity] = useState(1);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [clock, setClock] = useState(Date.now());
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [fileError, setFileError] = useState(false);
  const [wide, setWide] = useState(() => matchMedia('(min-width: 900px)').matches);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const t = strings(locale);
  const full = mode === 'full' && wide;
  const lastResult = [...lines].reverse().find(line => line.response?.products.length || line.response?.analogs.length || line.attachment);
  const uncertain = retry?.kind === 'confirm' && (!(error instanceof ApiFailure) || ['TIMEOUT', 'NETWORK', 'INVALID_RESPONSE'].includes(error.code) || (error.status ?? Number(error.code)) >= 500);
  const disabled = Boolean(busy) || uncertain;
  const expired = pending ? Date.parse(pending.proposal.expiresAt) <= clock : false;
  const proposalChanged = pending ? pending.proposal.items[0]?.quantity !== proposalQuantity : false;

  useEffect(() => {
    api.health().then(result => setSource(result.catalog)).catch(() => setSource('unavailable'));
    api.cart().catch(() => {});
    const media = matchMedia('(min-width: 900px)');
    const resize = () => setWide(media.matches); media.addEventListener('change', resize);
    const show = () => { setOpen(true); };
    window.addEventListener('open-assistant', show);
    return () => { media.removeEventListener('change', resize); window.removeEventListener('open-assistant', show); };
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem('ekt_locale', locale); } catch { /* Private browsing may disable storage. */ }
    window.dispatchEvent(new CustomEvent('ekt-locale', { detail: locale }));
  }, [locale]);
  useEffect(() => {
    // Never persist proposals, CSRF tokens or file bytes. Restored cards require a fresh proposal.
    const safeLines = lines.slice(-40).map(line => ({ ...line, response: line.response ? { ...line.response, proposal: null, cart: undefined } : undefined }));
    try { sessionStorage.setItem(historyKey, JSON.stringify({ at: Date.now(), lines: safeLines })); } catch { /* Storage is optional. */ }
  }, [lines]);
  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 3500);
    return () => clearTimeout(timer);
  }, [busy]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (!open) return;
    const root = launcherRef.current?.getRootNode() as ShadowRoot | undefined;
    returnFocus.current = (root?.activeElement || document.activeElement) as HTMLElement | null;
    // Opening never summons a mobile keyboard over the welcome screen.
    panelRef.current?.focus();
    return () => { (returnFocus.current?.isConnected ? returnFocus.current : launcherRef.current)?.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const locked = mode === 'full' || !matchMedia('(min-width: 641px)').matches;
    const old = document.body.style.overflow;
    if (locked) document.body.style.overflow = 'hidden';
    const viewport = () => {
      panelRef.current?.style.setProperty('--viewport-height', `${window.visualViewport?.height || innerHeight}px`);
      panelRef.current?.style.setProperty('--viewport-bottom', `${Math.max(0, innerHeight - (visualViewport?.height || innerHeight) - (visualViewport?.offsetTop || 0))}px`);
    };
    viewport(); visualViewport?.addEventListener('resize', viewport); visualViewport?.addEventListener('scroll', viewport);
    return () => { if (locked) document.body.style.overflow = old; visualViewport?.removeEventListener('resize', viewport); visualViewport?.removeEventListener('scroll', viewport); };
  }, [open, mode]);
  useEffect(() => { if (open && lines.length) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' }); }, [lines, busy, pending, open, mode]);

  function start(kind: NonNullable<typeof busy>) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(kind); setError(null); setRetry(null); return true;
  }
  function finish() { busyRef.current = false; setBusy(null); }
  function addLine(line: Omit<Line, 'id'>) { setLines(old => [...old.slice(-39), { ...line, id: crypto.randomUUID() }]); }
  function acceptResponse(response: ChatResponse, language: Locale) {
    setSource(response.factsSource === 'catalog_demo' ? 'demo' : response.factsSource === 'catalog_live' ? 'live' : source);
    addLine({ role: 'assistant', text: response.reply, response, locale: language, cartUrl: response.cartChanged ? response.cartUrl : undefined });
    if (response.proposal) {
      setPending({ proposal: response.proposal, products: [...response.products, ...response.analogs.map(a => a.product)], key: crypto.randomUUID() });
      setProposalQuantity(response.proposal.items[0]?.quantity || 1); setClock(Date.now());
    }
    if (response.cartChanged && response.cart) { publishCart(response.cart); api.cart().catch(() => {}); }
  }
  async function send(message: string, language = locale, repeat = false) {
    if (!message.trim() || message.length > 2000 || uncertain) return;
    const explicit = /^\s*(?:да[,\s]+добавь|да[,\s]+подтверждаю|подтверждаю|согласен[,\s]+добавь|иә[,\s]+қос)\s*[.!]?\s*$/iu.test(message);
    if (explicit) {
      if (!pending || proposalChanged || expired) { setError(new ApiFailure('', 'PROPOSAL_EXPIRED')); return; }
      setDraft(''); await confirm(); return;
    }
    if (!start('chat')) return;
    setPending(null);
    if (!repeat) addLine({ role: 'user', text: message, locale: language });
    setDraft('');
    try { acceptResponse(await api.chat(message, language), language); }
    catch (e) { setError(e); setRetry({ kind: 'chat', message, locale: language }); }
    finally { finish(); }
  }
  function prepare(sku: string, quantity: number) {
    const message = locale === 'kk' ? `Артикул ${sku}, себетке ${quantity} дана қос` : `Добавь ${quantity} шт. артикул ${sku}`;
    void send(message);
  }
  async function confirm() {
    if (!pending || proposalChanged || (expired && !uncertain) || !start('confirm')) return;
    try {
      const response = await api.confirm(pending.proposal.id, pending.key);
      publishCart(response.cart); api.cart().catch(() => {});
      addLine({ role: 'assistant', text: `${t.added}. ${pending.proposal.items.map(item => `${pending.products.find(p => p.id === item.productId)?.sku || item.productId}: ${item.quantity} ${t.units}`).join(', ')}`, cartUrl: response.cartUrl, locale });
      setPending(null);
    } catch (e) { setError(e); setRetry({ kind: 'confirm' }); }
    finally { finish(); }
  }
  function selectFile(selected?: File) {
    if (!selected) return;
    if (!/\.(pdf|docx|xlsx|jpe?g)$/i.test(selected.name) || selected.size > 2 * 1024 * 1024 || selected.size === 0) { setFileError(true); return; }
    setFile(selected); setConsent(false); setFileError(false);
  }
  async function upload(selected = file, photoConsent = consent, language = locale, repeat = false) {
    if (!selected || !start('file')) return;
    setPending(null);
    if (!repeat) addLine({ role: 'user', text: selected.name, locale: language });
    try {
      const response = await api.attachment(selected, language, photoConsent);
      addLine({ role: 'assistant', text: response.reply || strings(language).reviewHint, attachment: response, locale: language });
      setFile(null); setConsent(false);
    } catch (e) { setError(e); setRetry({ kind: 'file', file: selected, consent: photoConsent, locale: language }); }
    finally { finish(); }
  }
  function repeat() {
    if (retry?.kind === 'chat') void send(retry.message, retry.locale, true);
    if (retry?.kind === 'file') void upload(retry.file, retry.consent, retry.locale, true);
    if (retry?.kind === 'confirm') void confirm();
  }
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    if (event.key !== 'Tab') return;
    const nodes = [...panelRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select,summary')].filter(node => node.getClientRects().length > 0);
    const active = (panelRef.current!.getRootNode() as ShadowRoot).activeElement;
    if (event.shiftKey && (active === nodes[0] || active === panelRef.current)) { event.preventDefault(); nodes.at(-1)?.focus(); }
    if (!event.shiftKey && active === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
  }
  function results(line?: Line) {
    if (!line) return null;
    const response = line.response;
    const products = response?.products || line.attachment?.products || [];
    const renderProduct = (product: Product, analog?: NonNullable<ChatResponse['analogs']>[number]) => <ProductCard key={product.id} product={product} locale={locale} quantity={quantities[product.id] ?? 1} onQuantity={quantity => setQuantities(old => ({ ...old, [product.id]: quantity }))} onPrepare={() => prepare(product.sku, quantities[product.id] ?? 1)} disabled={disabled} original={products[0]} analog={analog} />;
    return <div className="results">{products.map(product => renderProduct(product))}{response?.analogs.map(analog => renderProduct(analog.product, analog))}{line.attachment && <AttachmentReview rows={reviewRows[line.id] || initialRows(line.attachment)} onRowsChange={rows => setReviewRows(old => ({ ...old, [line.id]: rows }))} response={line.attachment} locale={locale} disabled={disabled} onCheck={prepare} />}</div>;
  }
  const proposalProduct = pending?.products.find(p => p.id === pending.proposal.items[0]?.productId);
  const proposal = pending && <section className="proposal" aria-label={t.confirm}>
    <div className="proposal-title"><ShoppingCart size={22} /><div><h3>{t.unchanged}</h3><small>{t.prototype}</small></div></div>
    {pending.proposal.items.map(item => <p className="proposal-item" key={item.productId}><strong>{pending.products.find(p => p.id === item.productId)?.name || item.productId}</strong></p>)}
    <p>{t.confirmHint}</p><div className="proposal-quantity"><span>{t.quantity}</span><Quantity value={proposalQuantity} onChange={n => { setProposalQuantity(n); setError(null); setRetry(null); }} disabled={disabled} locale={locale} /><small>{t.units}</small></div>
    {expired && !uncertain && <p role="status">{t.expiredError}</p>}
    {!uncertain && (proposalChanged || expired || error != null) ? <button className="primary" disabled={disabled || !proposalProduct || !Number.isInteger(proposalQuantity) || proposalQuantity < 1 || proposalQuantity > 1000} onClick={() => proposalProduct && prepare(proposalProduct.sku, proposalQuantity)}>{t.update}</button> : <button className="primary" disabled={Boolean(busy)} onClick={() => void confirm()}><Check size={18} />{busy === 'confirm' ? t.confirming : uncertain ? t.retry : t.confirm}</button>}
    <button className="text-button" disabled={disabled} onClick={() => setPending(null)}>{t.cancel}</button>
  </section>;
  const status = source === 'demo' ? t.demo : source === 'live' ? t.live : source === 'unavailable' ? t.offline : t.checking;
  return <div className="ekt-assistant" lang={locale}>
    {!open && <button ref={launcherRef} className="launcher" aria-label={t.launcher} aria-expanded="false" onClick={() => setOpen(true)}><Sparkles size={28} /><span>{t.launcher}</span></button>}
    {open && <><div className={'backdrop mode-' + mode} onClick={() => setOpen(false)} /><section ref={panelRef} className={'assistant-window mode-' + mode} role="dialog" aria-label={t.title} aria-modal={mode === 'full' || !wide ? true : undefined} tabIndex={-1} onKeyDown={keys}>
      <div className="sheet-handle" /><header className="assistant-header"><div className="assistant-brand"><span className="brand-icon"><Sparkles size={25} /></span><div><h2>{t.title}</h2><span className="header-status"><span className={'status-dot ' + source} />{status}</span></div></div><div className="window-controls">{([{ value: 'quick', label: t.quick, Icon: Minimize2 }, { value: 'panel', label: t.panel, Icon: PanelRight }, { value: 'full', label: t.full, Icon: Maximize2 }] as const).filter(item => item.value !== mode).map(({ value, label, Icon }) => <button key={value} className={'icon-button control-' + value} aria-label={label} title={label} onClick={() => setMode(value)}><Icon size={17} /></button>)}<button className="icon-button" aria-label={t.close} title={t.close} onClick={() => setOpen(false)}><X size={21} /></button></div></header>
      <div className="assistant-toolbar"><span>{t.subtitle}</span><div className="locale-switch" role="group" aria-label={t.language}><button lang="ru" aria-pressed={locale === 'ru'} onClick={() => setLocale('ru')}>РУС</button><button lang="kk" aria-pressed={locale === 'kk'} onClick={() => setLocale('kk')}>ҚАЗ</button></div></div>
      <div className={'assistant-layout' + (full && lastResult ? ' has-details' : '')}><div className="conversation"><div className="messages" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={Boolean(busy)}>
        {!lines.length && <div className="welcome"><span className="welcome-spark"><Sparkles size={40} strokeWidth={1.5} /></span><h1>{t.welcome}</h1><p>{t.intro}</p><div className="suggestions">{[{ Icon: Search, title: t.find, hint: t.findHint, prompt: t.findPrompt }, { Icon: ArrowRight, title: t.analog, hint: t.analogHint, prompt: t.analogPrompt }, { Icon: Truck, title: t.terms, hint: t.termsHint, prompt: t.termsPrompt }].map(item => <button key={item.title} onClick={() => { setDraft(item.prompt); inputRef.current?.focus(); }}><span><item.Icon size={21} /></span><div><strong>{item.title}</strong><small>{item.hint}</small></div><ChevronRight size={17} /></button>)}</div><div className="welcome-note"><ShieldCheck size={17} />{t.draftHint}</div></div>}
        {lines.map(line => <div className={'message ' + line.role} key={line.id}><div className="message-text" lang={line.locale}>{line.role === 'assistant' && <Sparkles className="message-avatar" size={20} />}<div className="bubble">{line.text}</div></div>{line.response && <div className="message-source"><Database size={12} />{line.response.factsSource === 'catalog_demo' ? t.demo : line.response.factsSource === 'catalog_live' ? t.live : line.response.factsSource === 'partner_policy' ? t.policy : t.unknown}{safeLink(line.response.sourceUrl) && <a href={safeLink(line.response.sourceUrl)!} target="_blank" rel="noreferrer">{t.source} ↗</a>}{line.response.checkedAt && <span>{t.checked}: {line.response.checkedAt.slice(0, 10)}</span>}</div>}{!(full && line.id === lastResult?.id) && results(line)}{safeLink(line.cartUrl, true) && <a className="cart-success" href={cartLink(line.cartUrl!, locale)}><Check size={19} /><div><strong>{t.openCart}</strong><small>{t.prototype}</small></div><ArrowRight size={18} /></a>}</div>)}
        {busy && <div className="working" role="status"><span className="loading-dots"><i /><i /><i /></span>{slow ? t.slow : busy === 'file' ? t.uploading : busy === 'confirm' ? t.confirming : t.thinking}</div>}
        {!full && proposal}
      </div>
      {error != null && <div className="error" role="alert"><span>{uncertain ? t.confirmUncertain : errorText(error, locale)}</span>{retry && retry.kind !== 'confirm' && <button disabled={Boolean(busy)} onClick={repeat}>{t.retry}</button>}{uncertain && <a href={cartLink('/cart', locale)}>{t.openCart}</a>}</div>}
      <div className="composer-area">{fileError && <div className="error" role="alert">{t.fileInvalid}<button onClick={() => setFileError(false)} aria-label={t.close}><X size={16} /></button></div>}{file && <div className="file-preview"><div><FileText size={20} /><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024)} KB</small><button className="icon-button" aria-label={t.removeFile} disabled={Boolean(busy)} onClick={() => setFile(null)}><X size={17} /></button></div>{/\.jpe?g$/i.test(file.name) && <><label className="check-label"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={Boolean(busy)} />{t.photoConsent}</label><small>{t.photoHint}</small></>}<button className="secondary" disabled={disabled} onClick={() => void upload()}>{t.process}</button></div>}
      <form className="composer" onSubmit={event => { event.preventDefault(); void send(draft); }} onDragOver={e => { if (!disabled) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (!disabled) selectFile(e.dataTransfer.files[0]); }}>
        <input ref={fileRef} className="visually-hidden" tabIndex={-1} type="file" accept=".pdf,.docx,.xlsx,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg" onChange={e => { selectFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button className="attach-button" type="button" title={t.fileHint} aria-label={t.attachment} disabled={disabled} onClick={() => fileRef.current?.click()}><Paperclip size={21} /></button><textarea ref={inputRef} rows={1} aria-label={t.placeholder} placeholder={t.placeholder} maxLength={2000} value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft); } }} /><button className="send-button" type="submit" aria-label={t.send} disabled={disabled || !draft.trim()}><Send size={19} /></button>
      </form><div className="composer-footer"><span>{t.fileHint}</span><span>{draft.length > 1800 ? `${draft.length}/2000` : ''}</span></div></div></div>
      {full && lastResult && <aside className="detail-panel">{results(lastResult)}{proposal}</aside>}{full && !lastResult && proposal && <aside className="detail-panel">{proposal}</aside>}
      </div></section></>}
  </div>;
}

export function cartLink(value: string, locale: Locale) {
  const safe = safeLink(value, true);
  if (!safe) return '#';
  const url = new URL(safe); url.searchParams.set('lang', locale); return url.href;
}
