# Piotr – Petits travaux

Application web simple pour gérer des petits travaux :

- **Clients** : créent un compte, consultent le calendrier (créneaux pris affichés « Occupé » / « Indisponible », sans détail), demandent un créneau libre, suivent leurs demandes et le décompte (heures × tarif + achats). Chacun ne voit que ses propres interventions.
- **Administrateur (vous)** : valide / refuse les demandes, bloque des périodes d'indisponibilité, fixe le tarif horaire (par défaut et par intervention), encode les heures prestées et les achats (ex. un râteau à 19,99 €). Le total est calculé automatiquement.

Le **premier compte créé devient administrateur** (ou celui dont l'e-mail correspond à la variable `ADMIN_EMAIL`).

## Lancer

Node.js ≥ 22.5 requis (base SQLite intégrée, aucun serveur de base de données à installer).

```bash
npm install
npm start          # http://localhost:3000
```

Variables utiles : `PORT`, `DB_PATH` (fichier SQLite, défaut `data.sqlite`), `ADMIN_EMAIL`.
