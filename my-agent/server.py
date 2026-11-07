import asyncio
import base64
import json
import logging
import os
import secrets
import uuid
from datetime import datetime
from pathlib import Path

# Load .env file if it exists
from dotenv import load_dotenv
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

import bcrypt
import boto3
from fastapi import FastAPI, HTTPException, Header, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
from auth import (
    get_current_user,
    create_session_token,
    create_challenge_token,
    verify_challenge_token,
    verify_apple,
    verify_google_id_token,
    verify_microsoft_id_token,
)
from coach import stream_coach_response, save_profile, get_profile
from scorer import score_survey
from math_utils import calculate_psychology_cost
from image_agent import analyze_image, SYSTEM_PROMPT, ANALYSIS_PROMPT
from tracing import flush_all as flush_langfuse
from image_models import (
    AnalyzeRequest,
    AnalyzeTextRequest,
    AnalyzeResponse,
    AnalysisResult,
    ScoreBreakdown,
    PriceCheckRequest,
    PriceCheckResponse,
    StorePrice,
)
import price_matcher

logger = logging.getLogger("fincore.server")

INSIGHTS_SYSTEM_PROMPT = """Act as a world-class financial psychologist. Explain how a user's specific OCEAN scores will influence their spending and how the 'Faith' AI will coach them to be better.

Be warm, direct, and actionable. Use British English. Keep the response to 2-3 sentences that feel personal and specific to their scores."""


async def generate_insights(big_five: dict, name: str) -> str:
    """Generate personalised insights using Claude via the Agent SDK (same as coach)."""
    from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, ResultMessage

    scores_text = ", ".join(f"{k}: {v}/100" for k, v in big_five.items())
    user_prompt = f"Generate a 'How Faith Will Help You' insight for {name} with these OCEAN scores: {scores_text}. Keep it to 2-3 sentences, warm and actionable, using British English."

    result_text = ""
    async for msg in query(
        prompt=user_prompt,
        options=ClaudeAgentOptions(
            system_prompt=INSIGHTS_SYSTEM_PROMPT,
            allowed_tools=[],
            permission_mode="dontAsk",
        ),
    ):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if hasattr(block, "text"):
                    result_text += block.text
        elif isinstance(msg, ResultMessage):
            break

    return result_text.strip() or "Faith will help you understand your spending patterns and build better financial habits."


def _s3():
    """Return a cached S3 client."""
    if not hasattr(_s3, "_client"):
        _s3._client = boto3.client("s3")
    return _s3._client


def _sms():
    """Return a cached AWS End User Messaging SMS client."""
    if not hasattr(_sms, "_client"):
        _sms._client = boto3.client(
            "pinpoint-sms-voice-v2",
            region_name=os.getenv("AWS_REGION", "eu-west-2"),
        )
    return _sms._client


def send_sms(phone_number: str, message: str) -> str:
    """Send an SMS and return the provider message id."""
    response = _sms().send_text_message(
        DestinationPhoneNumber=phone_number,
        OriginationIdentity=os.getenv("FINCORE_SMS_SENDER_ID", "FINCORE"),
        MessageBody=message,
        MessageType="TRANSACTIONAL",
    )
    return response["MessageId"]


def issue_otp(user_id: str, profile: dict, phone_number: str, bucket: str) -> None:
    """Generate a one-time code, store only its hash, and text it to the user."""
    code = f"{secrets.randbelow(1000000):06d}"
    # Store only a hash -- the profile JSON sits beside the user's personal
    # details, so a readable OTP there would defeat the second factor.
    profile["2fa_code_hash"] = bcrypt.hashpw(code.encode(), bcrypt.gensalt()).decode()
    profile["2fa_code_expiry"] = datetime.utcnow().timestamp() + 300
    profile.pop("2fa_code", None)
    save_profile(user_id, profile, bucket)
    send_sms(phone_number, f"{code} is your Fincore verification code. It expires in 5 minutes.")


def consume_otp(user_id: str, profile: dict, code: str, bucket: str) -> None:
    """Validate a one-time code and burn it. Raises HTTPException on failure."""
    stored_hash = profile.get("2fa_code_hash")
    if not stored_hash:
        raise HTTPException(status_code=400, detail="No code requested")

    if datetime.utcnow().timestamp() > profile.get("2fa_code_expiry", 0):
        raise HTTPException(status_code=400, detail="Code expired")

    if not bcrypt.checkpw(code.encode(), stored_hash.encode()):
        raise HTTPException(status_code=400, detail="Invalid code")

    profile.pop("2fa_code_hash", None)
    profile.pop("2fa_code_expiry", None)
    save_profile(user_id, profile, bucket)


def mask_phone(phone_number: str) -> str:
    return f"••• ••• {phone_number[-4:]}" if len(phone_number) >= 4 else "•••"


def save_scan(user_id: str, scan_data: dict, bucket: str) -> str:
    """Save a scan result to S3 and return the scan_id."""
    scan_id = str(uuid.uuid4())[:8]
    timestamp = datetime.utcnow().isoformat()

    scan_record = {
        "scan_id": scan_id,
        "timestamp": timestamp,
        "user_id": user_id,
        **scan_data
    }

    key = f"users/{user_id}/scans/{scan_id}.json"
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(scan_record),
        ContentType="application/json"
    )
    return scan_id


def get_user_scans(user_id: str, bucket: str, limit: int = 10) -> list:
    """Get recent scans for a user."""
    try:
        response = _s3().list_objects_v2(
            Bucket=bucket,
            Prefix=f"users/{user_id}/scans/",
            MaxKeys=limit * 3  # Request more since we filter out non-JSON files
        )

        scans = []
        for obj in response.get("Contents", []):
            key = obj["Key"]
            # Only process .json files - skip images and other files
            if not key.endswith(".json"):
                continue
            try:
                scan_obj = _s3().get_object(Bucket=bucket, Key=key)
                scan_data = json.loads(scan_obj["Body"].read())
                scans.append(scan_data)
            except Exception as e:
                logger.warning(f"Failed to read scan {key}: {e}")
                continue

        # Sort by timestamp descending
        scans.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        return scans[:limit]
    except Exception as e:
        logger.error(f"Failed to list scans for user {user_id}: {e}")
        return []


