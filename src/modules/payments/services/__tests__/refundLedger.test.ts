import { applyRefundToPayment, remainingRefundable } from '../refundLedger';

function payment(overrides: any = {}) {
  return {
    _id: 'pay1',
    amount: 28.98,
    currency: 'EUR',
    status: 'completed',
    refunds: [],
    totalRefunded: 0,
    ...overrides
  };
}

describe('applyRefundToPayment', () => {
  it('enregistre un remboursement partiel et met à jour le statut', () => {
    const p = payment();

    const result = applyRefundToPayment(p, {
      refundId: 'R1', amount: 5, currency: 'EUR'
    });

    expect(result).toMatchObject({ changed: true, totalRefunded: 5, isFullyRefunded: false });
    expect(p.status).toBe('partially_refunded');
    expect(p.totalRefunded).toBe(5);
  });

  it('cumule les remboursements successifs', () => {
    const p = payment();
    applyRefundToPayment(p, { refundId: 'R1', amount: 5, currency: 'EUR' });

    const result = applyRefundToPayment(p, { refundId: 'R2', amount: 23.98, currency: 'EUR' });

    expect(result.totalRefunded).toBe(28.98);
    expect(result.isFullyRefunded).toBe(true);
    expect(p.status).toBe('refunded');
  });

  it('est idempotent : un webhook redélivré ne double pas le montant', () => {
    const p = payment();
    applyRefundToPayment(p, { refundId: 'R1', amount: 5, currency: 'EUR' });

    const replay = applyRefundToPayment(p, { refundId: 'R1', amount: 5, currency: 'EUR' });

    expect(replay.changed).toBe(false);
    expect(replay.totalRefunded).toBe(5);
    expect(p.refunds).toHaveLength(1);
  });

  it('ignore les entrées non abouties dans le total', () => {
    const p = payment({
      refunds: [{ refundId: 'R0', amount: 10, currency: 'EUR', status: 'pending' }]
    });

    const result = applyRefundToPayment(p, { refundId: 'R1', amount: 5, currency: 'EUR' });

    expect(result.totalRefunded).toBe(5);
  });
});

describe('remainingRefundable', () => {
  it('renvoie le montant total quand rien n\'a été remboursé', () => {
    expect(remainingRefundable(payment())).toBe(28.98);
  });

  it('déduit les remboursements déjà aboutis', () => {
    const p = payment({
      refunds: [{ refundId: 'R1', amount: 5, currency: 'EUR', status: 'completed' }]
    });

    expect(remainingRefundable(p)).toBe(23.98);
  });

  it('se base sur l\'historique même si totalRefunded n\'a pas été mis à jour', () => {
    // C'est le bug réel : totalRefunded n'était alimenté que par le webhook.
    // S'il manquait, la totalité du montant redevenait remboursable et le
    // vendeur pouvait rembourser deux fois.
    const p = payment({
      totalRefunded: 0,
      refunds: [{ refundId: 'R1', amount: 5, currency: 'EUR', status: 'completed' }]
    });

    expect(remainingRefundable(p)).toBe(23.98);
  });

  it('retient la valeur la plus prudente entre historique et totalRefunded', () => {
    const p = payment({ totalRefunded: 20, refunds: [] });

    expect(remainingRefundable(p)).toBe(8.98);
  });

  it('ne descend jamais sous zéro', () => {
    const p = payment({
      refunds: [{ refundId: 'R1', amount: 40, currency: 'EUR', status: 'completed' }]
    });

    expect(remainingRefundable(p)).toBe(0);
  });
});
