import path from 'path';
import { rm } from 'fs/promises';
import mongoose from 'mongoose';
import Product from '../../../models/productModel';
import { assertOwner, badRequest, notFound } from '../../../commons/utils/httpError';

/** Même plafond que l'envoi d'images à la création d'une annonce. */
export const MAX_PRODUCT_IMAGES = 10;

const PRODUCT_UPLOADS_DIR = path.resolve(__dirname, '../../../../uploads/products');

function assertValidProductId(productId: string): void {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    throw badRequest('ID de produit invalide');
  }
}

/** Annonce appartenant à l'utilisateur, sinon 404 / 403. */
async function findOwnedProduct(productId: string, userId: string) {
  const product = await Product.findById(productId);
  if (!product) throw notFound('Produit non trouvé');
  assertOwner(product.seller, userId, 'Vous n\'êtes pas autorisé à modifier ce produit');
  return product;
}

/**
 * Efface une image du disque, uniquement si elle est bien dans uploads/products :
 * un chemin stocké hors de ce dossier n'est jamais effacé.
 */
async function removeStoredImage(imagePath: string): Promise<void> {
  const fullPath = path.resolve(PRODUCT_UPLOADS_DIR, path.basename(imagePath));
  if (fullPath.startsWith(PRODUCT_UPLOADS_DIR + path.sep)) {
    await rm(fullPath, { force: true });
  }
}

/**
 * Ajoute à l'annonce l'image reçue par multer (déjà écrite sur le disque).
 * Si l'image n'est pas ajoutée (refus ou erreur), son fichier est effacé.
 *
 * @throws HttpError 400 (identifiant invalide, plafond atteint), 404, 403.
 */
export async function addProductImage({
  productId,
  userId,
  uploadedFilePath
}: {
  productId: string;
  userId: string;
  uploadedFilePath: string;
}): Promise<{ image: string; images: string[] }> {
  try {
    assertValidProductId(productId);
    const product = await findOwnedProduct(productId, userId);

    if (product.images.length >= MAX_PRODUCT_IMAGES) {
      throw badRequest(`Nombre maximum d'images atteint (${MAX_PRODUCT_IMAGES})`, 'PRODUCT_IMAGE_LIMIT_REACHED');
    }

    const image = `/uploads/products/${path.basename(uploadedFilePath)}`;
    product.images.push(image);
    await product.save();
    return { image, images: product.images };
  } catch (error) {
    await rm(uploadedFilePath, { force: true });
    throw error;
  }
}

/**
 * Retire une image de l'annonce et l'efface du disque. La dernière image ne
 * peut pas être retirée : une annonce en a toujours au moins une.
 *
 * @throws HttpError 400 (identifiant ou index invalide, dernière image), 404, 403.
 */
export async function deleteProductImage({
  productId,
  userId,
  imageIndex
}: {
  productId: string;
  userId: string;
  imageIndex: number;
}): Promise<string[]> {
  assertValidProductId(productId);
  const product = await findOwnedProduct(productId, userId);

  if (imageIndex >= product.images.length) {
    throw badRequest('Index d\'image invalide');
  }
  if (product.images.length <= 1) {
    throw badRequest('Impossible de supprimer la dernière image du produit', 'LAST_PRODUCT_IMAGE');
  }

  const [removedImage] = product.images.splice(imageIndex, 1);
  await removeStoredImage(removedImage);
  await product.save();
  return product.images;
}

/**
 * Réordonne les images : `imageOrder[i]` est l'index actuel de l'image à placer
 * en position i. L'ordre doit citer chaque image une fois : un doublon en
 * effacerait une autre de l'annonce.
 *
 * @throws HttpError 400 (identifiant ou ordre invalide), 404, 403.
 */
export async function reorderProductImages({
  productId,
  userId,
  imageOrder
}: {
  productId: string;
  userId: string;
  imageOrder: number[];
}): Promise<string[]> {
  assertValidProductId(productId);
  const product = await findOwnedProduct(productId, userId);

  const currentImages = [...product.images];
  if (
    imageOrder.length !== currentImages.length ||
    new Set(imageOrder).size !== imageOrder.length ||
    imageOrder.some((index) => !Number.isInteger(index) || index < 0 || index >= currentImages.length)
  ) {
    throw badRequest('Ordre des images invalide');
  }

  product.images = imageOrder.map((index) => currentImages[index]);
  await product.save();
  return product.images;
}