def get_scan(user_id: str, scan_id: str, bucket: str) -> dict | None:
    """Get a single scan by ID."""
    try:
        key = f"users/{user_id}/scans/{scan_id}.json"
        obj = _s3().get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read())
    except Exception:
        return None


def save_message(
    user_id: str,
    message: str,
    role: str,
    bucket: str,
    scan_reference: dict | None = None,
    financial_metadata: dict | None = None,
    session_id: str | None = None,
) -> None:
    """Save a message to the conversation history in S3 with multimodal support.

    Stores messages at users/{user_id}/conversations/history.json

    Schema v2 (Multimodal):
    {
        "schema_version": 2,
        "messages": [
            {
                "role": "user"|"assistant",
                "content": "message text",
                "timestamp": "ISO8601",
                "scan_reference": {"scan_id": "abc123", "product_name": "...", "category": "..."} | null,
                "financial_metadata": {"psychology_cost": 15.50, "base_price": 12.99, ...} | null,
                "session_id": "session_xxx" | null
            }
        ]
    }
    """
    key = f"users/{user_id}/conversations/history.json"
    timestamp = datetime.utcnow().isoformat()

    new_message = {
        "role": role,
        "content": message,
        "timestamp": timestamp,
        "scan_reference": scan_reference,
        "financial_metadata": financial_metadata,
        "session_id": session_id,
    }

    # Load existing history or create new
    try:
        obj = _s3().get_object(Bucket=bucket, Key=key)
        history = json.loads(obj["Body"].read())
        # Migrate old schema if needed
        if "schema_version" not in history:
            history["schema_version"] = 2
    except Exception:
        history = {"schema_version": 2, "messages": []}

    # Append new message
    history["messages"].append(new_message)

    # Save back to S3
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(history),
        ContentType="application/json"
    )


def get_conversation_history(user_id: str, bucket: str, limit: int = 20) -> list:
    """Retrieve the last N messages from conversation history.

    Returns a list of message dicts with role, content, and timestamp.
    """
    key = f"users/{user_id}/conversations/history.json"

    try:
        obj = _s3().get_object(Bucket=bucket, Key=key)
        history = json.loads(obj["Body"].read())
        messages = history.get("messages", [])
        # Return the last `limit` messages
        return messages[-limit:] if len(messages) > limit else messages
    except Exception:
        return []


def get_conversation_sessions(user_id: str, bucket: str) -> list:
    """Get a summary of all conversation sessions for a user.

    Groups messages by session_id and returns metadata for each session.
    Messages without a session_id are grouped under "default".

    Returns a list of session summaries sorted by most recent first:
    [
        {
            "session_id": "session_xxx",
            "title": "First user message truncated...",
            "message_count": 10,
            "last_message_time": "2026-05-08T12:00:00",
            "first_message_preview": "Full first user message"
        }
    ]
    """
    key = f"users/{user_id}/conversations/history.json"

    try:
        obj = _s3().get_object(Bucket=bucket, Key=key)
        history = json.loads(obj["Body"].read())
        messages = history.get("messages", [])
    except Exception:
        return []

    if not messages:
        return []

    # Group messages by session_id
    sessions: dict[str, list] = {}
    for msg in messages:
        session_id = msg.get("session_id") or "default"
        if session_id not in sessions:
            sessions[session_id] = []
        sessions[session_id].append(msg)

    # Build session summaries
    summaries = []
    for session_id, session_messages in sessions.items():
        # Find first user message for title/preview
        first_user_msg = next(
            (m for m in session_messages if m.get("role") == "user"),
            None
        )
        first_message_preview = first_user_msg.get("content", "") if first_user_msg else ""

        # Truncate title to ~50 chars
        title = first_message_preview[:50]
        if len(first_message_preview) > 50:
            title = title.rstrip() + "..."

        # Get the last message timestamp
        last_message_time = session_messages[-1].get("timestamp", "")

        summaries.append({
            "session_id": session_id,
            "title": title or "Untitled conversation",
            "message_count": len(session_messages),
            "last_message_time": last_message_time,
            "first_message_preview": first_message_preview,
        })

    # Sort by most recent first
    summaries.sort(key=lambda x: x.get("last_message_time", ""), reverse=True)

    return summaries


def get_session_messages(user_id: str, session_id: str, bucket: str) -> list:
    """Get all messages for a specific session_id.

    Args:
        user_id: The user's ID
        session_id: The session ID to filter by (use "default" for messages without session_id)
        bucket: S3 bucket name

    Returns:
        List of messages for the specified session, or empty list if none found.
    """
    key = f"users/{user_id}/conversations/history.json"

    try:
        obj = _s3().get_object(Bucket=bucket, Key=key)
        history = json.loads(obj["Body"].read())
        messages = history.get("messages", [])
    except Exception:
        return []

    # Filter messages by session_id
    # Messages with no session_id match "default"
    return [
        msg for msg in messages
        if (msg.get("session_id") or "default") == session_id
    ]


def update_scan(user_id: str, scan_id: str, updates: dict, bucket: str) -> dict | None:
    """Update a scan record with new values."""
    scan = get_scan(user_id, scan_id, bucket)
    if not scan:
        return None

    scan.update(updates)
    scan["updated_at"] = datetime.utcnow().isoformat()

    key = f"users/{user_id}/scans/{scan_id}.json"
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(scan),
        ContentType="application/json"
    )
    return scan


app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.on_event("shutdown")
async def shutdown_event():
    """Flush any pending Langfuse traces on shutdown."""
    flush_langfuse()
    logger.info("Langfuse traces flushed on shutdown")


ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:8081",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8081",
    "https://fincore.one",
    "https://api.fincore.one",
    "https://maximum-uptown-boxing.ngrok-free.dev",
    "exp://localhost:8081",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
BUCKET = os.environ["FINCORE_S3_BUCKET"]


class ChatRequest(BaseModel):
    message: str
    scan_id: str | None = None  # Optional: ID of a recent product scan to discuss
    scan_data: dict | None = None  # Optional: scan details (product_name, estimated_price, etc.)
    session_id: str | None = None  # Optional: session ID for Langfuse tracing continuity


class ProfileRequest(BaseModel):
    name: str
    big_five: dict  # {"openness": 75, "conscientiousness": 60, "extraversion": 80, "agreeableness": 55, "neuroticism": 40}
    email: str | None = None
    auth_provider: str = "anonymous"  # values: "anonymous", "google", "apple", "microsoft"


