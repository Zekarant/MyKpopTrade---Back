import { buildNotificationEmailHtml } from '../emailService';
import env from '../../../config/env';

const anEmail = (overrides: Partial<Parameters<typeof buildNotificationEmailHtml>[0]> = {}) => ({
  to: 'membre@test.com',
  username: 'Membre',
  title: 'Votre commande a été expédiée',
  content: 'Le vendeur a expédié votre commande.',
  link: '/account/purchases/abc',
  ...overrides
});

describe('buildNotificationEmailHtml', () => {
  it('échappe le pseudo, le titre et le texte saisis par les membres', () => {
    const html = buildNotificationEmailHtml(anEmail({
      username: '<img src=x onerror=alert(1)>',
      title: 'Offre sur <b>Photocard</b>',
      content: 'Message : <a href="https://evil.example">cliquez</a>'
    }));

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Photocard</b>');
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Offre sur &lt;b&gt;Photocard&lt;/b&gt;');
  });

  it('pointe le bouton vers le front à partir du lien de la notification', () => {
    const html = buildNotificationEmailHtml(anEmail());

    expect(html).toContain(`href="${env.FRONTEND_URL}/account/purchases/abc"`);
  });

  it('n\'affiche pas de bouton pour un lien qui n\'est pas un chemin interne', () => {
    const html = buildNotificationEmailHtml(anEmail({ link: 'https://evil.example' }));

    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('Voir sur MyKpopTrade');
  });

  it('propose en pied de page le lien vers les préférences de notification', () => {
    const html = buildNotificationEmailHtml(anEmail());

    expect(html).toContain(`href="${env.FRONTEND_URL}/adherents/settings?section=preferences"`);
  });

  it('affiche le suivi du colis échappé, sans reprendre une URL non http(s)', () => {
    const withTracking = buildNotificationEmailHtml(anEmail({
      tracking: { carrier: 'Colissimo', number: '6Z<123>', url: 'https://www.laposte.fr/suivi?code=6Z&x=1' }
    }));
    const withScriptUrl = buildNotificationEmailHtml(anEmail({
      tracking: { number: '6Z123', url: 'javascript:alert(1)' }
    }));

    expect(withTracking).toContain('6Z&lt;123&gt;');
    expect(withTracking).toContain('href="https://www.laposte.fr/suivi?code=6Z&amp;x=1"');
    expect(withScriptUrl).not.toContain('javascript:');
  });
});
