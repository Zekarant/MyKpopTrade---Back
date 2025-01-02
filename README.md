# MyKpopTrade - Back

Ce projet est le backend de l'application MyKpopTrade, une plateforme de vente et d'échange de cartes de K-Pop.

## Prérequis

- Node.js (version 14 ou supérieure) : [Site officiel](https://nodejs.org/en)
- npm (version 6 ou supérieure)
- Docker Desktop (pour MongoDB) : [Site officiel](https://www.docker.com/products/docker-desktop/)
- WLS2 (Pour Windows) : [Site d'installation de WLS2](https://learn.microsoft.com/fr-fr/windows/wsl/install)

## Installation

1. Clonez le dépôt :

```sh
git clone https://github.com/Zekarant/MyKpopTrade---Back.git
cd MyKpopTrade---Back
```

2. Installez les dépendances

```sh
npm install
```

3. Configurez les variables d'environnement

- Créez un fichier ```.env``` à la racine du projet et ajoutez les valeurs suivantes :

```sh
PORT=3000
MONGO_URI=mongodb://localhost:27017/mykpoptrade
```

4. Démarrez MongoDB avec Docker

```sh
docker-compose up -d
```

5. Démarrer le serveur

- Mode développement :

```sh
npm run dev
```

- Mode production :

```sh
npm start
```

6. Utilisation

L'API sera disponible à l'adresse suivante : <http://localhost:3000>

7. Structure du projet

- config/ : Configuration de la base de données
- controllers/ : Contrôleurs pour les routes
- models/ : Modèles Mongoose
- routes/ : Définition des routes
- index.js : Point d'entrée de l'application
