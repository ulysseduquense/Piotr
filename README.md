# Piotr – Petits travaux

Application web simple pour gérer des petits travaux, organisée en **activités** : chaque personne qui fait des travaux (le **prestataire**) crée son activité et la partage à ses **clients** par un **lien d’invitation**, un peu comme on partage un Tricount. Un même compte peut être prestataire de sa propre activité et client de plusieurs autres.

- **Compte** : une simple personne (nom, e-mail, téléphone, mot de passe). Il n’y a plus de rôle global : le rôle dépend de chaque activité.
- **Prestataire** (créateur de l’activité) : partage son lien d’invitation (`/join/<code>`), peut le régénérer (l’ancien lien cesse de fonctionner), voit et retire ses membres, fixe le tarif horaire par défaut de l’activité (et par intervention), bloque des périodes d’indisponibilité, valide / refuse les demandes, encode les heures prestées et les achats (ex. un râteau à 19,99 €). Le total est calculé automatiquement.
- **Client** (a rejoint l’activité par le lien) : consulte le calendrier de l’activité (créneaux pris affichés « Occupé » / « Indisponible », sans détail), demande un créneau libre, suit ses demandes et le décompte (heures × tarif + achats). Chacun ne voit que ses propres interventions. Un client retiré de l’activité perd l’accès à celle-ci et à ses anciennes demandes, que le prestataire continue de voir.

Tout (calendrier, indisponibilités, réservations, tarif, membres) est rattaché à une activité ; les activités sont indépendantes les unes des autres (le même créneau peut être pris dans deux activités différentes).

**Photos** : chaque intervention peut recevoir des photos (avant/après, et, pour le prestataire seulement, le justificatif d’un achat lié à l’intervention). Les fichiers sont stockés dans le bucket **R2** `piotr-photos` (binding `PHOTOS`, à créer avec `npx wrangler r2 bucket create piotr-photos`), les métadonnées dans la table `photos` de D1. Limite : **10 Mo** par fichier ; formats acceptés : JPEG, PNG, WebP, GIF et HEIC/HEIF, reconnus d’après le contenu du fichier (pas d’après l’extension ni le type annoncé). Les photos ne sont visibles que par le prestataire et le client de l’intervention (`GET /api/photos/<id>`, `?download=1` pour télécharger) ; le client peut supprimer celles qu’il a lui-même envoyées.

## API

Authentification par cookie de session `sid`. Un non-membre d’une activité reçoit **404** sur toutes ses routes (son existence n’est jamais révélée) ; un client qui tente une action de prestataire reçoit **403** `ADMIN_ONLY` (« Réservé au prestataire »). Même grille pour une intervention : **404** si elle est invisible pour l’utilisateur (autre client, non-membre, client retiré de l’activité), **403** si le client de l’intervention tente une action de prestataire.

- **Compte** : `POST /api/register` `{email, name, password, phone?}` · `POST /api/login` · `POST /api/logout` · `GET /api/me` → `{user: {id, email, name, phone} | null, activities: [{id, name, role: 'owner'|'client', owner_name, default_rate*, invite_code*, members_count*}]}` (`*` : prestataire seulement).
- **Activités** : `POST /api/activities` `{name, default_rate?}` (nom de 2 à 60 caractères, tarif ≥ 0, 25 par défaut) · `GET /api/activities/:aid` · `PATCH /api/activities/:aid` `{name?, default_rate?}` · `POST /api/activities/:aid/invite/regenerate` → `{invite_code}` · `GET /api/activities/:aid/members` → `[{id, name, email, phone, role, joined_at}]` · `DELETE /api/activities/:aid/members/:userId` (le prestataire ne peut pas être retiré).
- **Lien d’invitation** : `GET /api/join/:code` (public) → `{activity: {id, name}, owner: {name}}` · `POST /api/join/:code` (connecté, idempotent) → `{activity: {id, name, role}}`. La page `/join/<code>` est servie par `index.html` (`not_found_handling: single-page-application`).
- **Dans une activité** : `GET /api/activities/:aid/calendar` · `POST /api/activities/:aid/unavailabilities` et `DELETE /api/unavailabilities/:id` (prestataire) · `GET /api/activities/:aid/bookings` (prestataire : toutes ; client : les siennes) · `POST /api/activities/:aid/bookings` `{start, end, description?, address?}` (tarif = tarif par défaut de l’activité ; le prestataire peut encoder une intervention passée).
- **Interventions** : `GET /api/bookings/:id` · `PATCH /api/bookings/:id` (client : annulation seulement) · `POST /api/bookings/:id/work`, `DELETE /api/work/:id`, `POST /api/bookings/:id/expenses`, `DELETE /api/expenses/:id` (prestataire) · `POST /api/bookings/:id/photos`, `GET /api/photos/:id`, `DELETE /api/photos/:id`. Les objets intervention portent `activity_id`.

**Erreurs** : chaque réponse d’erreur est un JSON `{ "error": "<message en français>", "code": "<CODE>" }`. Le `code` est stable et sert à l’interface pour afficher le message dans la langue de l’utilisateur : `NOT_LOGGED_IN` (401), `ADMIN_ONLY`, `CLIENT_CANCEL_ONLY` (403), `NOT_FOUND`, `INVITE_INVALID` (404), `REGISTER_INVALID`, `ACTIVITY_INVALID`, `CANNOT_REMOVE_OWNER`, `SLOT_INVALID`, `SLOT_PAST`, `STATUS_INVALID`, `WORK_INVALID`, `EXPENSE_INVALID`, `PERIOD_INVALID`, `RATE_INVALID`, `FILE_MISSING`, `FILE_TYPE`, `EXPENSE_MISMATCH`, `CAPTION_INVALID` (400), `EMAIL_TAKEN`, `SLOT_UNAVAILABLE` (409), `INVALID_CREDENTIALS` (401), `FILE_TOO_LARGE` (413), `SERVER_ERROR` (500).

## Lancer

L’application tourne sur **Cloudflare Workers** : l’API (`src/worker.js`, framework Hono) utilise une base **D1** (SQLite géré par Cloudflare) et les fichiers de `public/` sont servis comme assets statiques. Node.js ≥ 22 est requis pour l’outil `wrangler`.

### En local

```bash
npm install
npm run db:migrate:local   # crée les tables dans une base D1 locale (dossier .wrangler/, ignoré par git)
npm run dev                # http://localhost:8787
```

### Déploiement sur Cloudflare

```bash
npx wrangler login
npx wrangler d1 create piotr   # copier l'id affiché dans wrangler.jsonc → d1_databases[0].database_id
npm run db:migrate             # applique migrations/ sur la base distante
npm run deploy                 # publie le Worker sur https://piotr.<compte>.workers.dev
```

Les évolutions de schéma s’ajoutent sous forme de nouveaux fichiers dans `migrations/` (`npx wrangler d1 migrations create piotr <nom>`), puis `npm run db:migrate:local` / `npm run db:migrate`.

La migration `0003_activities.sql` fait passer une base existante au modèle multi-activités sans perte de données : chaque ancien administrateur reçoit une activité à son nom (tarif = ancien réglage `default_rate`), les autres comptes deviennent clients de l’activité du premier administrateur, qui reçoit aussi toutes les réservations et indisponibilités existantes ; les tables `bookings` / `unavailabilities` sont reconstruites avec `activity_id` en conservant les ids (et donc les heures, achats et photos rattachés), puis `settings` et `users.role` sont supprimées.
