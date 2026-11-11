from datetime import datetime, timedelta, timezone
from typing import Any

import mongomock
import pytest
from interface_personal_whats import InvalidPasswordError, crypto, main, schemas

import validator

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
RETENTION_DAYS = 30


@pytest.fixture(scope="module")
def key() -> bytes:
    return crypto.derive_key("senha-de-teste")


@pytest.fixture
def database() -> Any:
    return mongomock.MongoClient(tz_aware=True)["personal_whats"]


def insert_message(database: Any, key: bytes, plaintext: bytes, **fields: Any) -> Any:
    encrypted_data = crypto.encrypt(key, plaintext)
    document = {**main.build_message_document("vagas", encrypted_data, now=NOW), **fields}
    return database[main.MESSAGES_COLLECTION].insert_one(document).inserted_id


def valid_plaintext(text: str = "oi") -> bytes:
    return schemas.MessagePayload(text=text).model_dump_json().encode()


def validate(database: Any, key: bytes) -> dict[Any, Any]:
    validator.validate_received_messages(
        database[main.MESSAGES_COLLECTION], key, RETENTION_DAYS, now=NOW
    )
    return {message["_id"]: message for message in database[main.MESSAGES_COLLECTION].find()}


def test_valid_message_is_validated(database: Any, key: bytes) -> None:
    message_id = insert_message(database, key, valid_plaintext())

    message = validate(database, key)[message_id]

    assert message["status"] == "validated"
    assert message["next_attempt_at"] == NOW
    assert "expires_at" not in message


def test_message_with_other_password_is_rejected(database: Any, key: bytes) -> None:
    message_id = insert_message(database, crypto.derive_key("outra"), valid_plaintext())

    message = validate(database, key)[message_id]

    assert (message["status"], message["error"]) == ("rejected", "Senha de criptografia inválida")
    assert message["expires_at"] == NOW + timedelta(days=RETENTION_DAYS)


def test_message_breaking_the_contract_is_rejected(database: Any, key: bytes) -> None:
    message_id = insert_message(database, key, b'{"text": null, "recipient": "123"}')

    message = validate(database, key)[message_id]

    assert message["status"] == "rejected"
    assert message["error"].startswith("Conteúdo inválido: recipient:")


@pytest.mark.parametrize(
    ("fields", "error"),
    [
        ({"encryption_version": 2}, "Versão de criptografia não suportada: 2"),
        ({"source": "Fonte Inválida"}, "Source inválido: 'Fonte Inválida'"),
    ],
)
def test_message_with_invalid_public_fields_is_rejected(
    database: Any, key: bytes, fields: dict[str, Any], error: str
) -> None:
    message_id = insert_message(database, key, valid_plaintext(), **fields)

    assert validate(database, key)[message_id]["error"] == error


def test_only_received_messages_are_processed(database: Any, key: bytes) -> None:
    message_id = insert_message(
        database, crypto.derive_key("outra"), valid_plaintext(), status="sent"
    )

    assert validate(database, key)[message_id]["status"] == "sent"


def test_ensure_key_check_creates_and_then_verifies(database: Any, key: bytes) -> None:
    settings = database[main.SETTINGS_COLLECTION]

    validator.ensure_key_check(settings, key)
    validator.ensure_key_check(settings, key)

    assert settings.count_documents({}) == 1
    with pytest.raises(InvalidPasswordError):
        validator.ensure_key_check(settings, crypto.derive_key("outra"))
