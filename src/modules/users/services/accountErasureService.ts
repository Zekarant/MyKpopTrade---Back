import crypto from 'crypto';
import User, { IUser } from '../../../models/userModel';
import Product from '../../../models/productModel';
import Cart from '../../../models/cartModel';
import Notification from '../../../models/notificationModel';
import SearchHistory from '../../../models/historicSearchModel';
import PushSubscription from '../../../models/pushSubscriptionModel';
import IdentityVerification from '../../../models/identityVerificationModel';
import Follow from '../../follows/model';
import SavedSearch from '../../savedSearches/model';
import Block from '../../../models/blockModel';
import { deleteSecureDocument } from '../../../commons/services/secureStorageService';
import { invalidateAllUserRefreshTokens } from '../../../commons/services/tokenService';
import { anonymizeBuyerPayments } from '../../payments/services/paymentAnonymizationService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

const DEFAULT_PROFILE_PICTURE = 'https://mykpoptrade.com/images/avatar-default.png';

/** Identifiant affiché à la place du pseudo : ne dérive d'aucune donnée personnelle. */
export const deletedUsernameFor = (userId: string): string => `deleted_${userId.slice(-12)}`;

/**
 * Efface les données personnelles portées par le document utilisateur.
 * Partagé par l'effacement complet et l'anonymisation « compte conservé ».
 */
export function erasePersonalFields(user: IUser, pseudonym: string): void {
  user.username = pseudonym;
  user.email = `${pseudonym}@deleted.local`;
  user.firstName = undefined;
  user.lastName = undefined;
  user.legalName = undefined;
  user.address = undefined;
  user.phoneNumber = undefined;
  user.isPhoneVerified = false;
  user.bio = '';
  user.location = '';
  user.profilePicture = DEFAULT_PROFILE_PICTURE;
  user.profileBanner = '';
  user.socialLinks = { instagram: '', twitter: '', discord: '' };
  // Libère aussi les identifiants Google / Discord / Facebook : la personne
  // doit pouvoir recréer un compte avec eux.
  user.socialAuth = undefined;
  user.paypalEmail = undefined;
  user.paypalMerchantId = undefined;
  user.paypalTrackingId = undefined;
  user.paypalOnboarding = undefined;
  user.paypalConnected = false;
  user.favorites = [];
  user.emailVerificationToken = undefined;
  user.passwordResetToken = undefined;
  user.phoneVerificationCode = undefined;
  user.marketingConsent = false;
  user.anonymized = true;
  user.markModified('socialAuth');
}

/**
 * Effacement RGPD d'un compte (art. 17), choisi comme « anonymisation » :
 * - le document utilisateur est vidé de ses données personnelles et désactivé ;
 * - les données annexes personnelles sont supprimées (sessions, pièce
 *   d'identité, historique de recherche, notifications, abonnements…) ;
 * - les annonces encore en vente sont retirées ;
 * - messages et avis restent visibles, signés par le pseudonyme `deleted_…` ;
 * - les paiements restent pour la comptabilité, anonymisés quand ils sont clos.
 *
 * Point d'entrée unique : suppression par l'utilisateur, confirmation admin,
 * anonymisation admin et échéance des 30 jours.
 */
export async function eraseUserAccount(userId: string): Promise<{ pseudonym: string }> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const pseudonym = deletedUsernameFor(userId);
  erasePersonalFields(user, pseudonym);
  // Mot de passe inutilisable : le compte ne doit plus jamais s'ouvrir.
  user.password = crypto.randomBytes(32).toString('hex');
  user.twoFactor = { enabled: false };
  user.accountStatus = 'deleted';
  user.isActive = false;
  user.scheduledForDeletion = false;
  user.scheduledDeletionDate = undefined;
  // Pseudonyme et email techniques ne respectent pas les validateurs de saisie.
  await user.save({ validateBeforeSave: false });

  const verifications = await IdentityVerification.find({ user: userId }).select('documentReferenceId');
  for (const verification of verifications) {
    try {
      deleteSecureDocument(verification.documentReferenceId);
    } catch (error) {
      logger.error('Pièce d\'identité non supprimée lors de l\'effacement d\'un compte', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await Promise.all([
    invalidateAllUserRefreshTokens(userId),
    IdentityVerification.deleteMany({ user: userId }),
    SearchHistory.deleteMany({ userId }),
    PushSubscription.deleteMany({ user: userId }),
    Notification.deleteMany({ recipient: userId }),
    Cart.deleteOne({ user: userId }),
    Follow.deleteMany({ $or: [{ follower: userId }, { following: userId }] }),
    SavedSearch.deleteMany({ user: userId }),
    Block.deleteMany({ $or: [{ blocker: userId }, { blocked: userId }] }),
    Product.updateMany({ seller: userId, isSold: { $ne: true } }, { $set: { isAvailable: false } }),
    anonymizeBuyerPayments(userId)
  ]);

  logger.info('Compte effacé (RGPD art. 17)', { userId: userId.substring(0, 5) + '...' });
  return { pseudonym };
}

/** Exécute les suppressions programmées arrivées à échéance (délai de rétractation de 30 jours). */
export async function eraseAccountsDueForDeletion(now = new Date()): Promise<number> {
  const due = await User.find({
    scheduledForDeletion: true,
    scheduledDeletionDate: { $lte: now },
    accountStatus: { $ne: 'deleted' }
  }).select('_id');

  let erased = 0;
  for (const { _id } of due) {
    try {
      await eraseUserAccount(String(_id));
      erased++;
    } catch (error) {
      logger.error('Échec de l\'effacement programmé d\'un compte', {
        userId: String(_id).substring(0, 5) + '...',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return erased;
}
