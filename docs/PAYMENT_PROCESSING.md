# Registre de traitement - Traitement des paiements PayPal

## Description du traitement
- **Nom du traitement** : Gestion des paiements via PayPal
- **Finalité** : Permettre aux utilisateurs de payer et recevoir des paiements via PayPal
- **Responsable** : MyKpopTrade SAS
- **Base légale** : Contrat (CGV) et consentement explicite

## Catégories de données traitées
- **Données d'identification** : ID utilisateur, email PayPal
- **Données de transaction** : montant, devise, identifiant de transaction, date
- **Données techniques** : IP anonymisée, identifiants de session

## Durée de conservation
- Données de transaction : 3 ans après la transaction (obligation légale)
- Données personnelles : anonymisées 2 ans après la transaction pour les utilisateurs actifs, ou immédiatement sur demande

## Mesures de sécurité
- Chiffrement des données sensibles au repos (AES-256)
- Transmission TLS 1.2+ pour toutes les communications avec PayPal
- Anonymisation des identifiants dans les logs (masquage partiel)
- Accès restreint aux données de paiement (authentification JWT)
- Détection des accès suspects aux données

## Exercice des droits
- Droit d'accès : export au format JSON via l'API
- Droit à l'effacement : anonymisation sur demande via l'API
- Droit à la portabilité : export au format standard

## Sous-traitants
- PayPal (traitement des paiements) - Transfert hors UE couvert par clauses contractuelles types

## Journalisation et audit
- Journalisation sécurisée sans données personnelles identifiables
- Système de détection d'accès suspect
- Conservation des logs d'audit pendant 1 an

## Procédure en cas de violation de données
1. Notification au DPO via email automatique
2. Analyse de l'impact potentiel sur les droits et libertés
3. Notification à la CNIL si nécessaire (72h)
4. Notification aux personnes concernées si risque élevé