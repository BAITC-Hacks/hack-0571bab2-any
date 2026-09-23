import { FileCheck2 } from 'lucide-react';
import type { AttachmentResponse, Locale } from '../types';
import { strings } from './i18n';

export type CandidateReviewRow = AttachmentResponse['candidates'][number] & { checked: boolean };

export function initialRows(response: AttachmentResponse): CandidateReviewRow[] {
  return response.candidates.map(row => ({ ...row, checked: false }));
}

export function AttachmentReview({ response, locale, disabled, onCheck, rows, onRowsChange }: {
  response: AttachmentResponse;
  locale: Locale;
  disabled: boolean;
  onCheck: (sku: string, quantity: number) => void;
  rows: CandidateReviewRow[];
  onRowsChange: (rows: CandidateReviewRow[]) => void;
}) {
  const t = strings(locale);
  return <section className="file-review"><h3><FileCheck2 size={18} />{t.review}</h3><p>{response.warning || t.reviewHint}</p>{!rows.length && <p>{t.noCandidates}</p>}{rows.map((row, index) => <div className="candidate" key={index}>
    <div className="candidate-inputs"><label>{t.sku}<input value={row.sku} maxLength={100} disabled={disabled} onChange={e => onRowsChange(rows.map((r, i) => i === index ? { ...r, sku: e.target.value, checked: false } : r))} /></label><label>{t.quantity}<input type="number" min="1" max="1000" step="1" value={row.quantity || ''} disabled={disabled} onChange={e => onRowsChange(rows.map((r, i) => i === index ? { ...r, quantity: Number(e.target.value), checked: false } : r))} /></label></div>
    <small className="muted">{t.confidence}: {t[row.confidence]}</small>
    <label className="check-label"><input type="checkbox" checked={row.checked} disabled={disabled} onChange={e => onRowsChange(rows.map((r, i) => i === index ? { ...r, checked: e.target.checked } : r))} />{t.reviewed}</label>
    <button className="secondary" disabled={disabled || !row.checked || !/^[\p{L}\p{N}./_-]{2,100}$/u.test(row.sku) || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000} onClick={() => onCheck(row.sku, row.quantity)}>{t.checkItem}</button>
  </div>)}</section>;
}
