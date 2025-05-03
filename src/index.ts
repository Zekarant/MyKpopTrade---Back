import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import passport from 'passport';
import { authRoutes } from './modules/auth';
import { userRoute } from './modules/users';
import { profileRoutes } from './modules/profiles';
import { errorHandler, notFoundHandler } from './commons/middlewares/errorMiddleware';
import { initializePassport } from './config/passport';
import { logAPIRequest } from './commons/utils/logger';
import env from './config/env';
import logger from './commons/utils/logger';

// Initialisation de l'application Express
const app = express();

// Middlewares
app.use(cors());
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

// Route racine
app.get('/', (req, res) => {
  res.send('API MyKpopTrade v1.0.0');
});

// Middleware pour les routes non trouvées
app.use('*', notFoundHandler);

// Middleware de gestion des erreurs
app.use(errorHandler);

// Connexion à MongoDB
mongoose.connect(env.MONGODB_URI)
  .then(() => {
    logger.info(`Connecté à MongoDB: ${env.MONGODB_URI}`);
    
    // Démarrage du serveur
    app.listen(env.PORT, () => {
      logger.info(`Serveur démarré sur le port ${env.PORT} en mode ${env.NODE_ENV}`);
      logger.info(`API URL: ${env.API_URL}`);
      logger.info(`Frontend URL: ${env.FRONTEND_URL}`);
    });
  })
  .catch(error => {
    logger.error('Erreur de connexion à MongoDB:', error);
    process.exit(1);
  });

export default app;