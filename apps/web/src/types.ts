export type FactsSource = 'catalog_live' | 'catalog_demo' | 'partner_policy' | 'unknown';

export type Product = {
  id: string;
  sku: string;
  name: string;
  category?: string | null;
  characteristics: Record<string, string>;
  certificateUrl?: string | null;
  price?: { amount: string; currency: string } | null;
  stock: { available: number | null; status: 'in_stock' | 'out_of_stock' | 'unknown' };
  source: 'catalog_live' | 'catalog_demo';
};

export type Analog = { product: Product; reason: string; matchedCharacteristics: string[] };
export type Proposal = { id: string; items: { productId: string; quantity: number }[]; expiresAt: string };
export type CartItem = { productId: string; sku: string; name: string; quantity: number; availableAtConfirmation: number | null };
export type Cart = { items: CartItem[]; itemCount: number; cartUrl?: string; mode?: 'demo' | 'live'; csrfToken?: string };
export type ChatResponse = {
  reply: string;
  products: Product[];
  analogs: Analog[];
  proposal: Proposal | null;
  factsSource: FactsSource;
  sourceUrl?: string;
  checkedAt?: string;
  cartChanged: boolean;
  cart?: Cart;
  cartUrl?: string;
  requestId?: string;
};
export type ConfirmResponse = { cart: Cart; cartUrl: string; status: 'added'; requestId?: string };
