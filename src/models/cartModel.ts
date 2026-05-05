import mongoose, { Schema, Document } from 'mongoose';

/** Nombre maximum d'articles dans un panier */
export const CART_MAX_ITEMS = 20;

/** Durée de vie d'un panier inactif (7 jours en secondes) */
export const CART_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ICartItem {
  product: mongoose.Types.ObjectId;
  addedAt: Date;
  priceSnapshot: number;
  currencySnapshot: string;
}

export interface ICart extends Document {
  user: mongoose.Types.ObjectId;
  items: ICartItem[];
  updatedAt: Date;
  createdAt: Date;
}

const cartItemSchema = new Schema<ICartItem>({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  addedAt: { type: Date, default: Date.now },
  priceSnapshot: { type: Number, required: true },
  currencySnapshot: { type: String, required: true }
}, { _id: false });

const cartSchema = new Schema<ICart>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: { type: [cartItemSchema], default: [] }
}, { timestamps: true });

cartSchema.index({ user: 1 });
// TTL : supprime automatiquement les paniers inactifs depuis 7 jours
cartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: CART_TTL_SECONDS });

export default mongoose.model<ICart>('Cart', cartSchema);
