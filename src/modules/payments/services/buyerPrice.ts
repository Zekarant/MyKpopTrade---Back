import type { IProduct } from '../../../models/productModel';

export type BuyerPricedProduct = Pick<IProduct, 'price'> & {
  negotiations?: IProduct['negotiations'] | null;
};

/**
 * Prix produit (hors livraison) réellement facturé à un acheteur : le montant
 * de sa négociation acceptée s'il en a une, sinon le prix catalogue.
 *
 * Seule source de vérité du paiement direct et du panier, pour que le total
 * affiché dans le panier et le montant PayPal ne puissent pas diverger.
 */
export function resolveBuyerPrice(product: BuyerPricedProduct, buyerId: string): number {
  const acceptedNegotiation = product.negotiations?.find(
    (neg) => neg.buyer?.toString() === buyerId && neg.status === 'accepted'
  );
  // Montant accepté ; counterOffer n'est qu'une étape de la négociation.
  return acceptedNegotiation ? acceptedNegotiation.currentOffer : product.price;
}
