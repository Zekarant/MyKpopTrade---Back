import mongoose from 'mongoose';
import Conversation from '../../../models/conversationModel';
import Product from '../../../models/productModel';
import { sendMessage } from './messageService';
import logger from '../../../commons/utils/logger';

/**
 * Démarre une négociation sur un produit
 */
export const startNegotiation = async ({
  productId,
  buyerId,
  initialOffer,
  message = ''
}: {
  productId: string;
  buyerId: string;
  initialOffer: number;
  message?: string;
}): Promise<any> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Récupérer le produit et vérifier qu'il existe
    const product = await Product.findById(productId).populate('seller');

    if (!product) {
      throw new Error('Produit non trouvé');
    }

    if (product.seller._id.toString() === buyerId) {
      throw new Error('Vous ne pouvez pas négocier votre propre produit');
    }

    if (!product.allowOffers) {
      throw new Error('Ce produit n\'accepte pas les offres');
    }

    if (product.price <= 0) {
      throw new Error('Impossible de négocier sur un produit gratuit');
    }

    if (initialOffer <= 0) {
      throw new Error('L\'offre doit être supérieure à zéro');
    }

    // Calculer le pourcentage de l'offre par rapport au prix
    const offerPercentage = (initialOffer / product.price) * 100;

    // Vérifier si l'offre est trop basse
    const minOfferPercentage = 50;
    if (offerPercentage < minOfferPercentage) {
      throw new Error(`L'offre est trop basse. Elle doit être au moins ${minOfferPercentage}% du prix demandé.`);
    }

    const conversationData: any = {
      participants: [buyerId, product.seller._id.toString()],
      productId,
      type: 'negotiation',
      title: `Négociation: ${product.title}`,
      createdBy: buyerId,
      negotiation: {
        initialPrice: product.price,
        currentOffer: initialOffer,
        status: 'pending',
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
      },
      offerHistory: [{
        offeredBy: buyerId,
        amount: initialOffer,
        offerType: 'initial',
        status: 'pending',
        message: message || '',
        createdAt: new Date()
      }]
    };

    const conversation = await Conversation.create([conversationData], { session });

    // Envoyer un message système pour indiquer le début de la négociation
    await sendMessage({
      conversationId: conversation[0]._id,
      senderId: buyerId,
      content: `Une offre de ${initialOffer} € a été faite pour ce produit`,
      contentType: 'offer',
      metadata: {
        offerAmount: initialOffer,
        negotiationAction: 'initial_offer'
      },
      encrypt: false
    });

    // Envoyer un message utilisateur si fourni
    if (message.trim()) {
      await sendMessage({
        conversationId: conversation[0]._id,
        senderId: buyerId,
        content: message,
        contentType: 'text'
      });
    }

    await session.commitTransaction();

    return conversation[0];
  } catch (error) {
    await session.abortTransaction();
    logger.error('Erreur lors de la création d\'une négociation', { error });
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Répond à une offre dans une négociation
 */
export const respondToOffer = async ({
  conversationId,
  userId,
  action,
  counterOffer,
  message = ''
}: {
  conversationId: string;
  userId: string;
  action: 'accept' | 'counter' | 'reject';
  counterOffer?: number;
  message?: string;
}): Promise<any> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Récupérer la conversation et vérifier qu'elle existe
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
      type: 'negotiation',
      'negotiation.status': 'pending'
    });

    if (!conversation) {
      throw new Error('Négociation non trouvée ou déjà finalisée');
    }

    // Récupérer le produit associé
    const product = await Product.findById(conversation.productId);
    if (!product) {
      throw new Error('Produit non trouvé');
    }

    // Vérifier que l'utilisateur est bien le vendeur
    if (product.seller.toString() !== userId) {
      throw new Error('Seul le vendeur peut répondre à cette offre');
    }

    // Traiter l'action demandée
    let content = '';
    let contentType: 'text' | 'system_notification' | 'offer' | 'counter_offer' | 'shipping_update' = 'system_notification';
    let metadata = {};
    let updateData: any = {};

    switch (action) {
      case 'accept':
        content = `Offre de ${conversation.negotiation!.currentOffer} € acceptée !`;
        metadata = {
          offerAmount: conversation.negotiation!.currentOffer,
          negotiationAction: 'accept'
        };
        updateData = {
          'negotiation.status': 'accepted',
          'offerHistory.$[elem].status': 'accepted',
          'offerHistory.$[elem].respondedAt': new Date()
        };
        break;

      case 'counter':
        if (!counterOffer || counterOffer <= 0) {
          throw new Error('Contre-offre invalide');
        }

        if (counterOffer <= conversation.negotiation!.currentOffer) {
          throw new Error('La contre-offre doit être supérieure à l\'offre actuelle');
        }

        if (counterOffer >= product.price) {
          throw new Error('La contre-offre ne peut pas être supérieure au prix initial');
        }

        content = `Contre-offre de ${counterOffer} € proposée`;
        contentType = 'counter_offer';
        metadata = {
          offerAmount: counterOffer,
          negotiationAction: 'counter'
        };
        updateData = {
          'negotiation.counterOffer': counterOffer,
          'negotiation.expiresAt': new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          $push: {
            offerHistory: {
              offeredBy: userId,
              amount: counterOffer,
              offerType: 'counter',
              status: 'pending',
              message: message || '',
              createdAt: new Date()
            }
          }
        };
        break;

      case 'reject':
        content = 'Offre refusée';
        metadata = {
          negotiationAction: 'reject'
        };
        updateData = {
          'negotiation.status': 'rejected',
          'offerHistory.$[elem].status': 'rejected',
          'offerHistory.$[elem].respondedAt': new Date()
        };
        break;

      default:
        throw new Error('Action non reconnue');
    }

    // Mettre à jour la conversation avec arrayFilters pour cibler la dernière offre
    const updateOptions: any = { session };
    if (action === 'accept' || action === 'reject') {
      updateOptions.arrayFilters = [{ 'elem.status': 'pending' }];
    }

    await Conversation.updateOne(
      { _id: conversationId },
      updateData,
      updateOptions
    );

    // Envoyer un message système
    await sendMessage({
      conversationId,
      senderId: userId,
      content,
      contentType,
      metadata,
      encrypt: false
    });

    // Envoyer un message supplémentaire si fourni
    if (message.trim()) {
      await sendMessage({
        conversationId,
        senderId: userId,
        content: message,
        contentType: 'text'
      });
    }

    await session.commitTransaction();

    return {
      action,
      status: action === 'counter' ? 'pending' : action === 'accept' ? 'accepted' : 'rejected',
      counterOffer: action === 'counter' ? counterOffer : undefined
    };
  } catch (error) {
    await session.abortTransaction();
    logger.error('Erreur lors de la réponse à une offre', { error });
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Démarre une négociation de type "Pay What You Want"
 */
export const startPayWhatYouWant = async ({
  productId,
  sellerId,
  minimumPrice,
  maximumPrice,
  message = ''
}: {
  productId: string;
  sellerId: string;
  minimumPrice: number;
  maximumPrice?: number;
  message?: string;
}): Promise<any> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Vérifier que le produit existe et appartient au vendeur
    const product = await Product.findOne({
      _id: productId,
      seller: sellerId
    });

    if (!product) {
      throw new Error('Produit non trouvé ou vous n\'êtes pas le vendeur');
    }

    if (minimumPrice < 0) {
      throw new Error('Le prix minimum ne peut pas être négatif');
    }

    // Créer une conversation Pay What You Want avec offerHistory initialisé
    const conversationData: any = {
      participants: [sellerId],
      productId,
      type: 'pay_what_you_want',
      title: `PWYW: ${product.title}`,
      createdBy: sellerId,
      payWhatYouWant: {
        minimumPrice,
        maximumPrice,
        status: 'pending'
      },
      offerHistory: []
    };

    const conversation = await Conversation.create([conversationData], { session });

    // Mettre à jour le produit pour indiquer qu'il accepte le PWYW
    await Product.updateOne(
      { _id: productId },
      {
        isPayWhatYouWant: true,
        pwywMinPrice: minimumPrice,
        pwywMaxPrice: maximumPrice || null
      },
      { session }
    );

    // Envoyer un message système
    await sendMessage({
      conversationId: conversation[0]._id,
      senderId: sellerId,
      content: `Option "Pay What You Want" activée avec un prix minimum de ${minimumPrice} €${maximumPrice ? ` et un maximum de ${maximumPrice} €` : ''}`,
      contentType: 'system_notification',
      metadata: {
        negotiationAction: 'pwyw_start',
        minimumPrice,
        maximumPrice
      },
      encrypt: false
    });

    // Ajouter un message explicatif si fourni
    if (message.trim()) {
      await sendMessage({
        conversationId: conversation[0]._id,
        senderId: sellerId,
        content: message,
        contentType: 'text'
      });
    }

    await session.commitTransaction();

    return conversation[0];
  } catch (error) {
    await session.abortTransaction();
    logger.error('Erreur lors de la création d\'une option Pay What You Want', { error });
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Faire une proposition dans une conversation Pay What You Want
 */
export const makePayWhatYouWantOffer = async ({
  conversationId,
  buyerId,
  proposedPrice,
  message = ''
}: {
  conversationId: string;
  buyerId: string;
  proposedPrice: number;
  message?: string;
}): Promise<any> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Récupérer la conversation PWYW
    const conversation = await Conversation.findOne({
      _id: conversationId,
      type: 'pay_what_you_want',
      'payWhatYouWant.status': 'pending'
    });

    if (!conversation) {
      throw new Error('Option Pay What You Want non trouvée ou déjà finalisée');
    }

    // Récupérer le produit associé
    const product = await Product.findById(conversation.productId);
    if (!product) {
      throw new Error('Produit non trouvé');
    }

    // Vérifier que l'utilisateur n'est pas le vendeur
    if (product.seller.toString() === buyerId) {
      throw new Error('Vous ne pouvez pas faire une offre sur votre propre produit');
    }

    // Vérifier que le prix proposé respecte le minimum requis
    if (proposedPrice < conversation.payWhatYouWant!.minimumPrice) {
      throw new Error(`Le prix proposé doit être au moins ${conversation.payWhatYouWant!.minimumPrice} €`);
    }

    // Vérifier que le prix proposé ne dépasse pas le maximum si défini
    if (conversation.payWhatYouWant!.maximumPrice &&
      proposedPrice > conversation.payWhatYouWant!.maximumPrice) {
      throw new Error(`Le prix proposé ne peut pas dépasser ${conversation.payWhatYouWant!.maximumPrice} €`);
    }

    // Ajouter l'acheteur à la conversation s'il n'y est pas déjà
    if (!conversation.participants.includes(buyerId as any)) {
      await Conversation.updateOne(
        { _id: conversationId },
        { $addToSet: { participants: buyerId } },
        { session }
      );
    }

    // Mettre à jour la conversation avec le prix proposé ET ajouter à l'historique
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: { 'payWhatYouWant.proposedPrice': proposedPrice },
        // Ajouter l'offre à l'historique
        $push: {
          offerHistory: {
            offeredBy: buyerId,
            amount: proposedPrice,
            offerType: 'initial',
            status: 'pending',
            message: message || '',
            createdAt: new Date()
          }
        }
      },
      { session }
    );

    // Envoyer un message système
    await sendMessage({
      conversationId,
      senderId: buyerId,
      content: `Une offre de ${proposedPrice} € a été proposée`,
      contentType: 'offer',
      metadata: {
        offerAmount: proposedPrice,
        negotiationAction: 'pwyw_offer'
      },
      encrypt: false
    });

    // Ajouter un message explicatif si fourni
    if (message.trim()) {
      await sendMessage({
        conversationId,
        senderId: buyerId,
        content: message,
        contentType: 'text'
      });
    }

    await session.commitTransaction();

    return {
      conversationId,
      proposedPrice,
      status: 'pending'
    };
  } catch (error) {
    await session.abortTransaction();
    logger.error('Erreur lors de la proposition d\'un prix PWYW', { error });
    throw error;
  } finally {
    session.endSession();
  }
};