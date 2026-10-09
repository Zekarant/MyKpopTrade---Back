import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Charger le fichier .env
dotenv.config({ quiet: true });

/** Valeur par défaut de JWT_SECRET, tolérée hors production uniquement. */
const DEV_JWT_SECRET = 'this_is_a_development_secret_key_do_not_use_in_production';

// Schéma de validation pour les variables d'environnement.
// Exporté pour être testé sans dépendre de process.env ni de process.exit.
export const envSchema = z.object({
  // Variables d'environnement générales
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // zod 4 : la valeur par défaut est celle de sortie (déjà transformée).
  PORT: z.string().transform(val => parseInt(val, 10)).default(3000),
  API_URL: z.string().url().default('http://localhost:3000'),
  FRONTEND_URL: z.string().url().default('http://localhost:8080'),
  // Origines autorisées par CORS, séparées par des virgules. FRONTEND_URL est
  // toujours autorisée en plus de cette liste (cf. app.ts).
  CORS_ORIGINS: z.string().default(''),
  // Nombre de reverse proxies devant l'API (0 = aucun). Indispensable pour que
  // req.ip soit l'IP réelle du client et non celle du proxy : sans ça, le rate
  // limiting par IP s'applique à tous les utilisateurs en même temps.
  // ⚠️ Ne jamais surévaluer : une valeur trop haute permet de forger X-Forwarded-For.
  TRUST_PROXY: z.string().transform(val => parseInt(val, 10)).default(0),
  // Taille maximale d'un corps de requête JSON / urlencoded.
  BODY_LIMIT: z.string().default('1mb'),
  
  // Base de données
  MONGODB_URI: z.string().default('mongodb://localhost:27017/mykpoptrade'),
  // Pool borné : le défaut du pilote (100 connexions par process) sature vite
  // une petite instance Mongo dès qu'on scale l'API horizontalement.
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(10),
  // Échouer vite (5 s au lieu des 30 s du pilote) si Mongo est injoignable :
  // le démarrage échoue clairement et /ready repasse en 503 sans attendre.
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // JWT
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  JWT_EXPIRE: z.string().default('15m'),
  JWT_REFRESH_EXPIRE: z.string().default('7d'),

  // Email
  EMAIL_SERVICE: z.string().optional(),
  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.string().transform(val => parseInt(val, 10)).optional(),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  FROM_EMAIL: z.string().email().default('noreply@mykpoptrade.com'),
  
  // Chaîne vide acceptée (webhook non configuré en local) : `isDiscordWebhookConfigured`
  // fait déjà `Boolean(...)` dessus, donc '' est traité comme "absent" en aval.
  ADMIN_DISCORD_WEBHOOK_URL: z.union([z.string().url(), z.literal('')]).optional(),
  // Canal des messages du formulaire de contact. Absent : repli sur le webhook admin.
  SUPPORT_DISCORD_WEBHOOK_URL: z.union([z.string().url(), z.literal('')]).optional(),

  // Analyse IA (Mistral La Plateforme) : pré-diagnostic de litiges, modération
  // des annonces suspectes... Clé absente = ces fonctionnalités sont inactives,
  // le reste de l'API fonctionne normalement. Ce n'est pas une erreur de démarrage.
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().default('mistral-small-latest'),
  // Solution de secours si Mistral est indisponible (ex. tier gratuit sans
  // capacité réservée, cf. docs internes). Optionnelle : sans clé, seul
  // Mistral est utilisé, comme avant.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),

  // SMS
  SMS_ENABLED: z.string().transform(val => val === 'true').default(false),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  
  // Auth sociale
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  
  // Notifications push navigateur (web-push). Clés absentes = envoi désactivé,
  // les abonnements restent enregistrés. Génération : npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:noreply@mykpoptrade.com'),

  // PayPal
  // Toute autre valeur que sandbox/live est refusée : une faute de frappe ne
  // doit pas basculer silencieusement d'un environnement PayPal à l'autre.
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  // Sans lui, la signature des webhooks PayPal ne peut pas être vérifiée.
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  // Merchant ID de la plateforme : `partner_id` des appels « show seller
  // status » et `payee` des platform_fees.
  PAYPAL_PARTNER_MERCHANT_ID: z.string().optional(),
  PAYPAL_BN_CODE: z.string().default('MYKPOPTRADE_SP_PPCP'),
  PAYPAL_PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  PAYPAL_RETURN_URL: z.string().default('http://localhost:3000/payment/success'),
  PAYPAL_CANCEL_URL: z.string().default('http://localhost:3000/payment/cancel'),

  // URL publique de la marketplace et email de support, pré-remplis sur les
  // comptes vendeurs connectés.
  MARKETPLACE_URL: z.string().url().default('https://mykpoptrade.com'),
  SUPPORT_EMAIL: z.string().email().default('support@mykpoptrade.com'),

  // Chiffrement des messages
  MESSAGE_ENCRYPTION_KEY: z.string().min(32).optional(),
  // Chiffrement des données personnelles (anonymisation RGPD des paiements,
  // documents d'identité). Doit faire 32 caractères au minimum : AES-256 en
  // consomme exactement 32 octets.
  // Cette variable était lue directement via process.env, sans validation :
  // son absence faisait échouer le démarrage sur une exception opaque.
  ENCRYPTION_KEY: z.string().min(32).optional(),

  // Temps réel (SSE) : flux ouverts simultanément sur ce process, tous
  // utilisateurs confondus. Chaque flux garde une socket ; au-delà, 503.
  REALTIME_MAX_CONNECTIONS: z.coerce.number().int().positive().default(1000),

  // Logs
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
}).superRefine((data, ctx) => {
  // En production, les secrets sensibles sont obligatoires. On nomme chaque
  // variable manquante : l'exploitant doit pouvoir corriger sans lire le code.
  if (data.NODE_ENV !== 'production') return;
  const requiredInProduction = {
    PAYPAL_CLIENT_ID: data.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: data.PAYPAL_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: data.PAYPAL_WEBHOOK_ID,
    PAYPAL_PARTNER_MERCHANT_ID: data.PAYPAL_PARTNER_MERCHANT_ID,
    MESSAGE_ENCRYPTION_KEY: data.MESSAGE_ENCRYPTION_KEY,
    ENCRYPTION_KEY: data.ENCRYPTION_KEY
  };
  for (const [name, value] of Object.entries(requiredInProduction)) {
    if (!value) {
      ctx.addIssue({ code: 'custom', path: [name], message: `${name} est requise en production.` });
    }
  }
  if (data.JWT_SECRET === DEV_JWT_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Un JWT_SECRET propre à la production est requis.' });
  }
}).refine(
  // Garde-fou : un `.env` oublié sur PAYPAL_MODE=live ferait passer de vraies
  // transactions depuis un poste de développement.
  (data) => data.PAYPAL_MODE !== 'live' || data.NODE_ENV === 'production',
  { path: ['PAYPAL_MODE'], message: 'PAYPAL_MODE=live est interdit hors production. Utilisez PAYPAL_MODE=sandbox.' }
).refine(
  // SMS activé sans Twilio complet : l'API promettrait des SMS jamais envoyés.
  (data) => !data.SMS_ENABLED ||
    Boolean(data.TWILIO_ACCOUNT_SID && data.TWILIO_AUTH_TOKEN && data.TWILIO_PHONE_NUMBER),
  { message: 'SMS_ENABLED=true exige TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN et TWILIO_PHONE_NUMBER.' }
);

