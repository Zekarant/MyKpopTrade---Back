import { validateFileType, formatCategory, generateMessagePreview } from '../messagingUtilsService';

describe('messagingUtilsService.validateFileType', () => {
  it('accepte les images JPEG, PNG, GIF, WebP', () => {
    expect(validateFileType('image/jpeg')).toBe(true);
    expect(validateFileType('image/png')).toBe(true);
    expect(validateFileType('image/gif')).toBe(true);
    expect(validateFileType('image/webp')).toBe(true);
  });

  it('accepte PDF et texte', () => {
    expect(validateFileType('application/pdf')).toBe(true);
    expect(validateFileType('text/plain')).toBe(true);
  });

  it('refuse les types non supportés', () => {
    expect(validateFileType('application/javascript')).toBe(false);
    expect(validateFileType('video/mp4')).toBe(false);
    expect(validateFileType('image/bmp')).toBe(false);
    expect(validateFileType('')).toBe(false);
  });
});

describe('messagingUtilsService.formatCategory', () => {
  it('mappe les catégories connues vers leur libellé FR', () => {
    expect(formatCategory('album')).toBe('Album');
    expect(formatCategory('photocard')).toBe('Photocard');
    expect(formatCategory('clothing')).toBe('Vêtements');
    expect(formatCategory('limited_edition')).toBe('Édition Limitée');
  });

  it('retourne la catégorie brute si inconnue', () => {
    expect(formatCategory('unknown_cat')).toBe('unknown_cat');
    expect(formatCategory('')).toBe('');
  });

  it('ne tombe pas sur le prototype pour une clé comme « constructor »', () => {
    expect(formatCategory('constructor')).toBe('constructor');
  });
});

describe('messagingUtilsService.generateMessagePreview', () => {
  it('retourne une chaîne vide pour null/undefined', () => {
    expect(generateMessagePreview(null)).toBe('');
    expect(generateMessagePreview(undefined)).toBe('');
  });

  it('indique un message chiffré', () => {
    expect(generateMessagePreview({ isEncrypted: true, content: 'xxx' })).toBe('[Message chiffré]');
  });

  it('affiche le contenu brut des notifications système', () => {
    const msg = { contentType: 'system_notification', content: 'Offre acceptée' };
    expect(generateMessagePreview(msg)).toBe('Offre acceptée');
  });

  it('utilise des icônes pour offer / counter_offer / shipping_update', () => {
    expect(generateMessagePreview({ contentType: 'offer', content: 'x' })).toBe('💰 Nouvelle offre');
    expect(generateMessagePreview({ contentType: 'counter_offer', content: 'x' })).toBe('🔄 Contre-offre');
    expect(generateMessagePreview({ contentType: 'shipping_update', content: 'x' })).toBe('📦 Mise à jour expédition');
  });

  it('tronque les messages texte longs à 50 caractères + ellipse', () => {
    const longText = 'a'.repeat(100);
    const preview = generateMessagePreview({ contentType: 'text', content: longText });
    expect(preview).toBe('a'.repeat(50) + '...');
    expect(preview.length).toBe(53);
  });

  it('laisse intact les messages texte courts', () => {
    const preview = generateMessagePreview({ contentType: 'text', content: 'Salut !' });
    expect(preview).toBe('Salut !');
  });
});
