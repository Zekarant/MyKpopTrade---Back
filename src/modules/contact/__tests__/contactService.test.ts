import { parseContactMessage } from '../contactService';

describe('parseContactMessage', () => {
  const valid = { name: 'Alice', email: 'alice@exemple.fr', subject: 'Paiement', message: 'Bonjour, une question.' };

  it('accepte et nettoie un message valide', () => {
    const contact = parseContactMessage({ ...valid, name: '  Alice  ' });

    expect(contact).toMatchObject({ name: 'Alice', email: 'alice@exemple.fr', subject: 'Paiement', source: 'contact' });
  });

  it.each([
    [{ ...valid, name: '' }],
    [{ ...valid, email: 'pas-un-email' }],
    [{ ...valid, message: 'court' }],
    [{ ...valid, email: { $ne: null } }]
  ])('refuse un message invalide : %p', (body) => {
    expect(() => parseContactMessage(body)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('tronque un message trop long au lieu de le transmettre en entier', () => {
    const contact = parseContactMessage({ ...valid, message: 'a'.repeat(10000) });

    expect(contact.message.length).toBe(3000);
  });
});
