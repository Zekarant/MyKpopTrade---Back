import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../models/productModel';
import Conversation from '../models/conversationModel';

/**
 * Migration idempotente : retire des documents les champs que le code
 * n'utilise plus.
 *  - Produits : la réservation pendant le paiement a été supprimée
 *    (`isReserved`, `reservedFor`, `reservedUntil`). Une réservation restée
 *    posée bloquerait sinon l'article dans les anciennes versions du front.
 *  - Conversations : le type `pay_what_you_want` n'est plus créé, une
 *    proposition de prix libre suit le circuit d'une négociation. Les
 *    anciennes deviennent des négociations, que la validation accepte encore.
 *
 * Passe par le driver : Mongoose ignore les chemins absents du schéma.
 *
 *   npm run migrate:legacy-fields
 */
export async function dropLegacyFields(): Promise<{ products: number; conversations: number }> {
  const products = await Product.collection.updateMany(
    { $or: [{ isReserved: { $exists: true } }, { reservedFor: { $exists: true } }, { reservedUntil: { $exists: true } }] },
    { $unset: { isReserved: '', reservedFor: '', reservedUntil: '' } }
  );
  const conversations = await Conversation.collection.updateMany(
    { $or: [{ type: 'pay_what_you_want' }, { payWhatYouWant: { $exists: true } }] },
    [{
      $set: { type: { $cond: [{ $eq: ['$type', 'pay_what_you_want'] }, 'negotiation', '$type'] } }
    }, {
      $unset: 'payWhatYouWant'
    }]
  );
  return { products: products.modifiedCount, conversations: conversations.modifiedCount };
}

async function main() {
  dotenv.config({ path: '.env.local', quiet: true });
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');
    const cleaned = await dropLegacyFields();
    console.log(`${cleaned.products} produit(s) et ${cleaned.conversations} conversation(s) nettoyé(s).`);
  } catch (error) {
    console.error('Erreur:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  void main();
}
