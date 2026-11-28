WITH request_spans AS (
    SELECT
        coalesce(nullIf(attributes['http.request.method'], ''), 'unknown') AS method,
        coalesce(nullIf(attributes['http.route'], ''), 'unknown') AS route,
        coalesce(nullIf(resource_attributes['service.version'], ''), 'unknown') AS revision,
        trace_id, span_id,
        toFloatOrNull(attributes['mikka.trace.sample_rate']) AS sample_rate,
        1 / nullIf(sample_rate, 0) AS inverse_rate,
        if(sample_rate > 0 AND sample_rate <= 1 AND isFinite(inverse_rate), inverse_rate, NULL) AS sample_weight,
        toIntOrNull(attributes['http.response.status_code']) AS http_status
    FROM posthog.trace_spans
    WHERE {filters}
        AND service_name = 'mikka-web' AND kind = 2
        AND (resource_attributes['deployment.environment.name'] = 'production' OR resource_attributes['deployment.environment'] = 'production')
        AND coalesce(attributes['http.request.method'], '') NOT IN ('OPTIONS', 'HEAD')
), grouped AS (
    SELECT method, route, revision,
        count() AS observed_server_spans,
        uniqExact(tuple(trace_id, span_id)) AS unique_server_spans,
        countIf(http_status >= 500 AND http_status <= 599) AS observed_http_5xx,
        countIf(http_status >= 100 AND http_status <= 599) AS valid_status_spans,
        count(sample_weight) AS valid_weight_spans,
        coalesce(sum(sample_weight), 0) AS estimated_known_requests,
        coalesce(sumIf(sample_weight, http_status >= 500 AND http_status <= 599), 0) AS estimated_known_5xx
    FROM request_spans
    GROUP BY method, route, revision
), checked AS (
    SELECT *,
        NOT isFinite(estimated_known_requests) OR NOT isFinite(estimated_known_5xx) AS nonfinite_weight_total,
        observed_server_spans = unique_server_spans AND observed_server_spans = valid_status_spans
            AND observed_server_spans = valid_weight_spans AND NOT nonfinite_weight_total AS estimate_available,
        round(estimated_known_requests, 1) AS rounded_requests
    FROM grouped
)
SELECT method, route, revision,
    observed_server_spans, observed_http_5xx,
    observed_server_spans - unique_server_spans AS duplicate_span_rows,
    observed_server_spans - valid_status_spans AS unknown_status_spans,
    observed_server_spans - valid_weight_spans AS unknown_weight_spans,
    nonfinite_weight_total,
    if(estimate_available, if(isFinite(rounded_requests), rounded_requests, estimated_known_requests), NULL) AS estimated_requests,
    if(estimate_available, round(100 * (estimated_known_5xx / nullIf(estimated_known_requests, 0)), 3), NULL) AS estimated_5xx_pct
FROM checked
ORDER BY observed_http_5xx DESC, observed_server_spans DESC, method, route, revision
LIMIT 500