class ProfileUpdateRequest(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    dob: str | None = None
    address: str | None = None
    occupation: str | None = None
    nationality: str | None = None
    auth_provider: str | None = None
    app_preferences: dict | None = None
    security_prefs: dict | None = None


# ─────────────────────────────────────────────────────────────────────────────
# Auth — provider identity verification -> server-issued session
# ─────────────────────────────────────────────────────────────────────────────

class ProviderAuthRequest(BaseModel):
    identity_token: str | None = None  # Apple identityToken / Google+Microsoft id_token
    authorization_code: str | None = None  # Apple only -- fallback when identity_token is absent


class ProviderAuthResponse(BaseModel):
    user_id: str
    # Absent when 2FA is on: the caller must clear the SMS challenge first.
    session_token: str | None = None
    requires_2fa: bool = False
    challenge_token: str | None = None
    phone_hint: str | None = None


class TwoFactorChallengeRequest(BaseModel):
    challenge_token: str
    code: str


# TEMP (2026-09-10): dev-only session bypass for local testing.
# Only active when ENVIRONMENT=development is set explicitly; there is no
# ENVIRONMENT variable in .env today, so the default is OFF. When off, the
# route returns 404 -- indistinguishable from not existing. Declared BEFORE
# /auth/{provider} so FastAPI matches it first.
DEV_AUTH_ENABLED = os.getenv("ENVIRONMENT", "").strip().lower() == "development"
DEV_TEST_USER_ID = "dev:local-tester"

if DEV_AUTH_ENABLED:
    logger.warning("ENVIRONMENT=development: /auth/dev session bypass is ENABLED. Never run production this way.")


def complete_login(user_id: str, provider: str) -> ProviderAuthResponse:
    """Issue a session, or an SMS challenge first when the user has 2FA on."""
    profile = get_profile(user_id, BUCKET) or {}
    phone = profile.get("2fa_phone")

    if not (profile.get("2fa_enabled") and phone):
        return ProviderAuthResponse(user_id=user_id, session_token=create_session_token(user_id, provider))

    try:
        issue_otp(user_id, profile, phone, BUCKET)
    except Exception:
        # Never fall back to issuing a session -- that would silently downgrade
        # 2FA to nothing whenever the SMS provider is having a bad day.
        logger.exception("Failed to send 2FA login code")
        raise HTTPException(status_code=502, detail="Could not send verification code")

    return ProviderAuthResponse(
        user_id=user_id,
        requires_2fa=True,
        challenge_token=create_challenge_token(user_id, provider),
        phone_hint=mask_phone(phone),
    )


@app.post("/auth/2fa/challenge", response_model=ProviderAuthResponse)
@limiter.limit("5/minute")
async def complete_2fa_challenge(request: Request, req: TwoFactorChallengeRequest):
    """Exchange a 2FA challenge token plus the SMS code for a real session."""
    user_id, provider = verify_challenge_token(req.challenge_token)

    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    consume_otp(user_id, profile, req.code, BUCKET)

    return ProviderAuthResponse(user_id=user_id, session_token=create_session_token(user_id, provider))


@app.post("/auth/dev", response_model=ProviderAuthResponse)
@limiter.limit("20/minute")
async def dev_auth(request: Request):
    """Mint a real signed session for a fixed test user without a provider token."""
    if not DEV_AUTH_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")
    return complete_login(DEV_TEST_USER_ID, "dev")


@app.post("/auth/{provider}", response_model=ProviderAuthResponse)
@limiter.limit("20/minute")
async def provider_auth(provider: str, request: Request, req: ProviderAuthRequest):
    """Verify a Sign-In-with-{Apple,Google,Microsoft} identity token and issue a session.

    user_id is derived entirely from the verified provider subject claim
    (`{provider}:{sub}`) -- the client never gets to choose it.
    """
    if provider == "apple":
        subject = verify_apple(req.identity_token, req.authorization_code)
    elif provider == "google":
        if not req.identity_token:
            raise HTTPException(status_code=400, detail="Missing identity_token")
        subject = verify_google_id_token(req.identity_token)
    elif provider == "microsoft":
        if not req.identity_token:
            raise HTTPException(status_code=400, detail="Missing identity_token")
        subject = verify_microsoft_id_token(req.identity_token)
    else:
        raise HTTPException(status_code=400, detail="Unknown provider")

    return complete_login(f"{provider}:{subject}", provider)


@app.get("/")
def health_check():
    return {"status": "ok"}


class SurveyAnswerItem(BaseModel):
    itemId: int
    facet: str
    domain: str
    reverse: bool
    rating: int


class SurveyRequest(BaseModel):
    name: str | None = None
    answers: list[SurveyAnswerItem]


@app.post("/score")
def submit_survey(req: SurveyRequest, user_id: str = Depends(get_current_user)):
    try:
        big_five = score_survey([a.model_dump() for a in req.answers])
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    # Merge: retaking the survey must not wipe contact details, photo or prefs.
    existing = get_profile(user_id, BUCKET) or {}
    profile = {**existing, "user_id": user_id, "big_five": big_five}
    if req.name:
        profile["name"] = req.name
    save_profile(user_id, profile, BUCKET)
    return {"big_five": big_five}


@app.post("/profile")
def upsert_profile(req: ProfileRequest, user_id: str = Depends(get_current_user)):
    existing = get_profile(user_id, BUCKET) or {}
    merged = {**existing, **req.model_dump(exclude_none=True), "user_id": user_id}
    save_profile(user_id, merged, BUCKET)
    return {"status": "ok"}


@app.patch("/profile")
def update_profile(req: ProfileUpdateRequest, user_id: str = Depends(get_current_user)):
    """Update specific profile fields without overwriting existing data."""
    existing = get_profile(user_id, BUCKET) or {}

    updates = req.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    merged = {**existing, **updates, "user_id": user_id}
    save_profile(user_id, merged, BUCKET)
    return {"status": "ok", "profile": merged}


class ProfilePhotoRequest(BaseModel):
    image_base64: str
    media_type: str = "image/jpeg"


@app.post("/profile/photo")
def upload_profile_photo(req: ProfilePhotoRequest, user_id: str = Depends(get_current_user)):
    """Upload a profile photo for the authenticated user."""
    import base64
    from datetime import datetime

    try:
        image_data = base64.b64decode(req.image_base64)
        extension = "jpg" if "jpeg" in req.media_type else req.media_type.split("/")[-1]
        key = f"users/{user_id}/profile-photo.{extension}"

        _s3().put_object(
            Bucket=BUCKET,
            Key=key,
            Body=image_data,
            ContentType=req.media_type,
        )

        photo_url = f"https://{BUCKET}.s3.amazonaws.com/{key}?t={int(datetime.utcnow().timestamp())}"

        existing = get_profile(user_id, BUCKET) or {}
        existing["photo_url"] = photo_url
        save_profile(user_id, existing, BUCKET)

        logger.info(f"Uploaded profile photo for user {user_id}")
        return {"status": "ok", "photo_url": photo_url}
    except Exception as e:
        logger.exception("Failed to upload profile photo")
        raise HTTPException(status_code=500, detail="Failed to upload photo")


@app.get("/profile")
def fetch_profile(user_id: str = Depends(get_current_user)):
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@app.get("/profile/insights")
async def get_insights(user_id: str = Depends(get_current_user)):
    """Generate personalised 'How Faith Will Help You' insights based on OCEAN scores."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    big_five = profile.get("big_five", {})
    if not big_five:
        raise HTTPException(status_code=400, detail="Complete the quiz first")

    # Generate insights using Claude
    insights = await generate_insights(big_five, profile.get("name", "User"))
    return {"insights": insights}


@app.get("/users/me")
def get_user(user_id: str = Depends(get_current_user)):
    """Return the full user object (profile + metadata)."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "user_id": user_id,
        "profile": profile,
        "metadata": {
            "auth_provider": profile.get("auth_provider", "anonymous"),
            "email": profile.get("email"),
        },
    }


