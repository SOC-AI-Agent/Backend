"""The Swagger document, checked for the things that make it usable.

Swagger is the API's own documentation, and it goes wrong quietly: a DTO without
its plugin shows an empty body, an operation without a security decorator makes
"Try it out" send no token, a controller that returns a plain object documents no
response at all. None of that fails a request, so nothing else would notice.

Needs no API key — /docs-json is public.
"""

import pytest

# Everything else is behind a guard, and has to say which.
PUBLIC = {("post", "/auth/login"), ("post", "/auth/refresh"), ("get", "/health"), ("get", "/")}
NO_BODY = {204}


@pytest.fixture(scope="module")
def spec(anon):
    resp = anon.get("/docs-json")
    assert resp.status_code == 200, resp.text
    return resp.json()


def operations(spec):
    for path, methods in spec["paths"].items():
        for method, op in methods.items():
            yield method, path, op


def test_every_operation_has_a_summary(spec):
    missing = [f"{m.upper()} {p}" for m, p, op in operations(spec) if not op.get("summary")]
    assert not missing, missing


def test_every_protected_operation_says_which_credential_it_needs(spec):
    # Without this, Authorize has nothing to apply to and Try it out sends no token.
    bare = [
        f"{m.upper()} {p}"
        for m, p, op in operations(spec)
        if (m, p) not in PUBLIC and not op.get("security")
    ]
    assert not bare, bare


def test_the_public_operations_are_public(spec):
    for m, p, op in operations(spec):
        if (m, p) in PUBLIC:
            assert not op.get("security"), f"{m.upper()} {p} is documented as needing a credential"


def test_the_analyze_route_takes_an_api_key_and_the_dashboard_routes_a_token(spec):
    schemes = {(m, p): {name for s in op.get("security", []) for name in s} for m, p, op in operations(spec)}
    assert schemes[("post", "/v1/analyze")] == {"X-API-Key"}
    assert schemes[("get", "/v1/results/{jobId}")] == {"X-API-Key"}
    assert schemes[("post", "/v1/jobs/{jobId}/lookup")] == {"bearer"}
    assert schemes[("get", "/admin/users")] == {"bearer"}


def test_no_schema_is_empty(spec):
    # An empty schema is a DTO the Swagger plugin never saw.
    empty = [name for name, s in spec["components"]["schemas"].items() if not (s.get("properties") or s.get("enum"))]
    assert not empty, empty


def test_every_success_response_says_what_it_returns(spec):
    silent = []
    for m, p, op in operations(spec):
        for code, response in op["responses"].items():
            if not code.startswith("2") or int(code) in NO_BODY:
                continue
            if not (response.get("content") or {}).get("application/json", {}).get("schema") and p != "/admin/audit-logs/export":
                silent.append(f"{m.upper()} {p} -> {code}")
    assert not silent, silent


def test_the_request_bodies_show_their_fields(spec):
    schemas = spec["components"]["schemas"]
    assert {"alert_id", "alert_name", "raw_log", "indicators"} <= set(schemas["AnalyzeDto"]["properties"])
    assert {"username", "password"} <= set(schemas["LoginDto"]["properties"])
    # And an example a person can send as it stands.
    assert schemas["AnalyzeDto"]["properties"]["raw_log"].get("example")


def test_the_job_detail_documents_the_splunk_stage(spec):
    detail = spec["components"]["schemas"]["JobDetailResponse"]
    fields = set(detail["properties"]) | {
        key
        for part in detail.get("allOf", [])
        for key in spec["components"]["schemas"].get(part.get("$ref", "").rsplit("/", 1)[-1], {}).get("properties", {})
    }
    assert {"lookup_status", "lookup_result", "final_analysis", "splunk_requirements", "ai_response"} <= fields
    assert {"status", "text", "resultsUsed"} <= set(spec["components"]["schemas"]["FinalAnalysisResponse"]["properties"])


def test_the_list_takes_its_paging_and_filter_as_documented_parameters(spec):
    params = {x["name"] for x in spec["paths"]["/v1/results"]["get"]["parameters"]}
    assert {"skip", "limit", "status_filter"} <= params
