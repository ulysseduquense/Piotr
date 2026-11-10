# Piotr – Petits travaux

Application web simple pour gérer des petits travaux :

- **Clients** : créent un compte, consultent le calendrier (créneaux pris affichés « Occupé » / « Indisponible », sans détail), demandent un créneau libre, suivent leurs demandes et le décompte (heures × tarif + achats). Chacun ne voit que ses propres interventions.
- **Administrateur (vous)** : valide / refuse les demandes, bloque des périodes d'indisponibilité, fixe le tarif horaire (par défaut et par intervention), encode les heures prestées et les achats (ex. un râteau à 19,99 €). Le total est calculé automatiquement.

Le **premier compte créé devient administrateur** (ou celui dont l'e-mail correspond à la variable `ADMIN_EMAIL`).

## Lancer

L'application tourne sur **Cloudflare Workers** : l'API (`src/worker.js`, framework Hono) utilise une base **D1** (SQLite géré par Cloudflare) et les fichiers de `public/` sont servis comme assets statiques. Node.js ≥ 22 est requis pour l'outil `wrangler`.

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

Variable `ADMIN_EMAIL` (`vars` dans `wrangler.jsonc`, ou `npx wrangler secret put ADMIN_EMAIL` pour ne pas la versionner) : si elle est renseignée, seul le compte créé avec cet e-mail devient administrateur ; sinon, c'est le premier compte créé.

Les évolutions de schéma s'ajoutent sous forme de nouveaux fichiers dans `migrations/` (`npx wrangler d1 migrations create piotr <nom>`), puis `npm run db:migrate:local` / `npm run db:migrate`.