@app.delete("/users/me")
def delete_user(user_id: str = Depends(get_current_user)):
    """Delete all user data from S3 (GDPR/App Store compliance).

    Deletes:
    - users/{user_id}/profile.json
    - users/{user_id}/scans/*
    - users/{user_id}/conversations/*
    - users/{user_id}/sessions.json
    - Any other objects under users/{user_id}/
    """
    prefix = f"users/{user_id}/"
    deleted_count = 0

    try:
        # List all objects with this prefix
        paginator = _s3().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            objects = page.get("Contents", [])
            if not objects:
                continue

            # Delete in batches of 1000 (S3 limit)
            delete_keys = [{"Key": obj["Key"]} for obj in objects]
            _s3().delete_objects(
                Bucket=BUCKET,
                Delete={"Objects": delete_keys}
            )
            deleted_count += len(delete_keys)

        logger.info(f"[GDPR] Deleted {deleted_count} objects for user {user_id}")

        if deleted_count == 0:
            raise HTTPException(status_code=404, detail="User not found")

        return {
            "status": "ok",
            "message": f"Account deleted. {deleted_count} objects removed.",
            "deleted_count": deleted_count,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed to delete user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to delete account")


@app.get("/users/scans")
def get_scans(limit: int = 10, user_id: str = Depends(get_current_user)):
    """Get recent scans for the authenticated user."""
    scans = get_user_scans(user_id, BUCKET, limit)
    return {"scans": scans, "count": len(scans)}


@app.get("/users/conversations")
def get_conversations(limit: int = 20, sessions: bool = False, user_id: str = Depends(get_current_user)):
    """Get conversation history for the authenticated user.

    Args:
        limit: Maximum number of messages to return (only used when sessions=False)
        sessions: If True, return grouped session summaries instead of flat messages

    Returns:
        If sessions=False (default): {"messages": [...], "count": N}
        If sessions=True: {"sessions": [...], "count": N}
    """
    if sessions:
        session_list = get_conversation_sessions(user_id, BUCKET)
        return {"sessions": session_list, "count": len(session_list)}

    messages = get_conversation_history(user_id, BUCKET, limit)
    return {"messages": messages, "count": len(messages)}


@app.get("/users/conversations/{session_id}")
def get_conversation_by_session(session_id: str, user_id: str = Depends(get_current_user)):
    """Get all messages for a specific conversation session.

    Args:
        session_id: The session ID (use "default" for messages without a session_id)

    Returns:
        {"messages": [...], "count": N, "session_id": "..."}
    """
    messages = get_session_messages(user_id, session_id, BUCKET)
    return {"messages": messages, "count": len(messages), "session_id": session_id}


class ScanUpdateRequest(BaseModel):
    estimated_price: float | None = None


@app.patch("/users/scans/{scan_id}")
def patch_scan(scan_id: str, req: ScanUpdateRequest, user_id: str = Depends(get_current_user)):
    """Update a scan record (e.g., user-corrected price)."""
    updates = req.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updated = update_scan(user_id, scan_id, updates, BUCKET)
    if not updated:
        raise HTTPException(status_code=404, detail="Scan not found")

    return {"status": "ok", "scan": updated}


@app.post("/chat")
@limiter.limit("30/minute")
async def chat(request: Request, req: ChatRequest, user_id: str = Depends(get_current_user)):
    # Load conversation history for THIS session only
    if req.session_id:
        conversation_history = await asyncio.to_thread(
            get_session_messages, user_id, req.session_id, BUCKET
        )
    else:
        # Fallback to old behavior if no session_id (shouldn't happen)
        conversation_history = await asyncio.to_thread(
            get_conversation_history, user_id, BUCKET, 20
        )

    # Build multimodal metadata from scan context
    scan_reference = None
    financial_metadata = None
    if req.scan_data:
        scan_reference = {
            "scan_id": req.scan_id,
            "product_name": req.scan_data.get("product_name"),
            "category": req.scan_data.get("category"),
        }
        # Extract financial metadata if present
        if req.scan_data.get("psychology_cost") or req.scan_data.get("estimated_price"):
            financial_metadata = {
                "psychology_cost": req.scan_data.get("psychology_cost"),
                "base_price": req.scan_data.get("estimated_price"),
                "overall_score": req.scan_data.get("overall_score"),
                "verdict": req.scan_data.get("verdict"),
            }

    # Save user message with multimodal context
    await asyncio.to_thread(
        save_message,
        user_id,
        req.message,
        "user",
        BUCKET,
        scan_reference=scan_reference,
        financial_metadata=financial_metadata,
        session_id=req.session_id,
    )

    # Shared state for saving partial responses on disconnect
    response_chunks: list[str] = []

    async def save_partial_response():
        """Save whatever was streamed so far."""
        if response_chunks:
            partial_message = "".join(response_chunks)
            await asyncio.to_thread(
                save_message,
                user_id,
                partial_message,
                "assistant",
                BUCKET,
                scan_reference=scan_reference,
                financial_metadata=financial_metadata,
                session_id=req.session_id,
            )

    async def generate():
        try:
            async for chunk in stream_coach_response(
                user_id,
                req.message,
                BUCKET,
                conversation_history,
                scan_id=req.scan_id,
                scan_data=req.scan_data,
                session_id=req.session_id,
            ):
                response_chunks.append(chunk)
                # JSON-encode the text so embedded newlines can't break the SSE
                # line format (each SSE event must fit on a single "data:" line).
                yield f"data: {json.dumps(chunk)}\n\n"

            # Save assistant response after streaming completes (with same scan context)
            assistant_message = "".join(response_chunks)
            if assistant_message:
                await asyncio.to_thread(
                    save_message,
                    user_id,
                    assistant_message,
                    "assistant",
                    BUCKET,
                    scan_reference=scan_reference,
                    financial_metadata=financial_metadata,
                    session_id=req.session_id,
                )

            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            # Client disconnected mid-stream - save partial response
            await save_partial_response()
            raise
        except GeneratorExit:
            # Generator closed - save partial response
            await save_partial_response()
            raise

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/analyze", response_model=AnalyzeResponse)
@limiter.limit("20/minute")
async def analyze(request: Request, req: AnalyzeRequest, user_id: str = Depends(get_current_user)):
    """Analyse a product image via AWS Bedrock and return a financial score."""
    # Generate scan_id upfront so we can pass it to tracing
    scan_id = str(uuid.uuid4())[:8]

    # Lookup user_name from profile if not provided (for Langfuse tracing)
    user_name = req.user_name
    if not user_name:
        try:
            profile = await asyncio.to_thread(get_profile, user_id, BUCKET)
            user_name = profile.get("name") if profile else None
        except Exception:
            pass  # Fallback to user_id in tracing

    try:
        # Bedrock vision takes several seconds. boto3 is synchronous, so calling
        # it directly from an async route parks the whole event loop -- every
        # other request (chat streams included) stalls until it returns. Hand it
        # to a worker thread so the loop keeps serving.
        result = await asyncio.to_thread(
            analyze_image,
            image_base64=req.image_base64,
            media_type=req.media_type,
            user_context=req.user_context,
            aws_region=os.getenv("AWS_REGION", "eu-west-2"),
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
            bedrock_model_id=os.getenv(
                "BEDROCK_IMAGE_MODEL_ID",
                "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
            ),
            user_id=user_id,
            user_name=user_name,
            scan_id=scan_id,
            session_id=req.session_id,
        )
        analysis = AnalysisResult(**result)

        # Save scan to S3
        key = f"users/{user_id}/scans/{scan_id}.json"
        from datetime import datetime
        scan_record = {
            "scan_id": scan_id,
            "timestamp": datetime.utcnow().isoformat(),
            "user_id": user_id,
            **result
        }
        try:
            await asyncio.to_thread(
                _s3().put_object,
                Bucket=BUCKET,
                Key=key,
                Body=json.dumps(scan_record),
                ContentType="application/json",
            )
            logger.info(f"Saved scan {scan_id} for user {user_id}")
        except Exception as e:
            logger.error(f"Failed to save scan to S3: {e}")

        return AnalyzeResponse(success=True, analysis=analysis, scan_id=scan_id)
    except Exception as exc:
        logger.exception("Image analysis failed")
        return AnalyzeResponse(success=False, error=str(exc))


TEXT_ANALYSIS_PROMPT = """You are a financial coach analysing a product that a user is considering purchasing.
The user has described the product as: "{product_description}"

Analyse this product from a financial perspective. Consider:
- What this product typically costs
- Whether it's a need vs want
- Value for money considerations
- Budget impact for an average person

Respond with a JSON object matching this exact schema:
{{
  "product_identified": "string - the product name/description",
  "product_name": "string - specific product name if identifiable",
  "product_brand": "string or null - brand if known",
  "product_category": "string - category like 'food', 'electronics', 'clothing', etc",
  "overall_score": "integer 0-100 - financial wisdom score (higher = better purchase)",
  "grade": "string - A/B/C/D/F grade",
  "verdict": "string - one sentence verdict on the purchase",
  "color": "string - 'green' (good), 'amber' (caution), or 'red' (bad)",
  "breakdown": {{
    "value_for_money": "integer 0-100",
    "necessity": "integer 0-100",
    "budget_impact": "integer 0-100"
  }},
  "recommendations": ["array of 2-3 actionable recommendations"],
  "financial_insight": "string - 2-3 sentences of financial wisdom about this purchase",
  "alternatives": ["array of 1-2 cheaper or better alternatives"],
  "estimated_price": "float or null - estimated price in GBP"
}}

Use British English. Be practical and helpful, not preachy."""


@app.post("/analyze-text", response_model=AnalyzeResponse)
@limiter.limit("20/minute")
async def analyze_text(request: Request, req: AnalyzeTextRequest, user_id: str = Depends(get_current_user)):
    """Analyse a product from text description (no image required)."""
    scan_id = str(uuid.uuid4())[:8]

    user_name = req.user_name
    if not user_name:
        try:
            profile = await asyncio.to_thread(get_profile, user_id, BUCKET)
            user_name = profile.get("name") if profile else None
        except Exception:
            pass

    try:
        import boto3

        bedrock = boto3.client(
            "bedrock-runtime",
            region_name=os.getenv("AWS_REGION", "eu-west-2"),
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        )

        prompt = TEXT_ANALYSIS_PROMPT.format(product_description=req.product_description)

        # Same as /analyze: synchronous boto3 call, run it off the event loop.
        response = await asyncio.to_thread(
            bedrock.invoke_model,
            modelId=os.getenv("BEDROCK_TEXT_MODEL_ID", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            contentType="application/json",
            accept="application/json",
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            }),
        )

        response_body = json.loads(await asyncio.to_thread(response["body"].read))
        content = response_body["content"][0]["text"]

        # Parse JSON from response (handle markdown code blocks)
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]

        result = json.loads(content.strip())
        analysis = AnalysisResult(**result)

        # Save scan to S3
        key = f"users/{user_id}/scans/{scan_id}.json"
        from datetime import datetime
        scan_record = {
            "scan_id": scan_id,
            "timestamp": datetime.utcnow().isoformat(),
            "user_id": user_id,
            "source": "text",
            **result,
        }
        try:
            await asyncio.to_thread(
                _s3().put_object,
                Bucket=BUCKET,
                Key=key,
                Body=json.dumps(scan_record),
                ContentType="application/json",
            )
            logger.info(f"Saved text scan {scan_id} for user {user_id}")
        except Exception as e:
            logger.error(f"Failed to save text scan to S3: {e}")

        return AnalyzeResponse(success=True, analysis=analysis, scan_id=scan_id)
    except Exception as exc:
        logger.exception("Text analysis failed")
        return AnalyzeResponse(success=False, error=str(exc))


