import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import passport from 'passport';
import { getAuth } from './config/betterAuth';
import { authRoutes } from './modules/auth';
import { userRoute } from './modules/users';
import { profileRoutes } from './modules/profiles';
import { productRoutes } from './modules/products';
import { messagingRoutes } from './modules/messaging';
import notificationRoutes from './modules/notifications/routes';
import paymentRoutes from './modules/payments/routes';
import accountsRoutes from './modules/accounts/routes';
import groupRoutes from './modules/groups/routes';
import albumRoutes from './modules/albums/routes';
import searchRoutes from './modules/search/routes';
import { errorHandler, notFoundHandler } from './commons/middlewares/errorMiddleware';
import { initializePassport } from './config/passport';
import { logAPIRequest } from './commons/utils/logger';
import env from './config/env';
import { verificationRoutes } from './modules/verification';
import logger from './commons/utils/logger';
import { reportRoutes } from './modules/reports';
import path from 'path';
import { startGdprCleanupTask } from './commons/tasks/gdprCleanupTask';

// Initialisation de l'application Express
const app = express();

async function bootstrap() {
  // CORS avec credentials pour que better-auth puisse poser ses cookies.
  // En dev on accepte n'importe quel localhost (évite les surprises de port Vite).
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (origin === env.FRONTEND_URL) return callback(null, true);
        if (env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS: origine refusée ${origin}`));
      },
      credentials: true,
    }),
  );

  // IMPORTANT : monter le handler better-auth AVANT express.json(),
  // `toNodeHandler` consomme directement le stream de la requête.
  // better-auth est ESM-only → import dynamique.
  const [{ toNodeHandler }, auth] = await Promise.all([
    import('better-auth/node'),
    getAuth(),
  ]);
  // Express 5 / path-to-regexp v8 : le wildcard doit être nommé.
  app.all('/api/auth/better/*splat', toNodeHandler(auth));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Logging des requêtes
  app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
      const responseTime = Date.now() - startTime;
      logAPIRequest(req, responseTime);
    });
    next();
  });

  // Initialisation de Passport
  initializePassport();
  app.use(passport.initialize());

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoute);
  app.use('/api/profiles', profileRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/verification', verificationRoutes);
  app.use('/api/messaging', messagingRoutes);
  app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/accounts', accountsRoutes);
  app.use('/api/groups', groupRoutes);
  app.use('/api/albums', albumRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/reports', reportRoutes);

  // Route racine
  app.get('/', (_req, res) => {
    res.send('API MyKpopTrade v1.0.0');
  });

  // Middleware pour les routes non trouvées (Express 5 : pas de path '*' nu, on
  // omet le path pour que le middleware attrape toutes les routes restantes).
  app.use(notFoundHandler);

  // Middleware de gestion des erreurs
  app.use(errorHandler);

  if (process.env.NODE_ENV !== 'test') {
    startGdprCleanupTask();
    logger.info('Tâches CRON de maintenance RGPD démarrées');
  }

  await mongoose.connect(env.MONGODB_URI);
  logger.info(`Connecté à MongoDB: ${env.MONGODB_URI}`);

  app.listen(env.PORT, () => {
    logger.info(`Serveur démarré sur le port ${env.PORT} en mode ${env.NODE_ENV}`);
    logger.info(`API URL: ${env.API_URL}`);
    logger.info(`Frontend URL: ${env.FRONTEND_URL}`);
  });
}

bootstrap().catch((error) => {
  logger.error('Erreur de démarrage du serveur:', error);
  process.exit(1);
});

export default app;
