import { createHash } from 'crypto';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import Conversation from '../../../models/conversationModel';
import { NotificationService } from '../../notifications/services/notificationService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

async function loadUserOr404(userId: string) {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }
  return user;
}

export async function updateConsents(userId: string, {
  privacyPolicy,
  dataProcessing,
  marketing
}: {
  privacyPolicy?: boolean;
  dataProcessing?: boolean;
  marketing?: boolean;
}) {
  const user = await loadUserOr404(userId);

  const now = new Date();

  if (privacyPolicy !== undefined) {
    user.privacyPolicyAccepted = privacyPolicy;
    if (privacyPolicy) {
      user.privacyPolicyAcceptedAt = now;
    }
  }

  if (dataProcessing !== undefined) {
    user.dataProcessingConsent = dataProcessing;
    if (dataProcessing) {
      user.dataProcessingConsentAt = now;
    }
  }

  if (marketing !== undefined) {
    user.marketingConsent = marketing;
    if (marketing) {
      user.marketingConsentAt = now;
    }
  }

  await user.save();

  logger.info('Consentements RGPD mis à jour', {
    userId: userId.substring(0, 5) + '...',
    privacyPolicy: user.privacyPolicyAccepted,
    dataProcessing: user.dataProcessingConsent,
    marketing: user.marketingConsent
  });

  return {
    privacyPolicy: user.privacyPolicyAccepted,
    privacyPolicyAcceptedAt: user.privacyPolicyAcceptedAt,
    dataProcessing: user.dataProcessingConsent,
    dataProcessingConsentAt: user.dataProcessingConsentAt,
    marketing: user.marketingConsent,
    marketingConsentAt: user.marketingConsentAt
  };
}

export async function buildUserDataExport(userId: string) {
  const user = await User.findById(userId).select('-password');
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const [buyerPayments, sellerPayments, products, conversations] = await Promise.all([
    Payment.find({ buyer: userId })
      .select('-__v')
      .populate('product', 'title price currency'),

    Payment.find({ seller: userId })
      .select('-__v')
      .populate('product', 'title price currency'),

    Product.find({ seller: userId }).select('-__v'),

    Conversation.find({ participants: userId }).select('title createdAt updatedAt')
  ]);

  const userData = {
    personnalInformation: {
      id: user._id,
      username: user.username,
      email: user.email,
      paypalEmail: user.paypalEmail,
      profilePicture: user.profilePicture,
      createdAt: user.createdAt,
      lastLogin: user.lastLoginAt,
      consents: {
        privacyPolicy: user.privacyPolicyAccepted,
        privacyPolicyAcceptedAt: user.privacyPolicyAcceptedAt,
        dataProcessing: user.dataProcessingConsent,
        dataProcessingConsentAt: user.dataProcessingConsentAt,
        marketing: user.marketingConsent,
        marketingConsentAt: user.marketingConsentAt
      }
    },
    payments: {
      asBuyer: buyerPayments,
      asSeller: sellerPayments
    },
    products,
    conversations
  };

  const fileName = `user-data-${createHash('sha256').update(userId).digest('hex').substring(0, 8)}-${Date.now()}.json`;

  logger.info('Export de données personnelles effectué', {
    userId: userId.substring(0, 5) + '...'
  });

  return { userData, fileName };
}

export async function scheduleAccountDeletion(userId: string, confirmation: unknown) {
  if (confirmation !== true) {
    throw new HttpError(400, 'Veuillez confirmer votre demande de suppression');
  }

  const user = await loadUserOr404(userId);

  const pendingPayments = await Payment.countDocuments({
    $or: [
      { buyer: userId, status: 'pending' },
      { seller: userId, status: 'pending' }
    ]
  });

  if (pendingPayments > 0) {
    throw new HttpError(
      400,
      'Impossible de supprimer votre compte car vous avez des paiements en cours. Veuillez les finaliser d\'abord.'
    );
  }

  const deletionDate = new Date();
  deletionDate.setDate(deletionDate.getDate() + 30);

  user.scheduledForDeletion = true;
  user.scheduledDeletionDate = deletionDate;
  await user.save();

  logger.info('Demande de suppression de compte reçue', {
    userId: userId.substring(0, 5) + '...',
    scheduledDeletionDate: deletionDate
  });

  await NotificationService.createNotification({
    recipientId: userId,
    type: 'system',
    title: 'Demande de suppression de compte',
    content: `Votre demande de suppression a été enregistrée. Votre compte sera supprimé le ${deletionDate.toLocaleDateString()}.`,
    link: '/account/settings',
    data: {
      scheduledDeletionDate: deletionDate
    }
  });

  return deletionDate;
}

export async function cancelAccountDeletion(userId: string) {
  const user = await loadUserOr404(userId);

  if (!user.scheduledForDeletion) {
    throw new HttpError(400, 'Aucune demande de suppression n\'est en cours pour ce compte');
  }

  user.scheduledForDeletion = false;
  user.scheduledDeletionDate = undefined;
  await user.save();

  logger.info('Demande de suppression de compte annulée', {
    userId: userId.substring(0, 5) + '...'
  });

  await NotificationService.createNotification({
    recipientId: userId,
    type: 'system',
    title: 'Annulation de la demande de suppression',
    content: 'Votre demande de suppression de compte a été annulée avec succès.',
    link: '/account/settings'
  });
}

export async function anonymizeAccount(userId: string, confirmation: unknown) {
  if (confirmation !== true) {
    throw new HttpError(400, 'Veuillez confirmer votre demande d\'anonymisation');
  }

  const user = await loadUserOr404(userId);

  const anonymousId = `anon_${createHash('sha256').update(userId + Date.now().toString()).digest('hex').substring(0, 10)}`;

  user.username = anonymousId;
  user.email = `${anonymousId}@anonymized.com`;
  user.paypalEmail = undefined;
  user.profilePicture = 'https://mykpoptrade.com/images/avatar-default.png';
  user.anonymized = true;

  user.marketingConsent = false;

  await user.save();

  logger.info('Données utilisateur anonymisées', {
    userId: userId.substring(0, 5) + '...'
  });
}
