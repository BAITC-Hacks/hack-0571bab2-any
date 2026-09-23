export type PurchaseTermsAnswer = {
  reply: string;
  sourceUrl: string;
  checkedAt: string;
};

const sourceUrl = 'https://ekt.kz/checkout-delivery/';
const checkedAt = '2026-09-23';

// Match Russian and Kazakh purchase terms without relying on \w/\b, which
// do not recognize Cyrillic word boundaries in JavaScript regular expressions.
const purchaseTermsPattern =
  /оплат|достав|самовывоз|минимал|парти|услови.{0,20}покуп|төлем|төлеу|жеткіз|ең\s+аз|ең\s+кем|тапсырыс.{0,20}(шарт|сом)|сатып\s+алу.{0,20}шарт|партия|алып\s+кет/i;

export function detectsPurchaseTerms(message: string): boolean {
  return purchaseTermsPattern.test(message.normalize('NFC'));
}

export function answerPurchaseTerms(locale: 'ru' | 'kk'): PurchaseTermsAnswer {
  const reply =
    locale === 'kk'
      ? 'ekt.kz сайтында жеке тұлғалар үшін картамен онлайн төлеу, алған кезде төлеу және өзі алып кеткенде сауда залында төлеу көрсетілген. Заңды тұлғалар үшін шот бойынша немесе өзі алып кеткенде сауда залында төлеу көрсетілген. Алматы бойынша жеткізу сипатталған; басқа қалаларға жеткізу құны мен мерзімі менеджермен келісіледі. Ең аз партия немесе тапсырыс сомасы ашық бетте көрсетілмеген — менеджерден нақтылаңыз. Алматы бойынша тегін жеткізу шегі сайтта қайшы көрсетілген, сондықтан оны да менеджерден растаңыз. Дереккөз: https://ekt.kz/checkout-delivery/ (23.09.2026 күні тексерілді).'
      : 'На сайте ekt.kz для физических лиц указаны онлайн-оплата картой, оплата при получении и оплата в торговом зале при самовывозе; для юридических лиц — оплата по счёту и в торговом зале при самовывозе. Доставка по Алматы описана; стоимость и сроки доставки в другие города согласуются с менеджером. Минимальная партия или сумма заказа на доступной странице не указана — уточните у менеджера. Порог бесплатной доставки по Алматы на сайте указан противоречиво, поэтому его также нужно подтвердить у менеджера. Источник: https://ekt.kz/checkout-delivery/ (проверено 23.09.2026).';

  return { reply, sourceUrl, checkedAt };
}
