/**
 * Projections des membres exposés par `populate` dans les réponses publiques
 * (participants, vendeurs, auteurs, expéditeurs, auteurs d'avis…). Une seule
 * définition, pour qu'aucune copie n'expose un champ privé de plus (email,
 * téléphone, adresse, statut du compte) sans que ce soit visible ici.
 * Les listes qui exposent volontairement d'autres champs (vue admin, détail
 * d'une conversation, signalements) restent déclarées dans leur service.
 */

/** Carte d'un membre : pseudo et avatar. */
export const USER_CARD_FIELDS = 'username profilePicture';

/** Auteur d'un post ou vendeur : ajoute le badge d'identité vérifiée. */
export const VERIFIED_USER_CARD_FIELDS = `${USER_CARD_FIELDS} isIdentityVerified`;

/** Vendeur d'une annonce dans les listes : ajoute sa note moyenne. */
export const SELLER_CARD_FIELDS = `${VERIFIED_USER_CARD_FIELDS} statistics.averageRating`;
