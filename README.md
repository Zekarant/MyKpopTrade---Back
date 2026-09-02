# MyKpopTrade — API

Backend de MyKpopTrade, plateforme de vente et d'échange de photocards K-Pop.

MyKpopTrade agit comme **intermédiaire technique** : les fonds ne transitent
jamais par la plateforme, ils circulent directement entre acheteur et vendeur
via PayPal, seul canal de paiement depuis le retrait de Stripe.

## Prérequis

- **Node.js 20+** (Express 5 et la chaîne TypeScript actuelle ne supportent plus Node 14/16)
- npm 9+
- MongoDB 6+ — un `docker-compose.yml` est fourni
- Docker Desktop (optionnel, pour MongoDB) : [site officiel](https://www.docker.com/products/docker-desktop/)

## Installation

```sh
git clone https://github.com/Zekarant/MyKpopTrade---Back.git
cd MyKpopTrade---Back
npm install
```

### Configuration

Copier `.env.example` en `.env` et renseigner les valeurs :

```sh
cp .env.example .env
```

Le schéma de référence est [`src/config/env.ts`](src/config/env.ts) (validation Zod).
**L'API refuse de démarrer si la configuration est invalide** — c'est voulu :
mieux vaut un crash explicite au boot qu'une erreur au premier appel.

Variables obligatoires en production, sans valeur par défaut acceptée :

| Variable | Rôle |
| --- | --- |
| `JWT_SECRET` | Signature des tokens (32 car. min.). `openssl rand -hex 32` |
| `MESSAGE_ENCRYPTION_KEY` | Chiffrement des messages (32 car. min.) |
| `ENCRYPTION_KEY` | Chiffrement des données personnelles (32 car. min.) |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Paiements |
| `CORS_ORIGINS` | Domaines front autorisés à appeler l'API |
| `TRUST_PROXY` | `1` derrière un reverse proxy, sinon le rate limiting par IP est inopérant |

### Démarrage

```sh
docker-compose up -d   # MongoDB
npm run dev            # développement (ts-node)
```

En production :

```sh
npm run build && npm start
```

L'API écoute sur <http://localhost:3000>.

## Scripts

| Commande | Effet |
| --- | --- |
| `npm run dev` | Serveur de développement |
| `npm run build` | Compilation TypeScript vers `dist/` |
| `npm start` | Lance `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Suite Jest |
| `npm run test:coverage` | Suite Jest avec couverture |
| `npm run paypal:status` | Diagnostic de la configuration PayPal |

## Supervision

| Endpoint | Sémantique |
| --- | --- |
| `GET /health` | *Liveness* — le process répond. Ne teste aucune dépendance. |
| `GET /ready` | *Readiness* — MongoDB est joignable. `503` sinon. |

À brancher sur les sondes de l'orchestrateur : `/health` pour le redémarrage,
`/ready` pour le routage du trafic.

## Structure

```
src/
├── app.ts                  Application Express (middlewares, routes, handlers)
├── index.ts                Point d'entrée : connexion Mongo + listen + CRON
├── config/                 env (Zod), passport, configuration paiements
├── models/                 Schémas Mongoose
├── commons/
│   ├── middlewares/        auth, erreurs, détection de fuite de données
│   ├── services/           tokens JWT / refresh tokens
│   ├── tasks/              CRON : anonymisation RGPD, suivi colis, réservations
│   └── utils/              logger (avec sanitisation), chiffrement, erreurs HTTP
└── modules/                Un dossier par domaine métier
    ├── auth/               inscription, connexion, OAuth, mots de passe
    ├── users/              RGPD (export, suppression, anonymisation), admin
    ├── products/ posts/    annonces et fil d'actualité
    ├── payments/           PayPal, Stripe Connect, remboursements, suivi colis
    ├── messaging/          conversations chiffrées, offres, négociation
    ├── cart/ addresses/    panier et carnet d'adresses
    ├── disputes/ reports/  litiges et signalements
    └── search/ seo/ ...    recherche, sitemap
```

Chaque module suit la même découpe : `routes.ts` → `controllers/` (fin, valide et
délègue) → `services/` (logique métier, testée unitairement).

## Tests

```sh
npm test
```

Les tests d'intégration utilisent `mongodb-memory-server` : aucune base externe
n'est requise. Les tests vivent dans `__tests__/` au plus près du code testé.

## Sécurité de l'authentification

| Mécanisme | Détail |
| --- | --- |
| Mot de passe | bcrypt |
| Session | JWT 15 min + refresh token 7 jours, révocables |
| Double authentification | TOTP (RFC 6238), optionnelle — voir ci-dessous |
| Vérification du téléphone | code à 6 chiffres par SMS (Twilio), `crypto.randomInt` |
| Rate limiting | par IP sur connexion / inscription / envoi d'emails, par utilisateur sur les SMS |

### Double authentification (TOTP)

Compatible Google Authenticator, Authy, 1Password et tout client RFC 6238.
L'algorithme est implémenté dans [`commons/utils/totp.ts`](src/commons/utils/totp.ts)
et sa conformité est vérifiée contre les vecteurs de test de l'annexe B de la
RFC 6238, en SHA-1, SHA-256 et SHA-512.

| Endpoint | Rôle |
| --- | --- |
| `GET /api/auth/2fa/status` | État de la 2FA du compte |
| `POST /api/auth/2fa/setup` | Génère un secret en attente + QR code. N'active rien |
| `POST /api/auth/2fa/enable` | Confirme avec un premier code, rend 8 codes de secours |
| `POST /api/auth/2fa/verify` | 2ᵉ étape de connexion. Public, protégé par le jeton de défi |
| `POST /api/auth/2fa/disable` | Exige mot de passe **et** code |
| `POST /api/auth/2fa/recovery-codes` | Régénère les codes de secours |

Propriétés garanties, et couvertes par les tests :

- le secret est chiffré au repos, les codes de secours sont stockés hachés ;
- l'activation est en deux temps : aucun compte ne peut se verrouiller sur un
  secret que l'utilisateur n'aurait pas enregistré ;
- un code TOTP déjà consommé est refusé, même dans sa fenêtre de 30 s ;
- un code de secours ne sert qu'une fois ;
- le jeton de défi émis à la connexion ne donne accès à aucune route de l'API.

## Conformité RGPD

- Export des données personnelles : `GET /api/users/me/data-export`
- Demande de suppression de compte : `POST /api/users/me/deletion-request`
- Anonymisation : `POST /api/users/me/anonymize`
- Consentements : `PUT /api/users/me/consents`
- Anonymisation automatique des paiements de plus de 3 ans (CRON hebdomadaire,
  cf. `commons/tasks/gdprCleanupTask.ts`)
- Les logs passent par un sanitizer qui masque mots de passe, tokens, emails et
  adresses (cf. `commons/utils/logger.ts` — l'ordre des formats winston y est
  critique, un test le verrouille).
- Les pièces jointes de conversation ne sont **pas** servies en statique : elles
  passent par une route authentifiée qui vérifie l'appartenance à la conversation
  (cf. `app.ts` et `modules/messaging/routes.ts`).
- La purge des pièces jointes déjà publiées dans l'historique git est décrite
  dans [`docs/PURGE_IMAGES_HISTORIQUE.md`](docs/PURGE_IMAGES_HISTORIQUE.md).

## Documentation complémentaire

- [`docs/PAYMENT_PROCESSING.md`](docs/PAYMENT_PROCESSING.md) — flux de paiement
- [`CLAUDE.md`](CLAUDE.md) — conventions de code du projet
