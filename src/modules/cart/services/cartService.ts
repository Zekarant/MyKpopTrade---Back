import mongoose from 'mongoose';
import Cart, { CART_MAX_ITEMS, ICartItem } from '../../../models/cartModel';
import Product, { IProduct } from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import { resolveBuyerPrice } from '../../payments/services/buyerPrice';
import { quoteShipping, ShippingMethod } from '../../payments/services/checkoutService';

/** Article du panier dont le produit est peuplé (null s'il a été supprimé). */
type ValidatedCartItem = Omit<ICartItem, 'product'> & {
  product: Pick<IProduct, '_id' | 'title' | 'price' | 'currency' | 'isAvailable' | 'isSold' | 'seller'> | null;
};

type CartProduct = Pick<IProduct, '_id' | 'title' | 'images' | 'price' | 'currency' | 'isAvailable' | 'isSold' | 'seller'>;

type PricedCartItem = Omit<ICartItem, 'product'> & {
  product: (CartProduct & Pick<IProduct, 'negotiations' | 'shippingOptions'>) | null;
};

/** Article renvoyé au client, avec le prix produit que PayPal facturera. */
export type CartViewItem = Omit<ICartItem, 'product'> & {
  product: CartProduct | null;
  /** Prix négocié accepté s'il existe, sinon prix catalogue (hors livraison). */
  buyerPrice: number;
  /** Frais de port que PayPal ajoutera, par méthode ; `null` si non proposée. */
  shippingCosts: Record<ShippingMethod, number | null> | null;
};

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Charge le panier avec, pour chaque article, le prix facturé à cet acheteur.
 * Les négociations servent au calcul mais ne sont pas renvoyées : elles
 * contiennent les offres des autres acheteurs.
 */
async function loadCartView(userId: string) {
  const cart = await Cart.findOne({ user: userId })
    .populate<{ items: PricedCartItem[] }>('items.product', 'title images price currency isAvailable isSold seller shippingOptions +negotiations')
    .lean();
  if (!cart) return null;

  const items: CartViewItem[] = cart.items.map(({ product, ...item }) => {
    if (!product) return { ...item, product: null, buyerPrice: item.priceSnapshot, shippingCosts: null };
    const { _id, title, images, price, currency, isAvailable, isSold, seller } = product;
    return {
      ...item,
      product: { _id, title, images, price, currency, isAvailable, isSold, seller },
      buyerPrice: resolveBuyerPrice(product, userId),
      shippingCosts: quoteShipping(product)
    };
  });
  return { ...cart, items };
}

async function requireCartView(userId: string) {
  const cart = await loadCartView(userId);
  if (!cart) {
    throw new HttpError(404, 'Panier non trouvé');
  }
  return cart;
}

export async function getCart(userId: string) {
  const cart = await loadCartView(userId);
  if (cart) return cart;
  await Cart.create({ user: userId, items: [] });
  return requireCartView(userId);
}

export async function addItem(userId: string, productId: string) {
  if (!productId || !isValidObjectId(productId)) {
    throw new HttpError(400, 'ID de produit invalide');
  }

  const product = await Product.findById(productId);
  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }
  if (!product.isAvailable || product.isSold) {
    throw new HttpError(400, 'Ce produit n\'est plus disponible');
  }
  if (product.seller.toString() === userId) {
    throw new HttpError(400, 'Vous ne pouvez pas ajouter votre propre produit au panier');
  }

  let cart = await Cart.findOne({ user: userId });
  if (!cart) {
    cart = await Cart.create({ user: userId, items: [] });
  }

  if (cart.items.length >= CART_MAX_ITEMS) {
    throw new HttpError(400, `Le panier est limité à ${CART_MAX_ITEMS} articles`);
  }

  const alreadyInCart = cart.items.some(item => item.product.toString() === productId);
  if (alreadyInCart) {
    throw new HttpError(400, 'Ce produit est déjà dans votre panier');
  }

  cart.items.push({
    product: product._id,
    addedAt: new Date(),
    priceSnapshot: product.price,
    currencySnapshot: product.currency
  });
  await cart.save();

  return requireCartView(userId);
}

export async function removeItem(userId: string, productId: string) {
  if (!productId || !isValidObjectId(productId)) {
    throw new HttpError(400, 'ID de produit invalide');
  }

  const cart = await Cart.findOne({ user: userId });
  if (!cart) {
    throw new HttpError(404, 'Panier non trouvé');
  }

  const idx = cart.items.findIndex(item => item.product.toString() === productId);
  if (idx === -1) {
    throw new HttpError(404, 'Produit non trouvé dans le panier');
  }

  cart.items.splice(idx, 1);
  await cart.save();

  return requireCartView(userId);
}

export async function clearCart(userId: string) {
  const cart = await Cart.findOne({ user: userId });
  if (!cart) return;
  cart.items = [];
  await cart.save();
}

/**
 * Retire du panier les articles que cet utilisateur a achetés. Les autres
 * restent : paiement annulé en cours de checkout multi-vendeurs, ou achat
 * direct d'un produit hors panier.
 */
export async function removePurchasedItems(userId: string) {
  const cart = await Cart.findOne({ user: userId }).select('items.product');
  if (!cart || cart.items.length === 0) return;

  const purchased = await Product.find({
    _id: { $in: cart.items.map(item => item.product) },
    isSold: true,
    soldTo: userId
  }).select('_id');
  if (purchased.length === 0) return;

  await Cart.updateOne(
    { user: userId },
    { $pull: { items: { product: { $in: purchased.map(product => product._id) } } } }
  );
}

export async function validateCart(userId: string) {
  // `title` sert aux messages d'erreur.
  const cart = await Cart.findOne({ user: userId })
    .populate<{ items: ValidatedCartItem[] }>('items.product', 'title price currency isAvailable isSold seller');
  if (!cart || cart.items.length === 0) {
    throw new HttpError(400, 'Panier vide');
  }

  const issues: string[] = [];
  const validItems: typeof cart.items = [];

  // Un prix négocié et accepté ne dépend plus du prix catalogue : son changement ne bloque pas.
  const negotiated = await Product.find({
    _id: { $in: cart.items.flatMap(item => (item.product ? [item.product._id] : [])) },
    negotiations: { $elemMatch: { buyer: userId, status: 'accepted' } }
  }).select('_id').lean();
  const negotiatedIds = new Set(negotiated.map(product => String(product._id)));

  for (const item of cart.items) {
    const product = item.product;
    if (!product) {
      issues.push(`Produit supprimé`);
      continue;
    }
    if (!product.isAvailable || product.isSold) {
      issues.push(`"${product.title}" n'est plus disponible`);
      continue;
    }
    const priceChanged = product.price !== item.priceSnapshot && !negotiatedIds.has(String(product._id));
    if (priceChanged || product.currency !== item.currencySnapshot) {
      issues.push(`Le prix de "${product.title}" a changé (${item.priceSnapshot} ${item.currencySnapshot} → ${product.price} ${product.currency})`);
      continue;
    }
    if (product.seller.toString() === userId) {
      issues.push(`"${product.title}" est votre propre produit`);
      continue;
    }
    validItems.push(item);
  }

  return { valid: issues.length === 0, issues, validItems, cart };
}
