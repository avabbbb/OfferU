from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Annotated, Any, Literal, TypeAlias, Union, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StrictBool,
    StrictInt,
    StrictStr,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from .errors import (
    ERROR_CODES,
    ERROR_CODE_RETRYABILITY,
    BridgeProtocolError,
    ErrorCode,
)


PROTOCOL_VERSION = 1
BRIDGE_VERSION = "0.1.0"

KNOWN_MESSAGE_TYPES = (
    "hello",
    "pairing.request",
    "pairing.status",
    "run.attach",
    "run.lease.renew",
    "context.snapshot",
    "skill.snapshot",
    "operation.list",
    "operation.schema",
    "operation.invoke",
    "proposal.get",
    "event.append",
    "event.follow",
    "run.finish",
)
RUN_FORBIDDEN_MESSAGE_TYPES = (
    "hello",
    "pairing.request",
    "pairing.status",
)
RUN_REQUIRED_MESSAGE_TYPES = tuple(
    message_type
    for message_type in KNOWN_MESSAGE_TYPES
    if message_type not in RUN_FORBIDDEN_MESSAGE_TYPES
)
STANDARD_EVENT_TYPES = (
    "run.attached",
    "run.resumed",
    "run.interrupt_requested",
    "run.finished",
    "agent.message.delta",
    "agent.message.completed",
    "operation.started",
    "operation.proposed",
    "operation.completed",
    "operation.failed",
    "approval.requested",
    "approval.decided",
    "artifact.declared",
    "artifact.accepted",
    "artifact.rejected",
    "executor.started",
    "executor.progress",
    "executor.finished",
    "control.followup",
)

RequestId: TypeAlias = Annotated[
    StrictStr,
    Field(min_length=1, max_length=200, pattern=r"^\S+$"),
]
Identifier: TypeAlias = Annotated[
    StrictStr,
    Field(min_length=1, max_length=200, pattern=r"^\S+$"),
]
NonEmptyString: TypeAlias = Annotated[
    StrictStr,
    Field(min_length=1, max_length=1000),
]
NonNegativeInt: TypeAlias = Annotated[StrictInt, Field(ge=0)]
PositiveInt: TypeAlias = Annotated[StrictInt, Field(gt=0)]
JsonObject: TypeAlias = dict[str, JsonValue]

RequestMessageType: TypeAlias = Literal[
    "hello",
    "pairing.request",
    "pairing.status",
    "run.attach",
    "run.lease.renew",
    "context.snapshot",
    "skill.snapshot",
    "operation.list",
    "operation.schema",
    "operation.invoke",
    "proposal.get",
    "event.append",
    "event.follow",
    "run.finish",
]
StandardEventType: TypeAlias = Literal[
    "run.attached",
    "run.resumed",
    "run.interrupt_requested",
    "run.finished",
    "agent.message.delta",
    "agent.message.completed",
    "operation.started",
    "operation.proposed",
    "operation.completed",
    "operation.failed",
    "approval.requested",
    "approval.decided",
    "artifact.declared",
    "artifact.accepted",
    "artifact.rejected",
    "executor.started",
    "executor.progress",
    "executor.finished",
    "control.followup",
]


class _StrictPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EmptyPayload(_StrictPayload):
    pass


class AdapterIdentity(_StrictPayload):
    name: Identifier
    version: NonEmptyString


class HarnessIdentity(_StrictPayload):
    name: Identifier
    version: NonEmptyString
    profile: NonEmptyString | None = None
    preset: NonEmptyString | None = None
    composition_hash: NonEmptyString | None = Field(
        default=None,
        alias="compositionHash",
    )


class HarnessCapabilities(_StrictPayload):
    session_resume: StrictBool = Field(alias="sessionResume")
    steer: StrictBool
    interrupt: StrictBool
    tool_suspend_resume: StrictBool = Field(alias="toolSuspendResume")
    event_stream: StrictBool = Field(alias="eventStream")
    workspace_isolation: NonEmptyString = Field(alias="workspaceIsolation")
    native_client: StrictBool = Field(alias="nativeClient")


class HelloPayload(_StrictPayload):
    adapter: AdapterIdentity
    harness: HarnessIdentity
    protocols: list[PositiveInt] = Field(min_length=1)
    capabilities: HarnessCapabilities


class PairingRequestPayload(_StrictPayload):
    bootstrap_token: NonEmptyString | None = Field(
        default=None,
        alias="bootstrapToken",
    )
    cwd_fingerprint: NonEmptyString | None = Field(
        default=None,
        alias="cwdFingerprint",
    )


class PairingStatusPayload(_StrictPayload):
    pairing_id: Identifier | None = Field(default=None, alias="pairingId")


