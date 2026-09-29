import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Post from '../modules/posts/model';

/**
 * Migration idempotente : réécrit les chemins d'images des publications de
 * /uploads/posts/ (non servi) vers /uploads/products/, où sont les fichiers.
 *
 *   npm run fix:post-images
 */
const BROKEN_PREFIX = '/uploads/posts/';
const SERVED_PREFIX = '/uploads/products/';

/** Réécrit les chemins cassés sur la connexion courante ; rend le nombre de publications corrigées. */
export async function fixPostImagePaths(): Promise<number> {
  const result = await Post.updateMany(
    { images: { $regex: `^${BROKEN_PREFIX}` } },
    [{
      $set: {
        images: {
          $map: {
            input: '$images',
            as: 'image',
            in: { $replaceOne: { input: '$$image', find: BROKEN_PREFIX, replacement: SERVED_PREFIX } }
          }
        }
      }
    }]
  );
  return result.modifiedCount;
}

async function main() {
  dotenv.config({ path: '.env.local' });
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');
    const fixed = await fixPostImagePaths();
    console.log(`${fixed} publication(s) corrigée(s).`);
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
