import User from '../../../models/userModel';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';

/**
 * Pousse une notification à tous les utilisateurs ayant ce produit dans
 * leur wishlist (User.favorites). Le seller est exclu : il ne se notifie
 * pas lui-même quand il modifie son propre produit.
 */
async function broadcastToWishlistOwners(
  productId: any,
  sellerId: any,
  payload: { type: string; title: string; content: string; link: string; data?: any }
): Promise<number> {
  const owners = await User.find(
    { favorites: productId, _id: { $ne: sellerId } },
    { _id: 1 }
  );

  await Promise.all(
    owners.map((owner) =>
      NotificationService.createNotification({
        recipientId: owner._id,
        type: payload.type,
        title: payload.title,
        content: payload.content,
        link: payload.link,
        data: payload.data
      }).catch((error) => {
        logger.error('Erreur notification wishlist', {
          ownerId: owner._id?.toString(),
          productId: productId?.toString(),
          error: error instanceof Error ? error.message : String(error)
        });
      })
    )
  );

  return owners.length;
}

/**
 * Notifie tous les "wishlisters" qu'un produit a baissé de prix. On
 * suppose que oldPrice > newPrice (l'appelant a déjà vérifié) ; on calcule
 * juste le pourcentage pour le contenu de la notification.
 */
export async function notifyWishlistPriceDrop(
  product: any,
  oldPrice: number,
  newPrice: number
): Promise<void> {
  if (!product?._id || !product?.seller) return;
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) return;
  if (newPrice >= oldPrice) return;

  const dropPct = Math.round(((oldPrice - newPrice) / oldPrice) * 100);

  await broadcastToWishlistOwners(product._id, product.seller, {
    type: 'wishlist_price_drop',
    title: 'Baisse de prix sur un favori',
    content: `${product.title} : ${oldPrice.toFixed(2)} ${product.currency || 'EUR'} → ${newPrice.toFixed(2)} ${product.currency || 'EUR'} (-${dropPct}%)`,
    link: `/products/${product._id}`,
    data: {
      productId: product._id,
      oldPrice,
      newPrice,
      dropPct
    }
  });
}

/**
 * Notifie les wishlisters qu'un produit favori n'est plus disponible
 * (vendu, retiré, ou réservé). Permet à l'utilisateur de nettoyer sa
 * wishlist et de chercher des alternatives.
 */
export async function notifyWishlistUnavailable(
  product: any,
  reason: 'sold' | 'unavailable' | 'reserved'
): Promise<void> {
  if (!product?._id || !product?.seller) return;

  const reasonLabel: Record<string, string> = {
    sold: 'a été vendu',
    unavailable: 'n\'est plus disponible',
    reserved: 'a été réservé'
  };

  await broadcastToWishlistOwners(product._id, product.seller, {
    type: 'wishlist_unavailable',
    title: 'Un favori n\'est plus disponible',
    content: `${product.title} ${reasonLabel[reason]}.`,
    link: `/products/${product._id}`,
    data: {
      productId: product._id,
      reason
    }
  });
}
