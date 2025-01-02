import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import connectDB from './config/db';
import routes from './routes';

dotenv.config();

const app = express();

// Connect to database
connectDB();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api', routes);

// Route de base générique
app.get('/', (req: Request, res: Response) => {
    res.send('API is running');
});

// Gestion des routes non trouvées
app.use((req: Request, res: Response, next: NextFunction) => {
    res.status(404).send('404 Not Found');
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});