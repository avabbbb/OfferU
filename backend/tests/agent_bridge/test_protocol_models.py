from __future__ import annotations

import json
import unittest

from pydantic import ValidationError

from app.services.agent_bridge import (
    ERROR_CODES,
    BridgeProtocolError,
    ErrorResponse,
    PROTOCOL_VERSION,
    ServerEvent,
    SuccessResponse,
    bridge_schema_bundle,
    error_response,
    parse_request_line,
    success_response,
)
from app.services.agent_bridge.protocol import OperationInvokeRequest


def _hello_request() -> dict[str, object]:
    return {
        "v": 1,
        "id": "req_hello",
        "type": "hello",
        "payload": {
            "adapter": {"name": "@offeru/dsh-plugin", "version": "0.1.0"},
            "harness": {
                "name": "deepseek-harness",
                "version": "0.1.0-rc.8",
                "profile": "offeru",
                "preset": "offeru-readonly",
                "compositionHash": "sha256:fixture",
            },
            "protocols": [1],
            "capabilities": {
                "sessionResume": True,
                "steer": False,
                "interrupt": True,
                "toolSuspendResume": True,
                "eventStream": True,
                "workspaceIsolation": "native_tools_disabled",
                "nativeClient": True,
            },
        },
    }


class RequestLineParsingTests(unittest.TestCase):
    def assert_bridge_error(self, line: str | bytes, code: str) -> BridgeProtocolError:
        with self.assertRaises(BridgeProtocolError) as raised:
            parse_request_line(line)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_parses_one_utf8_json_object_line(self) -> None:
        value = _hello_request()
        value["metadata"] = {"label": "求职"}
        value["futureTrace"] = "trace-1"

        request = parse_request_line(
            (json.dumps(value, ensure_ascii=False) + "\r\n").encode("utf-8")
        )

        self.assertEqual(request.type, "hello")
        self.assertEqual(request.payload.harness.name, "deepseek-harness")
        self.assertEqual(request.model_extra, {"futureTrace": "trace-1"})

    def test_rejects_malformed_json_without_echoing_input(self) -> None:
        error = self.assert_bridge_error('{"token":"secret"', "schema_invalid")

        self.assertNotIn("secret", str(error))
        self.assertEqual(error.details, {"line": 1, "column": 18})

    def test_rejects_non_object_json(self) -> None:
        error = self.assert_bridge_error("[]", "schema_invalid")

        self.assertEqual(error.details["actualType"], "list")

    def test_rejects_invalid_utf8_and_multiple_lines(self) -> None:
        self.assert_bridge_error(b"\xff", "schema_invalid")
        self.assert_bridge_error("{}\n{}\n", "schema_invalid")

    def test_rejects_duplicate_keys_and_nonstandard_numbers(self) -> None:
        self.assert_bridge_error(
            '{"v":1,"v":1,"id":"req_1","type":"pairing.request","payload":{}}',
            "schema_invalid",
        )
        self.assert_bridge_error(
            '{"v":1,"id":"req_1","type":"pairing.request","payload":{"cwdFingerprint":NaN}}',
            "schema_invalid",
        )

    def test_unknown_integer_version_is_protocol_mismatch(self) -> None:
        value = _hello_request()
        value["v"] = 2

        error = self.assert_bridge_error(json.dumps(value), "protocol_mismatch")

        self.assertEqual(error.request_id, "req_hello")
        self.assertEqual(error.details, {"requested": 2, "supported": [1]})

    def test_bad_version_type_and_unknown_message_are_schema_invalid(self) -> None:
        value = _hello_request()
        value["v"] = "1"
        self.assert_bridge_error(json.dumps(value), "schema_invalid")

        value = _hello_request()
        value["type"] = "run.create"
        error = self.assert_bridge_error(json.dumps(value), "schema_invalid")
        self.assertEqual(error.details["type"], "run.create")


