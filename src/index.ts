import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import passport from 'passport';
import { initializePassport } from './config/passport';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
// ... autres imports

dotenv.config();
const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Initialisation de Passport
initializePassport();
app.use(passport.initialize());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
// ... autres routes

// Route racine
app.get('/', (req, res) => {
  res.send('API is running');
});

// Connexion à la base de données et démarrage du serveur
import connectDB from './config/db';
import routes from './routes';

// Connect to database
connectDB();

// Routes not found
app.use((req: Request, res: Response, next: NextFunction) => {
    res.status(404).send('404 Not Found');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});