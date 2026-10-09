import nodemailer, { type Transporter } from 'nodemailer';
import { IUser } from '../../models/userModel';
import env from '../../config/env';
import logger from '../utils/logger';
import { escapeHtml } from '../utils/escapeHtml';

const BASE_URL = env.FRONTEND_URL;
const FROM_EMAIL = env.FROM_EMAIL;

/**
 * Transporteur mémoïsé.
 *
 * Il était auparavant reconstruit à chaque envoi : en développement cela
 * déclenchait un appel réseau à Ethereal par email (lent et soumis à quota), et
 * en production cela ouvrait un nouveau pool SMTP à chaque fois, sans jamais
 * réutiliser de connexion. On le construit donc une seule fois.
 *
 * La promesse est mise en cache (et non le transporteur résolu) pour que des
 * envois concurrents au démarrage partagent la même initialisation.
 */
let transporterPromise: Promise<Transporter> | null = null;

const buildTransporter = async (): Promise<Transporter> => {
  // Les notifications envoient désormais des emails depuis les tests
  // d'intégration : même Ethereal serait un appel réseau (cf. garde de env.ts).
  if (env.NODE_ENV === 'test') {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // Hors production : compte Ethereal jetable, aucun email réellement délivré.
  if (env.NODE_ENV !== 'production') {
    const testAccount = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
  }

  return nodemailer.createTransport({
    service: env.EMAIL_SERVICE,
    auth: {
      user: env.EMAIL_USER,
      pass: env.EMAIL_PASS
    },
    pool: true
  });
};

const createTransporter = async (): Promise<Transporter> => {
  if (!transporterPromise) {
    transporterPromise = buildTransporter().catch((error) => {
      // Ne pas mettre en cache un échec : le prochain envoi doit pouvoir réessayer.
      transporterPromise = null;
      throw error;
    });
  }
  return transporterPromise;
};

/**
 * Envoie un email de vérification à l'utilisateur
 */
export const sendVerificationEmail = async (user: IUser, token: string): Promise<void> => {
  const verificationUrl = `${BASE_URL}/verify-email/${token}`;
  
  const transporter = await createTransporter();
  
  const mailOptions = {
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: user.email,
    subject: 'Vérification de votre adresse email',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Bienvenue sur MyKpopTrade !</h2>
        <p>Bonjour ${user.username},</p>
        <p>Merci de vous être inscrit(e) sur MyKpopTrade. Pour activer votre compte, veuillez cliquer sur le lien ci-dessous :</p>
        <p>
          <a href="${verificationUrl}" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Vérifier mon adresse email
          </a>
        </p>
        <p>Ce lien expirera dans 24 heures.</p>
        <p>Si vous n'avez pas créé de compte sur MyKpopTrade, vous pouvez ignorer cet email.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Envoie un email de réinitialisation de mot de passe
 */
export const sendPasswordResetEmail = async (user: IUser, token: string): Promise<void> => {
  const resetUrl = `${BASE_URL}/reset-password/${token}`;
  
  const transporter = await createTransporter();
  
  const mailOptions = {
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: user.email,
    subject: 'Réinitialisation de votre mot de passe',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Réinitialisation de mot de passe</h2>
        <p>Bonjour ${user.username},</p>
        <p>Vous avez demandé une réinitialisation de mot de passe. Cliquez sur le lien ci-dessous pour créer un nouveau mot de passe :</p>
        <p>
          <a href="${resetUrl}" style="display: inline-block; background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Réinitialiser mon mot de passe
          </a>
        </p>
        <p>Ce lien expirera dans 1 heure.</p>
        <p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Prévient l'ancienne adresse qu'elle n'est plus celle du compte : si le
 * changement n'est pas du fait du titulaire, c'est sa seule alerte.
 */
export const sendEmailChangedNotice = async (user: IUser, previousEmail: string): Promise<void> => {
  const transporter = await createTransporter();

  await transporter.sendMail({
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: previousEmail,
    subject: 'Votre adresse email a été modifiée',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Adresse email modifiée</h2>
        <p>Bonjour ${user.username},</p>
        <p>L'adresse email de votre compte MyKpopTrade vient d'être remplacée par <strong>${user.email}</strong>.</p>
        <p>Si vous n'êtes pas à l'origine de ce changement, contactez immédiatement support@mykpoptrade.com.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  });
};

/**
 * Envoie un email de confirmation de suppression de compte
 */
export const sendAccountDeletionEmail = async (user: IUser): Promise<void> => {
  const transporter = await createTransporter();
  
  const mailOptions = {
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: user.email,
    subject: 'Confirmation de suppression de compte',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Votre compte a été supprimé</h2>
        <p>Bonjour ${user.username},</p>
        <p>Nous vous confirmons que votre compte a été supprimé de notre service.</p>
        <p>Nous regrettons de vous voir partir et espérons vous revoir bientôt !</p>
        <p>Si cette action a été faite par erreur, veuillez nous contacter rapidement à support@mykpoptrade.com.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Envoyer un email avec le résultat de la vérification d'identité
 */
export const sendVerificationResultEmail = async (
  email: string, 
  isApproved: boolean, 
  reason?: string
): Promise<void> => {
  const subject = isApproved 
    ? 'Votre identité a été vérifiée avec succès' 
    : 'Votre demande de vérification d\'identité a été rejetée';
  
  const content = isApproved 
    ? `
      <h2>Félicitations !</h2>
      <p>Votre identité a été vérifiée avec succès. Vous avez maintenant accès à toutes les fonctionnalités de MyKpopTrade.</p>
      <p>Vous bénéficiez désormais d'un badge vérifié sur votre profil, ce qui augmentera la confiance des autres utilisateurs envers vous.</p>
    `
    : `
      <h2>Demande de vérification rejetée</h2>
      <p>Nous sommes désolés de vous informer que votre demande de vérification d'identité a été rejetée.</p>
      <p><strong>Motif :</strong> ${reason || 'Document non conforme'}</p>
      <p>Vous pouvez soumettre une nouvelle demande en vous assurant que votre document répond aux critères suivants :</p>
      <ul>
        <li>Document officiel en cours de validité</li>
        <li>Document clairement lisible, non flouté</li>
        <li>Toutes les informations visibles sans obstruction</li>
      </ul>
    `;
  
  await sendEmail({
    to: email,
    subject,
    html: emailTemplate({
      title: subject,
      content,
      ctaText: isApproved ? 'Accéder à mon profil' : 'Soumettre une nouvelle demande',
      ctaUrl: isApproved 
        ? `${process.env.FRONTEND_URL}/profile` 
        : `${process.env.FRONTEND_URL}/verification`
    })
  });
};

/**
 * Template HTML générique pour les emails
 */
function emailTemplate(options: {
  title: string;
  content: string;
  ctaText?: string;
  ctaUrl?: string;
  /** HTML déjà sûr, affiché sous la signature. */
  footer?: string;
}): string {
  const ctaButton = options.ctaText && options.ctaUrl
    ? `<p>
        <a href="${options.ctaUrl}" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
          ${options.ctaText}
        </a>
      </p>`
    : '';

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${options.title}</h2>
      ${options.content}
      ${ctaButton}
      <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      ${options.footer ?? ''}
    </div>
  `;
}

/* ----------------------------------------------------------------------- */
/* Emails de notification                                                   */
/* ----------------------------------------------------------------------- */

/** Section « Préférences » des paramètres, où se règlent les emails de notification. */
const NOTIFICATION_PREFERENCES_URL = `${BASE_URL}/adherents/settings?section=preferences`;

export interface NotificationEmail {
  to: string;
  username: string;
  title: string;
  content: string;
  /** Chemin interne du front (ex. `/account/purchases/:id`), comme la notification in-app. */
  link?: string | null;
  tracking?: { carrier?: string; number?: string; url?: string };
}

/** Bloc de suivi du colis ; l'URL n'est reprise que si elle est en http(s). */
function trackingHtml(tracking: NotificationEmail['tracking']): string {
  if (!tracking) return '';
  const lines: string[] = [];
  if (tracking.carrier) {
    lines.push(`<p><strong>Transporteur :</strong> ${escapeHtml(tracking.carrier)}</p>`);
  }
  if (tracking.number) {
    lines.push(`<p><strong>Numéro de suivi :</strong> ${escapeHtml(tracking.number)}</p>`);
  }
  if (tracking.url && /^https?:\/\//i.test(tracking.url)) {
    const url = escapeHtml(tracking.url);
    lines.push(`<p>Suivez votre colis en direct : <a href="${url}">${url}</a></p>`);
  }
  return lines.join('\n');
}

/**
 * Un seul gabarit pour toutes les notifications : le titre et le texte sont
 * ceux de la notification in-app, ce qui évite de maintenir deux rédactions
 * par événement. Tout ce qui est interpolé est échappé : pseudos, titres
 * d'annonces et messages de litige viennent des membres.
 */
export function buildNotificationEmailHtml(email: NotificationEmail): string {
  // Seuls les chemins internes deviennent un bouton : le lien porte le domaine du front.
  const ctaUrl = email.link?.startsWith('/') ? escapeHtml(`${BASE_URL}${email.link}`) : undefined;

  return emailTemplate({
    title: escapeHtml(email.title),
    content: `
      <p>Bonjour ${escapeHtml(email.username)},</p>
      <p>${escapeHtml(email.content)}</p>
      ${trackingHtml(email.tracking)}
    `,
    ctaText: 'Voir sur MyKpopTrade',
    ctaUrl,
    footer: `
      <p style="font-size: 12px; color: #777;">
        Vous recevez cet email suite à une activité sur votre compte MyKpopTrade.
        <a href="${escapeHtml(NOTIFICATION_PREFERENCES_URL)}">Gérer mes préférences de notification</a>
      </p>
    `
  });
}

export const sendNotificationEmail = async (email: NotificationEmail): Promise<void> => {
  await sendEmail({
    to: email.to,
    subject: email.title,
    html: buildNotificationEmailHtml(email)
  });
};

/* ----------------------------------------------------------------------- */
/* Emails shipping                                                          */
/* ----------------------------------------------------------------------- */

interface ShipmentEmailContext {
  paymentId: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
}

/** Relance email à l'acheteur si le colis est expédié depuis trop longtemps. */
export const sendShipmentReminderEmail = async (
  user: IUser,
  ctx: ShipmentEmailContext & { daysSinceShipped: number }
): Promise<void> => {
  const trackingLink = ctx.trackingUrl
    ? `<p>Si besoin, vérifiez le suivi : <a href="${ctx.trackingUrl}">${ctx.trackingUrl}</a></p>`
    : '';
  await sendEmail({
    to: user.email,
    subject: 'Avez-vous bien reçu votre colis ?',
    html: emailTemplate({
      title: 'Votre colis devrait être arrivé',
      content: `
        <p>Bonjour ${user.username},</p>
        <p>Votre commande a été expédiée il y a ${ctx.daysSinceShipped} jours par <strong>${ctx.carrier}</strong> (${ctx.trackingNumber}).</p>
        <p>Merci de confirmer la réception depuis votre espace pour clôturer la transaction. Si le colis n'est pas arrivé, contactez le vendeur ou le support.</p>
        ${trackingLink}
      `,
      ctaText: 'Confirmer la réception',
      ctaUrl: `${BASE_URL}/payments`
    })
  });
};

/**
 * Envoie un email en utilisant le transporteur configuré
 * @param options Options de l'email (destinataire, sujet, contenu HTML)
 */
export async function sendEmail(options: { to: string; subject: string; html: string; }): Promise<void> {
  try {
    const transporter = await createTransporter();
    
    const mailOptions = {
      from: `"MyKpopTrade" <${FROM_EMAIL}>`,
      to: options.to,
      subject: options.subject,
      html: options.html
    };

    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error('Erreur lors de l\'envoi de l\'email', {
      error: error instanceof Error ? error.message : String(error)
    });
    // En développement, on peut choisir de ne pas propager l'erreur
    // En production, il peut être préférable de la propager pour une gestion centralisée
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
  }
}
