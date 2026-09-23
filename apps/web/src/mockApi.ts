import { ApiFailure } from './errors';
import type { Cart, ChatResponse, ConfirmResponse, Product, Proposal } from './types';

// Entirely synthetic data for an offline UI demonstration. Never presented as ekt.kz stock.
const available: Product = {
  id: 'demo-led-12', sku: 'DEMO-LED-12', name: 'Синтетический светильник 12 В',
  category: 'Освещение', characteristics: { 'Напряжение': '12 В', 'Мощность': '12 Вт', 'Монтаж': 'накладной' },
  certificateUrl: null, price: null, stock: { available: 4, status: 'in_stock' }, source: 'catalog_demo',
};
const unavailable: Product = {
  id: 'demo-led-old', sku: 'DEMO-LED-OLD', name: 'Синтетический светильник 12 В (снят с наличия)',
  category: 'Освещение', characteristics: { 'Напряжение': '12 В', 'Мощность': '12 Вт', 'Монтаж': 'накладной' },
  certificateUrl: null, price: null, stock: { available: 0, status: 'out_of_stock' }, source: 'catalog_demo',
};
const products = [available, unavailable];
const cartKey = 'ekt_mock_cart_v1';
const proposalKey = 'ekt_mock_proposal_v1';
const replayKey = 'ekt_mock_replay_v1';
const lastSkuKey = 'ekt_mock_last_sku_v1';

function readCart(): Cart {
  try {
    const items = JSON.parse(sessionStorage.getItem(cartKey) || '[]') as Cart['items'];
    return { items, itemCount: items.reduce((sum, item) => sum + item.quantity, 0), cartUrl: '/cart', mode: 'demo' };
  } catch {
    return { items: [], itemCount: 0, cartUrl: '/cart', mode: 'demo' };
  }
}

function delay() { return new Promise<void>((resolve) => window.setTimeout(resolve, 220)); }

export const mockApi = {
  async chat(message: string): Promise<ChatResponse> {
    await delay();
    const text = message.trim();
    const normalized = text.toUpperCase();
    const product = products.find((item) => normalized.includes(item.sku)) ||
      products.find((item) => item.sku === sessionStorage.getItem(lastSkuKey));
    const base = { products: [] as Product[], analogs: [] as ChatResponse['analogs'], proposal: null as Proposal | null,
      factsSource: 'catalog_demo' as const, cartChanged: false, requestId: crypto.randomUUID() };

    if (/оплат|достав|партии|партия|заказа|услови/i.test(text)) {
      return { ...base, factsSource: 'partner_policy', reply: 'На публичной странице ekt.kz указаны способы оплаты для физических и юридических лиц и общие условия доставки. Точную стоимость и срок доставки нужно согласовать для вашего города и заказа. Подтверждённая минимальная партия в доступных источниках не указана — уточните у менеджера. Источник: https://ekt.kz/checkout-delivery/ (проверено 23.09.2026).' };
    }
    if (/добав|корзин|возьму|купить/i.test(text)) {
      if (!product || product.stock.available === null || product.stock.available < 1) {
        return { ...base, reply: 'Для подготовки корзины выберите товар с подтверждённым остатком.' };
      }
      const quantity = Number(text.match(/\b(\d+)\s*(?:шт\.?|штук|единиц)\b/i)?.[1] || 1);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
        return { ...base, reply: 'Укажите количество от 1 до 999.' };
      }
      const proposal: Proposal = { id: crypto.randomUUID(), items: [{ productId: product.id, quantity }], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
      sessionStorage.setItem(proposalKey, JSON.stringify(proposal));
      return { ...base, products: [product], proposal, reply: `Подготовил предложение: ${quantity} шт. ${product.sku}. Корзина пока не изменена. Проверьте количество и подтвердите отдельно.` };
    }
    if (product) {
      sessionStorage.setItem(lastSkuKey, product.sku);
      if (product.stock.status === 'out_of_stock') {
        return { ...base, products: [product], analogs: [{ product: available, reason: 'В демонстрационном наборе совпадают напряжение 12 В, мощность 12 Вт и накладной монтаж; перед реальной заменой нужна проверка габаритов и сертификата.', matchedCharacteristics: ['Напряжение', 'Мощность', 'Монтаж'] }], reply: `${product.sku} отсутствует в синтетическом каталоге. Ниже возможный аналог и ограничения совместимости.` };
      }
      return { ...base, products: [product], reply: `${product.sku}: в синтетическом каталоге доступно ${product.stock.available} шт. Цена и сертификат не указаны.` };
    }
    return { ...base, reply: 'Для проверки демонстрационного каталога укажите DEMO-LED-12 или DEMO-LED-OLD. Для условий покупки спросите об оплате и доставке.' };
  },
  async confirm(proposalId: string, idempotencyKey: string): Promise<ConfirmResponse> {
    await delay();
    const replay = JSON.parse(sessionStorage.getItem(replayKey) || '{}') as Record<string, ConfirmResponse>;
    if (replay[idempotencyKey]) return replay[idempotencyKey];
    const proposal = JSON.parse(sessionStorage.getItem(proposalKey) || 'null') as Proposal | null;
    if (!proposal || proposal.id !== proposalId || Date.parse(proposal.expiresAt) <= Date.now()) {
      throw new ApiFailure('Предложение устарело. Подготовьте новое и подтвердите его.', 'PROPOSAL_EXPIRED');
    }
    const item = proposal.items[0];
    const product = products.find((entry) => entry.id === item.productId);
    if (!product || product.stock.available === null) throw new ApiFailure('Остаток неизвестен. Добавление недоступно.', 'STOCK_UNKNOWN');
    const cart = readCart();
    const existing = cart.items.find((entry) => entry.productId === product.id);
    const remaining = product.stock.available - (existing?.quantity || 0);
    if (item.quantity > remaining) throw new ApiFailure(`Доступно для добавления: ${Math.max(0, remaining)} шт. Подготовьте новое предложение.`, 'INSUFFICIENT_STOCK', Math.max(0, remaining));
    if (existing) existing.quantity += item.quantity;
    else cart.items.push({ productId: product.id, sku: product.sku, name: product.name, quantity: item.quantity, availableAtConfirmation: product.stock.available });
    cart.itemCount = cart.items.reduce((sum, entry) => sum + entry.quantity, 0);
    sessionStorage.setItem(cartKey, JSON.stringify(cart.items));
    sessionStorage.removeItem(proposalKey);
    const result: ConfirmResponse = { cart, cartUrl: '/cart', status: 'added', requestId: crypto.randomUUID() };
    replay[idempotencyKey] = result;
    sessionStorage.setItem(replayKey, JSON.stringify(replay));
    return result;
  },
  async cart(): Promise<Cart> {
    await delay();
    return readCart();
  },
};