@app.post("/price-check", response_model=PriceCheckResponse)
async def price_check(req: PriceCheckRequest):
    """Look up supermarket prices for a product barcode."""
    try:
        prices = await price_matcher.fetch_supermarket_prices(req.barcode)
    except ValueError as exc:
        return PriceCheckResponse(success=False, barcode=req.barcode, error=str(exc))
    except Exception as exc:
        logger.exception("Price check failed")
        return PriceCheckResponse(success=False, barcode=req.barcode, error="Unexpected error during price lookup")

    if not prices:
        return PriceCheckResponse(
            success=True,
            barcode=req.barcode,
            prices=[],
            error="No prices found for this barcode",
        )

    store_prices = [StorePrice(**p) for p in prices]
    cheapest = store_prices[0]
    return PriceCheckResponse(
        success=True,
        barcode=req.barcode,
        cheapest_store=cheapest.store,
        cheapest_price=cheapest.price,
        prices=store_prices,
    )


class PsychologyCostRequest(BaseModel):
    base_price: float


@app.post("/psychology-cost")
async def get_psychology_cost(req: PsychologyCostRequest, user_id: str = Depends(get_current_user)):
    profile = await asyncio.to_thread(get_profile, user_id, BUCKET)
    if not profile or not profile.get("big_five"):
        raise HTTPException(status_code=400, detail="Complete quiz first")

    result = calculate_psychology_cost(req.base_price, profile["big_five"])
    return result


