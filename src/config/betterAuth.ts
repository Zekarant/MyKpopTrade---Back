import { MongoClient } from 'mongodb';
import env from './env';

// better-auth est un package ESM-only ; on le charge via import dynamique
// pour rester compatible avec le projet CommonJS.
type BetterAuthInstance = any;

let mongoClient: MongoClient | null = null;
let authPromise: Promise<BetterAuthInstance> | null = null;

async function buildAuth(): Promise<BetterAuthInstance> {
  const { betterAuth } = await import('better-auth');
  const { mongodbAdapter } = await import('better-auth/adapters/mongodb');

  if (!mongoClient) {
    mongoClient = new MongoClient(env.MONGODB_URI);
    await mongoClient.connect();
  }

  return betterAuth({
    basePath: '/api/auth/better',
    baseURL: env.API_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(mongoClient.db()),
    trustedOrigins: [
      env.FRONTEND_URL,
      env.API_URL,
      // En dev, on tolère n'importe quel localhost (le port Vite peut varier).
      ...(env.NODE_ENV !== 'production'
        ? ['http://localhost:5173', 'http://localhost:8080', 'http://localhost:3000']
        : []),
    ],
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID as string,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      },
    },
  });
}

export function getAuth(): Promise<BetterAuthInstance> {
  if (!authPromise) {
    authPromise = buildAuth();
  }
  return authPromise;
}