class RunAttachPayload(_StrictPayload):
    harness: HarnessIdentity
    adapter: AdapterIdentity
    harness_session_id: Identifier | None = Field(
        default=None,
        alias="harnessSessionId",
    )
    bootstrap_token: NonEmptyString | None = Field(
        default=None,
        alias="bootstrapToken",
    )
    pairing_id: Identifier | None = Field(default=None, alias="pairingId")
    lease_id: Identifier | None = Field(default=None, alias="leaseId")
    last_event_seq: NonNegativeInt = Field(default=0, alias="lastEventSeq")


class RunLeaseRenewPayload(_StrictPayload):
    lease_id: Identifier | None = Field(default=None, alias="leaseId")


class ContextSnapshotPayload(_StrictPayload):
    context_version: NonNegativeInt | None = Field(
        default=None,
        alias="contextVersion",
    )


class OperationSchemaPayload(_StrictPayload):
    operation: Identifier


class OperationInvokePayload(_StrictPayload):
    operation: Identifier
    arguments: JsonObject
    idempotency_key: Identifier = Field(alias="idempotencyKey")
    context_version: NonNegativeInt = Field(alias="contextVersion")


class ProposalGetPayload(_StrictPayload):
    proposal_id: Identifier = Field(alias="proposalId")


class EventAppendPayload(_StrictPayload):
    type: StandardEventType
    payload: JsonObject
    host_event_id: Identifier | None = Field(default=None, alias="hostEventId")


class EventFollowPayload(_StrictPayload):
    after_seq: NonNegativeInt = Field(default=0, alias="afterSeq")
    limit: PositiveInt = Field(default=100, le=1000)


class RunFinishPayload(_StrictPayload):
    status: Literal["completed", "failed", "cancelled"]
    summary: NonEmptyString | None = None
    details: JsonObject = Field(default_factory=dict)


class _RequestEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)

    v: Literal[1]
    id: RequestId
    metadata: JsonObject | None = None


class _NoRunRequest(_RequestEnvelope):
    model_config = ConfigDict(
        extra="allow",
        strict=True,
        json_schema_extra={"not": {"required": ["runId"]}},
    )

    @model_validator(mode="before")
    @classmethod
    def reject_run_id(cls, value: Any) -> Any:
        if isinstance(value, Mapping) and (
            "runId" in value or "run_id" in value
        ):
            raise ValueError("runId is forbidden for this request type")
        return value


class _RunRequest(_RequestEnvelope):
    run_id: Identifier = Field(alias="runId")


class HelloRequest(_NoRunRequest):
    type: Literal["hello"]
    payload: HelloPayload


class PairingRequest(_NoRunRequest):
    type: Literal["pairing.request"]
    payload: PairingRequestPayload


class PairingStatusRequest(_NoRunRequest):
    type: Literal["pairing.status"]
    payload: PairingStatusPayload


class RunAttachRequest(_RunRequest):
    type: Literal["run.attach"]
    payload: RunAttachPayload


class RunLeaseRenewRequest(_RunRequest):
    type: Literal["run.lease.renew"]
    payload: RunLeaseRenewPayload


class ContextSnapshotRequest(_RunRequest):
    type: Literal["context.snapshot"]
    payload: ContextSnapshotPayload


class SkillSnapshotRequest(_RunRequest):
    type: Literal["skill.snapshot"]
    payload: EmptyPayload


class OperationListRequest(_RunRequest):
    type: Literal["operation.list"]
    payload: EmptyPayload


class OperationSchemaRequest(_RunRequest):
    type: Literal["operation.schema"]
    payload: OperationSchemaPayload


class OperationInvokeRequest(_RunRequest):
    type: Literal["operation.invoke"]
    payload: OperationInvokePayload


class ProposalGetRequest(_RunRequest):
    type: Literal["proposal.get"]
    payload: ProposalGetPayload


class EventAppendRequest(_RunRequest):
    type: Literal["event.append"]
    payload: EventAppendPayload


class EventFollowRequest(_RunRequest):
    type: Literal["event.follow"]
    payload: EventFollowPayload


class RunFinishRequest(_RunRequest):
    type: Literal["run.finish"]
    payload: RunFinishPayload


BridgeRequest: TypeAlias = Annotated[
    Union[
        HelloRequest,
        PairingRequest,
        PairingStatusRequest,
        RunAttachRequest,
        RunLeaseRenewRequest,
        ContextSnapshotRequest,
        SkillSnapshotRequest,
        OperationListRequest,
        OperationSchemaRequest,
        OperationInvokeRequest,
        ProposalGetRequest,
        EventAppendRequest,
        EventFollowRequest,
        RunFinishRequest,
    ],
    Field(discriminator="type"),
]
RequestEnvelope = BridgeRequest


