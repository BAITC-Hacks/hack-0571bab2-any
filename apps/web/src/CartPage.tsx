import { useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck, ShoppingBasket } from 'lucide-react';
import { api } from './api';
import type { Cart, Locale } from './types';
import { errorText, readLocale, strings } from './assistant/i18n';

export function CartPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [locale, setLocale] = useState<Locale>(() => new URLSearchParams(location.search).get('lang') === 'kk' ? 'kk' : readLocale());
  const t = strings(locale);
  function refresh() { setError(null); api.cart().then(setCart).catch(setError); }
  useEffect(() => {
    refresh();
    const snapshot = (event: Event) => setCart((event as CustomEvent<Cart>).detail);
    const changeLocale = (event: Event) => setLocale((event as CustomEvent<Locale>).detail);
    window.addEventListener('ekt-cart-snapshot', snapshot); window.addEventListener('ekt-locale', changeLocale);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('ekt-cart-snapshot', snapshot); window.removeEventListener('ekt-locale', changeLocale); window.removeEventListener('focus', refresh); };
  }, []);
  return <main className="cart-page shell" lang={locale}><a href="/" className="cart-back"><ArrowLeft size={17} />{t.back}</a><h1>{t.cart}</h1><div className="cart-banner"><ShieldCheck size={20} />{cart?.mode === 'live' ? t.cart : t.prototypeNote}</div>
    {error != null ? <div className="empty-block" role="alert"><p>{errorText(error, locale)}</p><button className="outline-btn" onClick={refresh}>{t.retry}</button></div> : !cart ? <p role="status">{t.loading}</p> : !cart.items.length ? <div className="empty-block"><ShoppingBasket size={52} /><h2>{t.empty}</h2><button className="outline-btn" onClick={() => window.dispatchEvent(new Event('open-assistant'))}>{t.find}</button></div> : <div className="cart-items">{cart.items.map(item => <div className="cart-item" key={item.productId}><div className="cart-item-icon"><ShoppingBasket size={28} /></div><div><strong>{item.name}</strong><small>{t.sku}: {item.sku}</small></div><b>{item.quantity} {t.units}</b></div>)}<div className="cart-total">{t.total}: <strong>{cart.itemCount} {t.units}</strong></div></div>}
  </main>;
}
