import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferencesUpdateSchema,
  resolveDeliveryChannels,
  resolveNotificationPreferences
} from '../notificationPreferences';

describe('resolveNotificationPreferences', () => {
  it('applique les défauts à un compte sans choix enregistré', () => {
    const preferences = resolveNotificationPreferences(undefined);

    expect(preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(preferences.orders.email).toBe(true);
    expect(preferences.disputes.email).toBe(true);
    expect(preferences.offers.email).toBe(true);
    expect(preferences.messages.email).toBe(false);
    expect(preferences.social.email).toBe(false);
  });

  it('garde le défaut des canaux non choisis d\'une catégorie partiellement réglée', () => {
    const preferences = resolveNotificationPreferences({ orders: { email: false } });

    expect(preferences.orders).toEqual({ email: false, push: true });
  });

  it('ignore une valeur stockée non booléenne', () => {
    const preferences = resolveNotificationPreferences({ messages: { email: undefined, push: false } });

    expect(preferences.messages).toEqual({ email: false, push: false });
  });
});

describe('resolveDeliveryChannels', () => {
  const everythingOff = {
    orders: { email: false, push: false },
    offers: { email: false, push: false },
    messages: { email: false, push: false },
    disputes: { email: false, push: false },
    reviews: { email: false, push: false },
    social: { email: false, push: false }
  };

  it.each([
    ['product_sold', true],
    ['order_status', true],
    ['refund_issued', true],
    ['offer', true],
    ['counter_offer', true],
    ['dispute_opened', true],
    ['dispute_resolved', true],
    ['message', false],
    ['rating_received', false],
    ['new_follower', false]
  ])('par défaut, %s → email %s', (type, expectedEmail) => {
    expect(resolveDeliveryChannels(type, undefined)).toEqual({ email: expectedEmail, push: true });
  });

  it('respecte le refus d\'email d\'une catégorie', () => {
    expect(resolveDeliveryChannels('order_status', { orders: { email: false } }).email).toBe(false);
  });

  it('respecte l\'activation d\'un email désactivé par défaut', () => {
    expect(resolveDeliveryChannels('message', { messages: { email: true } }).email).toBe(true);
  });

  it('range les alertes de recherches sauvegardées avec les alertes wishlist, dans « social »', () => {
    const socialPushOff = { social: { push: false } };

    expect(resolveDeliveryChannels('saved_search_match', undefined)).toEqual({ email: false, push: true });
    expect(resolveDeliveryChannels('saved_search_match', socialPushOff))
      .toEqual(resolveDeliveryChannels('wishlist_price_drop', socialPushOff));
    expect(resolveDeliveryChannels('saved_search_match', socialPushOff).push).toBe(false);
  });

  it('envoie toujours les notifications système, même si tout est désactivé', () => {
    expect(resolveDeliveryChannels('system', everythingOff)).toEqual({ email: true, push: true });
    expect(resolveDeliveryChannels('product_flagged', everythingOff)).toEqual({ email: true, push: true });
  });

  it('n\'envoie jamais d\'email pour un type sans catégorie (alerte admin)', () => {
    expect(resolveDeliveryChannels('admin_alert', undefined)).toEqual({ email: false, push: true });
    expect(resolveDeliveryChannels('type_inconnu', undefined)).toEqual({ email: false, push: true });
  });
});

describe('notificationPreferencesUpdateSchema', () => {
  it('accepte une mise à jour partielle', () => {
    const parsed = notificationPreferencesUpdateSchema.safeParse({ orders: { email: false } });

    expect(parsed.success).toBe(true);
  });

  it('refuse une catégorie inconnue, y compris système', () => {
    expect(notificationPreferencesUpdateSchema.safeParse({ system: { email: false } }).success).toBe(false);
    expect(notificationPreferencesUpdateSchema.safeParse({ marketing: { email: true } }).success).toBe(false);
  });

  it('refuse un canal inconnu', () => {
    expect(notificationPreferencesUpdateSchema.safeParse({ orders: { sms: true } }).success).toBe(false);
  });

  it('refuse une valeur non booléenne', () => {
    expect(notificationPreferencesUpdateSchema.safeParse({ orders: { email: 'false' } }).success).toBe(false);
  });
});
