import type { AttachmentResponse, Cart, ChatResponse, ConfirmResponse, Locale } from './types';
import { ApiFailure } from './errors';
export { ApiFailure } from './errors';

let sessionCsrfToken: string | undefined;
let cartRequest: Promise<Cart> | undefined;
let apiBase = '/api';

// Keep the session on the host origin. In production, proxy this prefix to the API.
export function configureApi(base = '/api') {
  const url = new URL(base, location.origin);
  if (url.origin !== location.origin || url.search || url.hash) throw new Error('API must use a same-origin path');
  apiBase = url.pathname.replace(/\/$/, '');
  sessionCsrfToken = undefined;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), path === '/attachments' ? 45000 : 15000);
  try {
    const response = await fetch(apiBase + path, {
      ...options, credentials: 'same-origin', signal: controller.signal,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(sessionCsrfToken ? { 'X-CSRF-Token': sessionCsrfToken } : {}), ...options.headers,
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !body) {
      const details = (body as { error?: { code?: string; message?: string; available?: number } } | null)?.error;
      throw new ApiFailure(details?.message || 'Запрос не выполнен', details?.code || (response.ok ? 'INVALID_RESPONSE' : String(response.status)), details?.available, response.status);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure('Нет ответа сервера', error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  } finally { window.clearTimeout(timer); }
}

async function mutation<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  if (!sessionCsrfToken) await api.cart();
  const options = { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body), headers };
  try { return await request<T>(path, options); }
  catch (error) {
    if (!(error instanceof ApiFailure) || !['SESSION_REQUIRED', 'CSRF_INVALID'].includes(error.code)) throw error;
    sessionCsrfToken = undefined;
    await api.cart();
    return request<T>(path, options);
  }
}

export function publishCart(cart: Cart) {
  window.dispatchEvent(new CustomEvent<Cart>('ekt-cart-snapshot', { detail: cart }));
}

export const api = {
  chat: (message: string, locale: Locale): Promise<ChatResponse> => mutation('/chat', { message, locale }),
  async confirm(proposalId: string, idempotencyKey: string): Promise<ConfirmResponse> {
    const result = await mutation<ConfirmResponse>('/cart/confirm', { proposalId, idempotencyKey });
    if (result.status !== 'added' || !Array.isArray(result.cart?.items) || typeof result.cartUrl !== 'string') throw new ApiFailure('Некорректный ответ', 'INVALID_RESPONSE');
    return result;
  },
  attachment(file: File, locale: Locale, photoConsent: boolean): Promise<AttachmentResponse> {
    const body = new FormData(); body.append('file', file);
    return mutation('/attachments', body, { 'X-Attachment-Locale': locale, 'X-Photo-Consent': String(photoConsent) });
  },
  health: () => request<{ catalog: 'live' | 'demo' | 'unavailable'; model: 'ready' | 'fallback' }>('/health'),
  cart(): Promise<Cart> {
    if (!cartRequest) cartRequest = request<Cart>('/cart').then(cart => {
      sessionCsrfToken = cart.csrfToken; publishCart(cart); return cart;
    }).finally(() => { cartRequest = undefined; });
    return cartRequest;
  },
};
