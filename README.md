# Caisse Café ☕

Logiciel de caisse pour café / petite restauration, pensé pour une **tablette Android avec une imprimante ticket USB**, et un **back-office consultable partout** (téléphone, PC) en temps réel.

- **Caisse** : plan des tables + ventes comptoir, ajout/retrait d'articles, annulation de ligne ou de commande, changement de table, addition, encaissement (espèces avec rendu monnaie, carte, autre), impression du ticket, rapport du jour.
- **Back-office** : suivi en direct (tables, commandes en cours, ce qui est encaissé ou non), chiffre d'affaires global / par produit / par catégorie / par mode de paiement / par jour ou par heure sur la période de votre choix, export CSV, historique des tickets (réimpression, annulation), gestion des produits, catégories et tables, en-tête du ticket.
- Montants en **dinars (3 décimales)**, tickets **58 mm** (ou 80 mm).

Aucune compilation : ce sont des fichiers HTML/JS/CSS statiques.

---

## 1. Essayer tout de suite (mode local)

Sans configuration, l'appli fonctionne en **mode local** : les données restent dans le navigateur, avec des produits et tables de démo.

```bash
python -m http.server 8765
```

Puis ouvrez <http://localhost:8765>. En mode local, la caisse et le back-office ne se synchronisent qu'entre onglets du **même** appareil.

## 2. Mettre en ligne (mode cloud, recommandé)

### a) Base de données Supabase (gratuit)

1. Créez un compte et un projet sur <https://supabase.com>.
2. **SQL Editor → New query** : collez le contenu de [`supabase/schema.sql`](supabase/schema.sql) puis **Run**.
3. **Authentication → Users → Add user** : créez un compte (email + mot de passe) pour la caisse, et un pour vous si vous voulez.
4. **Authentication → Sign In / Providers** : **désactivez « Allow new users to sign up »** pour que personne d'autre ne puisse créer de compte.
5. **Project Settings → API** : copiez l'**URL** et la clé **anon public**, et collez-les dans [`js/config.js`](js/config.js).

> La clé « anon » peut être publique : sans compte connecté, la base refuse tout accès (règles RLS du schéma).

### a bis) Rôles : gérant / caisse

1. **SQL Editor** : exécutez [`supabase/roles.sql`](supabase/roles.sql).
2. Désignez le gérant (accès au back-office) — remplacez l'email :
   ```sql
   update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"manager"}'
   where email = 'email-du-gerant@exemple.tn';
   ```
   Le gérant se déconnecte puis se reconnecte.
3. Tout autre compte est **caisse** : il ne voit que l'écran de caisse, ne peut ni lire le chiffre d'affaires, ni modifier la carte, ni toucher à l'historique (bloqué aussi côté base de données).

> Import MOJO : [`supabase/import_mojo.sql`](supabase/import_mojo.sql) vide la caisse, installe la carte MOJO et l'historique de l'ancienne caisse.

### b) Hébergement (HTTPS obligatoire pour l'imprimante USB)

Le plus simple, avec ce dépôt GitHub : **Settings → Pages → Deploy from a branch → `main` / root**. L'appli sera disponible sur `https://<utilisateur>.github.io/POS/`.

(Autres options : Netlify ou Cloudflare Pages, en glissant le dossier.)

## 3. Installer la caisse sur la tablette Android

1. Ouvrez l'adresse de l'appli dans **Chrome**, connectez-vous.
2. Menu ⋮ → **Ajouter à l'écran d'accueil** / **Installer l'application** : la caisse s'ouvre alors en plein écran directement sur les tables.
3. Branchez l'imprimante (câble **USB OTG**).
4. Dans la caisse, touchez le bouton **🖨** en haut → mode **USB direct** → **Connecter l'imprimante USB** → choisissez-la → **Imprimer un test**.

**Si l'imprimante n'apparaît pas ou n'imprime pas** en USB direct :
- installez l'application **RawBT** (Play Store), configurez-y votre imprimante USB, puis choisissez le mode **Application RawBT** dans la caisse ;
- ou, si un pilote d'impression Android est installé pour votre imprimante, choisissez **Impression Android / Chrome**.

Le mode **Aperçu à l'écran** permet de tout tester sans imprimante.

## 4. Utilisation au quotidien

| Action | Où |
|---|---|
| Prendre une commande | Caisse → toucher une table (ou **Nouvelle vente** au comptoir) → toucher les produits |
| Retirer un article | Bouton **−** (une unité) ou **✕** (toute la ligne). Le retrait est conservé pour le suivi des annulations |
| Imprimer l'addition | **Addition** |
| Encaisser | **Encaisser** → mode de paiement → montant reçu (calcul du rendu) → **Valider & imprimer** |
| Annuler une commande | **Annuler** (motif facultatif) |
| Déplacer une commande | **Changer de table** |
| Réimprimer | **Réimprimer dernier** (caisse) ou Back-office → Historique |
| Clôture de la journée | **Rapport du jour** → Imprimer |
| Produits, prix, tables | Back-office → Produits / Tables |
| Nom, adresse, matricule fiscal sur le ticket | Back-office → Paramètres |
| Empêcher le personnel d'ouvrir le back-office | Back-office → Paramètres → Code PIN |

## Structure

```
index.html            page unique
css/style.css         styles (clair / sombre)
js/config.js          ← vos clés Supabase
js/app.js             connexion, accueil, navigation
js/pos.js             écran caisse
js/admin.js           back-office
js/printer.js         impression (WebUSB, RawBT, navigateur, aperçu)
js/ticket.js          mise en page des tickets + encodage ESC/POS
js/data.js            statistiques et paramètres
js/db.js              accès aux données (local ou Supabase + temps réel)
supabase/schema.sql   tables, sécurité, temps réel, données de départ
```

## Limites connues

- En mode cloud, la caisse a besoin d'internet pour enregistrer les ventes (pas de file d'attente hors-ligne pour l'instant).
- Les caractères accentués sont imprimés sans accent (ex. « Cafe »), pour être compatibles avec toutes les imprimantes thermiques.

## Compilation (compatibilité vieux navigateurs)

L'appli est compilée en un seul fichier compatible avec **Chrome 51+** (tablettes Android 6/7 et plus), avec la librairie Supabase et les polyfills inclus : rien n'est téléchargé depuis un CDN au démarrage.

Après toute modification de `js/` ou `css/` :

```bash
npm install
```

```bash
npm run build
```

puis commitez aussi `dist/` (c'est ce que charge `index.html`).
