import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import passport from 'passport';
import dotenv from 'dotenv';
import { initializePassport } from './config/passport';
import authRoutes from './routes/authRoutes';

dotenv.config();

// Initialisation de l'application
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialisation de Passport
initializePassport();
app.use(passport.initialize());

// Routes
app.use('/api/auth', authRoutes);

// Route racine
app.get('/', (req, res) => {
  res.send('API MyKpopTrade en ligne');
});

// Connexion à MongoDB et démarrage du serveur
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('Connexion à MongoDB établie');
    app.listen(PORT, () => {
      console.log(`Serveur démarré sur le port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Erreur de connexion à MongoDB:', error);
  });

export default app;