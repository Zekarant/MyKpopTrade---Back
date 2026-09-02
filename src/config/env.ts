import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Charger le fichier .env
dotenv.config();

// Schéma de validation pour les variables d'environnement
const envSchema = z.object({
  // Variables d'environnement générales
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform(val => parseInt(val, 10)).default('3000'),
  API_URL: z.string().url().default('http://localhost:3000'),
  FRONTEND_URL: z.string().url().default('http://localhost:8080'),
  // Origines autorisées par CORS, séparées par des virgules. FRONTEND_URL est
  // toujours autorisée en plus de cette liste (cf. app.ts).
  CORS_ORIGINS: z.string().default(''),
  // Nombre de reverse proxies devant l'API (0 = aucun). Indispensable pour que
  // req.ip soit l'IP réelle du client et non celle du proxy : sans ça, le rate
  // limiting par IP s'applique à tous les utilisateurs en même temps.
  // ⚠️ Ne jamais surévaluer : une valeur trop haute permet de forger X-Forwarded-For.
  TRUST_PROXY: z.string().transform(val => parseInt(val, 10)).default('0'),
  // Taille maximale d'un corps de requête JSON / urlencoded.
  BODY_LIMIT: z.string().default('1mb'),
  
  // Base de données
  MONGODB_URI: z.string().default('mongodb://localhost:27017/mykpoptrade'),
  
  // JWT
  JWT_SECRET: z.string().min(32).default('this_is_a_development_secret_key_do_not_use_in_production'),
  JWT_EXPIRE: z.string().default('15m'),
  JWT_REFRESH_EXPIRE: z.string().default('7d'),

  // Email
  EMAIL_SERVICE: z.string().optional(),
  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.string().transform(val => parseInt(val, 10)).optional(),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  FROM_EMAIL: z.string().email().default('noreply@mykpoptrade.com'),
  
  // SMS
  SMS_ENABLED: z.string().transform(val => val === 'true').default('false'),
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
  
  // PayPal
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),

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

  // Logs
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
}).refine(
  (data) => {
    // En production, les secrets sensibles sont obligatoires
    if (data.NODE_ENV !== 'production') return true;
    return (
      Boolean(data.PAYPAL_CLIENT_ID) &&
      Boolean(data.PAYPAL_CLIENT_SECRET) &&
      Boolean(data.MESSAGE_ENCRYPTION_KEY) &&
      Boolean(data.ENCRYPTION_KEY) &&
      data.JWT_SECRET !== 'this_is_a_development_secret_key_do_not_use_in_production'
    );
  },
  {
    message:
      'En production, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, MESSAGE_ENCRYPTION_KEY, ENCRYPTION_KEY et un JWT_SECRET custom sont requis.'
  }
);

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

export default env;