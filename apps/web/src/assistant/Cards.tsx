import { Check, FileText, Minus, Package, Plus, ShoppingCart } from 'lucide-react';
import type { Analog, Locale, Product } from '../types';
import { strings } from './i18n';

export function safeLink(value?: string | null, sameOrigin = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, location.origin);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    if (sameOrigin && url.origin !== location.origin) return null;
    if (!sameOrigin && url.protocol !== 'https:' && url.origin !== location.origin) return null;
    return url.href;
  } catch { return null; }
}

const labels: Record<string, [string, string]> = {
  NOMINALNOE_NAPRYAZHENIE: ['Напряжение', 'Кернеу'], NOMINALNYY_TOK: ['Номинальный ток', 'Номиналды ток'],
  KOLICHESTVO_POLYUSOV: ['Количество полюсов', 'Полюстер саны'], TIP_USTANOVKI: ['Монтаж', 'Орнату түрі'],
};
export const specLabel = (key: string, locale: Locale) => labels[key]?.[locale === 'kk' ? 1 : 0] || key;

export function Quantity({ value, onChange, disabled, locale, max = 1000 }: { value: number; onChange: (n: number) => void; disabled?: boolean; locale: Locale; max?: number }) {
  const t = strings(locale);
  return <div className="quantity"><button type="button" aria-label={t.decrease} disabled={disabled || value <= 1} onClick={() => onChange(Math.max(1, value - 1))}><Minus size={16} /></button><input aria-label={t.quantity} type="number" min="1" max={max} step="1" inputMode="numeric" value={value || ''} onChange={e => onChange(Number(e.target.value))} disabled={disabled} /><button type="button" aria-label={t.increase} disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + 1))}><Plus size={16} /></button></div>;
}

export function ProductCard({ product, locale, quantity, onQuantity, onPrepare, disabled, original, analog }: {
  product: Product; locale: Locale; quantity: number; onQuantity: (n: number) => void; onPrepare: () => void; disabled: boolean;
  original?: Product; analog?: Analog;
}) {
  const t = strings(locale);
  const certificate = safeLink(product.certificateUrl);
  const inStock = product.stock.status === 'in_stock' && product.stock.available !== null && product.stock.available > 0;
  const valid = Number.isInteger(quantity) && quantity > 0 && quantity <= 1000;
  const differences = original ? Object.entries(product.characteristics).filter(([key, value]) => original.characteristics[key] !== undefined && original.characteristics[key] !== value) : [];
  return <article className={'product-card' + (analog ? ' analog-card' : '')}>
    <div className="product-heading"><span className="product-icon"><Package size={29} strokeWidth={1.4} /></span><div><small>{t.sku}: {product.sku}</small><h3>{product.name}</h3></div></div>
    <span className={'badge ' + (product.source === 'catalog_demo' ? 'badge-demo' : '')}>{product.source === 'catalog_demo' ? t.demo : t.live}</span>
    <div className={'stock ' + (inStock ? 'in-stock' : '')}>{inStock ? <Check size={16} /> : <Package size={16} />}{product.stock.available === null || product.stock.status === 'unknown' ? t.unknownStock : product.stock.status === 'out_of_stock' ? t.unavailable : `${t.stock}: ${product.stock.available} ${t.units}`}</div>
    <p className="price">{product.price ? `${product.price.amount} ${product.price.currency}` : t.priceUnknown}</p>
    {Object.keys(product.characteristics).length ? <dl className="specs">{Object.entries(product.characteristics).map(([key, value]) => <div key={key}><dt>{specLabel(key, locale)}</dt><dd>{value}</dd></div>)}</dl> : <p className="muted">{t.noSpecs}</p>}
    {certificate ? <a className="text-link" href={certificate} target="_blank" rel="noreferrer"><FileText size={17} />{t.certificate}</a> : <p className="muted certificate-note"><FileText size={16} />{t.noCertificate}</p>}
    {analog && <div className="reason"><strong><Check size={17} />{t.why}</strong><p>{analog.reason}</p>{analog.matchedCharacteristics.length > 0 && <details><summary>{t.compared}</summary><ul>{analog.matchedCharacteristics.map(item => <li key={item}>{item}</li>)}</ul></details>}{differences.length > 0 && <div className="differences"><strong>{t.differences}</strong>{differences.map(([key, value]) => <p key={key}>{specLabel(key, locale)}: {original?.characteristics[key]} → {value}</p>)}</div>}</div>}
    {inStock && <div className="product-actions"><Quantity value={quantity} onChange={onQuantity} disabled={disabled} locale={locale} /><button className="secondary" disabled={disabled || !valid} onClick={onPrepare}><ShoppingCart size={17} />{t.requestAdd}</button></div>}
  </article>;
}
