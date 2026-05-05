import mongoose from 'mongoose';
import Cart, { CART_MAX_ITEMS, ICartItem } from '../../../models/cartModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export async function getCart(userId: string) {
  let cart = await Cart.findOne({ user: userId }).populate('items.product', 'title images price currency isAvailable isSold seller');
  if (!cart) {
    cart = await Cart.create({ user: userId, items: [] });
  }
  return cart;
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

  return cart.populate('items.product', 'title images price currency isAvailable isSold seller');
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

  return cart.populate('items.product', 'title images price currency isAvailable isSold seller');
}

export async function clearCart(userId: string) {
  const cart = await Cart.findOne({ user: userId });
  if (!cart) return;
  cart.items = [];
  await cart.save();
}

export async function validateCart(userId: string) {
  const cart = await Cart.findOne({ user: userId }).populate('items.product', 'price currency isAvailable isSold seller');
  if (!cart || cart.items.length === 0) {
    return { valid: true, issues: [] as string[], validItems: [] as ICartItem[], cart };
  }

  const issues: string[] = [];
  const validItems: typeof cart.items = [];

  for (const item of cart.items) {
    const product = item.product as any;
    if (!product) {
      issues.push(`Produit supprimé`);
      continue;
    }
    if (!product.isAvailable || product.isSold) {
      issues.push(`"${product.title}" n'est plus disponible`);
      continue;
    }
    if (product.price !== item.priceSnapshot || product.currency !== item.currencySnapshot) {
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
