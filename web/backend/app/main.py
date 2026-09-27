from datetime import datetime, timezone, timedelta
from pathlib import Path
import hashlib
import json
import os
import secrets
import uuid

import boto3
from supabase import create_client
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError


# =========================================================
# CONFIGURATION
# =========================================================

APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
WEB_DIR = BACKEND_DIR.parent
ROOT_DIR = WEB_DIR.parent
DATA_DIR = ROOT_DIR / "data"

LOCAL_AUDIO_DIR = ROOT_DIR / "storage" / "audio"

load_dotenv(BACKEND_DIR / ".env")

MONGODB_URL = os.getenv(
    "MONGODB_URL",
    "mongodb://127.0.0.1:27017",
)

MONGODB_DB = os.getenv(
    "MONGODB_DB",
    "medassist_language_data",
)

CORS_ORIGINS = [
    item.strip()
    for item in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173",
    ).split(",")
    if item.strip()
]

AUDIO_STORAGE = os.getenv(
    "AUDIO_STORAGE",
    "local",
).lower()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "").strip()
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "audio").strip()

MAX_AUDIO_BYTES = 15 * 1024 * 1024

RATE_LIMIT_WINDOW = timedelta(minutes=10)
MAX_UPLOADS_PER_WINDOW = 10

ALLOWED_LANGUAGES = {
    "fon",
    "goun",
    "yoruba",
}

POINTS_PER_CONTRIBUTION = 100

ALLOWED_AUDIO_TYPES = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
}


# =========================================================
# APP
# =========================================================

app = FastAPI(
    title="MedAssist Language Data API",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# =========================================================
# MONGODB
# =========================================================

mongo = MongoClient(MONGODB_URL)
db = mongo[MONGODB_DB]

contributors = db["contributors"]
recordings = db["recordings"]
counters = db["counters"]

contributors.create_index(
    "assist_id",
    unique=True,
)

contributors.create_index(
    "client_id",
    unique=True,
    sparse=True,
)

contributors.create_index(
    "access_token_hash",
    unique=True,
    sparse=True,
)

contributors.create_index(
    [
        ("points", -1),
        ("contributions", -1),
    ],
)

recordings.create_index(
    [
        ("contributor_id", 1),
        ("language", 1),
        ("symptom_id", 1),
    ],
    unique=True,
)

recordings.create_index(
    [
        ("contributor_id", 1),
        ("created_at", -1),
    ],
)

recordings.create_index("symptom_id")
recordings.create_index("language")


# =========================================================
# SESSIONS
# =========================================================

SESSION_GROUPS = [
    {
        "id": 1,
        "title": "Les symptômes courants",
        "symptoms": [
            "SYM-01",
            "SYM-02",
            "SYM-03",
            "SYM-04",
            "SYM-05",
        ],
    },
    {
        "id": 2,
        "title": "Ventre et digestion",
        "symptoms": [
            "SYM-06",
            "SYM-07",
            "SYM-08",
            "SYM-09",
            "SYM-10",
        ],
    },
    {
        "id": 3,
        "title": "Respiration et tête",
        "symptoms": [
            "SYM-11",
            "SYM-12",
            "SYM-13",
            "SYM-14",
            "SYM-15",
        ],
    },
    {
        "id": 4,
        "title": "Autres symptômes",
        "symptoms": [
            "SYM-16",
            "SYM-17",
            "SYM-18",
            "SYM-19",
            "SYM-20",
        ],
    },
    {
        "id": 5,
        "title": "Peau et douleurs",
        "symptoms": [
            "SYM-21",
            "SYM-22",
            "SYM-23",
            "SYM-24",
            "SYM-25",
        ],
    },
    {
        "id": 6,
        "title": "Phrases importantes",
        "urgent": True,
        "symptoms": [
            "URG-01",
            "URG-02",
            "URG-03",
            "URG-04",
            "URG-05",
        ],
    },
]


# =========================================================
# HELPERS
# =========================================================

def now():
    return datetime.now(timezone.utc)


def load_json(path: Path):
    if not path.exists():
        return []

    try:
        return json.loads(
            path.read_text(encoding="utf-8")
        )
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"JSON invalide: {path.name}",
        ) from exc