class EmotionalTaxBreakdown(BaseModel):
    scan_id: str
    timestamp: str
    base_price: float
    psychology_cost: float
    emotional_tax: float
    product_name: str | None = None


class EmotionalTaxResponse(BaseModel):
    total_tax: float
    scan_count: int
    breakdown: list[EmotionalTaxBreakdown]


@app.get("/users/emotional-tax", response_model=EmotionalTaxResponse)
def get_emotional_tax(limit: int = 5, user_id: str = Depends(get_current_user)):
    """Calculate the total emotional/personality tax paid across recent scans."""
    profile = get_profile(user_id, BUCKET)
    if not profile or not profile.get("big_five"):
        raise HTTPException(status_code=400, detail="Complete quiz first")

    scans = get_user_scans(user_id, BUCKET, limit=limit)

    breakdown = []
    total_tax = 0.0

    for scan in scans:
        base_price = scan.get("estimated_price") or scan.get("base_price")
        if base_price is None:
            continue

        # Calculate psychology cost using the math_utils logic
        result = calculate_psychology_cost(base_price, profile["big_five"])
        psychology_cost = result["psychology_cost"]
        emotional_tax = psychology_cost - base_price

        total_tax += emotional_tax
        breakdown.append(EmotionalTaxBreakdown(
            scan_id=scan.get("scan_id", "unknown"),
            timestamp=scan.get("timestamp", ""),
            base_price=base_price,
            psychology_cost=psychology_cost,
            emotional_tax=round(emotional_tax, 2),
            product_name=scan.get("product_name"),
        ))

    return EmotionalTaxResponse(
        total_tax=round(total_tax, 2),
        scan_count=len(breakdown),
        breakdown=breakdown,
    )


class UploadScanImageRequest(BaseModel):
    image_base64: str  # Base64-encoded image data (without data URI prefix)
    scan_id: str


class UploadScanImageResponse(BaseModel):
    success: bool
    s3_url: str | None = None
    error: str | None = None


