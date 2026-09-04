# Spec — Music Fetcher pour Navidrome

## 1. Stack technique

**Node.js + Express + EJS + Socket.io**

- EJS : rendu serveur simple, un seul écran, pas besoin de SPA complexe (React serait overkill pour ce use case).
- Socket.io : recherche en temps réel (debounce côté client) + notifications d'avancement non-bloquantes, sans polling.
- `yt-dlp` (binaire, pas la lib node) : le plus fiable pour extraire l'audio YouTube en best quality.
- `ffmpeg` : conversion + normalisation.
- `node-id3` ou `music-metadata` (lecture) + `node-id3`/`ffmpeg -metadata` (écriture) pour l'embed des tags + cover + paroles synchronisées (USLT/SYLT pour mp3, ou tag LYRICS pour flac).
- APIs externes : Deezer (publique, pas de clé requise pour la recherche) + Spotify Web API (client credentials flow, nécessite `CLIENT_ID`/`CLIENT_SECRET`) + lrclib.net (pas de clé).

## 2. Architecture / flow

```
[Client] --search query (debounced)--> [Socket: "search"]
   <-- résultats agrégés Deezer+Spotify (nom, artiste, cover, durée) --

[Client] --sélection track(s) ou URL playlist--> [Socket: "queue:add"]

[Worker Queue] pour chaque item :
  1. Résoudre la source YouTube (ytsearch "{artist} - {title} {duration filter}")
  2. Vérifier si le fichier existe déjà dans le path Navidrome (skip + notif si oui)
  3. yt-dlp --extract-audio --audio-format flac/mp3 -> fichier temp
  4. Fetch metadata complètes (Deezer/Spotify: album, artiste album, n° piste, disque, date, genre, cover HD)
  5. Fetch lyrics lrclib.net (synced .lrc en priorité, sinon plain, sinon skip silencieusement)
  6. Embed : tags ID3/Vorbis + cover + paroles synchronisées dans le fichier
  7. Renommer/déplacer vers l'arborescence Navidrome
  8. Émettre progression via socket ("queue:progress", "queue:done", "queue:skipped", "queue:error")
```

Queue traitée séquentiellement (ou 2-3 en parallèle max pour ne pas se faire rate-limit par YouTube).

## 3. Arborescence Navidrome

Navidrome lit bien la structure standard :

```
/music/{AlbumArtist}/{Album} ({Year})/{TrackNumber:02d} - {Title}.{ext}
```

- Cover embarquée dans le fichier (pas besoin de `cover.jpg` séparé, mais on peut aussi en écrire un dans le dossier album pour compat totale).
- `.lrc` synchronisé écrit à côté du fichier audio (Navidrome le lit nativement) **en plus** de l'embed dans les tags.

## 3bis. Décisions confirmées

- **Format** : MP3 320kbps CBR (`ffmpeg -b:a 320k`), `yt-dlp -x --audio-format mp3 --audio-quality 0` en entrée puis réencodage propre.
- **Source de recherche** : bouton toggle Deezer ⇄ Spotify en haut de la barre de recherche. Deezer par défaut (pas de clé API, plus rapide, pas de rate-limit agressif) ; Spotify dispo si tu préfères son catalogue/matching. Un seul actif à la fois, pas de fusion des deux dans les résultats (plus simple à lire, évite les doublons visuels).
- **Résolution audio** : l'utilisateur cherche par titre/artiste dans Deezer ou Spotify et choisit le morceau dans la liste (pas de choix manuel de la vidéo YouTube) → le serveur résout automatiquement la meilleure source YouTube en interne (`ytsearch5 "{artist} - {title}"`, on filtre par durée la plus proche ±5s puis on prend le 1er résultat, fallback résultat suivant si échec de download).
- **Import par lien YouTube (vidéo ou playlist)** : même pipeline mais à l'envers — on parse le titre YouTube (nettoyage regex des trucs type "(Official Video)", "ft.", etc.), on cherche l'équivalent sur Deezer (ou Spotify selon le toggle actif) pour récupérer les vraies métadonnées/cover, si aucun match → on tague avec les infos YouTube brutes + notif "métadonnées partielles".
- **Import Spotify/Deezer playlist** : lecture de la playlist via l'API du service → chaque piste passe par le pipeline normal (résolution YouTube automatique).
- **Concurrence** : téléchargements en parallèle, limité par `MAX_CONCURRENT_DOWNLOADS` (env, défaut 3) via `p-limit` — évite de saturer la bande passante ou de se faire rate-limit par YouTube.

## 4. Structure du projet

