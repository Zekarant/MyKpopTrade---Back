import type { IUser } from '../../../models/userModel';
import { sendShipmentReminderEmail } from '../emailService';

/**
 * Les textes saisis sont stockés en texte brut : un transporteur saisi
 * « &lt;a href=…&gt; » est enregistré comme un vrai lien. L'e-mail de relance
 * doit l'échapper, sinon le vendeur glisse un lien sous la signature du site.
 */

// `jest.mock` est remonté avant les imports : emailService reçoit ce transporteur.
const sendMail = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail }), createTestAccount: jest.fn() }
}));

describe('sendShipmentReminderEmail', () => {
  it('échappe le transporteur, le numéro, le lien de suivi et le pseudo', async () => {
    sendMail.mockResolvedValue(undefined);
    const buyer = { email: 'acheteur@test.com', username: 'A&B' } as unknown as IUser;

    await sendShipmentReminderEmail(buyer, {
      paymentId: 'p1',
      carrier: '<a href="https://evil.tld">Payer ici</a>',
      trackingNumber: '<b>6Z123</b>',
      trackingUrl: 'https://suivi.test/?n="><script>x</script>',
      daysSinceShipped: 12
    });

    const { html } = sendMail.mock.calls[0][0];
    expect(html).not.toContain('<a href="https://evil.tld">');
    expect(html).not.toContain('<b>6Z123</b>');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&lt;a href=&quot;https://evil.tld&quot;&gt;Payer ici&lt;/a&gt;');
    expect(html).toContain('Bonjour A&amp;B,');
  });
});