@app.post("/upload-scan-image", response_model=UploadScanImageResponse)
async def upload_scan_image(req: UploadScanImageRequest, user_id: str = Depends(get_current_user)):
    """Upload a scan image to S3 at users/{user_id}/scans/{scan_id}/original.jpg."""
    try:
        # Decode base64 image
        try:
            image_bytes = base64.b64decode(req.image_base64)
        except Exception:
            return UploadScanImageResponse(
                success=False,
                error="Invalid base64 image data"
            )

        # Construct S3 key
        s3_key = f"users/{user_id}/scans/{req.scan_id}/original.jpg"

        # Upload to S3 (off the event loop -- this is a photo, not a few bytes)
        await asyncio.to_thread(
            _s3().put_object,
            Bucket=BUCKET,
            Key=s3_key,
            Body=image_bytes,
            ContentType="image/jpeg",
        )

        # Construct the S3 URL
        region = os.getenv("AWS_REGION", "us-east-1")
        s3_url = f"https://{BUCKET}.s3.{region}.amazonaws.com/{s3_key}"

        # Optionally update the scan record with the image URL
        scan = await asyncio.to_thread(get_scan, user_id, req.scan_id, BUCKET)
        if scan:
            await asyncio.to_thread(update_scan, user_id, req.scan_id, {"image_url": s3_url}, BUCKET)

        return UploadScanImageResponse(success=True, s3_url=s3_url)

    except Exception as exc:
        logger.exception("Failed to upload scan image")
        return UploadScanImageResponse(
            success=False,
            error=f"Upload failed: {str(exc)}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Waitlist Endpoint
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# Security & Authentication Endpoints
# ─────────────────────────────────────────────────────────────────────────────

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@app.post("/change-password")
async def change_password(req: ChangePasswordRequest, user_id: str = Depends(get_current_user)):
    """Change user password (placeholder - integrate with your auth provider)."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    current_hash = profile.get("password_hash")

    if current_hash:
        if not bcrypt.checkpw(req.current_password.encode(), current_hash.encode()):
            raise HTTPException(status_code=401, detail="Current password is incorrect")

    new_hash = bcrypt.hashpw(req.new_password.encode(), bcrypt.gensalt()).decode()
    profile["password_hash"] = new_hash
    save_profile(user_id, profile, BUCKET)

    return {"status": "ok"}


class TwoFactorSendRequest(BaseModel):
    # Optional: falls back to the phone captured at signup.
    phone_number: str | None = None


@app.post("/2fa/send-code")
@limiter.limit("3/minute")
async def send_2fa_code(request: Request, req: TwoFactorSendRequest, user_id: str = Depends(get_current_user)):
    """Send a 2FA enrolment code over SMS via AWS End User Messaging."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    phone = (req.phone_number or profile.get("phone") or "").strip()
    if not phone:
        raise HTTPException(status_code=400, detail="No phone number on file")

    # Held as pending until the code is verified. Committing it here would let
    # an abandoned or failed re-enrolment repoint an already-working 2FA setup
    # at an unreachable number, locking the user out at next sign-in.
    profile["2fa_phone_pending"] = phone

    try:
        issue_otp(user_id, profile, phone, BUCKET)
    except Exception:
        logger.exception("Failed to send 2FA SMS")
        raise HTTPException(status_code=502, detail="Could not send verification code")

    logger.info(f"[2FA] Enrolment code sent for {user_id}")

    return {"status": "ok", "message": "Code sent"}


class TwoFactorVerifyRequest(BaseModel):
    code: str


@app.post("/2fa/verify")
@limiter.limit("5/minute")
async def verify_2fa_code(request: Request, req: TwoFactorVerifyRequest, user_id: str = Depends(get_current_user)):
    """Verify a 2FA code and enable 2FA for the user."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    consume_otp(user_id, profile, req.code, BUCKET)

    pending = profile.pop("2fa_phone_pending", None)
    if pending:
        profile["2fa_phone"] = pending

    profile["2fa_enabled"] = True
    save_profile(user_id, profile, BUCKET)

    return {"status": "ok"}


@app.post("/2fa/disable")
async def disable_2fa(user_id: str = Depends(get_current_user)):
    """Disable 2FA for the authenticated user."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    profile["2fa_enabled"] = False
    profile.pop("2fa_phone", None)
    save_profile(user_id, profile, BUCKET)

    return {"status": "ok"}


# ─────────────────────────────────────────────────────────────────────────────
# Session Management
# ─────────────────────────────────────────────────────────────────────────────

def get_user_sessions(user_id: str, bucket: str) -> list:
    """Get all active sessions for a user."""
    key = f"users/{user_id}/sessions.json"
    try:
        obj = _s3().get_object(Bucket=bucket, Key=key)
        data = json.loads(obj["Body"].read())
        return data.get("sessions", [])
    except Exception:
        return []


def save_user_sessions(user_id: str, sessions: list, bucket: str):
    """Save sessions for a user."""
    key = f"users/{user_id}/sessions.json"
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps({"sessions": sessions}),
        ContentType="application/json"
    )


@app.get("/users/sessions")
def get_sessions(user_id: str = Depends(get_current_user)):
    """Get all active sessions for the authenticated user."""
    sessions = get_user_sessions(user_id, BUCKET)

    # If no sessions exist, create a default "current" session
    if not sessions:
        sessions = [{
            "session_id": str(uuid.uuid4())[:8],
            "device_name": "This device",
            "last_active": datetime.utcnow().isoformat(),
            "is_current": True,
        }]
        save_user_sessions(user_id, sessions, BUCKET)

    return {"sessions": sessions}


@app.post("/users/sessions/{session_id}/revoke")
def revoke_session(session_id: str, user_id: str = Depends(get_current_user)):
    """Revoke a specific session."""
    sessions = get_user_sessions(user_id, BUCKET)
    sessions = [s for s in sessions if s.get("session_id") != session_id]
    save_user_sessions(user_id, sessions, BUCKET)
    return {"status": "ok"}


# ─────────────────────────────────────────────────────────────────────────────
# Data Export (GDPR)
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/users/data-export")
async def request_data_export(user_id: str = Depends(get_current_user)):
    """Request a data export for GDPR compliance."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    # Record the export request
    export_request = {
        "user_id": user_id,
        "requested_at": datetime.utcnow().isoformat(),
        "status": "pending",
        "email": profile.get("email"),
    }

    # Store in exports queue
    key = f"exports/{user_id}/{datetime.utcnow().strftime('%Y%m%d%H%M%S')}.json"
    _s3().put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(export_request),
        ContentType="application/json"
    )

    # TODO: Trigger async export job (Lambda, SQS, etc.)
    logger.info(f"[GDPR] Data export requested for user {user_id}")

    return {"status": "ok", "message": "Export requested"}


# ─────────────────────────────────────────────────────────────────────────────
# Push Notifications
# ─────────────────────────────────────────────────────────────────────────────

class PushTokenRequest(BaseModel):
    push_token: str
    platform: str  # 'ios' or 'android'
    device_name: str | None = None


@app.post("/users/push-token")
async def register_push_token(req: PushTokenRequest, user_id: str = Depends(get_current_user)):
    """Register a device push token for the authenticated user."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        profile = {"user_id": user_id}

    # Store push tokens as a list (user may have multiple devices)
    push_tokens = profile.get("push_tokens", [])

    # Remove existing token for this device (avoid duplicates)
    push_tokens = [t for t in push_tokens if t.get("token") != req.push_token]

    # Add new token
    push_tokens.append({
        "token": req.push_token,
        "platform": req.platform,
        "device_name": req.device_name,
        "registered_at": datetime.utcnow().isoformat(),
    })

    profile["push_tokens"] = push_tokens
    save_profile(user_id, profile, BUCKET)

    logger.info(f"[Push] Registered token for user {user_id} on {req.platform}")
    return {"status": "ok"}


class NotificationPrefsRequest(BaseModel):
    prefs: dict


