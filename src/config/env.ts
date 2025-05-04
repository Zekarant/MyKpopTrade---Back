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
  
  // Logs
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

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