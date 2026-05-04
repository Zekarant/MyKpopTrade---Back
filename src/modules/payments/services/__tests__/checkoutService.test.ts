import {
  computeCheckout,
  validateShippingAddress,
  resolveCheckout
} from '../checkoutService';

function buildProduct(overrides: any = {}) {
  return {
    price: 20,
    currency: 'EUR',
    shippingOptions: {
      worldwide: false,
      nationalOnly: true,
      localPickup: false,
      nationalCost: 4.5
    },
    ...overrides
  };
}

const VALID_ADDRESS = {
  recipientName: 'Jean Dupont',
  streetLine1: '12 rue de la Paix',
  postalCode: '75002',
  city: 'Paris',
  country: 'FR'
};

describe('computeCheckout', () => {
  it('additionne prix produit et coût national', () => {
    const product = buildProduct();
    expect(computeCheckout(product, 'national', 20)).toEqual({
      productAmount: 20,
      shippingAmount: 4.5,
      total: 24.5
    });
  });

  it('utilise worldwideCost pour la méthode worldwide', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: true, nationalOnly: false, localPickup: false, worldwideCost: 12 }
    });
    expect(computeCheckout(product, 'worldwide', 20).shippingAmount).toBe(12);
  });

  it('localPickup → coût zéro même si nationalCost défini', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: false, nationalOnly: true, localPickup: true, nationalCost: 4.5 }
    });
    expect(computeCheckout(product, 'localPickup', 20).shippingAmount).toBe(0);
  });

  it('fallback sur le legacy shippingCost si nationalCost absent', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: false, nationalOnly: true, localPickup: false, shippingCost: 3 }
    });
    expect(computeCheckout(product, 'national', 20).shippingAmount).toBe(3);
  });

  it('arrondit les montants à 2 décimales', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: false, nationalOnly: true, localPickup: false, nationalCost: 4.567 }
    });
    const breakdown = computeCheckout(product, 'national', 19.999);
    expect(breakdown.productAmount).toBe(20);
    expect(breakdown.shippingAmount).toBe(4.57);
    expect(breakdown.total).toBe(24.57);
  });

  it('400 si la méthode n\'est pas proposée par le vendeur', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: false, nationalOnly: false, localPickup: true, nationalCost: 4.5 }
    });
    expect(() => computeCheckout(product, 'national', 20))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'SHIPPING_METHOD_UNAVAILABLE' }));
  });

  it('400 si le coût n\'est pas configuré pour la méthode offerte', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: true, nationalOnly: false, localPickup: false }
    });
    expect(() => computeCheckout(product, 'worldwide', 20))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'SHIPPING_COST_MISSING' }));
  });
});

describe('validateShippingAddress', () => {
  it('accepte une adresse FR valide et normalise les champs', () => {
    const out = validateShippingAddress({
      ...VALID_ADDRESS,
      streetLine2: '  Apt 12  ',
      country: 'fr'
    });
    expect(out.recipientName).toBe('Jean Dupont');
    expect(out.streetLine2).toBe('Apt 12');
    expect(out.country).toBe('FR');
  });

  it('défaut country=FR si non fourni', () => {
    const out = validateShippingAddress({ ...VALID_ADDRESS, country: undefined });
    expect(out.country).toBe('FR');
  });

  it('rejette un code postal FR mal formé', () => {
    expect(() => validateShippingAddress({ ...VALID_ADDRESS, postalCode: '7500' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejette un code postal FR alphanumérique', () => {
    expect(() => validateShippingAddress({ ...VALID_ADDRESS, postalCode: '75A02' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('accepte un code postal non-FR sans regex stricte', () => {
    const out = validateShippingAddress({
      ...VALID_ADDRESS, postalCode: '1000', country: 'BE'
    });
    expect(out.postalCode).toBe('1000');
  });

  it('400 si nom destinataire manquant', () => {
    expect(() => validateShippingAddress({ ...VALID_ADDRESS, recipientName: '   ' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('400 si code pays au mauvais format', () => {
    expect(() => validateShippingAddress({ ...VALID_ADDRESS, country: 'France' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('tronque les espaces sur les champs string', () => {
    const out = validateShippingAddress({
      ...VALID_ADDRESS,
      recipientName: '  Jean Dupont  ',
      streetLine1: '  12 rue de la Paix  '
    });
    expect(out.recipientName).toBe('Jean Dupont');
    expect(out.streetLine1).toBe('12 rue de la Paix');
  });
});

describe('resolveCheckout', () => {
  it('localPickup ne nécessite pas d\'adresse', () => {
    const product = buildProduct({
      shippingOptions: { worldwide: false, nationalOnly: false, localPickup: true }
    });
    const out = resolveCheckout(product, 20, 'localPickup', undefined);
    expect(out.method).toBe('localPickup');
    expect(out.address).toBeUndefined();
    expect(out.breakdown.shippingAmount).toBe(0);
  });

  it('méthode national exige une adresse', () => {
    const product = buildProduct();
    expect(() => resolveCheckout(product, 20, 'national', undefined))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'SHIPPING_ADDRESS_REQUIRED' }));
  });

  it('400 sur une méthode invalide', () => {
    expect(() => resolveCheckout(buildProduct(), 20, 'pigeon', VALID_ADDRESS))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'INVALID_SHIPPING_METHOD' }));
  });

  it('renvoie l\'adresse normalisée pour national', () => {
    const out = resolveCheckout(buildProduct(), 20, 'national', VALID_ADDRESS);
    expect(out.address?.country).toBe('FR');
    expect(out.breakdown.total).toBe(24.5);
  });
});