def load_symptoms():
    data = load_json(
        DATA_DIR / "symptoms_fr.json"
    )

    result = {}

    for item in data:
        symptom_id = item.get("id")

        if not symptom_id:
            continue

        title = (
            item.get("symptom_fr")
            or item.get("title")
            or item.get("symptom")
            or symptom_id
        )

        sentence = (
            item.get("sentence_fr")
            or item.get("sentence")
            or item.get("phrase_fr")
            or item.get("phrase")
            or item.get("text")
            or ""
        )

        result[symptom_id] = {
            "id": symptom_id,
            "title": title,
            "sentence": sentence,
            "type": item.get("type"),
        }

    return result


def load_translations(language):
    path = (
        DATA_DIR
        / language
        / "translations.json"
    )

    data = load_json(path)

    result = {}

    for item in data:
        symptom_id = (
            item.get("symptom_id")
            or item.get("id")
        )

        translation = (
            item.get("translation")
            or item.get("text")
            or item.get("phrase")
            or item.get("sentence")
        )

        if symptom_id and translation:
            result[symptom_id] = translation

    return result


def sanitize_contributor(document):
    if not document:
        return None

    document = dict(document)

    document.pop("_id", None)
    document.pop("access_token_hash", None)

    return document


def issue_access_token():
    token = secrets.token_urlsafe(32)

    token_hash = hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()

    return token, token_hash


def authenticate(authorization):
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Authentification requise.",
        )

    parts = authorization.split(" ", 1)

    if len(parts) != 2:
        raise HTTPException(
            status_code=401,
            detail="Jeton d'authentification invalide.",
        )

    scheme, token = parts

    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=401,
            detail="Jeton d'authentification invalide.",
        )

    token_hash = hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()

    contributor = contributors.find_one(
        {"access_token_hash": token_hash}
    )

    if not contributor:
        raise HTTPException(
            status_code=401,
            detail="Jeton expiré ou invalide.",
        )

    return contributor


def store_audio(
    content,
    language,
    recording_id,
    suffix,
    content_type,
):
    if AUDIO_STORAGE == "supabase":
        if not all(
            [
                SUPABASE_URL,
                SUPABASE_SECRET_KEY,
                SUPABASE_BUCKET,
            ]
        ):
            raise HTTPException(
                status_code=500,
                detail="Stockage Supabase mal configuré.",
            )

        key = (
            f"recordings/{language}/"
            f"{datetime.now(timezone.utc):%Y/%m}/"
            f"{recording_id}{suffix}"
        )

        try:
            client = create_client(
                SUPABASE_URL,
                SUPABASE_SECRET_KEY,
            )

            client.storage.from_(
                SUPABASE_BUCKET
            ).upload(
                path=key,
                file=content,
                file_options={
                    "content-type": content_type,
                    "upsert": "false",
                },
            )
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Impossible de stocker l'audio dans Supabase.",
            ) from exc

        return key

    if AUDIO_STORAGE == "r2":
        endpoint = os.getenv("R2_ENDPOINT")
        access_key = os.getenv("R2_ACCESS_KEY_ID")
        secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
        bucket = os.getenv("R2_BUCKET")

        if not all(
            [
                endpoint,
                access_key,
                secret_key,
                bucket,
            ]
        ):
            raise HTTPException(
                status_code=500,
                detail="Stockage R2 mal configuré.",
            )

        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="auto",
        )

        key = (
            f"recordings/{language}/"
            f"{datetime.now(timezone.utc):%Y/%m}/"
            f"{recording_id}{suffix}"
        )

        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=content,
            ContentType=content_type,
        )

        return key

    LOCAL_AUDIO_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    destination_dir = LOCAL_AUDIO_DIR / language

    destination_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    file_path = (
        destination_dir
        / f"{recording_id}{suffix}"
    )

    file_path.write_bytes(content)

    return str(
        file_path.relative_to(ROOT_DIR)
    ).replace("\\", "/")

def delete_stored_audio(storage_key):
    if not storage_key:
        return

    try:
        if AUDIO_STORAGE == "supabase":
            if not all(
                [
                    SUPABASE_URL,
                    SUPABASE_SECRET_KEY,
                    SUPABASE_BUCKET,
                ]
            ):
                return

            client = create_client(
                SUPABASE_URL,
                SUPABASE_SECRET_KEY,
            )

            client.storage.from_(
                SUPABASE_BUCKET
            ).remove([storage_key])

            return

        if AUDIO_STORAGE == "r2":
            endpoint = os.getenv("R2_ENDPOINT")
            access_key = os.getenv("R2_ACCESS_KEY_ID")
            secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
            bucket = os.getenv("R2_BUCKET")

            client = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                region_name="auto",
            )

            client.delete_object(
                Bucket=bucket,
                Key=storage_key,
            )
        else:
            path = ROOT_DIR / storage_key

            if path.exists():
                path.unlink()
    except Exception:
        pass

