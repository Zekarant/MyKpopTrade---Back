import { z } from 'zod';

/**
 * Catégories que le membre peut régler. Les notifications système/sécurité
 * (suspension, connexion PayPal, modération d'une annonce…) n'en font pas
 * partie : elles sont toujours envoyées, sur tous les canaux.
 */
export const NOTIFICATION_CATEGORIES = ['orders', 'offers', 'messages', 'disputes', 'reviews', 'social'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Canaux réglables. L'in-app est toujours actif : c'est l'historique de référence du membre. */
export const NOTIFICATION_CHANNELS = ['email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type ChannelPreferences = Record<NotificationChannel, boolean>;
export type NotificationPreferences = Record<NotificationCategory, ChannelPreferences>;

/**
 * Forme stockée dans `user.preferences.notifications` : seuls les choix
 * explicites du membre y figurent, les défauts restent ici. Changer un défaut
 * s'applique ainsi à tous les comptes qui n'ont pas exprimé de choix.
 */
export type StoredNotificationPreferences = {
  [Category in NotificationCategory]?: Partial<ChannelPreferences>;
};

/**
 * Le push reste actif partout par défaut (comportement antérieur à ces
 * réglages). L'email est réservé à ce qui engage de l'argent ou demande une
 * action : un email par message privé serait du bruit.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  orders: { email: true, push: true },
  offers: { email: true, push: true },
  messages: { email: false, push: true },
  disputes: { email: true, push: true },
  reviews: { email: false, push: true },
  social: { email: false, push: true }
};

const ALWAYS_DELIVERED = 'system';

/**
 * Catégorie de chaque type de notification (cf. enum de notificationModel).
 * `admin_alert` n'y figure pas volontairement : ces alertes partent déjà sur
 * Discord, les doubler par email inonderait les administrateurs.
 */
const CATEGORY_BY_TYPE: Record<string, NotificationCategory | typeof ALWAYS_DELIVERED> = {
  product_sold: 'orders',
  order_status: 'orders',
  refund_issued: 'orders',
  refund_pending: 'orders',
  offer: 'offers',
  counter_offer: 'offers',
  offer_accepted: 'offers',
  offer_rejected: 'offers',
  message: 'messages',
  dispute_opened: 'disputes',
  dispute_message: 'disputes',
  dispute_resolved: 'disputes',
  rating_received: 'reviews',
  new_follower: 'social',
  wishlist_price_drop: 'social',
  wishlist_unavailable: 'social',
  saved_search_match: 'social',
  system: ALWAYS_DELIVERED,
  product_flagged: ALWAYS_DELIVERED
};

/** Complète les choix stockés avec les défauts. */
export function resolveNotificationPreferences(
  stored?: StoredNotificationPreferences | null
): NotificationPreferences {
  const resolved = {} as NotificationPreferences;
  for (const category of NOTIFICATION_CATEGORIES) {
    resolved[category] = { ...DEFAULT_NOTIFICATION_PREFERENCES[category], ...pickDefined(stored?.[category]) };
  }
  return resolved;
}

/** Un `undefined` stocké ne doit pas écraser le défaut lors de la fusion. */
function pickDefined(channels?: Partial<ChannelPreferences>): Partial<ChannelPreferences> {
  const defined: Partial<ChannelPreferences> = {};
  for (const channel of NOTIFICATION_CHANNELS) {
    if (typeof channels?.[channel] === 'boolean') defined[channel] = channels[channel];
  }
  return defined;
}

/**
 * Canaux externes à utiliser pour une notification, en plus de l'in-app.
 * Un type sans catégorie (alerte admin, type ajouté sans mise à jour de la
 * table) garde le comportement historique : push, jamais d'email non désiré.
 */
export function resolveDeliveryChannels(
  type: string,
  stored?: StoredNotificationPreferences | null
): ChannelPreferences {
  const category = CATEGORY_BY_TYPE[type];
  if (category === ALWAYS_DELIVERED) return { email: true, push: true };
  if (!category) return { email: false, push: true };
  return resolveNotificationPreferences(stored)[category];
}

const channelUpdateSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional()
}).strict();

/**
 * Liste blanche de la mise à jour : toute catégorie ou tout canal inconnu est
 * refusé (400) plutôt qu'ignoré, pour qu'un client désynchronisé le sache.
 */
export const notificationPreferencesUpdateSchema = z.object({
  orders: channelUpdateSchema.optional(),
  offers: channelUpdateSchema.optional(),
  messages: channelUpdateSchema.optional(),
  disputes: channelUpdateSchema.optional(),
  reviews: channelUpdateSchema.optional(),
  social: channelUpdateSchema.optional()
}).strict();

export type NotificationPreferencesUpdate = z.infer<typeof notificationPreferencesUpdateSchema>;
