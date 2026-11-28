WITH classified AS (
    SELECT service_name, status_code, resource_attributes,
        coalesce(attributes['mikka.trace.sample_rate'], '') != '' AS rate_present,
        toFloatOrNull(attributes['mikka.trace.sample_rate']) AS sample_rate,
        1 / nullIf(sample_rate, 0) AS inverse_rate,
        coalesce(sample_rate > 0 AND sample_rate <= 1 AND isFinite(inverse_rate), false) AS weight_valid
    FROM posthog.trace_spans
    WHERE {filters}
        AND service_name IN ('mikka-web', 'mikka-daemon')
        AND (resource_attributes['deployment.environment.name'] = 'production' OR resource_attributes['deployment.environment'] = 'production')
)
SELECT
    service_name AS service,
    count() AS retained_spans,
    countIf(coalesce(resource_attributes['service.version'], '') != '') AS version_known,
    countIf(NOT rate_present) AS sample_rate_missing,
    countIf(rate_present AND NOT weight_valid) AS sample_rate_invalid,
    countIf(status_code = 2 AND NOT rate_present) AS error_spans_missing_weight,
    countIf(status_code = 2 AND rate_present AND NOT weight_valid) AS error_spans_invalid_weight
FROM classified
GROUP BY service_name
ORDER BY service
LIMIT 50