def get_contributor(assist_id):
    contributor = contributors.find_one(
        {"assist_id": assist_id}
    )

    if not contributor:
        raise HTTPException(
            status_code=404,
            detail="Contributeur introuvable.",
        )

    return contributor


# =========================================================
# HEALTH
# =========================================================

@app.get("/api/health")
def health():
    mongo.admin.command("ping")

    return {
        "status": "ok",
        "service": "medassist-language-data",
        "database": MONGODB_DB,
        "audio_storage": AUDIO_STORAGE,
    }


# =========================================================
# CONTRIBUTORS
# =========================================================

@app.post("/api/contributors")
def create_contributor(
    client_id: str = Query(default=""),
):
    client_id = client_id.strip()

    if client_id:
        existing = contributors.find_one(
            {"client_id": client_id}
        )

        if existing:
            token, token_hash = issue_access_token()

            updated = contributors.find_one_and_update(
                {"_id": existing["_id"]},
                {
                    "$set": {
                        "access_token_hash": token_hash,
                        "updated_at": now(),
                    }
                },
                return_document=ReturnDocument.AFTER,
            )

            result = sanitize_contributor(
                updated
            )

            result["access_token"] = token

            return result

    counter = counters.find_one_and_update(
        {"_id": "assist_id"},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )

    number = int(counter["value"])
    assist_id = f"Assist-{number}"

    token, token_hash = issue_access_token()

    contributor = {
        "assist_id": assist_id,
        "client_id": client_id or None,
        "access_token_hash": token_hash,
        "contributions": 0,
        "points": 0,
        "created_at": now(),
        "updated_at": now(),
    }

    contributors.insert_one(contributor)

    result = sanitize_contributor(
        contributor
    )

    result["access_token"] = token

    return result


@app.get("/api/contributors/{assist_id}")
def contributor_profile(assist_id: str):
    contributor = get_contributor(
        assist_id
    )

    rows = list(
        contributors.find(
            {},
            {
                "_id": 0,
                "assist_id": 1,
                "contributions": 1,
                "points": 1,
            },
        ).sort(
            [
                ("points", -1),
                ("contributions", -1),
                ("assist_id", 1),
            ]
        )
    )

    ranking = next(
        (
            index + 1
            for index, row in enumerate(rows)
            if row["assist_id"] == assist_id
        ),
        None,
    )

    result = sanitize_contributor(
        contributor
    )

    result["ranking"] = ranking

    return result


# =========================================================
# LEADERBOARD
# =========================================================

@app.get("/api/leaderboard")
def leaderboard(limit: int = 10):
    limit = max(1, min(limit, 100))

    rows = list(
        contributors.find(
            {},
            {
                "_id": 0,
                "assist_id": 1,
                "contributions": 1,
                "points": 1,
            },
        ).sort(
            [
                ("points", -1),
                ("contributions", -1),
                ("assist_id", 1),
            ]
        ).limit(limit)
    )

    return {
        "items": [
            {
                **row,
                "rank": index + 1,
            }
            for index, row in enumerate(rows)
        ]
    }


@app.get(
    "/api/leaderboard/{assist_id}/challenge"
)
def leaderboard_challenge(
    assist_id: str,
):
    contributor = get_contributor(
        assist_id
    )

    rows = list(
        contributors.find(
            {},
            {
                "_id": 0,
                "assist_id": 1,
                "contributions": 1,
                "points": 1,
            },
        ).sort(
            [
                ("points", -1),
                ("contributions", -1),
                ("assist_id", 1),
            ]
        )
    )

    current_index = next(
        (
            index
            for index, row in enumerate(rows)
            if row["assist_id"] == assist_id
        ),
        None,
    )

    if current_index is None:
        raise HTTPException(
            status_code=404,
            detail="Contributeur introuvable.",
        )

    rank = current_index + 1

    if current_index == 0:
        return {
            "assist_id": assist_id,
            "rank": rank,
            "leader": True,
            "points_to_next": 0,
            "contributions_to_next": 0,
        }

    person_ahead = rows[
        current_index - 1
    ]

    points_to_next = max(
        person_ahead["points"]
        - contributor["points"],
        0,
    )

    contributions_to_next = (
        (points_to_next + POINTS_PER_CONTRIBUTION - 1)
        // POINTS_PER_CONTRIBUTION
    )

    return {
        "assist_id": assist_id,
        "rank": rank,
        "leader": False,
        "target_assist_id": person_ahead["assist_id"],
        "points_to_next": points_to_next,
        "contributions_to_next": contributions_to_next,
    }


