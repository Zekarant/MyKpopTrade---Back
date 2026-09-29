import { Types } from 'mongoose';
import User, { IUser } from '../../models/userModel';
import Product, { IProduct } from '../../models/productModel';

let uniqueCounter = 0;

/**
 * Crée un utilisateur minimal avec des valeurs par défaut uniques.
 * Toutes les propriétés peuvent être surchargées via `overrides`.
 */
export async function createTestUser(overrides: Partial<IUser> = {}) {
  uniqueCounter += 1;
  const suffix = `${Math.random().toString(36).substring(2, 8)}${uniqueCounter}`;

  const defaults = {
    username: `u_${suffix}`,
    email: `u_${suffix}@test.com`,
    password: 'Password1!',
    isActive: true,
    accountStatus: 'active',
    verificationLevel: 'none'
  } satisfies Partial<IUser>;

  return await User.create({ ...defaults, ...overrides });
}

/**
 * Crée un produit minimal rattaché à un vendeur.
 */
export async function createTestProduct(sellerId: Types.ObjectId | string, overrides: Partial<IProduct> = {}) {
  uniqueCounter += 1;

  const defaults = {
    seller: new Types.ObjectId(sellerId),
    title: 'Photocard BTS Jungkook',
    description: 'Photocard officielle en excellent état',
    price: 20,
    currency: 'EUR',
    condition: 'likeNew',
    category: 'photocard',
    type: 'photocard',
    kpopGroup: 'BTS',
    images: ['/uploads/products/test.jpg'],
    isAvailable: true,
    views: 0,
    favorites: 0
  } satisfies Partial<IProduct>;

  return await Product.create({ ...defaults, ...overrides });
}
