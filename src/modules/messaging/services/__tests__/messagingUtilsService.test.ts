import { MessagingUtilsService } from '../messagingUtilsService';

describe('MessagingUtilsService.validateFileType', () => {
  it('accepte les images JPEG, PNG, GIF, WebP', () => {
    expect(MessagingUtilsService.validateFileType('image/jpeg')).toBe(true);
    expect(MessagingUtilsService.validateFileType('image/png')).toBe(true);
    expect(MessagingUtilsService.validateFileType('image/gif')).toBe(true);
    expect(MessagingUtilsService.validateFileType('image/webp')).toBe(true);
  });

  it('accepte PDF et texte', () => {
    expect(MessagingUtilsService.validateFileType('application/pdf')).toBe(true);
    expect(MessagingUtilsService.validateFileType('text/plain')).toBe(true);
  });

  it('refuse les types non supportés', () => {
    expect(MessagingUtilsService.validateFileType('application/javascript')).toBe(false);
    expect(MessagingUtilsService.validateFileType('video/mp4')).toBe(false);
    expect(MessagingUtilsService.validateFileType('image/bmp')).toBe(false);
    expect(MessagingUtilsService.validateFileType('')).toBe(false);
  });
});

describe('MessagingUtilsService.formatCategory', () => {
  it('mappe les catégories connues vers leur libellé FR', () => {
    expect(MessagingUtilsService.formatCategory('album')).toBe('Album');
    expect(MessagingUtilsService.formatCategory('photocard')).toBe('Photocard');
    expect(MessagingUtilsService.formatCategory('clothing')).toBe('Vêtements');
    expect(MessagingUtilsService.formatCategory('limited_edition')).toBe('Édition Limitée');
  });

  it('retourne la catégorie brute si inconnue', () => {
    expect(MessagingUtilsService.formatCategory('unknown_cat')).toBe('unknown_cat');
    expect(MessagingUtilsService.formatCategory('')).toBe('');
  });
});

describe('MessagingUtilsService.generateMessagePreview', () => {
  it('retourne une chaîne vide pour null/undefined', () => {
    expect(MessagingUtilsService.generateMessagePreview(null)).toBe('');
    expect(MessagingUtilsService.generateMessagePreview(undefined)).toBe('');
  });

  it('indique un message chiffré', () => {
    expect(
      MessagingUtilsService.generateMessagePreview({ isEncrypted: true, content: 'xxx' })
    ).toBe('[Message chiffré]');
  });

  it('affiche le contenu brut des notifications système', () => {
    const msg = { contentType: 'system_notification', content: 'Offre acceptée' };
    expect(MessagingUtilsService.generateMessagePreview(msg)).toBe('Offre acceptée');
  });

  it('utilise des icônes pour offer / counter_offer / shipping_update', () => {
    expect(
      MessagingUtilsService.generateMessagePreview({ contentType: 'offer', content: 'x' })
    ).toBe('💰 Nouvelle offre');
    expect(
      MessagingUtilsService.generateMessagePreview({ contentType: 'counter_offer', content: 'x' })
    ).toBe('🔄 Contre-offre');
    expect(
      MessagingUtilsService.generateMessagePreview({ contentType: 'shipping_update', content: 'x' })
    ).toBe('📦 Mise à jour expédition');
  });

  it('tronque les messages texte longs à 50 caractères + ellipse', () => {
    const longText = 'a'.repeat(100);
    const preview = MessagingUtilsService.generateMessagePreview({
      contentType: 'text',
      content: longText
    });
    expect(preview).toBe('a'.repeat(50) + '...');
    expect(preview.length).toBe(53);
  });

  it('laisse intact les messages texte courts', () => {
    const preview = MessagingUtilsService.generateMessagePreview({
      contentType: 'text',
      content: 'Salut !'
    });
    expect(preview).toBe('Salut !');
  });
});