class ErrorPayload(_StrictPayload):
    code: ErrorCode
    message: NonEmptyString
    retryable: StrictBool
    details: JsonObject = Field(default_factory=dict)

    @model_validator(mode="after")
    def enforce_retryability_policy(self) -> "ErrorPayload":
        fixed_retryability = ERROR_CODE_RETRYABILITY[self.code]
        if (
            fixed_retryability is not None
            and self.retryable != fixed_retryability
        ):
            raise ValueError(
                f"{self.code} retryable must be {fixed_retryability}"
            )
        return self


class _ResponseEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)

    v: Literal[1]
    id: RequestId | None
    metadata: JsonObject | None = None


class SuccessResponse(_ResponseEnvelope):
    ok: Literal[True]
    result: JsonValue


class ErrorResponse(_ResponseEnvelope):
    ok: Literal[False]
    error: ErrorPayload


BridgeResponse: TypeAlias = Union[SuccessResponse, ErrorResponse]
ResponseEnvelope = BridgeResponse


class ServerEvent(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)

    v: Literal[1]
    type: StandardEventType
    run_id: Identifier = Field(alias="runId")
    seq: PositiveInt
    payload: JsonObject
    metadata: JsonObject | None = None


_REQUEST_ADAPTER = TypeAdapter(BridgeRequest)
_RESPONSE_ADAPTER = TypeAdapter(BridgeResponse)
_REQUEST_ID_PATTERN = re.compile(r"^\S{1,200}$")


class _InvalidJsonValue(ValueError):
    def __init__(self, message: str, *, details: Mapping[str, Any]) -> None:
        self.details = dict(details)
        super().__init__(message)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _InvalidJsonValue(
                "Request line contains a duplicate object key",
                details={"key": key},
            )
        value[key] = item
    return value


def _reject_nonstandard_number(value: str) -> None:
    raise _InvalidJsonValue(
        "Request line contains a non-standard JSON number",
        details={"value": value},
    )


def _request_id_from(value: Mapping[str, Any]) -> str | None:
    request_id = value.get("id")
    if isinstance(request_id, str) and _REQUEST_ID_PATTERN.fullmatch(request_id):
        return request_id
    return None


def _validation_issues(error: ValidationError) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for issue in error.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    ):
        issues.append(
            {
                "path": list(issue.get("loc", ())),
                "type": str(issue.get("type", "validation_error")),
                "message": str(issue.get("msg", "Invalid value")),
            }
        )
    return issues


def validate_request(value: object) -> BridgeRequest:
    if not isinstance(value, Mapping):
        raise BridgeProtocolError(
            "schema_invalid",
            "Request line must contain one JSON object",
            details={"actualType": type(value).__name__},
        )

    request_id = _request_id_from(value)
    version = value.get("v")
    if type(version) is not int:
        raise BridgeProtocolError(
            "schema_invalid",
            "Request protocol version must be the integer 1",
            details={"field": "v"},
            request_id=request_id,
        )
    if version != PROTOCOL_VERSION:
        raise BridgeProtocolError(
            "protocol_mismatch",
            "Unsupported Agent Bridge protocol version",
            details={
                "requested": version,
                "supported": [PROTOCOL_VERSION],
            },
            request_id=request_id,
        )

    message_type = value.get("type")
    if not isinstance(message_type, str):
        raise BridgeProtocolError(
            "schema_invalid",
            "Request message type must be a string",
            details={"field": "type"},
            request_id=request_id,
        )
    if message_type not in KNOWN_MESSAGE_TYPES:
        raise BridgeProtocolError(
            "schema_invalid",
            "Unknown Agent Bridge request message type",
            details={
                "type": message_type,
                "knownTypes": list(KNOWN_MESSAGE_TYPES),
            },
            request_id=request_id,
        )

    try:
        return _REQUEST_ADAPTER.validate_python(value, strict=True)
    except ValidationError as error:
        raise BridgeProtocolError(
            "schema_invalid",
            "Request does not match the Agent Bridge v1 schema",
            details={"issues": _validation_issues(error)},
            request_id=request_id,
        ) from error