# =========================================================
# SESSIONS
# =========================================================

@app.get(
    "/api/sessions/{language}/{session_id}"
)
def get_session(
    language: str,
    session_id: int,
):
    if language not in ALLOWED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail="Langue non supportée.",
        )

    session = next(
        (
            item
            for item in SESSION_GROUPS
            if item["id"] == session_id
        ),
        None,
    )

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Session introuvable.",
        )

    symptoms = load_symptoms()
    translations = load_translations(
        language
    )

    phrases = []

    for symptom_id in session["symptoms"]:
        symptom = symptoms.get(
            symptom_id
        )

        if not symptom:
            continue

        phrases.append(
            {
                "id": symptom["id"],
                "title": symptom["title"],
                "french": symptom["sentence"],
                "local_text": translations.get(
                    symptom_id
                ),
                "type": symptom["type"],
            }
        )

    return {
        "session_id": session["id"],
        "title": session["title"],
        "urgent": session.get(
            "urgent",
            False,
        ),
        "language": language,
        "phrases": phrases,
    }


# =========================================================
# RECORDINGS
# =========================================================

@app.post("/api/recordings")
async def create_recording(
    language: str = Form(...),
    symptom_id: str = Form(...),
    audio: UploadFile = File(...),
    authorization: str | None = Header(
        default=None,
    ),
):
    contributor = authenticate(
        authorization
    )

    if language not in ALLOWED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail="Langue non supportée.",
        )

    symptoms = load_symptoms()

    if symptom_id not in symptoms:
        raise HTTPException(
            status_code=404,
            detail="Symptôme introuvable.",
        )

    translations = load_translations(
        language
    )

    if not translations.get(symptom_id):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Traduction en {language} "
                "pas disponible."
            ),
        )

    recent_limit = now() - RATE_LIMIT_WINDOW

    recent_uploads = recordings.count_documents(
        {
            "contributor_id": contributor[
                "assist_id"
            ],
            "created_at": {
                "$gte": recent_limit,
            },
        }
    )

    if recent_uploads >= MAX_UPLOADS_PER_WINDOW:
        raise HTTPException(
            status_code=429,
            detail=(
                "Trop de contributions en peu de temps. "
                "Réessaie plus tard."
            ),
        )

    already_exists = recordings.find_one(
        {
            "contributor_id": contributor[
                "assist_id"
            ],
            "language": language,
            "symptom_id": symptom_id,
        }
    )

    if already_exists:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cette expression a déjà été "
                "enregistrée avec ce profil."
            ),
        )

    content_type = (
        audio.content_type or ""
    ).split(";")[0].lower()

    suffix = ALLOWED_AUDIO_TYPES.get(
        content_type
    )

    if not suffix:
        raise HTTPException(
            status_code=415,
            detail=(
                "Format audio non supporté."
            ),
        )

    content = await audio.read()

    if not content:
        raise HTTPException(
            status_code=400,
            detail="Fichier audio vide.",
        )

    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                "Enregistrement trop volumineux."
            ),
        )

    recording_id = str(uuid.uuid4())

    storage_key = store_audio(
        content=content,
        language=language,
        recording_id=recording_id,
        suffix=suffix,
        content_type=content_type,
    )

    recording = {
        "recording_id": recording_id,
        "contributor_id": contributor[
            "assist_id"
        ],
        "language": language,
        "symptom_id": symptom_id,
        "audio_file": storage_key,
        "content_type": content_type,
        "size_bytes": len(content),
        "created_at": now(),
    }

    try:
        recordings.insert_one(
            recording
        )
    except DuplicateKeyError:
        delete_stored_audio(
            storage_key
        )

        raise HTTPException(
            status_code=409,
            detail=(
                "Cette expression a déjà été "
                "enregistrée avec ce profil."
            ),
        )

    updated = contributors.find_one_and_update(
        {
            "assist_id": contributor[
                "assist_id"
            ]
        },
        {
            "$inc": {
                "contributions": 1,
                "points": POINTS_PER_CONTRIBUTION,
            },
            "$set": {
                "updated_at": now(),
            },
        },
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
    )

    return {
        "message": "Contribution enregistrée.",
        "recording_id": recording_id,
        "contributor": sanitize_contributor(updated),
        "points_added": POINTS_PER_CONTRIBUTION,
    }
