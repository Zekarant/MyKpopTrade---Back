import env from '../../config/env';
import logger from '../utils/logger';

const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_FIELD_VALUE_LENGTH = 1024;
const MAX_FIELDS = 25;

const REQUEST_TIMEOUT_MS = 5000;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
  footer?: { text: string };
}

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

export const isDiscordWebhookConfigured = (): boolean =>
  Boolean(env.ADMIN_DISCORD_WEBHOOK_URL);

export const postDiscordEmbed = async (embed: DiscordEmbed): Promise<boolean> => {
  const webhookUrl = env.ADMIN_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const payload = {
    embeds: [
      {
        ...embed,
        title: truncate(embed.title, MAX_TITLE_LENGTH),
        description: embed.description
          ? truncate(embed.description, MAX_DESCRIPTION_LENGTH)
          : undefined,
        fields: embed.fields?.slice(0, MAX_FIELDS).map((field) => ({
          ...field,
          value: truncate(field.value, MAX_FIELD_VALUE_LENGTH)
        }))
      }
    ]
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      logger.warn('Webhook Discord refusé', {
        status: response.status,
        title: embed.title
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.warn('Échec de l\'envoi du webhook Discord', {
      error: error instanceof Error ? error.message : String(error),
      title: embed.title
    });
    return false;
  }
};