@app.post("/users/notification-prefs")
async def save_notification_prefs(req: NotificationPrefsRequest, user_id: str = Depends(get_current_user)):
    """Save notification preferences for the authenticated user."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        profile = {"user_id": user_id}

    profile["notification_prefs"] = req.prefs
    save_profile(user_id, profile, BUCKET)

    return {"status": "ok"}


@app.get("/users/notification-prefs")
def get_notification_prefs(user_id: str = Depends(get_current_user)):
    """Get notification preferences for the authenticated user."""
    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    return {"prefs": profile.get("notification_prefs", {})}


class SendNotificationRequest(BaseModel):
    title: str
    body: str
    data: dict | None = None


@app.post("/users/send-notification")
async def send_push_notification(req: SendNotificationRequest, user_id: str = Depends(get_current_user)):
    """Send a push notification to the authenticated user's own devices via Expo Push Service."""
    import httpx

    profile = get_profile(user_id, BUCKET)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    push_tokens = profile.get("push_tokens", [])
    if not push_tokens:
        raise HTTPException(status_code=400, detail="No push tokens registered")

    # Check if user has notifications enabled
    notification_prefs = profile.get("notification_prefs", {})
    if not notification_prefs.get("pushNotifications", True):
        return {"status": "skipped", "reason": "User has disabled push notifications"}

    # Build Expo push messages
    messages = []
    for token_info in push_tokens:
        token = token_info.get("token")
        if token and token.startswith("ExponentPushToken"):
            messages.append({
                "to": token,
                "title": req.title,
                "body": req.body,
                "data": req.data or {},
                "sound": "default",
                "priority": "high",
            })

    if not messages:
        return {"status": "skipped", "reason": "No valid Expo push tokens"}

    # Send to Expo Push API
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://exp.host/--/api/v2/push/send",
                json=messages,
                headers={"Content-Type": "application/json"},
            )
            result = response.json()
            logger.info(f"[Push] Sent notification to {user_id}: {result}")
            return {"status": "ok", "result": result}
    except Exception as e:
        logger.error(f"[Push] Failed to send notification: {e}")
        raise HTTPException(status_code=500, detail="Failed to send notification")


class BroadcastNotificationRequest(BaseModel):
    title: str
    body: str
    data: dict | None = None
    filter_pref: str | None = None  # e.g., "appUpdates" to only send to users with this enabled


@app.post("/admin/broadcast-notification")
async def broadcast_notification(
    req: BroadcastNotificationRequest,
    x_admin_key: str = Header(..., alias="X-Admin-Key"),
):
    """Broadcast a notification to all users (admin endpoint)."""
    import httpx

    admin_key = os.getenv("FINCORE_ADMIN_KEY")
    if not admin_key or x_admin_key != admin_key:
        raise HTTPException(status_code=401, detail="Invalid admin key")

    # List all user profiles
    try:
        response = _s3().list_objects_v2(
            Bucket=BUCKET,
            Prefix="users/",
            MaxKeys=1000
        )
    except Exception as e:
        logger.exception("Failed to list users for broadcast")
        raise HTTPException(status_code=500, detail="Failed to send broadcast")

    messages = []
    user_count = 0

    for obj in response.get("Contents", []):
        key = obj["Key"]
        if not key.endswith("/profile.json"):
            continue

        try:
            profile_obj = _s3().get_object(Bucket=BUCKET, Key=key)
            profile = json.loads(profile_obj["Body"].read())
        except Exception:
            continue

        # Check notification preferences
        notification_prefs = profile.get("notification_prefs", {})
        if not notification_prefs.get("pushNotifications", True):
            continue

        if req.filter_pref and not notification_prefs.get(req.filter_pref, False):
            continue

        # Get push tokens
        for token_info in profile.get("push_tokens", []):
            token = token_info.get("token")
            if token and token.startswith("ExponentPushToken"):
                messages.append({
                    "to": token,
                    "title": req.title,
                    "body": req.body,
                    "data": req.data or {},
                    "sound": "default",
                })
                user_count += 1

    if not messages:
        return {"status": "ok", "sent_to": 0}

    # Send in batches of 100 (Expo limit)
    try:
        async with httpx.AsyncClient() as client:
            for i in range(0, len(messages), 100):
                batch = messages[i:i+100]
                await client.post(
                    "https://exp.host/--/api/v2/push/send",
                    json=batch,
                    headers={"Content-Type": "application/json"},
                )

        logger.info(f"[Push] Broadcast sent to {user_count} devices")
        return {"status": "ok", "sent_to": user_count}
    except Exception as e:
        logger.error(f"[Push] Broadcast failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to send broadcast")


# ─────────────────────────────────────────────────────────────────────────────
# Waitlist
# ─────────────────────────────────────────────────────────────────────────────

class WaitlistRequest(BaseModel):
    email: str
    feature: str  # 'banking' or 'analytics'


class WaitlistResponse(BaseModel):
    success: bool
    message: str | None = None


@app.post("/waitlist", response_model=WaitlistResponse)
async def add_to_waitlist(req: WaitlistRequest):
    """
    Add an email to the feature waitlist.
    Stores in S3 at users/global/waitlist.json as a JSON array.

    Schema:
    {
      "entries": [
        {
          "email": "user@example.com",
          "feature": "banking",
          "timestamp": "2026-05-08T22:30:00Z"
        }
      ]
    }
    """
    try:
        s3_key = "users/global/waitlist.json"

        # Load existing waitlist or create new
        try:
            response = _s3().get_object(Bucket=BUCKET, Key=s3_key)
            waitlist = json.loads(response["Body"].read().decode("utf-8"))
        except _s3().exceptions.NoSuchKey:
            waitlist = {"entries": []}
        except Exception:
            waitlist = {"entries": []}

        # Check for duplicate
        existing = any(
            e["email"] == req.email and e["feature"] == req.feature
            for e in waitlist["entries"]
        )
        if existing:
            return WaitlistResponse(success=True, message="Already on waitlist")

        # Add new entry
        waitlist["entries"].append({
            "email": req.email,
            "feature": req.feature,
            "timestamp": datetime.utcnow().isoformat() + "Z"
        })

        # Save back to S3
        _s3().put_object(
            Bucket=BUCKET,
            Key=s3_key,
            Body=json.dumps(waitlist, indent=2),
            ContentType="application/json"
        )

        logger.info(f"[waitlist] Added {req.email} for {req.feature}")
        return WaitlistResponse(success=True, message="Added to waitlist")

    except Exception as exc:
        logger.exception("Failed to add to waitlist")
        raise HTTPException(status_code=500, detail=str(exc))