// console et non le logger : le logger lit sa configuration ici, il n'existe
// pas encore quand cette validation s'exécute.
// Vérifier qu'un fichier .env existe et alerter en mode développement s'il manque
if (process.env.NODE_ENV !== 'production') {
  const envFilePath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFilePath)) {
    console.warn(
      '\x1b[33m%s\x1b[0m',
      'Attention: Fichier .env non trouvé. Utilisez .env.example comme modèle.'
    );
  }
}

// Valider les variables d'environnement
const envValidation = envSchema.safeParse(process.env);

if (!envValidation.success) {
  console.error('\x1b[31m%s\x1b[0m', 'Erreur de configuration des variables d\'environnement:');
  envValidation.error.issues.forEach((issue) => {
    console.error(`- ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

// Typage des variables d'environnement
export type Env = z.infer<typeof envSchema>;

// Exporter les variables d'environnement validées
export const env: Env = envValidation.data;

// Les fixtures de tests (src/tests/helpers/fixtures.ts) créent de vrais utilisateurs
// et déclenchent les vrais services (dispatchAdminAlert, modération IA, envoi
// d'email...), y compris avec les identifiants du .env local. Si ce dernier
// contient un vrai webhook Discord ou de vraies clés Mistral/Gemini, chaque
// exécution des tests (ou du hook pre-push) spamme le canal Discord réel et/ou
// appelle les vraies API IA avec des données bidon. Les tests ne doivent
// jamais pouvoir atteindre un service externe réel, quoi que contienne le .env.
if (env.NODE_ENV === 'test') {
  env.ADMIN_DISCORD_WEBHOOK_URL = '';
  env.SUPPORT_DISCORD_WEBHOOK_URL = '';
  env.MISTRAL_API_KEY = undefined;
  env.GEMINI_API_KEY = undefined;
}

export default env;