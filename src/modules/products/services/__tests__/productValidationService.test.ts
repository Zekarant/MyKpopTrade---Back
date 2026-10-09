import { validateProductData, validateProductUpdate } from '../productValidationService';

/** Annonce telle que l'envoie le formulaire multipart de création (tout en texte). */
const multipartProduct = (overrides: Record<string, unknown> = {}) => ({
  title: 'Photocard Jungkook',
  description: 'Photocard officielle, jamais sortie de son sleeve',
  price: '12.5',
  currency: 'EUR',
  condition: 'likeNew',
  category: 'photocard',
  type: 'photocard',
  kpopGroup: 'BTS',
  kpopMember: '',
  albumName: '',
  allowOffers: 'true',
  shippingOptions: { worldwide: false, nationalOnly: true, localPickup: false, nationalCost: 2 },
  images: ['/uploads/products/a.jpg'],
  ...overrides
});

describe('validateProductData', () => {
  it('convertit les nombres et booléens envoyés en texte par le formulaire', () => {
    const { value, error } = validateProductData(multipartProduct());

    expect(error).toBeUndefined();
    expect(value).toMatchObject({ price: 12.5, allowOffers: true });
  });

  it('applique les valeurs par défaut de la création', () => {
    const { value } = validateProductData(multipartProduct({
      currency: undefined,
      allowOffers: undefined,
      shippingOptions: undefined
    }));

    expect(value).toMatchObject({
      currency: 'EUR',
      allowOffers: false,
      shippingOptions: { worldwide: false, nationalOnly: true, localPickup: false }
    });
  });

  it.each([
    ['title', 'Le titre est obligatoire'],
    ['price', 'Le prix est obligatoire'],
    ['condition', 'La condition est obligatoire'],
    ['kpopGroup', 'Le groupe K-pop est obligatoire']
  ])('signale le champ obligatoire manquant (%s)', (field, message) => {
    expect(validateProductData(multipartProduct({ [field]: undefined })).error).toBe(message);
  });

  it('refuse un prix vide plutôt que d\'y voir zéro', () => {
    expect(validateProductData(multipartProduct({ price: '' })).error).toBe('Le prix doit être un nombre');
  });

  it('refuse un champ inconnu', () => {
    expect(validateProductData(multipartProduct({ isPayWhatYouWant: true })).error).toMatch(/isPayWhatYouWant/);
  });

  it('refuse plus de 10 images', () => {
    const images = Array.from({ length: 11 }, (_, i) => `/uploads/products/${i}.jpg`);

    expect(validateProductData(multipartProduct({ images })).error).toBe('Maximum 10 images autorisées');
  });
});

describe('validateProductUpdate', () => {
  it('accepte une mise à jour partielle sans y ajouter de valeur par défaut', () => {
    expect(validateProductUpdate({ isAvailable: true })).toEqual({ value: { isAvailable: true } });
  });

  it('applique aux champs présents les règles de la création', () => {
    expect(validateProductUpdate({ description: 'court' }).error).toBe(
      'La description doit contenir au moins 10 caractères'
    );
  });
});
