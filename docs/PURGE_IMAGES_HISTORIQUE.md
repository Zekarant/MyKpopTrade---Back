# Purge des pièces jointes privées de l'historique git

## Pourquoi

Quatre pièces jointes de conversations privées d'utilisateurs ont été committées
avant que `uploads/` ne soit ajouté au `.gitignore` :

```
uploads/chat_attachments/1042ef6267ad73879f19052c1e1a0454.jpg
uploads/chat_attachments/224785d144a299be37a8fe3954a49ec6.jpg
uploads/chat_attachments/a47ec52b54b38f4f5f05462d083b8b31.jpg
uploads/chat_attachments/b74023940ccfbaf90fb5cfaafe7b7ebe.jpg
```

Elles ont été retirées de l'index, mais **restent présentes dans l'historique du
dépôt distant**. Tant qu'elles y sont, elles sont récupérables par quiconque peut
cloner le dépôt : c'est de la donnée personnelle exposée (RGPD art. 5, principe
de minimisation).

> **Note importante** : ces fichiers étaient également servis publiquement par
> `express.static` avant la correction de `app.ts`. Les noms de fichiers ayant
> été publiés sur GitHub, considérer ces quatre images comme compromises même
> après la purge. Si elles correspondent à de vraies conversations, le plus sûr
> est de les supprimer aussi du disque serveur.

## Avant de commencer

Cette opération **réécrit tout l'historique** : tous les SHA de commits changent.
Trois conditions non négociables :

1. **Arbre de travail propre.** `git status` doit être vide. `filter-branch`
   refuse de tourner autrement.
2. **Sauvegarde.** Créer un bundle avant toute chose (étape 1 ci-dessous).
3. **Coordination avec les autres contributeurs.** Après le force-push, tout
   clone existant est désynchronisé. Chaque personne devra re-cloner, ou
   exécuter `git fetch origin && git reset --hard origin/master`. Prévenir
   **avant** de pousser, et s'assurer que personne n'a de travail non poussé.

La branche `feat/login-google` existe aussi côté distant : elle est réécrite par
la procédure et doit être force-pushée elle aussi.

## Procédure

Toutes les commandes se lancent depuis la racine du dépôt back.

### 1. Sauvegarde

```sh
git bundle create ../mykpoptrade-back-avant-purge.bundle --all
```

Conserver ce fichier jusqu'à validation complète. Pour restaurer en cas de
problème : `git clone --mirror ../mykpoptrade-back-avant-purge.bundle`.

### 2. Purge des fichiers sur toutes les refs

```sh
export FILTER_BRANCH_SQUELCH_WARNING=1

git filter-branch -f --index-filter \
  'git rm -r --cached --ignore-unmatch uploads/chat_attachments' \
  --prune-empty --tag-name-filter cat -- --all
```

Le `-f` est nécessaire : des `refs/original/` d'un précédent `filter-branch`
existent déjà dans le dépôt.

### 3. Supprimer les refs de sauvegarde et compacter

Sans cette étape, les anciens objets restent atteignables via `refs/original/`
et le reflog : **la purge n'est pas effective**.

```sh
git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

### 4. Vérifier

```sh
# Doit afficher 0 pour chacun des quatre fichiers
for f in 1042ef6267ad73879f19052c1e1a0454 224785d144a299be37a8fe3954a49ec6 \
         a47ec52b54b38f4f5f05462d083b8b31 b74023940ccfbaf90fb5cfaafe7b7ebe; do
  echo "$f.jpg : $(git log --all --oneline -- "uploads/chat_attachments/$f.jpg" | wc -l) commit(s)"
done

# Doit ne rien afficher
git rev-list --objects --all | grep chat_attachments

# Doit afficher le même nombre de commits qu'avant (101 au moment de la rédaction)
git rev-list --count master
```

### 5. Pousser

⚠️ **Point de non-retour.** Ne rien pousser avant d'avoir validé l'étape 4 et
prévenu les autres contributeurs.

```sh
git push --force-with-lease origin master
git push --force-with-lease origin feat/login-google
```

`--force-with-lease` plutôt que `--force` : le push échoue si quelqu'un a poussé
entre-temps, au lieu d'écraser son travail.

### 6. Demander la purge côté GitHub

Le force-push retire les objets des branches, mais GitHub garde des objets
inatteignables en cache et les expose encore via l'URL directe du blob
(`https://github.com/<org>/<repo>/blob/<sha>/...`) pendant un temps indéterminé.

Ouvrir un ticket au support GitHub en demandant explicitement le
*garbage collection* du dépôt, en citant les SHA des commits concernés.
Cf. la documentation GitHub « Removing sensitive data from a repository ».

## Après la purge

Les autres contributeurs doivent, au choix :

```sh
# Option simple : re-cloner
git clone https://github.com/Zekarant/MyKpopTrade---Back.git

# Option sur un clone existant, en perdant les commits locaux non poussés
git fetch origin
git reset --hard origin/master
```

## Procédure validée

Cette procédure a été exécutée et vérifiée le 2 septembre 2026 sur un clone
miroir du dépôt : les quatre fichiers disparaissent de l'historique, les 101
commits sont préservés, les messages de commit sont inchangés, et l'arbre de
fichiers du dernier commit est identique à l'original hors images (comparaison
par empreinte).
