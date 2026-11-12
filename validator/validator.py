"""Checks every message inserted by the interface before it can reach WhatsApp.

A `received` message becomes `validated` only when it decrypts with the configured password
and its content follows the interface contract; otherwise it becomes `rejected` and the
WhatsApp container never sees it. On startup it also writes the key check the interface uses
to reject a wrong password before inserting anything.
"""

import logging
import os
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from interface_personal_whats import InvalidPasswordError, crypto, main, schemas
from pydantic import ValidationError
from pymongo import ASCENDING, MongoClient
from pymongo.collection import Collection

log = logging.getLogger("validator")

Document = dict[str, Any]

BATCH_SIZE = 50
MAX_ERROR_LENGTH = 500


def ensure_key_check(settings: Collection[Document], key: bytes) -> None:
    """Creates the key check, or makes sure the configured password matches the existing one."""
    key_check = main.read_key_check(settings)
    if key_check is None:
        new_key_check = crypto.build_key_check(key)
        settings.insert_one(
            {
                "_id": main.KEY_CHECK_ID,
                "nonce": new_key_check.nonce,
                "ciphertext": new_key_check.ciphertext,
                "created_at": datetime.now(timezone.utc),
            }
        )
        log.info("Key check created")
        return
    crypto.verify_key_check(key, key_check)


def ensure_indexes(messages: Collection[Document]) -> None:
    messages.create_index([("status", ASCENDING), ("created_at", ASCENDING)])
    messages.create_index([("status", ASCENDING), ("next_attempt_at", ASCENDING)])
    messages.create_index([("source", ASCENDING), ("created_at", ASCENDING)])
    messages.create_index("expires_at", expireAfterSeconds=0)


def ensure_watch_indexes(watches: Collection[Document], incoming: Collection[Document]) -> None:
    """Chat watches and the commands they received (interface watch_chat / read_new_messages)."""
    watches.create_index([("source", ASCENDING), ("stopped_at", ASCENDING)])
    watches.create_index("expires_at", expireAfterSeconds=0)
    incoming.create_index(
        [("watch_id", ASCENDING), ("whatsapp_message_id", ASCENDING)], unique=True
    )
    incoming.create_index(
        [("watch_id", ASCENDING), ("read_at", ASCENDING), ("received_at", ASCENDING)]
    )
    incoming.create_index("expires_at", expireAfterSeconds=0)


def summarize_validation_error(error: ValidationError) -> str:
    problems = [
        f"{'.'.join(str(location) for location in problem['loc']) or 'mensagem'}: {problem['msg']}"
        for problem in error.errors()
    ]
    return "Conteúdo inválido: " + "; ".join(problems)


def find_rejection_reason(key: bytes, message: Document) -> Optional[str]:
    if message.get("encryption_version") != crypto.ENCRYPTION_VERSION:
        return f"Versão de criptografia não suportada: {message.get('encryption_version')}"
    try:
        schemas.MessageSource(source=message.get("source"))
    except ValidationError:
        return f"Source inválido: {message.get('source')!r}"
    try:
        main.decrypt_payload(key, message)
    except InvalidPasswordError:
        return "Senha de criptografia inválida"
    except ValidationError as error:
        return summarize_validation_error(error)
    except (KeyError, TypeError, ValueError) as error:
        return f"Documento malformado: {error}"
    return None


def validate_received_messages(
    messages: Collection[Document],
    key: bytes,
    retention_days: int,
    now: Optional[datetime] = None,
) -> int:
    """Validates the oldest received messages and returns how many were processed."""
    now = now or datetime.now(timezone.utc)
    received_messages = list(
        messages.find({"status": schemas.MessageStatus.RECEIVED.value})
        .sort("created_at", ASCENDING)
        .limit(BATCH_SIZE)
    )
    for message in received_messages:
        rejection_reason = find_rejection_reason(key, message)
        if rejection_reason is None:
            changes: Document = {
                "status": schemas.MessageStatus.VALIDATED.value,
                "validated_at": now,
                "next_attempt_at": now,
                "error": None,
            }
            log.info(f"Message {message['_id']} from {message.get('source')} validated")
        else:
            changes = {
                "status": schemas.MessageStatus.REJECTED.value,
                "error": rejection_reason[:MAX_ERROR_LENGTH],
                "expires_at": now + timedelta(days=retention_days),
            }
            log.warning(f"Message {message['_id']} rejected: {rejection_reason}")
        messages.update_one(
            {"_id": message["_id"], "status": schemas.MessageStatus.RECEIVED.value},
            {"$set": {**changes, "updated_at": now}},
        )
    return len(received_messages)


def run() -> None:
    logging.basicConfig(
        level=logging.INFO, format="[validator %(asctime)s] %(levelname)s %(message)s"
    )
    mongo_uri = os.environ["MONGO_URI"]
    encryption_password = os.environ["ENCRYPTION_PASSWORD"]
    database_name = os.environ.get("MONGO_DATABASE") or main.DEFAULT_DATABASE_NAME
    poll_interval_seconds = float(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
    retention_days = int(os.environ.get("MESSAGE_RETENTION_DAYS", "30"))

    is_running = True

    def stop(signal_number: int, frame: Any) -> None:
        nonlocal is_running
        is_running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    key = crypto.derive_key(encryption_password)
    client: MongoClient[Document] = MongoClient(
        mongo_uri, serverSelectionTimeoutMS=15_000, tz_aware=True
    )
    database = client[database_name]
    messages = database[main.MESSAGES_COLLECTION]
    try:
        ensure_key_check(database[main.SETTINGS_COLLECTION], key)
    except InvalidPasswordError:
        log.critical(
            "ENCRYPTION_PASSWORD does not match the key check stored in MongoDB. If the password "
            f"was changed on purpose, delete {database_name}.{main.SETTINGS_COLLECTION} "
            f"{main.KEY_CHECK_ID!r}; messages encrypted with the old password will be rejected."
        )
        sys.exit(1)
    ensure_indexes(messages)
    ensure_watch_indexes(database[main.WATCHES_COLLECTION], database[main.INCOMING_COLLECTION])
    log.info(f"Validating messages from {database_name} every {poll_interval_seconds}s")

    while is_running:
        try:
            processed = validate_received_messages(messages, key, retention_days)
        except Exception:
            log.exception("Failed to validate messages, trying again")
            processed = 0
        if processed < BATCH_SIZE:
            time.sleep(poll_interval_seconds)

    client.close()
    log.info("Stopped")


if __name__ == "__main__":
    run()
