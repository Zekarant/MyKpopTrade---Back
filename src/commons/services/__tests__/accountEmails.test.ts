import env from '../../../config/env';
import type { IUser } from '../../../models/userModel';
import {
  sendAccountDeletionEmail,
  sendEmailChangedNotice,
  sendPasswordResetEmail,
  sendVerificationEmail
} from '../emailService';

/**
 * Emails de compte (vérification, mot de passe, changement d'adresse,
 * suppression) : même envoi que les autres emails (sendEmail) — un transporteur
 * en panne n'interrompt pas l'action hors production, mais remonte en production.
 */

// `jest.mock` est remonté avant les imports : emailService reçoit ce transporteur.
const sendMail = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail }), createTestAccount: jest.fn() }
}));

const user = { email: 'membre@test.com', username: '<b>Membre</b>' } as unknown as IUser;

describe('emails de compte', () => {
  const nodeEnv = env.NODE_ENV;

  beforeEach(() => sendMail.mockReset());
  afterEach(() => {
    (env as { NODE_ENV: string }).NODE_ENV = nodeEnv;
  });

  it('passent par l\'expéditeur commun et échappent le pseudo', async () => {
    sendMail.mockResolvedValue(undefined);

    await sendVerificationEmail(user, 'jeton');

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: `"MyKpopTrade" <${env.FROM_EMAIL}>`,
      to: 'membre@test.com',
      subject: 'Vérification de votre adresse email'
    }));
    const { html } = sendMail.mock.calls[0][0];
    expect(html).toContain(`${env.FRONTEND_URL}/verify-email/jeton`);
    expect(html).toContain('&lt;b&gt;Membre&lt;/b&gt;');
    expect(html).not.toContain('<b>Membre</b>');
  });

  it('n\'interrompent pas l\'action hors production si l\'envoi échoue', async () => {
    sendMail.mockRejectedValue(new Error('SMTP indisponible'));

    await expect(sendVerificationEmail(user, 'jeton')).resolves.toBeUndefined();
    await expect(sendPasswordResetEmail(user, 'jeton')).resolves.toBeUndefined();
    await expect(sendEmailChangedNotice(user, 'ancienne@test.com')).resolves.toBeUndefined();
    await expect(sendAccountDeletionEmail(user)).resolves.toBeUndefined();
  });

  it('remontent l\'échec d\'envoi en production', async () => {
    sendMail.mockRejectedValue(new Error('SMTP indisponible'));
    (env as { NODE_ENV: string }).NODE_ENV = 'production';

    await expect(sendPasswordResetEmail(user, 'jeton')).rejects.toThrow('SMTP indisponible');
  });
});
