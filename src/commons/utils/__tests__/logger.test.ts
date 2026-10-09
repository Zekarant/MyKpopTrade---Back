import winston from 'winston';
import { MESSAGE } from 'triple-beam';
import logger from '../logger';
import { runWithRequestId } from '../requestContext';

/**
 * Ces tests verrouillent la sanitisation des logs.
 *
 * Régression historique : `logsSanitizer()` était placé APRÈS
 * `winston.format.json()` dans le format du logger. Comme `json()` fige la ligne
 * sérialisée dans `info[MESSAGE]` et que les transports Fichier écrivent cette
 * valeur, la sanitisation n'avait aucun effet sur les fichiers de log : chaque
 * échec de login écrivait le mot de passe en clair dans logs/error.log.
 *
 * On vérifie donc la sortie RÉELLEMENT sérialisée, pas l'objet intermédiaire.
 */
describe('logger — sanitisation des données sensibles', () => {
  /** Fait passer un log dans la chaîne de formats du logger et rend la ligne écrite. */
  function serialize(message: string, meta: Record<string, unknown>): string {
    const info = (logger.format as winston.Logform.Format).transform(
      { level: 'error', message, ...meta } as winston.Logform.TransformableInfo,
      {}
    );
    if (!info) throw new Error('Le format a rejeté le log');
    return String((info as Record<symbol, unknown>)[MESSAGE as unknown as symbol]);
  }

  it('masque le mot de passe présent dans un body de requête', () => {
    const line = serialize('[POST] /api/auth/login - 401', {
      body: { identifier: 'victime@test.com', password: 'SuperSecret123!' }
    });

    expect(line).not.toContain('SuperSecret123!');
    expect(line).toContain('******');
  });

  it('masque les variantes de mot de passe (currentPassword, newPassword)', () => {
    const line = serialize('[PUT] /api/auth/update-password - 400', {
      body: { currentPassword: 'OldPass1!', newPassword: 'NewPass1!' }
    });

    expect(line).not.toContain('OldPass1!');
    expect(line).not.toContain('NewPass1!');
  });

  it('masque les tokens (token, accessToken, refreshToken)', () => {
    const line = serialize('refresh échoué', {
      token: 'raw-token',
      accessToken: 'raw-access',
      refreshToken: 'raw-refresh'
    });

    expect(line).not.toContain('raw-token');
    expect(line).not.toContain('raw-access');
    expect(line).not.toContain('raw-refresh');
  });

  it('pseudonymise les emails en conservant un indice de diagnostic', () => {
    const line = serialize('utilisateur introuvable', {
      body: { email: 'utilisateur@exemple.com' }
    });

    expect(line).not.toContain('utilisateur@exemple.com');
    expect(line).toContain('uti***');
  });

  it('masque les champs sensibles imbriqués', () => {
    const line = serialize('erreur paiement', {
      payload: { buyer: { paypalEmail: 'acheteur@paypal.com', address: '1 rue de la Paix' } }
    });

    expect(line).not.toContain('acheteur@paypal.com');
    expect(line).not.toContain('1 rue de la Paix');
  });

  it('masque les variantes de nom de champ (motif, pas liste exacte)', () => {
    const line = serialize('mise à jour profil', {
      newPayPalEmail: 'vendeur@paypal.com',
      passwordResetToken: 'reset-abc',
      emailVerificationToken: 'verif-def',
      shippingAddress: '12 avenue des Lilas',
      ipAddress: '203.0.113.42',
      recipientName: 'Jean Dupont'
    });

    expect(line).not.toContain('vendeur@paypal.com');
    expect(line).not.toContain('reset-abc');
    expect(line).not.toContain('verif-def');
    expect(line).not.toContain('12 avenue des Lilas');
    expect(line).not.toContain('203.0.113.42');
    expect(line).not.toContain('Jean Dupont');
  });

  it('masque les champs sensibles dans un tableau d\'objets', () => {
    const line = serialize('export lot', {
      buyers: [
        { email: 'a@exemple.com', password: 'secret-un' },
        { email: 'b@exemple.com', password: 'secret-deux' }
      ]
    });

    expect(line).not.toContain('a@exemple.com');
    expect(line).not.toContain('b@exemple.com');
    expect(line).not.toContain('secret-un');
    expect(line).not.toContain('secret-deux');
  });

  it('laisse lisibles les métadonnées K-pop publiques (diagnostic)', () => {
    const line = serialize('album indexé', {
      albumName: 'FANCY YOU',
      artistName: 'TWICE',
      groupName: 'BTS',
      memberName: 'Jungkook'
    });

    expect(line).toContain('FANCY YOU');
    expect(line).toContain('TWICE');
    expect(line).toContain('BTS');
    expect(line).toContain('Jungkook');
  });

  it('masque un objet adresse entier, dont les sous-champs n\'ont pas de nom sensible', () => {
    const line = serialize('paiement créé', {
      shippingAddress: { streetLine1: '12 rue des Lilas', city: 'Lyon', postalCode: '69001' }
    });

    expect(line).not.toContain('12 rue des Lilas');
    expect(line).not.toContain('Lyon');
    expect(line).not.toContain('69001');
  });

  it('masque noms, prénom et contenu de message', () => {
    const line = serialize('message envoyé', {
      firstName: 'Camille',
      lastName: 'Durand',
      content: 'Mon numéro perso est 06 12 34 56 78'
    });

    expect(line).not.toContain('Camille');
    expect(line).not.toContain('Durand');
    expect(line).not.toContain('06 12 34 56 78');
  });

  it('masque les jetons présents dans une URL, y compris dans le message', () => {
    const line = serialize('API Request: GET /api/auth/verify-email/abc123secret', {
      url: '/api/messaging/messages/1/attachments/x.png?token=eyJhbGciOi.jwt&dl=1'
    });

    expect(line).not.toContain('abc123secret');
    expect(line).not.toContain('eyJhbGciOi.jwt');
    expect(line).toContain('dl=1');
  });

  it('tronque l\'IP sans la supprimer', () => {
    const line = serialize('API Request', { ip: '203.0.113.42' });

    expect(line).not.toContain('203.0.113.42');
    expect(line).toContain('203.0.113.0');
  });

  it('ajoute l\'identifiant de la requête en cours à chaque ligne', () => {
    const line = runWithRequestId('req-123', () => serialize('produit créé', {}));

    expect(JSON.parse(line).requestId).toBe('req-123');
  });

  it('n\'ajoute pas d\'identifiant hors requête (tâche CRON, démarrage)', () => {
    const line = serialize('tâche exécutée', {});

    expect(JSON.parse(line)).not.toHaveProperty('requestId');
  });

  it('laisse intactes les données non sensibles', () => {
    const line = serialize('produit créé', { productId: 'abc123', amount: 20 });

    expect(line).toContain('abc123');
    expect(line).toContain('20');
  });
});
