import requests
import pymongo
from datetime import datetime
import time
import logging
import re
from typing import Dict, Optional, List, Set
import base64
import json

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class HybridKpopCollector:
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
        
        # Cache pour éviter les doublons
        self.processed_spotify_ids = set()
        self.existing_group_names = set()

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

    def load_existing_groups_cache(self):
        """Charger les groupes existants pour éviter les doublons"""
        try:
            existing_groups = list(self.groups_collection.find({}, {"name": 1, "spotifyId": 1}))
            
            self.existing_group_names = set()
            self.processed_spotify_ids = set()
            
            for group in existing_groups:
                self.existing_group_names.add(group['name'].lower().strip())
                if group.get('spotifyId'):
                    self.processed_spotify_ids.add(group['spotifyId'])
            
            logger.info(f"✅ {len(self.existing_group_names)} groupes existants chargés")
            
        except Exception as e:
            logger.error(f"❌ Erreur chargement cache: {e}")

    def search_albums_by_artist(self, artist_name: str, market: str = 'FR') -> List[Dict]:
        """🎯 RECHERCHE DIRECTE D'ALBUMS PAR ARTISTE VIA SEARCH API - ALBUMS UNIQUEMENT"""
        if not self.refresh_spotify_token_if_needed():
            return []
            
        try:
            headers = {'Authorization': f'Bearer {self.spotify_token}'}
            
            all_albums = []
            offset = 0
            limit = 50
            
            while offset < 1000:  # Limite Spotify = 1000 résultats max
                # ✅ RECHERCHE DIRECTE D'ALBUMS AVEC QUERY ARTIST
                params = {
                    'q': f'artist:"{artist_name}"',  # ✅ Recherche par artiste
                    'type': 'album',                 # ✅ Type album uniquement
                    'market': market,
                    'limit': limit,
                    'offset': offset,
                }
                
                response = requests.get(
                    'https://api.spotify.com/v1/search',
                    headers=headers,
                    params=params,
                    timeout=10
                )
                
                if response.status_code == 200:
                    data = response.json()
                    albums = data.get('albums', {}).get('items', [])
                    
                    if not albums:
                        break
                    
                    # ✅ FILTRAGE ALBUMS VALIDES ET PAR ARTISTE - ALBUMS SEULEMENT
                    valid_albums = []
                    for album in albums:
                        if (self.is_album_by_artist(album, artist_name) and 
                            self.is_valid_spotify_album_only(album)):
                            valid_albums.append(album)
                    
                    all_albums.extend(valid_albums)
                    
                    if len(albums) < limit:
                        break
                    
                    offset += limit
                else:
                    logger.warning(f"❌ Erreur search albums Spotify: {response.status_code}")
                    break
                
                time.sleep(0.1)
            
            logger.info(f"📀 {len(all_albums)} albums trouvés pour {artist_name}")
            return all_albums
            
        except Exception as e:
            logger.error(f"❌ Erreur recherche albums {artist_name}: {e}")
            return []

    def is_album_by_artist(self, album: Dict, target_artist: str) -> bool:
        """Vérifier que l'album appartient bien à l'artiste cible"""
        album_artists = album.get('artists', [])
        target_lower = target_artist.lower().strip()
        
        for artist in album_artists:
            artist_name = artist.get('name', '').lower().strip()
            
            # Correspondance exacte ou très proche
            if (artist_name == target_lower or
                target_lower in artist_name or
                artist_name in target_lower):
                return True
        
        return False

    def search_kpop_artists_discovery(self, query: str, market: str = 'FR') -> List[Dict]:
        """Rechercher des artistes K-pop sur Spotify pour découverte"""
        if not self.refresh_spotify_token_if_needed():
            return []
            
        try:
            headers = {'Authorization': f'Bearer {self.spotify_token}'}
            
            all_artists = []
            offset = 0
            limit = 50
            
            while offset < 1000:  # Limite Spotify = 1000 résultats max
                params = {
                    'q': query,
                    'type': 'artist',
                    'market': market,
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
                    artists = data.get('artists', {}).get('items', [])
                    
                    if not artists:
                        break
                    
                    # ✅ FILTRER UNIQUEMENT LES VRAIS ARTISTES K-POP NOUVEAUX
                    new_kpop_artists = []
                    for artist in artists:
                        if (self.is_valid_kpop_spotify_artist(artist) and 
                            artist['id'] not in self.processed_spotify_ids and
                            artist['name'].lower().strip() not in self.existing_group_names):
                            new_kpop_artists.append(artist)
                            self.processed_spotify_ids.add(artist['id'])
                    
                    all_artists.extend(new_kpop_artists)
                    
                    if len(artists) < limit:
                        break
                    
                    offset += limit
                else:
                    logger.warning(f"❌ Erreur search Spotify: {response.status_code}")
                    break
                
                time.sleep(0.1)
            
            return all_artists
            
        except Exception as e:
            logger.error(f"❌ Erreur recherche Spotify: {e}")
            return []

    def is_valid_kpop_spotify_artist(self, artist: Dict) -> bool:
        """Valider qu'un artiste Spotify est bien K-pop"""
        name = artist.get('name', '')
        genres = [g.lower() for g in artist.get('genres', [])]
        popularity = artist.get('popularity', 0)
        
        # ✅ VALIDATION ÉTENDUE
        
        # 1. Genre K-pop OU haute popularité avec nom typique
        has_kpop_genre = any('k-pop' in genre or 'korean' in genre for genre in genres)
        high_popularity_kpop = popularity > 30 and self.looks_like_kpop_name(name)
        
        if not (has_kpop_genre or high_popularity_kpop):
            return False
        
        # 2. Nom valide
        if not name or len(name.strip()) < 2:
            return False
        
        # 3. Popularité minimale
        if popularity < 5:
            return False
        
        # 4. Blacklist des labels/entreprises
        name_lower = name.lower()
        label_keywords = [
            'entertainment', 'records', 'music', 'label', 'company', 
            'corporation', 'inc', 'ltd', 'production', 'official'
        ]
        
        if any(keyword in name_lower for keyword in label_keywords):
            return False
        
        # 5. Patterns suspects
        if re.search(r'^\d+|soundtrack|ost|various|compilation|vol\.|pt\.|part', name_lower):
            return False
        
        return True

    def looks_like_kpop_name(self, name: str) -> bool:
        """Détecter si un nom ressemble à un nom K-pop"""
        name_lower = name.lower()
        
        # Mots-clés K-pop courants
        kpop_keywords = [
            'twice', 'blackpink', 'bts', 'stray', 'ateez', 'itzy', 'aespa', 
            'ive', 'newjeans', 'sserafim', 'gidle', 'nmixx', 'kep1er',
            'seventeen', 'nct', 'enhypen', 'txt', 'treasure', 'the boyz'
        ]
        
        # Patterns typiques K-pop
        kpop_patterns = [
            r'\b(girl|boy)\b',
            r'\b\d+(kids?|teens?)\b',
            r'^[A-Z]{2,8}$',
            r'[xz]{2,}',
        ]
        
        if any(keyword in name_lower for keyword in kpop_keywords):
            return True
        
        if any(re.search(pattern, name_lower) for pattern in kpop_patterns):
            return True
        
        return False

    def discover_new_kpop_artists(self) -> List[Dict]:
        """Découvrir de nouveaux artistes K-pop via différentes recherches Spotify"""
        logger.info("🔍 PHASE 1 : Découverte de nouveaux artistes K-pop...")
        
        # ✅ STRATÉGIES DE RECHERCHE SPOTIFY ÉTENDUES
        search_queries = [
            'genre:"k-pop"',
            'genre:"korean pop"',
            'kpop', 'k-pop'
        ]
        
        all_discovered = []
        
        for i, query in enumerate(search_queries):
            logger.info(f"🔍 Recherche {i+1}/{len(search_queries)}: {query}")
            
            artists = self.search_kpop_artists_discovery(query)
            all_discovered.extend(artists)
            
            logger.info(f"   ✅ {len(artists)} nouveaux artistes trouvés")
            time.sleep(0.5)
        
        # ✅ DÉDUPLICATION FINALE
        unique_artists = {}
        for artist in all_discovered:
            artist_id = artist['id']
            if artist_id not in unique_artists:
                unique_artists[artist_id] = artist
        
        final_list = list(unique_artists.values())
        final_list.sort(key=lambda x: x.get('popularity', 0), reverse=True)
        
        logger.info(f"🎯 {len(final_list)} artistes K-pop uniques découverts")
        return final_list

    def process_artist_complete(self, spotify_artist: Dict) -> Dict:
        """🎯 TRAITER ARTISTE + RECHERCHE DIRECTE ALBUMS"""
        artist_name = spotify_artist.get('name', '')
        
        logger.info(f"🎤 Traitement complet: {artist_name}")
        
        stats = {
            'artist_name': artist_name,
            'group_action': 'failed',
            'albums_discovered': 0,
            'albums_created': 0,
            'albums_updated': 0,
            'albums_failed': 0
        }
        
        try:
            # ✅ ÉTAPE 1: Créer/Mettre à jour le groupe
            group_document = self.create_group_document(spotify_artist)
            success, action, final_group = self.save_or_update_group(group_document)
            
            if not success or not final_group:
                logger.error(f"❌ Impossible de sauvegarder {artist_name}")
                return stats
            
            stats['group_action'] = action
            
            # ✅ ÉTAPE 2: RECHERCHE DIRECTE D'ALBUMS PAR SEARCH API
            albums = self.search_albums_by_artist(artist_name)
            stats['albums_discovered'] = len(albums)
            
            # ✅ ÉTAPE 3: Traiter chaque album
            for album in albums:
                try:
                    album_document = self.create_album_document(album, final_group)
                    album_success, album_action = self.save_or_update_album(album_document)
                    
                    if album_success:
                        if 'created' in album_action:
                            stats['albums_created'] += 1
                        elif 'updated' in album_action:
                            stats['albums_updated'] += 1
                    else:
                        stats['albums_failed'] += 1
                        
                except Exception as e:
                    logger.error(f"❌ Erreur album {album.get('name')}: {e}")
                    stats['albums_failed'] += 1
            
            return stats
            
        except Exception as e:
            logger.error(f"❌ Erreur traitement {artist_name}: {e}")
            return stats

    def get_all_existing_groups(self) -> List[Dict]:
        """Récupérer tous les groupes existants en base"""
        try:
            # ✅ SYNTAXE CORRECTE : find(filtre, projection)
            groups = list(self.groups_collection.find(
                {},  # ← FILTRE : {} = tous les documents
                {"_id": 1, "name": 1, "spotifyId": 1}  # ← PROJECTION : champs à retourner
            ))
            
            logger.info(f"📋 {len(groups)} groupes existants chargés")
            return groups
            
        except Exception as e:
            logger.error(f"❌ Erreur récupération groupes existants: {e}")
            return []

    def process_existing_group_albums(self, group_data: Dict) -> Dict:
        """🎯 TRAITER ALBUMS D'UN GROUPE EXISTANT VIA API DIRECTE SPOTIFY"""
        group_name = group_data['name']
        spotify_id = group_data.get('spotifyId')
        
        logger.info(f"🔄 Albums pour groupe existant: {group_name}")
        
        stats = {
            'group_name': group_name,
            'albums_discovered': 0,
            'albums_created': 0,
            'albums_updated': 0,
            'albums_failed': 0
        }
        
        try:
            # ✅ PRIORITÉ : UTILISER L'API DIRECTE SI SPOTIFY ID DISPONIBLE
            if spotify_id:
                albums = self.search_albums_by_artist_id(spotify_id, group_name)
            else:
                # ✅ FALLBACK : SEARCH API SI PAS DE SPOTIFY ID
                albums = self.search_albums_by_artist(group_name)
        
            stats['albums_discovered'] = len(albums)
            
            # ✅ Traiter chaque album
            for album in albums:
                try:
                    album_document = self.create_album_document(album, group_data)
                    album_success, album_action = self.save_or_update_album(album_document)
                    
                    if album_success:
                        if 'created' in album_action:
                            stats['albums_created'] += 1
                        elif 'updated' in album_action:
                            stats['albums_updated'] += 1
                    else:
                        stats['albums_failed'] += 1
                        
                except Exception as e:
                    logger.error(f"❌ Erreur album {album.get('name')}: {e}")
                    stats['albums_failed'] += 1
            
            return stats
            
        except Exception as e:
            logger.error(f"❌ Erreur traitement albums {group_name}: {e}")
            return stats

    def search_albums_by_artist_id(self, artist_id: str, artist_name: str) -> List[Dict]:
        """🎯 RECHERCHE D'ALBUMS PAR SPOTIFY ID SPÉCIFIQUE - TOUS LES ALBUMS"""
        if not self.refresh_spotify_token_if_needed():
            return []
            
        try:
            headers = {'Authorization': f'Bearer {self.spotify_token}'}
            
            all_albums = []
            offset = 0
            limit = 50
            
            while True:
                # ✅ RÉCUPÉRER TOUS LES ALBUMS/SINGLES COMME L'API SPOTIFY
                params = {
                    'include_groups': 'album,single',  # ✅ ALBUMS ET SINGLES
                    'market': 'FR',
                    'limit': limit,
                    'offset': offset
                }
                
                response = requests.get(
                    f'https://api.spotify.com/v1/artists/{artist_id}/albums',
                    headers=headers,
                    params=params,
                    timeout=10
                )
                
                if response.status_code == 200:
                    data = response.json()
                    albums = data.get('items', [])
                    
                    if not albums:
                        break
                    
                    # ✅ FILTRAGE SIMPLE - JUSTE VALIDER QUE C'EST BIEN L'ARTISTE PRINCIPAL
                    valid_albums = []
                    for album in albums:
                        # Vérifier que c'est bien un album de l'artiste principal ET que c'est valide
                        if (self.is_primary_artist_album(album, artist_id) and 
                            self.is_valid_release_simple(album)):
                            valid_albums.append(album)
                    
                    all_albums.extend(valid_albums)
                    
                    if len(albums) < limit:
                        break
                    
                    offset += limit
                
                elif response.status_code == 429:
                    retry_after = int(response.headers.get('Retry-After', '60'))
                    if retry_after <= 60:
                        logger.warning(f"⏳ Rate limited, attente {retry_after}s...")
                        time.sleep(retry_after)
                        continue
                    else:
                        logger.warning(f"⚠️ Rate limiting trop long ({retry_after}s)")
                        break
                
                else:
                    logger.warning(f"❌ Erreur albums Spotify: {response.status_code}")
                    break
            
            logger.info(f"📀 {len(all_albums)} albums trouvés pour {artist_name}")
            return all_albums
            
        except Exception as e:
            logger.error(f"❌ Erreur récupération albums {artist_name}: {e}")
            return []
        
    def is_primary_artist_album(self, album: Dict, target_artist_id: str) -> bool:
        """Vérifier que l'album appartient principalement à l'artiste cible"""
        album_artists = album.get('artists', [])
        
        if not album_artists:
            return False
        
        # ✅ L'artiste cible doit être le premier artiste (artiste principal)
        primary_artist = album_artists[0]
        return primary_artist.get('id') == target_artist_id

    def is_valid_release_simple(self, release: Dict) -> bool:
        """Validation pour ALBUMS et EPS uniquement (pas de singles courts)"""
        total_tracks = release.get('total_tracks', 0)
        name = release.get('name', '')
        album_type = release.get('album_type', '')
        album_group = release.get('album_group', '')
        
        # 1. ✅ CRITÈRES STRICTS POUR ALBUMS/EPS SEULEMENT
        # EP = 4-7 pistes, Album = 8+ pistes
        if total_tracks < 4:
            return False
        
        # 2. Nom valide
        if not name or len(name.strip()) < 1:
            return False
        
        # 3. ✅ EXCLURE COMPILATIONS ET APPARITIONS
        if album_group in ['compilation', 'appears_on']:
            return False
        
        # 4. ✅ PATTERNS SUSPECTS MINIMAUX
        name_lower = name.lower()
        suspect_patterns = [
            r'^\s*\(null\)\s*$', 
            r'^\s*null\s*$',
            r'^\s*undefined\s*$',
            r'karaoke\s+version',
            r'\(karaoke\)',
            r'soundtrack.*pt\.',  # OST parties
            r'original.*soundtrack.*pt\.',
        ]
        
        for pattern in suspect_patterns:
            if re.search(pattern, name_lower):
                return False
        
        return True

    def create_album_document(self, spotify_release: Dict, group_data: Dict) -> Dict:
        """Créer un document album à partir des données Spotify"""
        
        name = spotify_release.get('name', '').strip()
        release_date_str = spotify_release.get('release_date', '')
        total_tracks = spotify_release.get('total_tracks', 0)
        spotify_url = spotify_release.get('external_urls', {}).get('spotify', '')
        images = spotify_release.get('images', [])
        album_type = spotify_release.get('album_type', '')
        spotify_id = spotify_release.get('id', '')
        
        # ✅ CONVERSION DATE SPOTIFY ROBUSTE
        release_date = None
        if release_date_str:
            try:
                if len(release_date_str) == 10:  # YYYY-MM-DD
                    release_date = datetime.strptime(release_date_str, '%Y-%m-%d')
                elif len(release_date_str) == 7:  # YYYY-MM
                    release_date = datetime.strptime(release_date_str + '-01', '%Y-%m-%d')
                elif len(release_date_str) == 4:  # YYYY
                    release_date = datetime.strptime(release_date_str + '-01-01', '%Y-%m-%d')
            except:
                pass
        
        # Meilleure image
        cover_image = '/images/albums/default-album.jpg'
        if images:
            cover_image = images[0].get('url', cover_image)
        
        # ✅ DÉTERMINER LE TYPE FINAL BASÉ SUR LE NOMBRE DE PISTES
        if total_tracks >= 8:
            final_album_type = 'album'  # 8+ pistes = Album complet
        elif total_tracks >= 4:
            final_album_type = 'ep'     # 4-7 pistes = EP/Mini-album
        else:
            final_album_type = 'single' # 1-3 pistes = Single (ne devrait pas arriver ici)
        
        return {
            'name': name,
            'coverImage': cover_image,
            'artistId': group_data['_id'],
            'artistName': group_data['name'],
            'spotifyId': spotify_id,
            'spotifyUrl': spotify_url,
            'releaseDate': release_date,
            'totalTracks': total_tracks,
            'albumType': final_album_type,
            'discoverySource': 'Spotify',
            'lastScraped': datetime.now(),
            'createdAt': datetime.now(),
            'updatedAt': datetime.now()
        }

    def save_or_update_group(self, document: Dict) -> tuple[bool, str, Optional[Dict]]:
        """Sauvegarder ou mettre à jour un groupe"""
        try:
            existing = self.groups_collection.find_one({
                "$or": [
                    {"spotifyId": document.get('spotifyId')},
                    {"name": {"$regex": f"^{re.escape(document['name'])}$", "$options": "i"}}
                ]
            })
            
            if existing:
                document['createdAt'] = existing.get('createdAt', datetime.now())
                document['updatedAt'] = datetime.now()
                document['_id'] = existing['_id']
                
                self.groups_collection.replace_one({"_id": existing["_id"]}, document)
                logger.info(f"🔄 Groupe mis à jour: {document['name']}")
                return True, "updated", document
            else:
                result = self.groups_collection.insert_one(document)
                document['_id'] = result.inserted_id
                logger.info(f"✅ Nouveau groupe: {document['name']}")
                return True, "created", document
                
        except Exception as e:
            logger.error(f"❌ Erreur sauvegarde groupe {document['name']}: {e}")
            return False, f"error: {e}", None

    def save_or_update_album(self, document: Dict) -> tuple[bool, str]:
        """Sauvegarder ou mettre à jour un album"""
        try:
            existing = self.albums_collection.find_one({
                "$or": [
                    {"spotifyId": document.get('spotifyId')},
                    {
                        "artistName": document['artistName'],
                        "name": {"$regex": f"^{re.escape(document['name'])}$", "$options": "i"}
                    }
                ]
            })
            
            if existing:
                document['createdAt'] = existing.get('createdAt', datetime.now())
                document['updatedAt'] = datetime.now()
                
                self.albums_collection.replace_one({"_id": existing["_id"]}, document)
                logger.debug(f"🔄 Album mis à jour: {document['name']}")
                return True, "updated"
            else:
                self.albums_collection.insert_one(document)
                logger.info(f"✅ Nouvel album: {document['artistName']} - {document['name']} ({document['totalTracks']} pistes)")
                return True, "created"
                
        except Exception as e:
            logger.error(f"❌ Erreur sauvegarde album: {e}")
            return False, f"error: {e}"

    def cleanup_old_data(self):
        """Nettoyer les anciennes données"""
        logger.info("🧹 Nettoyage des anciennes données...")
        
        try:
            # Supprimer champs obsolètes des albums
            albums_cleaned = self.albums_collection.update_many(
                {},
                {"$unset": {"playcount": "", "lastfmUrl": "", "availableProducts": ""}}
            )
            
            # Supprimer albums de mauvaise qualité
            bad_albums = self.albums_collection.delete_many({
                "$or": [
                    {"name": {"$regex": r"^\s*\(null\)\s*$", "$options": "i"}},
                    {"name": {"$regex": r"^\s*null\s*$", "$options": "i"}},
                    {"name": {"$regex": r"^\s*undefined\s*$", "$options": "i"}},
                ]
            })
            
            logger.info(f"🧹 {albums_cleaned.modified_count} albums nettoyés, {bad_albums.deleted_count} supprimés")
            return albums_cleaned.modified_count + bad_albums.deleted_count
            
        except Exception as e:
            logger.error(f"❌ Erreur nettoyage: {e}")
            return 0

    def run_hybrid_collection(self):
        """🎯 EXÉCUTER LA COLLECTE HYBRIDE AVEC SEARCH DIRECTE"""
        logger.info("🚀 COLLECTE HYBRIDE K-POP - RECHERCHE DIRECTE D'ALBUMS")
        
        # ✅ ÉTAPE 0: Préparation
        self.load_existing_groups_cache()
        cleaned_count = self.cleanup_old_data()
        
        global_stats = {
            'phase_1_discovered': 0,
            'phase_1_processed': 0,
            'phase_1_groups_created': 0,
            'phase_1_albums_created': 0,
            'phase_2_groups_processed': 0,
            'phase_2_albums_created': 0,
            'phase_2_albums_updated': 0,
            'total_albums_created': 0,
            'total_albums_updated': 0,
            'cleaned_count': cleaned_count
        }
        
        # ✅ PHASE 1: DÉCOUVERTE DE NOUVEAUX GROUPES
        logger.info("\n" + "="*70)
        logger.info("🔍 PHASE 1 : DÉCOUVERTE DE NOUVEAUX GROUPES K-POP")
        logger.info("="*70)
        
        discovered_artists = self.discover_new_kpop_artists()
        global_stats['phase_1_discovered'] = len(discovered_artists)
        
        if discovered_artists:
            logger.info(f"🎯 {len(discovered_artists)} nouveaux artistes à traiter")
            
            for i, spotify_artist in enumerate(discovered_artists):
                try:
                    artist_stats = self.process_artist_complete(spotify_artist)
                    
                    global_stats['phase_1_processed'] += 1
                    
                    if 'created' in artist_stats['group_action']:
                        global_stats['phase_1_groups_created'] += 1
                    
                    global_stats['phase_1_albums_created'] += artist_stats['albums_created']
                    
                    # Progress
                    if (i + 1) % 10 == 0:
                        progress = ((i + 1) / len(discovered_artists)) * 100
                        logger.info(f"📈 Phase 1: {i+1}/{len(discovered_artists)} ({progress:.1f}%) - "
                                  f"✅ {global_stats['phase_1_groups_created']} nouveaux groupes")
                    
                    time.sleep(1)  # Rate limiting
                    
                except Exception as e:
                    logger.error(f"💥 Erreur phase 1 - {spotify_artist.get('name')}: {e}")
                    global_stats['phase_1_processed'] += 1
        else:
            logger.info("ℹ️ Aucun nouveau groupe découvert")
        
        # ✅ PHASE 2: COMPLÉTION DES ALBUMS POUR TOUS LES GROUPES
        logger.info("\n" + "="*70)
        logger.info("📀 PHASE 2 : COMPLÉTION ALBUMS POUR TOUS LES GROUPES")
        logger.info("="*70)
        
        existing_groups = self.get_all_existing_groups()
        
        if existing_groups:
            logger.info(f"📋 {len(existing_groups)} groupes à traiter pour leurs albums")
            
            for i, group_data in enumerate(existing_groups):
                try:
                    album_stats = self.process_existing_group_albums(group_data)
                    
                    global_stats['phase_2_groups_processed'] += 1
                    global_stats['phase_2_albums_created'] += album_stats['albums_created']
                    global_stats['phase_2_albums_updated'] += album_stats['albums_updated']
                    
                    # Progress
                    if (i + 1) % 15 == 0:
                        progress = ((i + 1) / len(existing_groups)) * 100
                        logger.info(f"📈 Phase 2: {i+1}/{len(existing_groups)} ({progress:.1f}%) - "
                                  f"📀 {global_stats['phase_2_albums_created']} albums créés")
                    
                    time.sleep(0.8)  # Rate limiting
                    
                except Exception as e:
                    logger.error(f"💥 Erreur phase 2 - {group_data.get('name')}: {e}")
                    global_stats['phase_2_groups_processed'] += 1
        
        # ✅ CALCUL STATS FINALES
        global_stats['total_albums_created'] = global_stats['phase_1_albums_created'] + global_stats['phase_2_albums_created']
        global_stats['total_albums_updated'] = global_stats['phase_2_albums_updated']
        
        return global_stats

    def cleanup_invalid_spotify_artists(self):
        """🧹 SUPPRIMER LES ARTISTES INVALIDES OU PAS SUR SPOTIFY"""
        logger.info("🧹 NETTOYAGE DES ARTISTES SPOTIFY INVALIDES...")
        
        try:
            # Récupérer tous les groupes avec un spotifyId
            groups_with_spotify = list(self.groups_collection.find(
                {"spotifyId": {"$exists": True, "$ne": None, "$ne": ""}},
                {"_id": 1, "name": 1, "spotifyId": 1}
            ))
            
            logger.info(f"📊 {len(groups_with_spotify)} groupes avec Spotify ID à vérifier")
            
            invalid_count = 0
            rate_limited_count = 0
            checked_count = 0
            
            for i, group in enumerate(groups_with_spotify, 1):
                group_name = group.get('name', 'Unknown')
                spotify_id = group.get('spotifyId')
                group_id = group.get('_id')
                
                logger.info(f"🔍 [{i}/{len(groups_with_spotify)}] Vérification: {group_name}")
                
                try:
                    if not self.refresh_spotify_token_if_needed():
                        logger.error("❌ Impossible de rafraîchir le token Spotify")
                        continue
                    
                    headers = {'Authorization': f'Bearer {self.spotify_token}'}
                    
                    # Vérifier si l'artiste existe sur Spotify
                    response = requests.get(
                        f'https://api.spotify.com/v1/artists/{spotify_id}',
                        headers=headers,
                        timeout=10
                    )
                    
                    if response.status_code == 200:
                        artist_data = response.json()
                        artist_name = artist_data.get('name', '')
                        genres = artist_data.get('genres', [])
                        
                        # Vérifier si c'est K-pop
                        kpop_genres = ['k-pop', 'korean pop', 'korean', 'korean hip hop', 'korean r&b']
                        is_kpop = any(kpop_genre in genre.lower() for genre in genres for kpop_genre in kpop_genres)
                        
                        # Vérifier la correspondance du nom (tolérance)
                        name_similarity = self.calculate_name_similarity(group_name, artist_name)
                        
                        if not is_kpop:
                            logger.warning(f"🚫 {group_name} n'est pas K-pop sur Spotify: {genres}")
                            self.delete_group_and_albums(group_id, group_name, "Pas K-pop sur Spotify")
                            invalid_count += 1
                        elif name_similarity < 0.6:  # Moins de 60% de similarité
                            logger.warning(f"🚫 {group_name} != {artist_name} (similarité: {name_similarity:.2f})")
                            self.delete_group_and_albums(group_id, group_name, f"Nom incorrect: {artist_name}")
                            invalid_count += 1
                        else:
                            logger.info(f"✅ {group_name} = {artist_name} (K-pop: {is_kpop})")
                            checked_count += 1
                    
                    elif response.status_code == 404:
                        logger.warning(f"🚫 {group_name} n'existe pas sur Spotify (404)")
                        self.delete_group_and_albums(group_id, group_name, "Artiste inexistant sur Spotify")
                        invalid_count += 1
                    
                    elif response.status_code == 429:
                        retry_after = response.headers.get('Retry-After', '60')
                        wait_time = int(retry_after)
                        
                        if wait_time <= 300:  # Max 5 minutes d'attente
                            logger.warning(f"⏳ Rate limited, attente {wait_time}s...")
                            time.sleep(wait_time)
                            rate_limited_count += 1
                            continue
                        else:
                            logger.warning(f"⚠️ Rate limiting trop long ({wait_time}s), passage au suivant")
                            rate_limited_count += 1
                    
                    else:
                        logger.error(f"❌ Erreur HTTP {response.status_code} pour {group_name}")
                    
                    # Pause entre chaque vérification
                    time.sleep(1)
                    
                except Exception as e:
                    logger.error(f"❌ Erreur vérification {group_name}: {e}")
                    continue
        
        except Exception as e:
            logger.error(f"❌ Erreur nettoyage global: {e}")
            return {'checked': 0, 'deleted': 0, 'rate_limited': 0}

    def calculate_name_similarity(self, name1: str, name2: str) -> float:
        """Calculer la similarité entre deux noms d'artistes"""
        import difflib
        
        # Normaliser les noms
        n1 = name1.lower().strip()
        n2 = name2.lower().strip()
        
        # Similarité basique
        similarity = difflib.SequenceMatcher(None, n1, n2).ratio()
        
        # Bonus si un nom contient l'autre
        if n1 in n2 or n2 in n1:
            similarity = max(similarity, 0.8)
        
        return similarity

    def delete_group_and_albums(self, group_id, group_name: str, reason: str):
        """Supprimer un groupe et tous ses albums"""
        try:
            # Supprimer tous les albums du groupe
            albums_deleted = self.albums_collection.delete_many({"artistId": group_id})
            
            # Supprimer le groupe
            group_deleted = self.groups_collection.delete_one({"_id": group_id})
            
            if group_deleted.deleted_count > 0:
                logger.info(f"🗑️ {group_name} supprimé ({albums_deleted.deleted_count} albums) - Raison: {reason}")
            else:
                logger.warning(f"⚠️ Impossible de supprimer {group_name}")
                
        except Exception as e:
            logger.error(f"❌ Erreur suppression {group_name}: {e}")

    def run_cleanup_only(self):
        """🧹 EXÉCUTER SEULEMENT LE NETTOYAGE"""
        logger.info("🧹 MODE NETTOYAGE UNIQUEMENT")
        logger.info("=" * 50)
        
        try:
            # Charger le cache
            self.load_existing_groups_cache()
            
            # Nettoyer les artistes invalides
            cleanup_stats = self.cleanup_invalid_spotify_artists()
            
            return cleanup_stats
            
        except Exception as e:
            logger.error(f"❌ Erreur nettoyage: {e}")
            return {'checked': 0, 'deleted': 0, 'rate_limited': 0}

def main():
    print("🎵 HYBRID K-POP COLLECTOR v15.1 - AVEC OPTIONS")
    print("=" * 70)
    print("🎯 OPTIONS DISPONIBLES:")
    print("   1. 🚀 Collecte complète (découverte + albums)")
    print("   2. 🧹 Nettoyage uniquement (supprimer artistes invalides)")
    print("   3. 📊 Statistiques uniquement")
    print("   4. ❌ Quitter")
    print()
    
    try:
        collector = HybridKpopCollector()
        
        # MENU INTERACTIF
        while True:
            choice = input("Votre choix (1-4): ").strip()
            
            if choice == "4":
                print("Au revoir! 👋")
                break
            
            start_time = datetime.now()
            
            if choice == "1":
                # 🚀 Collecte complète
                print("\n🚀 LANCEMENT DE LA COLLECTE COMPLÈTE...")
                stats = collector.run_hybrid_collection()
                
                print("\n🎉 COLLECTE HYBRIDE TERMINÉE!")
                print("=" * 70)
                print("📍 PHASE 1 - DÉCOUVERTE:")
                print(f"   🔍 Nouveaux groupes découverts : {stats['phase_1_discovered']}")
                print(f"   🔄 Nouveaux groupes traités     : {stats['phase_1_processed']}")
                print(f"   ✅ Nouveaux groupes créés       : {stats['phase_1_groups_created']}")
                print(f"   📀 Albums nouveaux groupes      : {stats['phase_1_albums_created']}")
                print()
                print("📍 PHASE 2 - COMPLÉTION:")
                print(f"   📋 Groupes existants traités    : {stats['phase_2_groups_processed']}")
                print(f"   📀 Albums créés (existants)     : {stats['phase_2_albums_created']}")
                print(f"   🔄 Albums mis à jour            : {stats['phase_2_albums_updated']}")
                print()
                print("📊 TOTAUX:")
                print(f"   📀 TOTAL albums créés           : {stats['total_albums_created']}")
                print(f"   🔄 TOTAL albums mis à jour      : {stats['total_albums_updated']}")
                print(f"   🧹 Données nettoyées            : {stats['cleaned_count']}")
                
            elif choice == "2":
                # 🧹 Nettoyage uniquement
                print("\n🧹 LANCEMENT DU NETTOYAGE...")
                cleanup_stats = collector.cleanup_invalid_spotify_artists()
                
                print("\n🧹 NETTOYAGE TERMINÉ!")
                print("=" * 50)
                print(f"   ✅ Groupes vérifiés: {cleanup_stats.get('checked', 'N/A')}")
                print(f"   🗑️ Groupes supprimés: {cleanup_stats.get('deleted', 'N/A')}")
                print(f"   ⏳ Rate limited: {cleanup_stats.get('rate_limited', 'N/A')}")
                
            elif choice == "3":
                # 📊 Statistiques uniquement
                print("\n📊 STATISTIQUES ACTUELLES...")
                
                total_groups = collector.groups_collection.count_documents({})
                active_groups = collector.groups_collection.count_documents({"isActive": True})
                spotify_groups = collector.groups_collection.count_documents({"spotifyId": {"$exists": True, "$ne": None, "$ne": ""}})
                total_albums = collector.albums_collection.count_documents({})
                spotify_albums = collector.albums_collection.count_documents({"discoverySource": "Spotify"})
                
                print(f"\n📊 ÉTAT DE LA BASE:")
                print("=" * 50)
                print(f"   🎤 Total groupes        : {total_groups}")
                print(f"   ✅ Groupes actifs       : {active_groups}")
                print(f"   🎯 Groupes Spotify      : {spotify_groups} ({(spotify_groups/total_groups*100) if total_groups > 0 else 0:.1f}%)")
                print(f"   📀 Total albums         : {total_albums}")
                print(f"   🎯 Albums Spotify       : {spotify_albums} ({(spotify_albums/total_albums*100) if total_albums > 0 else 0:.1f}%)")
                
                # Top 10 groupes par nombre d'albums
                pipeline = [
                    {"$group": {"_id": "$artistName", "count": {"$sum": 1}}},
                    {"$sort": {"count": -1}},
                    {"$limit": 10}
                ]
                top_artists = list(collector.albums_collection.aggregate(pipeline))
                
                if top_artists:
                    print(f"\n🏆 TOP 10 GROUPES (par nb albums):")
                    for i, artist in enumerate(top_artists, 1):
                        print(f"   {i:2d}. {artist['_id']} ({artist['count']} albums)")
                
                # Vérifier TWICE spécifiquement
                twice_group = collector.groups_collection.find_one({"name": {"$regex": "^TWICE$", "$options": "i"}})
                if twice_group:
                    twice_albums_count = collector.albums_collection.count_documents({"artistId": twice_group["_id"]})
                    print(f"\n🌟 TWICE: {twice_albums_count} albums trouvés")
                    
                    # Quelques albums récents
                    recent_albums = list(collector.albums_collection.find(
                        {"artistId": twice_group["_id"]}, 
                        {"name": 1, "releaseDate": 1, "totalTracks": 1}
                    ).sort("releaseDate", -1).limit(5))
                    
                    if recent_albums:
                        print("   📀 Albums récents:")
                        for album in recent_albums:
                            release_year = album.get('releaseDate', datetime.now()).year if album.get('releaseDate') else 'N/A'
                            tracks = album.get('totalTracks', 0)
                            print(f"      • {album['name']} ({release_year}, {tracks} pistes)")
                
            else:
                print("❌ Choix invalide. Veuillez choisir 1, 2, 3 ou 4.")
                continue
            
            end_time = datetime.now()
            duration = end_time - start_time
            print(f"\n⏱️ Durée: {duration}")
            print("\n" + "="*50 + "\n")
            
    except KeyboardInterrupt:
        print("\n🛑 ARRÊT MANUEL")
    except Exception as e:
        logger.error(f"💥 Erreur globale: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if 'collector' in locals():
            collector.client.close()
if __name__ == "__main__":
    main()