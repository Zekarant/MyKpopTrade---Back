import { stripMongoOperators } from '../mongoOperatorMiddleware';

describe('stripMongoOperators', () => {
  it('retire un opérateur passé à la place d\'une valeur', () => {
    const body = { refreshToken: { $ne: null } };

    stripMongoOperators(body);

    expect(body).toEqual({ refreshToken: {} });
  });

  it('retire les opérateurs imbriqués dans des objets et des tableaux', () => {
    const body = {
      filters: { email: { $regex: '^a', exact: 'x' } },
      items: [{ id: { $gt: '' } }, 'plain']
    };

    stripMongoOperators(body);

    expect(body).toEqual({
      filters: { email: { exact: 'x' } },
      items: [{ id: {} }, 'plain']
    });
  });

  it('laisse intact un corps légitime', () => {
    const body = { email: 'a@b.fr', price: 12, tags: ['bts'], nested: { city: 'Lyon' } };
    const copy = JSON.parse(JSON.stringify(body));

    stripMongoOperators(body);

    expect(body).toEqual(copy);
  });

  it('ignore les valeurs non objets', () => {
    expect(() => stripMongoOperators(undefined)).not.toThrow();
    expect(() => stripMongoOperators('texte')).not.toThrow();
  });
});