```
navidrome-fetcher/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── src/
│   ├── server.js              # Express + Socket.io init
│   ├── routes/
│   │   └── index.js
│   ├── sockets/
│   │   ├── search.js           # handlers "search"
│   │   └── queue.js             # handlers "queue:add", worker
│   ├── services/
│   │   ├── deezer.js
│   │   ├── spotify.js
│   │   ├── ytdlp.js
│   │   ├── lyrics.js            # lrclib
│   │   ├── tagger.js            # embed metadata + cover + lyrics
│   │   └── library.js           # check duplicate, build path, move file
│   ├── views/
│   │   ├── index.ejs
│   │   └── partials/
│   └── public/
│       ├── css/style.css
│       └── js/app.js            # socket client, debounce search, UI logic
├── tmp/                          # downloads temporaires
└── README.md
```

## 5. Frontend

**Palette** : fond beige clair (`#F5F1E8`) ou blanc, texte/bordures noir plein (`#111`), pas de gris — traits épais (2-3px), coins carrés ou très légèrement arrondis, esthétique "brutaliste minimal".

- Barre de recherche en haut, large, bordure noire épaisse, pas d'ombre.
- Résultats sous forme de rectangles (liste verticale) : cover carrée à gauche, titre + artiste au centre, bouton "+" à droite. Mise à jour en live à chaque frappe (socket `search`, debounce ~300ms).
- Toggle Deezer/Spotify juste au-dessus ou à côté de la barre de recherche (deux boutons pill, celui actif en noir plein, l'autre en contour).
- Champ alternatif : coller une URL (YouTube vidéo/playlist, playlist Spotify/Deezer) → bouton "Ajouter à la file", même style rectangulaire.
- Notification d'avancement : rectangle flottant en bas à droite, coins arrondis moyens, ne bloque pas l'UI (position fixed, empilable si plusieurs téléchargements simultanés) — cover miniature, artiste, titre, barre de progression fine en bas du rectangle. Disparaît/se transforme en check ✓ ou croix ✗ à la fin.
- Cas "déjà présent" → notification distincte (icône différente, ex. bordure orange) "déjà dans la bibliothèque, ignoré".
- Erreurs → même système de notif, message clair en français, jamais de stack trace brute affichée à l'utilisateur.

## 6. Gestion d'erreurs (côté service)

- Aucun résultat YouTube pertinent trouvé → notif "Impossible de trouver une source audio pour ce titre".
- Metadata Deezer/Spotify introuvables → fallback sur les infos YouTube brutes + notif "Métadonnées partielles".
- lrclib sans résultat → on continue sans paroles, pas d'erreur bloquante.
- Écriture fichier échoue (permissions, disque plein) → notif explicite + log serveur.
- Toujours wrap chaque étape du worker en try/catch, jamais crash du process entier.

## 7. Authentification (activable)

- Simple middleware Express : si `ENABLE_AUTH=true`, toutes les routes/sockets exigent une session valide (cookie signé, login via mot de passe unique dans `.env`, pas de gestion multi-utilisateurs — même logique que ton app inventaire filament).
- Si `ENABLE_AUTH=false` (défaut), page accessible librement — pratique en local/LAN.
- Page de login minimaliste, même charte graphique (beige/blanc, traits noirs).

## 8. Scan Navidrome automatique (configurable)

- Variables optionnelles : `NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASSWORD` (ou token).
- Si renseignées → à la fin de chaque batch de la queue (ou après un délai d'inactivité de la queue, ex. 10s sans nouvel item), appel à `POST {NAVIDROME_URL}/api/library/scan` (auth via le endpoint `/auth/login` de Navidrome pour obtenir un token, ou Subsonic API `/rest/startScan.view` selon la version).
- Si non configuré → rien ne se passe, l'utilisateur rescanne à la main dans Navidrome.

## 9. Docker

```yaml
# docker-compose.yml
services:
  music-fetcher:
    build: .
    ports:
      - "3000:3000"
    environment:
      - SPOTIFY_CLIENT_ID=${SPOTIFY_CLIENT_ID}
      - SPOTIFY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET}
      - MUSIC_LIBRARY_PATH=/music
    volumes:
      - /chemin/vers/navidrome/music:/music   # <- même volume que Navidrome
    restart: unless-stopped
```

```dockerfile
# Dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg python3 pip curl \
    && pip install -U yt-dlp --break-system-packages
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

Compatible avec ton setup Dokploy/Swarm actuel : monte le même volume que ton service Navidrome sur `/music`.

## 10. Guide de config rapide

1. Créer une app Spotify sur developer.spotify.com → récupérer `CLIENT_ID`/`CLIENT_SECRET`.
2. Copier `.env.example` → `.env`, remplir les clés, `MUSIC_LIBRARY_PATH`, `MAX_CONCURRENT_DOWNLOADS` (défaut 3), et optionnellement `ENABLE_AUTH`/`AUTH_PASSWORD` + `NAVIDROME_URL`/`NAVIDROME_USER`/`NAVIDROME_PASSWORD`.
3. Adapter le volume dans `docker-compose.yml` pour pointer vers le même dossier que Navidrome.
4. `docker compose up -d --build`.
5. Accéder à `http://<host>:3000`, choisir Deezer ou Spotify via le toggle, chercher et ajouter des morceaux/playlists/liens YouTube à la queue.


