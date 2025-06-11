import requests
import pymongo
from datetime import datetime
import time
import logging
from typing import Dict, List, Optional
import base64
from bson import ObjectId

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class KpopSpotifyCleaner:
    def __init__(self):
        # ✅ SPOTIFY API CONFIG
        self.spotify_client_id = "4ffa5ddf6ba943dcb280c76cf0744ce5"
        self.spotify_client_secret = "a1aa0f2628594e4fa9c77b43bf6885ff"
        self.spotify_token = None
        self.spotify_token_expires = None
        
        # MongoDB
        self.client = pymongo.MongoClient("mongodb://localhost:27017/mykpoptrade")
        self.groups_collection = self.client.mykpoptrade.kpopgroups
        self.albums_collection = self.client.mykpoptrade.kpopalbums
        
        # ✅ INITIALISER SPOTIFY TOKEN
        if not self.get_spotify_token():
            raise Exception("❌ Impossible d'obtenir le token Spotify")

    def get_spotify_token(self):
        """Obtenir un token d'accès Spotify"""
        try:
            client_credentials = f"{self.spotify_client_id}:{self.spotify_client_secret}"
            client_credentials_b64 = base64.b64encode(client_credentials.encode()).decode()
            
            headers = {
                'Authorization': f'Basic {client_credentials_b64}',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
            
            data = {'grant_type': 'client_credentials'}
            
            response = requests.post(
                'https://accounts.spotify.com/api/token',
                headers=headers,
                data=data,
                timeout=10
            )
            
            if response.status_code == 200:
                token_data = response.json()
                self.spotify_token = token_data['access_token']
                self.spotify_token_expires = datetime.now().timestamp() + token_data['expires_in']
                logger.info("✅ Token Spotify obtenu avec succès")
                return True
            else:
                logger.error(f"❌ Erreur token Spotify: {response.status_code}")
                return False
                
        except Exception as e:
            logger.error(f"❌ Erreur lors de l'obtention du token Spotify: {e}")
            return False

    def refresh_spotify_token_if_needed(self):
        """Renouveler le token Spotify si nécessaire"""
        if not self.spotify_token or datetime.now().timestamp() >= (self.spotify_token_expires - 300):
            logger.info("🔄 Renouvellement du token Spotify...")
            return self.get_spotify_token()
        return True

    def validate_kpop_artist_by_id(self, spotify_id: str) -> bool:
        """Valider qu'un artiste Spotify est bien K-pop via son ID"""
        if not self.refresh_spotify_token_if_needed():
            return False
            
        max_retries = 3
        retry_count = 0
        
        while retry_count < max_retries:
            try:
                headers = {'Authorization': f'Bearer {self.spotify_token}'}
                
                response = requests.get(
                    f'https://api.spotify.com/v1/artists/{spotify_id}',
                    headers=headers,
                    timeout=10
                )
                
                if response.status_code == 200:
                    artist_data = response.json()
                    genres = [g.lower() for g in artist_data.get('genres', [])]
                    
                    # Vérifier les genres K-pop
                    kpop_genres = ['k-pop', 'korean pop', 'korean', 'korean hip hop', 'korean r&b']
                    has_kpop_genre = any(kpop_genre in genre for genre in genres for kpop_genre in kpop_genres)
                    
                    logger.info(f"🎤 {artist_data.get('name')} - Genres: {genres} - K-pop: {has_kpop_genre}")
                    return has_kpop_genre
                
                elif response.status_code == 429:
                    # Rate limiting détecté
                    retry_after = response.headers.get('Retry-After', '60')
                    wait_time = int(retry_after)
                    
                    # 🚨 LIMITE DE SÉCURITÉ: MAX 10 MINUTES D'ATTENTE
                    if wait_time > 600:  # Plus de 10 minutes
                        logger.error(f"🚨 RATE LIMITING EXTRÊME: {wait_time}s = {wait_time//3600}h{(wait_time%3600)//60}m")
                        logger.error(f"🚨 ARRÊT DU TRAITEMENT pour {spotify_id}")
                        logger.error("🚨 RELANCEZ LE SCRIPT DANS QUELQUES HEURES")
                        
                        # Marquer le groupe pour réessai plus tard
                        return False
                    
                    logger.warning(f"⏳ Rate limiting Spotify: {wait_time}s pour {spotify_id}")
                    logger.warning(f"⏳ Attente...")
                    
                    time.sleep(wait_time)
                    retry_count += 1
                    continue
                
                elif response.status_code == 404:
                    logger.warning(f"⚠️ Artiste {spotify_id} non trouvé (404)")
                    return False
                
                else:
                    logger.warning(f"⚠️ Erreur validation artiste {spotify_id}: {response.status_code}")
                    retry_count += 1
                    time.sleep(min(2 ** retry_count, 60))  # Max 60s de backoff
                    continue
                    
            except Exception as e:
                logger.error(f"❌ Erreur validation artiste {spotify_id}: {e}")
                retry_count += 1
                time.sleep(min(2 ** retry_count, 60))
                continue
        
        logger.error(f"❌ Échec validation après {max_retries} tentatives pour {spotify_id}")
        return False

    def get_groups_from_database(self) -> List[Dict]:
        """🎯 RÉCUPÉRER TOUS LES GROUPES K-POP DE LA BASE MONGODB"""
        try:
            # Récupérer les groupes actifs ET ceux qui peuvent être réessayés après rate limiting
            current_time = datetime.now().timestamp()
            
            groups = list(self.groups_collection.find(
                {
                    "$or": [
                        {"isActive": True, "rateLimited": {"$exists": False}},  # Groupes normaux
                        {"isActive": True, "rateLimited": True, "retryAfter": {"$lt": current_time}}  # Rate limited mais réessayables
                    ]
                },
                {
                    "_id": 1,
                    "name": 1,
                    "spotifyId": 1,
                    "socialLinks.spotify": 1,
                    "rateLimited": 1
                }
            ))
            
            # Compter les groupes rate limited qui peuvent être réessayés
            retry_count = sum(1 for g in groups if g.get('rateLimited'))
            normal_count = len(groups) - retry_count
            
            logger.info(f"📊 {len(groups)} groupes trouvés dans la base")
            if retry_count > 0:
                logger.info(f"   🔄 {normal_count} groupes normaux")
                logger.info(f"   ⏳ {retry_count} groupes à réessayer (ex-rate limited)")
            
            return groups
            
        except Exception as e:
            logger.error(f"❌ Erreur récupération groupes: {e}")
            return []

    def extract_spotify_id_from_group(self, group: Dict) -> Optional[str]:
        """🔍 EXTRAIRE LE SPOTIFY ID D'UN GROUPE (spotifyId OU socialLinks.spotify)"""
        
        # 1. Vérifier le champ spotifyId direct
        spotify_id = group.get('spotifyId')
        if spotify_id and len(spotify_id) == 22:  # Format Spotify ID valide
            return spotify_id
        
        # 2. Vérifier socialLinks.spotify (URL Spotify)
        social_links = group.get('socialLinks', {})
        spotify_url = social_links.get('spotify', '')
        
        if spotify_url:
            # Extraire l'ID de l'URL Spotify
            # Format: https://open.spotify.com/artist/7n2Ycct7Beij7Dj7meI4X0
            if '/artist/' in spotify_url:
                try:
                    spotify_id = spotify_url.split('/artist/')[-1].split('?')[0]
                    if len(spotify_id) == 22:
                        return spotify_id
                except:
                    pass
        
        return None

    def validate_kpop_artist_by_id(self, spotify_id: str) -> bool:
        """Valider qu'un artiste Spotify est bien K-pop via son ID"""
        if not self.refresh_spotify_token_if_needed():
            return False
            
        max_retries = 3
        retry_count = 0
        
        while retry_count < max_retries:
            try:
                headers = {'Authorization': f'Bearer {self.spotify_token}'}
                
                response = requests.get(
                    f'https://api.spotify.com/v1/artists/{spotify_id}',
                    headers=headers,
                    timeout=10
                )
                
                if response.status_code == 200:
                    artist_data = response.json()
                    genres = [g.lower() for g in artist_data.get('genres', [])]
                    
                    # Vérifier les genres K-pop
                    kpop_genres = ['k-pop', 'korean pop', 'korean', 'korean hip hop', 'korean r&b']
                    has_kpop_genre = any(kpop_genre in genre for genre in genres for kpop_genre in kpop_genres)
                    
                    logger.info(f"🎤 {artist_data.get('name')} - Genres: {genres} - K-pop: {has_kpop_genre}")
                    return has_kpop_genre
                
                elif response.status_code == 429:
                    # Rate limiting détecté
                    retry_after = response.headers.get('Retry-After', '60')
                    wait_time = int(retry_after)
                    
                    # 🚨 LIMITE DE SÉCURITÉ: MAX 10 MINUTES D'ATTENTE
                    if wait_time > 600:  # Plus de 10 minutes
                        logger.error(f"🚨 RATE LIMITING EXTRÊME: {wait_time}s = {wait_time//3600}h{(wait_time%3600)//60}m")
                        logger.error(f"🚨 ARRÊT DU TRAITEMENT pour {spotify_id}")
                        logger.error("🚨 RELANCEZ LE SCRIPT DANS QUELQUES HEURES")
                        
                        # Marquer le groupe pour réessai plus tard
                        return False
                    
                    logger.warning(f"⏳ Rate limiting Spotify: {wait_time}s pour {spotify_id}")
                    logger.warning(f"⏳ Attente...")
                    
                    time.sleep(wait_time)
                    retry_count += 1
                    continue
                
                elif response.status_code == 404:
                    logger.warning(f"⚠️ Artiste {spotify_id} non trouvé (404)")
                    return False
                
                else:
                    logger.warning(f"⚠️ Erreur validation artiste {spotify_id}: {response.status_code}")
                    retry_count += 1
                    time.sleep(min(2 ** retry_count, 60))  # Max 60s de backoff
                    continue
                    
            except Exception as e:
                logger.error(f"❌ Erreur validation artiste {spotify_id}: {e}")
                retry_count += 1
                time.sleep(min(2 ** retry_count, 60))
                continue
        
        logger.error(f"❌ Échec validation après {max_retries} tentatives pour {spotify_id}")
        return False

    def get_albums_by_artist_id(self, spotify_id: str, artist_name: str) -> List[Dict]:
        """🎯 RÉCUPÉRER ALBUMS VIA DOUBLE APPROCHE (ARTIST ALBUMS + SEARCH)"""
        if not self.refresh_spotify_token_if_needed():
            return []
        
        logger.info(f"🔍 Récupération albums pour {artist_name} (ID: {spotify_id})")
        
        # 🎯 MÉTHODE 1: Albums officiels via /artists/{id}/albums (PRIORITAIRE)
        official_albums = self.get_official_albums(spotify_id, artist_name)
        
        # 🎯 MÉTHODE 2: Albums supplémentaires via /search (OPTIONNEL)
        search_albums = self.get_search_albums(spotify_id, artist_name)
        
        # 🔀 FUSION ET DÉDUPLICATION
        all_albums = self.merge_albums(official_albums, search_albums, spotify_id, artist_name)
        
        return all_albums

    def get_official_albums(self, spotify_id: str, artist_name: str) -> List[Dict]:
        """📀 MÉTHODE 1: Albums officiels via /artists/{id}/albums"""
        try:
            headers = {'Authorization': f'Bearer {self.spotify_token}'}
            all_albums = []
            offset = 0
            limit = 50
            
            while True:
                params = {
                    'include_groups': 'album,single',
                    'market': 'FR',
                    'limit': limit,
                    'offset': offset
                }
                
                response = requests.get(
                    f'https://api.spotify.com/v1/artists/{spotify_id}/albums',
                    headers=headers,
                    params=params,
                    timeout=10
                )
                
                if response.status_code == 200:
                    data = response.json()
                    albums = data.get('items', [])
                    
                    if not albums:
                        break
                    
                    # ✅ VALIDATION MINIMALE (ces albums sont déjà du bon artiste)
                    valid_albums = [album for album in albums if self.is_valid_spotify_release(album)]
                    all_albums.extend(valid_albums)
                    
                    if len(albums) < limit:
                        break
                    
                    offset += limit
                else:
                    logger.warning(f"❌ Erreur albums officiels: {response.status_code}")
                    break
                
                time.sleep(0.1)
            
            logger.info(f"📀 Albums officiels trouvés: {len(all_albums)} pour {artist_name}")
            return all_albums
            
        except Exception as e:
            logger.error(f"❌ Erreur albums officiels {artist_name}: {e}")
            return []

    def get_search_albums(self, spotify_id: str, artist_name: str) -> List[Dict]:
        """🔍 MÉTHODE 2: Albums supplémentaires via /search (avec filtrage strict)"""
        try:
            headers = {'Authorization': f'Bearer {self.spotify_token}'}
            all_albums = []
            offset = 0
            limit = 50
            max_results = 200  # Limite réduite car beaucoup de parasites
            
            logger.info(f"🔍 Recherche albums supplémentaires pour {artist_name}...")
            
            while len(all_albums) < max_results:
                params = {
                    'q': f'artist:{spotify_id}',
                    'type': 'album',
                    'market': 'FR',
                    'limit': limit,
                    'offset': offset
                }
                
                response = requests.get(
                    'https://api.spotify.com/v1/search',
                    headers=headers,
                    params=params,
                    timeout=10
                )
                
                if response.status_code == 200:
                    data = response.json()
                    albums_data = data.get('albums', {})
                    albums = albums_data.get('items', [])
                    total_results = albums_data.get('total', 0)
                    
                    if not albums:
                        break
                    
                    # 🎯 FILTRAGE ULTRA-STRICT
                    valid_albums = []
                    for album in albums:
                        if (self.is_valid_spotify_release(album) and 
                            self.verify_album_belongs_to_artist(album, spotify_id, artist_name)):
                            valid_albums.append(album)
                    
                    all_albums.extend(valid_albums)
                    logger.info(f"🔍 Page {offset//limit + 1}: {len(valid_albums)}/{len(albums)} albums valides")
                    
                    # Arrêter si pas de nouveaux albums valides depuis 3 pages
                    if len(valid_albums) == 0 and offset > 100:
                        logger.info(f"🔚 Arrêt recherche: aucun album valide depuis 3 pages")
                        break
                    
                    if offset + limit >= total_results or len(albums) < limit:
                        break
                    
                    offset += limit
                else:
                    logger.warning(f"❌ Erreur search: {response.status_code}")
                    break
                
                time.sleep(0.2)
            
            logger.info(f"🔍 Albums search trouvés: {len(all_albums)} pour {artist_name}")
            return all_albums
            
        except Exception as e:
            logger.error(f"❌ Erreur search albums {artist_name}: {e}")
            return []

    def merge_albums(self, official_albums: List[Dict], search_albums: List[Dict], spotify_id: str, artist_name: str) -> List[Dict]:
        """🔀 FUSIONNER ET DÉDUPLIQUER LES ALBUMS"""
        
        # Dictionnaire pour déduplication par Spotify ID
        unique_albums = {}
        
        # 1. Ajouter les albums officiels (PRIORITÉ ABSOLUE)
        for album in official_albums:
            album_id = album.get('id')
            if album_id:
                unique_albums[album_id] = {
                    **album,
                    'discovery_method': 'official'
                }
        
        # 2. Ajouter les albums search (seulement s'ils n'existent pas déjà)
        new_from_search = 0
        for album in search_albums:
            album_id = album.get('id')
            if album_id and album_id not in unique_albums:
                unique_albums[album_id] = {
                    **album,
                    'discovery_method': 'search'
                }
                new_from_search += 1
        
        # 3. Conversion en liste et tri par date
        final_albums = list(unique_albums.values())
        final_albums.sort(key=lambda x: x.get('release_date', ''), reverse=True)
        
        # 📊 STATISTIQUES
        official_count = len(official_albums)
        search_count = len(search_albums)
        final_count = len(final_albums)
        
        logger.info(f"📊 {artist_name} - Fusion albums:")
        logger.info(f"   📀 Albums officiels: {official_count}")
        logger.info(f"   🔍 Albums search: {search_count}")
        logger.info(f"   🆕 Nouveaux via search: {new_from_search}")
        logger.info(f"   📀 Total final: {final_count}")
        
        return final_albums

    def clean_albums_for_group(self, group: Dict):
        """🧹 NETTOYER LES ALBUMS D'UN GROUPE SPÉCIFIQUE"""
        group_name = group.get('name', 'Unknown')
        group_id = group.get('_id')
        
        logger.info(f"\n🧹 === TRAITEMENT: {group_name} ===")
        
        # 1. Extraire le Spotify ID
        spotify_id = self.extract_spotify_id_from_group(group)
        if not spotify_id:
            logger.warning(f"⚠️ Pas de Spotify ID pour {group_name}")
            self.mark_group_as_invalid(group_id, group_name, "Pas de Spotify ID")
            return
        
        logger.info(f"🔍 Spotify ID: {spotify_id}")
        
        # 2. Valider que c'est bien K-pop
        if not self.validate_kpop_artist_by_id(spotify_id):
            logger.warning(f"⚠️ {group_name} n'est pas validé comme K-pop")
            self.mark_group_as_invalid(group_id, group_name, "Pas K-pop ou artiste inexistant")
            return
        
        # 3. Supprimer les anciens albums
        deleted_result = self.albums_collection.delete_many({"artistId": group_id})
        logger.info(f"🗑️ {deleted_result.deleted_count} anciens albums supprimés")
        
        # 4. Mettre à jour le spotifyId dans le groupe
        self.groups_collection.update_one(
            {"_id": group_id},
            {"$set": {
                "spotifyId": spotify_id, 
                "updatedAt": datetime.now(),
                "isActive": True,  # Confirmer que c'est actif
                "lastValidated": datetime.now()
            }}
        )
        
        # 5. Récupérer les albums (DOUBLE APPROCHE)
        albums = self.get_albums_by_artist_id(spotify_id, group_name)
        
        if not albums:
            logger.warning(f"⚠️ Aucun album trouvé pour {group_name}")
            # Pas de suppression si pas d'albums, c'est peut-être temporaire
            return
        
        # 6. Créer les documents albums
        albums_created = 0
        albums_skipped = 0
        
        logger.info(f"📀 Création de {len(albums)} albums...")
        
        for i, album in enumerate(albums, 1):
            try:
                album_document = self.create_album_document(album, group)
                result = self.albums_collection.insert_one(album_document)
                
                if result.inserted_id:
                    albums_created += 1
                    release_year = album.get('release_date', '')[:4] if album.get('release_date') else 'N/A'
                    album_type = album.get('album_type', 'album')
                    discovery_method = album.get('discovery_method', 'unknown')
                    logger.info(f"✅ [{i}/{len(albums)}] [{discovery_method}] {album['name']} ({release_year}, {album.get('total_tracks', 0)} pistes)")
                else:
                    albums_skipped += 1
                    
            except Exception as e:
                albums_skipped += 1
                logger.error(f"❌ [{i}/{len(albums)}] Erreur création album {album.get('name')}: {e}")
        
        logger.info(f"🎉 {group_name} TERMINÉ: {albums_created} créés, {albums_skipped} échoués")

    def mark_group_as_invalid(self, group_id: ObjectId, group_name: str, reason: str):
        """🚫 MARQUER UN GROUPE COMME INVALIDE"""
        try:
            # Si c'est dû au rate limiting extrême, marquer pour réessai dans 24h
            if "429" in reason or "rate" in reason.lower() or "Rate limiting" in reason:
                retry_after_timestamp = datetime.now().timestamp() + 86400  # 24h plus tard
                
                self.groups_collection.update_one(
                    {"_id": group_id},
                    {"$set": {
                        "isActive": True,  # Garder actif pour réessayer plus tard
                        "rateLimited": True,
                        "lastRateLimitedAt": datetime.now(),
                        "retryAfter": retry_after_timestamp,
                        "rateLimitReason": reason,
                        "updatedAt": datetime.now()
                    }}
                )
                logger.warning(f"⏳ {group_name} marqué comme rate limited (réessai dans 24h)")
            else:
                # Désactiver définitivement
                self.groups_collection.update_one(
                    {"_id": group_id},
                    {"$set": {
                        "isActive": False,
                        "invalidReason": reason,
                        "invalidatedAt": datetime.now(),
                        "updatedAt": datetime.now()
                    }}
                )
                logger.warning(f"🚫 {group_name} marqué comme invalide: {reason}")
            
        except Exception as e:
            logger.error(f"❌ Erreur marquage invalide {group_name}: {e}")

    def discover_kpop_artists_from_spotify(self) -> List[Dict]:
        """🔍 DÉCOUVRIR DE NOUVEAUX ARTISTES K-POP VIA SPOTIFY SEARCH"""
        if not self.refresh_spotify_token_if_needed():
            return []
        
        logger.info("🔍 DÉCOUVERTE DE NOUVEAUX ARTISTES K-POP...")
        
        headers = {'Authorization': f'Bearer {self.spotify_token}'}
        all_new_artists = []
        
        # 🎯 DIFFÉRENTES REQUÊTES DE RECHERCHE K-POP
        search_queries = [
            'tag:k-pop',           # Tag officiel K-pop
            'genre:k-pop',         # Genre K-pop
            'tag:kpop',            # Variation sans tiret
            'genre:korean',        # Genre coréen
            'tag:korean%20pop',    # Korean pop
        ]
        
        for query in search_queries:
            logger.info(f"🔍 Recherche avec: {query}")
            
            try:
                offset = 0
                limit = 50
                max_pages = 5  # Limiter pour éviter trop de résultats
                
                for page in range(max_pages):
                    params = {
                        'q': query,
                        'type': 'artist',
                        'market': 'FR',
                        'limit': limit,
                        'offset': offset
                    }
                    
                    response = requests.get(
                        'https://api.spotify.com/v1/search',
                        headers=headers,
                        params=params,
                        timeout=10
                    )
                    
                    if response.status_code == 200:
                        data = response.json()
                        artists_data = data.get('artists', {})
                        artists = artists_data.get('items', [])
                        
                        if not artists:
                            break
                        
                        # Filtrer et valider les artistes
                        for artist in artists:
                            if self.is_valid_kpop_artist_candidate(artist):
                                all_new_artists.append(artist)
                        
                        logger.info(f"   Page {page + 1}: {len(artists)} artistes trouvés")
                        offset += limit
                        
                        if len(artists) < limit:
                            break
                    else:
                        logger.warning(f"❌ Erreur search artistes: {response.status_code}")
                        break
                    
                    time.sleep(0.3)  # Rate limiting
                    
            except Exception as e:
                logger.error(f"❌ Erreur recherche '{query}': {e}")
                continue
        
        # Déduplication par Spotify ID
        unique_artists = {}
        for artist in all_new_artists:
            artist_id = artist.get('id')
            if artist_id and artist_id not in unique_artists:
                unique_artists[artist_id] = artist
        
        final_artists = list(unique_artists.values())
        logger.info(f"🎉 {len(final_artists)} artistes K-pop uniques découverts")
        
        return final_artists

    def is_valid_kpop_artist_candidate(self, artist: Dict) -> bool:
        """✅ VALIDER QU'UN ARTISTE EST UN BON CANDIDAT K-POP"""
        
        name = artist.get('name', '')
        genres = [g.lower() for g in artist.get('genres', [])]
        popularity = artist.get('popularity', 0)
        followers = artist.get('followers', {}).get('total', 0)
        
        # 1. Nom valide
        if not name or len(name.strip()) < 1:
            return False
        
        # 2. Popularité minimale (éviter les artistes inconnus)
        if popularity < 10 or followers < 1000:
            return False
        
        # 3. Genres K-pop
        kpop_genres = ['k-pop', 'korean pop', 'korean', 'korean hip hop', 'korean r&b', 'korean rock']
        has_kpop_genre = any(kpop_genre in genre for genre in genres for kpop_genre in kpop_genres)
        
        if not has_kpop_genre:
            return False
        
        # 4. Filtrer les artistes suspects
        name_lower = name.lower()
        suspect_patterns = [
            'various artists',
            'compilation',
            'ost',
            'soundtrack',
            'karaoke'
        ]
        
        for pattern in suspect_patterns:
            if pattern in name_lower:
                return False
        
        return True

    def add_discovered_artists_to_database(self, discovered_artists: List[Dict]) -> int:
        """➕ AJOUTER LES NOUVEAUX ARTISTES DÉCOUVERTS À LA BASE"""
        
        if not discovered_artists:
            logger.info("📭 Aucun nouvel artiste à ajouter")
            return 0
        
        logger.info(f"➕ Ajout de {len(discovered_artists)} nouveaux artistes...")
        
        added_count = 0
        skipped_count = 0
        
        for artist in discovered_artists:
            try:
                spotify_id = artist.get('id')
                name = artist.get('name', '')
                
                # Vérifier si l'artiste existe déjà
                existing = self.groups_collection.find_one({
                    "$or": [
                        {"spotifyId": spotify_id},
                        {"name": {"$regex": f"^{name}$", "$options": "i"}}
                    ]
                })
                
                if existing:
                    skipped_count += 1
                    logger.debug(f"⏭️ {name} existe déjà")
                    continue
                
                # Créer le document groupe
                group_document = self.create_group_document_from_spotify(artist)
                
                result = self.groups_collection.insert_one(group_document)
                
                if result.inserted_id:
                    added_count += 1
                    genres = artist.get('genres', [])
                    popularity = artist.get('popularity', 0)
                    logger.info(f"✅ Ajouté: {name} (Popularité: {popularity}, Genres: {genres[:3]})")
                else:
                    skipped_count += 1
                    
            except Exception as e:
                skipped_count += 1
                logger.error(f"❌ Erreur ajout {artist.get('name', 'Unknown')}: {e}")
        
        logger.info(f"🎉 Artistes découverts: {added_count} ajoutés, {skipped_count} ignorés")
        return added_count

    def create_group_document_from_spotify(self, spotify_artist: Dict) -> Dict:
        """📝 CRÉER UN DOCUMENT GROUPE À PARTIR D'UN ARTISTE SPOTIFY"""
        
        name = spotify_artist.get('name', '').strip()
        spotify_id = spotify_artist.get('id', '')
        spotify_url = spotify_artist.get('external_urls', {}).get('spotify', '')
        genres = spotify_artist.get('genres', [])
        popularity = spotify_artist.get('popularity', 0)
        followers = spotify_artist.get('followers', {}).get('total', 0)
        images = spotify_artist.get('images', [])
        
        # Image de profil
        profile_image = '/images/groups/default-group.jpg'
        if images:
            profile_image = images[0].get('url', profile_image)
        
        return {
            'name': name,
            'profileImage': profile_image,
            'spotifyId': spotify_id,
            'socialLinks': {
                'spotify': spotify_url
            },
            'genres': genres,
            'popularity': popularity,
            'followers': followers,
            'discoverySource': 'Spotify Search',
            'isActive': True,
            'createdAt': datetime.now(),
            'updatedAt': datetime.now(),
            'lastValidated': datetime.now()
        }

    def discover_and_add_new_kpop_artists(self):
        """🔍➕ DÉCOUVRIR ET AJOUTER DE NOUVEAUX ARTISTES K-POP"""
        logger.info("\n🚀 DÉCOUVERTE DE NOUVEAUX ARTISTES K-POP")
        logger.info("=" * 50)
        
        try:
            # 1. Découvrir les artistes
            discovered_artists = self.discover_kpop_artists_from_spotify()
            
            if not discovered_artists:
                logger.info("📭 Aucun nouvel artiste découvert")
                return
            
            # 2. Les ajouter à la base
            added_count = self.add_discovered_artists_to_database(discovered_artists)
            
            logger.info(f"\n🎉 DÉCOUVERTE TERMINÉE:")
            logger.info(f"   🔍 {len(discovered_artists)} artistes découverts")
            logger.info(f"   ➕ {added_count} artistes ajoutés à la base")
            
        except Exception as e:
            logger.error(f"❌ Erreur découverte artistes: {e}")

    def is_valid_spotify_release(self, release: Dict) -> bool:
        """✅ Valider qu'une release Spotify est valide"""
        total_tracks = release.get('total_tracks', 0)
        name = release.get('name', '')
        album_type = release.get('album_type', '')
        
        # ✅ CRITÈRES MINIMAUX
        if total_tracks < 1:
            return False
        
        if not name or len(name.strip()) < 1:
            return False
        
        # Filtrer les types suspects
        if album_type in ['compilation'] and 'various' in name.lower():
            return False
        
        # Patterns suspects dans le nom
        name_lower = name.lower()
        suspect_patterns = [
            r'^\s*\(null\)\s*$', 
            r'^\s*null\s*$',
            r'^\s*undefined\s*$',
            r'^\s*test\s*$',
            r'various artists',
            r'hits années',
            r'best of'
        ]
        
        import re
        for pattern in suspect_patterns:
            if re.search(pattern, name_lower):
                return False
        
        return True

    def verify_album_belongs_to_artist(self, album: Dict, expected_spotify_id: str, expected_artist_name: str) -> bool:
        """✅ VÉRIFIER QUE L'ALBUM APPARTIENT AU BON ARTISTE (STRICT)"""
        
        # Vérification STRICTE par Spotify ID dans les artistes de l'album
        artists = album.get('artists', [])
        
        for artist in artists:
            artist_id = artist.get('id', '')
            if artist_id == expected_spotify_id:
                return True
        
        # Si pas trouvé, c'est un REJET automatique
        return False

    def create_album_document(self, spotify_album: Dict, group: Dict) -> Dict:
        """📝 CRÉER UN DOCUMENT ALBUM À PARTIR D'UN ALBUM SPOTIFY"""
        
        album_name = spotify_album.get('name', '').strip()
        spotify_id = spotify_album.get('id', '')
        spotify_url = spotify_album.get('external_urls', {}).get('spotify', '')
        release_date = spotify_album.get('release_date', '')
        album_type = spotify_album.get('album_type', 'album')
        total_tracks = spotify_album.get('total_tracks', 0)
        images = spotify_album.get('images', [])
        
        # Image de couverture
        cover_image = '/images/albums/default-album.jpg'
        if images:
            cover_image = images[0].get('url', cover_image)
        
        # Année de sortie
        release_year = None
        if release_date:
            try:
                release_year = int(release_date[:4])
            except:
                pass
        
        return {
            'name': album_name,
            'artistId': group.get('_id'),
            'artistName': group.get('name', ''),
            'spotifyId': spotify_id,
            'spotifyUrl': spotify_url,
            'coverImage': cover_image,
            'releaseDate': release_date,
            'releaseYear': release_year,
            'albumType': album_type,
            'totalTracks': total_tracks,
            'discoveryMethod': spotify_album.get('discovery_method', 'unknown'),
            'createdAt': datetime.now(),
            'updatedAt': datetime.now()
        }

    def clean_all_groups_from_database(self):
        """🧹 NETTOYER TOUS LES GROUPES DE LA BASE DE DONNÉES"""
        logger.info("🚀 NETTOYAGE DE TOUS LES GROUPES DE LA BASE")
        
        try:
            # Récupérer tous les groupes actifs
            groups = self.get_groups_from_database()
            
            if not groups:
                logger.warning("⚠️ Aucun groupe trouvé dans la base")
                return
            
            logger.info(f"📊 {len(groups)} groupes à traiter")
            
            # Compteurs pour statistiques
            processed_count = 0
            success_count = 0
            invalid_count = 0
            error_count = 0
            rate_limited_count = 0
            extreme_rate_limit_count = 0
            
            # Traiter chaque groupe
            for i, group in enumerate(groups, 1):
                group_name = group.get('name', 'Unknown')
                
                try:
                    logger.info(f"\n🔄 Traitement: {group_name}")
                    logger.info(f"📊 Progression: {i}/{len(groups)} ({(i/len(groups)*100):.1f}%)")
                    
                    # 🚨 VÉRIFIER SI ON EST EN RATE LIMITING EXTRÊME
                    if rate_limited_count > 10:
                        logger.error("🚨 TROP DE RATE LIMITING DÉTECTÉ!")
                        logger.error("🚨 ARRÊT PRÉVENTIF DU SCRIPT")
                        logger.error("🚨 Relancez dans quelques heures")
                        break
                    
                    # Nettoyer les albums du groupe
                    self.clean_albums_for_group(group)
                    
                    processed_count += 1
                    
                    # Vérifier si le groupe est toujours actif (pas marqué comme invalide)
                    updated_group = self.groups_collection.find_one({"_id": group.get('_id')})
                    if updated_group and updated_group.get('isActive', True):
                        success_count += 1
                    else:
                        invalid_count += 1
                        # Vérifier si c'est dû au rate limiting
                        if updated_group and updated_group.get('rateLimited'):
                            rate_limited_count += 1
                            reason = updated_group.get('rateLimitReason', '')
                            if 'EXTRÊME' in reason:
                                extreme_rate_limit_count += 1
                    
                    # ⏳ PAUSE BEAUCOUP PLUS LONGUE après rate limiting
                    if rate_limited_count > 0:
                        logger.info("⏳ Rate limiting détecté - Pause de 30 secondes...")
                        time.sleep(30)
                    elif i % 3 == 0:  # Pause tous les 3 groupes
                        logger.info("⏳ Pause de 10 secondes (précaution)...")
                        time.sleep(10)
                    else:
                        time.sleep(3)  # Pause minimale plus longue
                    
                except KeyboardInterrupt:
                    logger.info("🛑 ARRÊT MANUEL DÉTECTÉ")
                    break
                except Exception as e:
                    error_count += 1
                    logger.error(f"❌ Erreur traitement {group_name}: {e}")
                    continue
            
            # Statistiques finales
            logger.info("\n🎉 NETTOYAGE TERMINÉ!")
            logger.info("=" * 50)
            logger.info(f"📊 STATISTIQUES:")
            logger.info(f"   🔄 Groupes traités: {processed_count}/{len(groups)}")
            logger.info(f"   ✅ Groupes réussis: {success_count}")
            logger.info(f"   🚫 Groupes invalidés: {invalid_count}")
            logger.info(f"   ⏳ Rate limited: {rate_limited_count}")
            logger.info(f"   🚨 Rate limiting extrême: {extreme_rate_limit_count}")
            logger.info(f"   ❌ Erreurs: {error_count}")
            
            # ⚠️ AVERTISSEMENT FINAL
            if rate_limited_count > 5:
                logger.warning("\n⚠️ ATTENTION: BEAUCOUP DE RATE LIMITING DÉTECTÉ")
                logger.warning("⚠️ Attendez 24h avant de relancer le script")
                logger.warning("⚠️ Ou réduisez encore plus la vitesse de traitement")
            
        except Exception as e:
            logger.error(f"❌ Erreur nettoyage global: {e}")
            raise

    def get_statistics(self) -> Dict:
        """📊 OBTENIR LES STATISTIQUES DE LA BASE"""
        try:
            stats = {
                'groups_active': self.groups_collection.count_documents({"isActive": True}),
                'groups_inactive': self.groups_collection.count_documents({"isActive": False}),
                'groups_total': self.groups_collection.count_documents({}),
                'albums_total': self.albums_collection.count_documents({}),
                'albums_by_discovery': {},
                'groups_by_source': {}
            }
            
            # Albums par méthode de découverte
            pipeline_albums = [
                {"$group": {"_id": "$discoveryMethod", "count": {"$sum": 1}}}
            ]
            for result in self.albums_collection.aggregate(pipeline_albums):
                method = result['_id'] or 'unknown'
                stats['albums_by_discovery'][method] = result['count']
            
            # Groupes par source de découverte
            pipeline_groups = [
                {"$group": {"_id": "$discoverySource", "count": {"$sum": 1}}}
            ]
            for result in self.groups_collection.aggregate(pipeline_groups):
                source = result['_id'] or 'manual'
                stats['groups_by_source'][source] = result['count']
            
            return stats
            
        except Exception as e:
            logger.error(f"❌ Erreur statistiques: {e}")
            return {}

def main():
    print("🧹 K-POP SPOTIFY CLEANER v2.2 - RATE LIMIT SAFE")
    print("=" * 50)
    print("🎯 FONCTIONNALITÉS:")
    print("   • Nettoyer les albums des groupes existants")
    print("   • Marquer/supprimer les groupes invalides")
    print("   • Découvrir de nouveaux artistes K-pop")
    print("   🚨 Protection contre le rate limiting extrême")
    print()
    
    try:
        cleaner = KpopSpotifyCleaner()
        
        # CHOIX DE L'UTILISATEUR
        print("Que voulez-vous faire ?")
        print("1. 🧹 Nettoyer tous les groupes existants (MODE LENT)")
        print("2. 🔍 Découvrir de nouveaux artistes K-pop")
        print("3. 🚀 Faire les deux (nettoyage + découverte)")
        print("4. 📊 Voir seulement les statistiques")
        
        choice = input("\nVotre choix (1-4): ").strip()
        
        start_time = datetime.now()
        
        if choice == '4':
            # Afficher seulement les stats
            stats = cleaner.get_statistics()
            print(f"\n📊 STATISTIQUES ACTUELLES:")
            print(f"   🎤 Groupes actifs: {stats.get('groups_active', 0)}")
            print(f"   🚫 Groupes inactifs: {stats.get('groups_inactive', 0)}")
            print(f"   📀 Albums totaux: {stats.get('albums_total', 0)}")
            
            # Groupes rate limited
            rate_limited = cleaner.groups_collection.count_documents({"rateLimited": True})
            print(f"   ⏳ Groupes rate limited: {rate_limited}")
            
        elif choice in ['1', '3']:
            print("\n⚠️ ATTENTION: MODE LENT ACTIVÉ")
            print("⚠️ Le script fera des pauses longues pour éviter le rate limiting")
            confirm = input("Continuer ? (y/N): ").strip().lower()
            
            if confirm == 'y':
                cleaner.clean_all_groups_from_database()
            else:
                print("Annulé.")
        
        if choice in ['2', '3']:
            cleaner.discover_and_add_new_kpop_artists()
        
        end_time = datetime.now()
        duration = end_time - start_time
        
        print("\n🎉 TRAITEMENT TERMINÉ!")
        print("=" * 50)
        print(f"⏱️ Durée totale: {duration}")
        
    except KeyboardInterrupt:
        print("\n🛑 ARRÊT MANUEL")
        print("Les groupes traités ont été sauvegardés.")
    except Exception as e:
        logger.error(f"💥 Erreur globale: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if 'cleaner' in locals():
            cleaner.client.close()

if __name__ == "__main__":
    main()