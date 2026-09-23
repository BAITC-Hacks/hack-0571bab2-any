import type { Cart, ChatResponse, ConfirmResponse } from './types';
import { mockApi } from './mockApi';
import { ApiFailure } from './errors';
export { ApiFailure } from './errors';

export const isDemo = (): boolean => {
  if (new URLSearchParams(window.location.search).get('demo') === '1') {
    sessionStorage.setItem('ekt_frontend_mock', '1');
  }
  return sessionStorage.getItem('ekt_frontend_mock') === '1';
};

function csrfToken(): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
  const cookie = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/)?.[1];
  return meta || (cookie ? decodeURIComponent(cookie) : undefined);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  const token = csrfToken();
  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-CSRF-Token': token } : {}),
        ...options.headers,
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
      const details = error && typeof error === 'object' ? error as Record<string, unknown> : {};
      const available = body && typeof body === 'object' && 'available' in body ? body.available : undefined;
      throw new ApiFailure(
        typeof details.message === 'string' ? details.message : response.status >= 500 ? 'Сервис временно недоступен. Повторите запрос позже.' : `Запрос не выполнен (${response.status}).`,
        typeof details.code === 'string' ? details.code : String(response.status),
        typeof available === 'number' ? available : undefined,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ApiFailure('Сервер не ответил вовремя. Попробуйте ещё раз.', 'TIMEOUT');
    throw new ApiFailure('Нет связи с сервером. Проверьте соединение и повторите запрос.', 'NETWORK');
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  chat(message: string): Promise<ChatResponse> {
    return isDemo() ? mockApi.chat(message) : request('/api/chat', { method: 'POST', body: JSON.stringify({ message, locale: 'ru' }) });
  },
  confirm(proposalId: string, idempotencyKey: string): Promise<ConfirmResponse> {
    return isDemo() ? mockApi.confirm(proposalId, idempotencyKey) : request('/api/cart/confirm', { method: 'POST', body: JSON.stringify({ proposalId, idempotencyKey }) });
  },
  cart(): Promise<Cart> {
    return isDemo() ? mockApi.cart() : request('/api/cart');
  },
};
