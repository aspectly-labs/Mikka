WITH weighted_spans AS (
    SELECT service_name, attributes,
        toFloatOrNull(attributes['mikka.trace.sample_rate']) AS sample_rate,
        1 / nullIf(sample_rate, 0) AS inverse_rate,
        if(sample_rate > 0 AND sample_rate <= 1 AND isFinite(inverse_rate), inverse_rate, NULL) AS sample_weight
    FROM posthog.trace_spans
    WHERE {filters}
      AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
      AND status_code = 2
)
SELECT service_name,
    coalesce(nullIf(attributes['mikka.route'], ''), '(unknown route)') AS route,
    coalesce(nullIf(attributes['mikka.error.code'], ''), nullIf(attributes['error.type'], ''), '(unknown code)') AS error_code,
    coalesce(nullIf(attributes['mikka.error.detail'], ''), '(detail not instrumented)') AS error_detail,
    count() AS sampled_error_spans,
    if(count(sample_weight) = count() AND isFinite(sum(sample_weight)), sum(sample_weight), NULL) AS estimated_error_spans_weighted,
    count() - count(sample_weight) AS sampled_error_spans_unknown_weight
FROM weighted_spans
GROUP BY service_name, route, error_code, error_detail
ORDER BY greatest(coalesce(if(isFinite(sum(sample_weight)), sum(sample_weight), NULL), 0), toFloat(count())) DESC,
    route ASC, error_code ASC, service_name ASC, error_detail ASC
LIMIT 100