def parse_request_line(line: str | bytes | bytearray) -> BridgeRequest:
    if isinstance(line, str):
        try:
            line.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise BridgeProtocolError(
                "schema_invalid",
                "Request line is not valid UTF-8",
                details={"start": error.start},
            ) from error
        text = line
    elif isinstance(line, (bytes, bytearray)):
        try:
            text = bytes(line).decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise BridgeProtocolError(
                "schema_invalid",
                "Request line is not valid UTF-8",
                details={"start": error.start},
            ) from error
    else:
        raise BridgeProtocolError(
            "schema_invalid",
            "Request line must be UTF-8 text or bytes",
            details={"actualType": type(line).__name__},
        )

    if text.endswith("\r\n"):
        text = text[:-2]
    elif text.endswith("\n"):
        text = text[:-1]
    if "\r" in text or "\n" in text:
        raise BridgeProtocolError(
            "schema_invalid",
            "Request input must contain exactly one JSON line",
        )

    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonstandard_number,
        )
    except json.JSONDecodeError as error:
        raise BridgeProtocolError(
            "schema_invalid",
            "Request line is malformed JSON",
            details={"line": error.lineno, "column": error.colno},
        ) from error
    except _InvalidJsonValue as error:
        raise BridgeProtocolError(
            "schema_invalid",
            str(error),
            details=error.details,
        ) from error

    return validate_request(value)


def success_response(request_id: str, result: JsonValue) -> dict[str, Any]:
    response = SuccessResponse(
        v=PROTOCOL_VERSION,
        id=request_id,
        ok=True,
        result=result,
    )
    return response.model_dump(mode="json", by_alias=True, exclude_none=True)


def error_response(
    request_id: str | None,
    error: BridgeProtocolError | ErrorPayload | Mapping[str, Any],
) -> dict[str, Any]:
    if isinstance(error, BridgeProtocolError):
        error_payload = ErrorPayload.model_validate(error.to_payload(), strict=True)
    elif isinstance(error, ErrorPayload):
        error_payload = error
    else:
        error_payload = ErrorPayload.model_validate(error, strict=True)
    response = ErrorResponse(
        v=PROTOCOL_VERSION,
        id=request_id,
        ok=False,
        error=error_payload,
    )
    return response.model_dump(mode="json", by_alias=True, exclude_none=False)


def bridge_schema_bundle() -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "bridgeVersion": BRIDGE_VERSION,
        "messageTypes": list(KNOWN_MESSAGE_TYPES),
        "runRequiredMessageTypes": list(RUN_REQUIRED_MESSAGE_TYPES),
        "runForbiddenMessageTypes": list(RUN_FORBIDDEN_MESSAGE_TYPES),
        "eventTypes": list(STANDARD_EVENT_TYPES),
        "errorCodes": list(ERROR_CODES),
        "errorRetryability": {
            code: (
                "conditional"
                if ERROR_CODE_RETRYABILITY[code] is None
                else ERROR_CODE_RETRYABILITY[code]
            )
            for code in ERROR_CODES
        },
        "schemas": {
            "request": _REQUEST_ADAPTER.json_schema(),
            "response": _RESPONSE_ADAPTER.json_schema(),
            "successResponse": SuccessResponse.model_json_schema(),
            "errorResponse": ErrorResponse.model_json_schema(),
            "error": ErrorPayload.model_json_schema(),
            "event": ServerEvent.model_json_schema(),
        },
    }


__all__ = [
    "AdapterIdentity",
    "BRIDGE_VERSION",
    "BridgeRequest",
    "BridgeResponse",
    "ContextSnapshotPayload",
    "ContextSnapshotRequest",
    "EmptyPayload",
    "ErrorPayload",
    "ErrorResponse",
    "EventAppendPayload",
    "EventAppendRequest",
    "EventFollowPayload",
    "EventFollowRequest",
    "HarnessCapabilities",
    "HarnessIdentity",
    "HelloPayload",
    "HelloRequest",
    "KNOWN_MESSAGE_TYPES",
    "OperationInvokePayload",
    "OperationInvokeRequest",
    "OperationListRequest",
    "OperationSchemaPayload",
    "OperationSchemaRequest",
    "PROTOCOL_VERSION",
    "PairingRequest",
    "PairingRequestPayload",
    "PairingStatusPayload",
    "PairingStatusRequest",
    "ProposalGetPayload",
    "ProposalGetRequest",
    "RUN_FORBIDDEN_MESSAGE_TYPES",
    "RUN_REQUIRED_MESSAGE_TYPES",
    "RequestEnvelope",
    "ResponseEnvelope",
    "RunAttachPayload",
    "RunAttachRequest",
    "RunFinishPayload",
    "RunFinishRequest",
    "RunLeaseRenewPayload",
    "RunLeaseRenewRequest",
    "STANDARD_EVENT_TYPES",
    "ServerEvent",
    "SkillSnapshotRequest",
    "SuccessResponse",
    "bridge_schema_bundle",
    "error_response",
    "parse_request_line",
    "success_response",
    "validate_request",
]
