require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

// Connect to database
connectDB();

app.use(cors());
app.use(express.json());

// Routes
const routes = require('./routes');
app.use('/api', routes);

// Route de base générique
app.get('/', (req, res) => {
    res.send('API is running');
});

// Gestion des routes non trouvées
app.use((req, res, next) => {
    res.status(404).send('404 Not Found');
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});