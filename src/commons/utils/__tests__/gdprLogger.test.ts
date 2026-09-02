import { GdprLogger } from '../gdprLogger';
import logger from '../logger';

/**
 * Ces tests verrouillent la détection d'accès massifs aux données personnelles,
 * montée sur les routes /api/payments/my, /export et /:paymentId.
 *
 * Régression historique : la clé du compteur était dérivée de
 * `generateTransactionHash(..., Date.now())`, qui incorpore `Date.now()` ET
 * `Math.random()`. Elle était donc unique à chaque appel, le compteur ne
 * retrouvait jamais d'enregistrement existant et la détection renvoyait
 * toujours `false` — tout en insérant une entrée par requête dans la Map.
 */
describe('GdprLogger.checkSuspiciousActivity', () => {
  /** Seuil défini dans GdprLogger (THRESHOLD = 20). */
  const THRESHOLD = 20;

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    GdprLogger.resetSuspiciousActivityCounters();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('ne signale rien en dessous du seuil', () => {
    for (let i = 0; i < THRESHOLD; i++) {
      expect(GdprLogger.checkSuspiciousActivity('user-1', 'payment_export', '10.0.0.1')).toBe(false);
    }
  });

  it('signale le dépassement du seuil pour une même combinaison', () => {
    for (let i = 0; i < THRESHOLD; i++) {
      GdprLogger.checkSuspiciousActivity('user-1', 'payment_export', '10.0.0.1');
    }

    // La requête suivante franchit le seuil.
    expect(GdprLogger.checkSuspiciousActivity('user-1', 'payment_export', '10.0.0.1')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'Activité suspecte détectée - Possible violation de données',
      expect.objectContaining({ resourceType: 'payment_export' })
    );
  });

  it('compte séparément deux utilisateurs distincts', () => {
    for (let i = 0; i <= THRESHOLD; i++) {
      GdprLogger.checkSuspiciousActivity('user-bruyant', 'payment_export', '10.0.0.1');
    }

    // Un autre utilisateur ne doit pas hériter du compteur du premier.
    expect(GdprLogger.checkSuspiciousActivity('user-calme', 'payment_export', '10.0.0.1')).toBe(false);
  });

  it('compte séparément deux types de ressource', () => {
    for (let i = 0; i <= THRESHOLD; i++) {
      GdprLogger.checkSuspiciousActivity('user-1', 'payment_export', '10.0.0.1');
    }

    expect(GdprLogger.checkSuspiciousActivity('user-1', 'payment_history', '10.0.0.1')).toBe(false);
  });

  it('ne divulgue ni l\'identifiant complet ni l\'IP dans l\'alerte', () => {
    for (let i = 0; i <= THRESHOLD; i++) {
      GdprLogger.checkSuspiciousActivity('utilisateur-identifiable-123', 'payment_export', '203.0.113.7');
    }

    const [, meta] = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
    expect(JSON.stringify(meta)).not.toContain('utilisateur-identifiable-123');
    expect(JSON.stringify(meta)).not.toContain('203.0.113.7');
  });
});
