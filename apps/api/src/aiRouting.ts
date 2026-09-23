/**
 * A deterministic cost/complexity decision. It never supplies product facts or
 * authorizes a cart write. The caller may use a model only after checking its
 * own permission and call budget; otherwise it keeps the local fallback.
 */
export type AssistantTier = 'rules' | 'light' | 'balanced' | 'deep' | 'vision' | 'refuse';
export type AssistantTask = 'known_item' | 'purchase_terms' | 'cart' | 'search' | 'multi_category' | 'project' | 'photo' | 'unsafe';

export type RoutingContext = {
  imagePresent?: boolean;
  recentProductIds?: readonly string[];
  recentCategories?: readonly string[];
  modelCallsUsed?: number;
  externalProcessingAllowed?: boolean;
  customerConsented?: boolean;
};

export type AssistantRoute = {
  task: AssistantTask;
  desiredTier: AssistantTier;
  executionTier: AssistantTier;
  /** No catalog dump is ever sent to a model. */
  maxCandidateFacts: number;
  maxOutputTokens: number;
  requiresClarification: boolean;
  categoriesMentioned: readonly string[];
};

const MAX_MODEL_CALLS_PER_SESSION = 8;
const categoryPatterns = [
  ['cable', /кабел|провод|сым/iu],
  ['breaker', /автомат|ажыратқыш/iu],
  ['socket', /розетк|электр\s*ұя/iu],
  ['lighting', /светильник|ламп|жарық/iu],
  ['switch', /выключател|қосқыш/iu],
] as const;

const skuPattern = /[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9]+(?:[-/][A-ZА-ЯЁӘҒҚҢӨҰҮҺІ0-9]+)+|[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]{2,}\d{2,}/giu;
const unsafePattern = /(?:ignore\s+(?:(?:all|previous|system)\s+){1,3}instructions|покажи\s+(?:api[-_ ]?)?(?:ключ|парол)|раскрой\s+(?:секрет|инструкц)|обойди\s+(?:подтвержден|проверку\s+корзин)|сделай\s+вид,\s+что\s+остаток)/iu;
const cartPattern = /добав(?:ь|ить|ьте)|полож(?:и|ить)|в\s+корзин|подтверждаю|да[,\s]+добавь|себетке|қос\s*$/iu;
const termsPattern = /оплат|достав|самовывоз|минимал|парти|төлем|жеткіз|тапсырыс.{0,20}шарт/iu;
const projectPattern = /(?:весь|целый|полностью|под\s+ключ|бүкіл|толық).{0,50}(?:дом|квартир|объект|үй)|(?:дом|квартир|объект|үй).{0,50}(?:полностью|под\s+ключ|собер|жабдықта)/iu;

function mentionedCategories(message: string): string[] {
  const found = categoryPatterns.flatMap(([name, pattern]) => pattern.test(message) ? [name] : []);
  return found.includes('breaker') && /автоматическ|автомат|ажыратқыш/iu.test(message)
    ? found.filter((name) => name !== 'switch') : found;
}

function countDistinctSkus(message: string): number {
  return new Set((message.match(skuPattern) ?? []).map((value) => value.toUpperCase())).size;
}

export function routeUserRequest(message: string, context: RoutingContext = {}): AssistantRoute {
  const clean = message.normalize('NFC').trim().slice(0, 2000);
  const categoriesMentioned = mentionedCategories(clean);
  const skus = countDistinctSkus(clean);
  let task: AssistantTask;
  let desiredTier: AssistantTier;
  let requiresClarification = false;

  if (unsafePattern.test(clean)) {
    task = 'unsafe'; desiredTier = 'refuse';
  } else if (context.imagePresent) {
    task = 'photo'; desiredTier = 'vision';
  } else if (cartPattern.test(clean)) {
    task = 'cart'; desiredTier = 'rules';
  } else if (termsPattern.test(clean)) {
    task = 'purchase_terms'; desiredTier = 'rules';
  } else if (projectPattern.test(clean)) {
    task = 'project'; desiredTier = 'deep'; requiresClarification = true;
  } else if (/сравн|что\s+лучше|қайсысы\s+жақсы/iu.test(clean) && (context.recentProductIds?.length ?? 0) >= 2) {
    task = 'multi_category'; desiredTier = 'balanced';
  } else if (skus === 1 && categoriesMentioned.length < 2) {
    task = 'known_item'; desiredTier = 'rules';
  } else if (skus > 1 || categoriesMentioned.length >= 2) {
    task = 'multi_category'; desiredTier = 'balanced';
  } else {
    task = 'search'; desiredTier = 'light';
  }

  const allowed = context.externalProcessingAllowed === true &&
    (desiredTier !== 'vision' || context.customerConsented === true) &&
    (context.modelCallsUsed ?? 0) < MAX_MODEL_CALLS_PER_SESSION;
  const executionTier = desiredTier === 'light' || desiredTier === 'balanced' || desiredTier === 'deep' || desiredTier === 'vision'
    ? (allowed ? desiredTier : 'rules') : desiredTier;
  return {
    task, desiredTier, executionTier,
    maxCandidateFacts: desiredTier === 'deep' || desiredTier === 'balanced' ? 8 : desiredTier === 'light' ? 5 : 0,
    maxOutputTokens: executionTier === 'deep' ? 1_000 : executionTier === 'balanced' ? 500
      : executionTier === 'light' || executionTier === 'vision' ? 240 : 0,
    requiresClarification,
    categoriesMentioned,
  };
}

/** Small, typed context that avoids retaining the user's raw transcript. */
export function boundedRoutingContext(context: RoutingContext): RoutingContext {
  return {
    recentProductIds: [...new Set(context.recentProductIds ?? [])].slice(-6),
    recentCategories: [...new Set(context.recentCategories ?? [])].slice(-6),
    modelCallsUsed: Math.max(0, Math.min(MAX_MODEL_CALLS_PER_SESSION, context.modelCallsUsed ?? 0)),
    externalProcessingAllowed: context.externalProcessingAllowed === true,
    customerConsented: context.customerConsented === true,
  };
}