class RequestModelTests(unittest.TestCase):
    def assert_schema_invalid(self, value: dict[str, object]) -> BridgeProtocolError:
        with self.assertRaises(BridgeProtocolError) as raised:
            parse_request_line(json.dumps(value))
        self.assertEqual(raised.exception.code, "schema_invalid")
        return raised.exception

    def test_payload_rejects_unknown_business_fields(self) -> None:
        value = _hello_request()
        assert isinstance(value["payload"], dict)
        value["payload"]["confirm"] = True

        error = self.assert_schema_invalid(value)

        self.assertTrue(
            any(issue["type"] == "extra_forbidden" for issue in error.details["issues"])
        )

    def test_run_id_is_forbidden_before_pairing_and_required_after(self) -> None:
        hello = _hello_request()
        hello["runId"] = "run_01J"
        self.assert_schema_invalid(hello)

        operation = {
            "v": 1,
            "id": "req_op_7",
            "type": "operation.invoke",
            "payload": {
                "operation": "get_pre_application_state",
                "arguments": {"job_id": 42},
                "idempotencyKey": "run_01J/call/7",
                "contextVersion": 12,
            },
        }
        self.assert_schema_invalid(operation)

    def test_operation_invoke_matches_the_v1_example(self) -> None:
        value = {
            "v": 1,
            "id": "req_op_7",
            "type": "operation.invoke",
            "runId": "run_01J",
            "payload": {
                "operation": "get_pre_application_state",
                "arguments": {"job_id": 42},
                "idempotencyKey": "run_01J/call/7",
                "contextVersion": 12,
            },
        }

        request = parse_request_line(json.dumps(value))

        self.assertIsInstance(request, OperationInvokeRequest)
        self.assertEqual(request.run_id, "run_01J")
        self.assertEqual(request.payload.arguments, {"job_id": 42})
        self.assertEqual(request.payload.context_version, 12)

    def test_operation_payload_does_not_accept_confirm_or_shell(self) -> None:
        value = {
            "v": 1,
            "id": "req_op_7",
            "type": "operation.invoke",
            "runId": "run_01J",
            "payload": {
                "operation": "get_pre_application_state",
                "arguments": {"job_id": 42},
                "idempotencyKey": "run_01J/call/7",
                "contextVersion": 12,
                "shell": "echo hidden",
            },
        }

        self.assert_schema_invalid(value)


class ResponseAndSchemaTests(unittest.TestCase):
    def test_success_and_error_helpers_emit_valid_response_envelopes(self) -> None:
        success = success_response("req_1", {"status": "completed"})
        error = BridgeProtocolError(
            "grant_denied",
            "Operation is not granted for this Run",
            details={"operation": "update_application_status"},
            request_id="req_2",
        )

        self.assertEqual(SuccessResponse.model_validate(success).result["status"], "completed")
        error_value = error.to_response()
        self.assertEqual(ErrorResponse.model_validate(error_value).error.code, "grant_denied")
        self.assertEqual(
            error_response(None, error)["id"],
            None,
        )

    def test_fixed_retryability_cannot_be_overridden(self) -> None:
        with self.assertRaises(ValueError):
            BridgeProtocolError(
                "schema_invalid",
                "bad schema",
                retryable=True,
            )

        conditional = BridgeProtocolError(
            "lease_lost",
            "lease can be reacquired",
            retryable=True,
        )
        self.assertTrue(conditional.to_payload()["retryable"])

    def test_server_event_has_no_request_id_and_requires_positive_seq(self) -> None:
        event = ServerEvent.model_validate(
            {
                "v": 1,
                "type": "approval.decided",
                "runId": "run_01J",
                "seq": 42,
                "payload": {"proposalId": "prop_01J", "decision": "approved"},
            }
        )
        self.assertEqual(event.seq, 42)
        self.assertNotIn("id", event.model_dump(by_alias=True))

        with self.assertRaises(ValidationError):
            ServerEvent.model_validate(
                {
                    "v": 1,
                    "type": "approval.decided",
                    "runId": "run_01J",
                    "seq": 0,
                    "payload": {},
                }
            )

    def test_schema_bundle_is_complete_and_payloads_are_closed(self) -> None:
        bundle = bridge_schema_bundle()

        self.assertEqual(bundle["protocolVersion"], PROTOCOL_VERSION)
        self.assertEqual(bundle["errorCodes"], list(ERROR_CODES))
        self.assertEqual(bundle["errorRetryability"]["lease_lost"], "conditional")
        self.assertEqual(bundle["errorRetryability"]["context_stale"], True)
        self.assertEqual(
            set(bundle["schemas"]),
            {
                "request",
                "response",
                "successResponse",
                "errorResponse",
                "error",
                "event",
            },
        )
        request_defs = bundle["schemas"]["request"]["$defs"]
        self.assertFalse(request_defs["OperationInvokePayload"]["additionalProperties"])
        self.assertTrue(request_defs["OperationInvokeRequest"]["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
