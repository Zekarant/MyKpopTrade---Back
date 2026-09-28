import env from '../../config/env';
import { postDiscordEmbed } from '../../commons/services/discordWebhookService';
import { HttpError } from '../../commons/utils/httpError';
import { validateEmail } from '../../commons/utils/validators';

export interface ContactMessage {
  name: string;
  email: string;
  subject: string;
  message: string;
  /** Page d'origine (contact, page de succès de paiement…), pour le tri côté support. */
  source: string;
}

const MAX_LENGTHS = { name: 100, email: 254, subject: 150, message: 3000, source: 50 };
const MIN_MESSAGE_LENGTH = 10;

const readText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

/** Valide et normalise un message de contact reçu du front (route publique). */
export function parseContactMessage(body: any): ContactMessage {
  const contact: ContactMessage = {
    name: readText(body?.name, MAX_LENGTHS.name),
    email: readText(body?.email, MAX_LENGTHS.email),
    subject: readText(body?.subject, MAX_LENGTHS.subject) || 'Autre',
    message: readText(body?.message, MAX_LENGTHS.message),
    source: readText(body?.source, MAX_LENGTHS.source) || 'contact'
  };

  if (!contact.name) throw new HttpError(400, 'Le nom est requis');
  if (!validateEmail(contact.email)) throw new HttpError(400, 'Email invalide');
  if (contact.message.length < MIN_MESSAGE_LENGTH) {
    throw new HttpError(400, `Le message doit contenir au moins ${MIN_MESSAGE_LENGTH} caractères`);
  }
  return contact;
}

/**
 * Transmet le message au canal support. L'URL du webhook reste côté serveur :
 * exposée dans le bundle du front, n'importe qui pouvait spammer ou supprimer
 * le canal.
 */
export async function deliverContactMessage(contact: ContactMessage): Promise<void> {
  const webhookUrl = env.SUPPORT_DISCORD_WEBHOOK_URL || env.ADMIN_DISCORD_WEBHOOK_URL;
  const delivered = await postDiscordEmbed({
    title: `📩 Nouveau message de support — ${contact.subject}`,
    color: 0x17202a,
    fields: [
      { name: '👤 Nom', value: contact.name, inline: true },
      { name: '📧 Email', value: contact.email, inline: true },
      { name: '🏷️ Sujet', value: contact.subject, inline: false },
      { name: '💬 Message', value: contact.message, inline: false }
    ],
    footer: { text: `MyKpopTrade — Support · ${contact.source}` },
    timestamp: new Date().toISOString()
  }, webhookUrl);

  if (!delivered) {
    throw new HttpError(503, 'Le service de support est momentanément indisponible. Veuillez réessayer plus tard.');
  }
}
