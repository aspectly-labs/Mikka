SELECT
    service_name AS service,
    count() AS retained_spans,
    countIf(coalesce(resource_attributes['service.version'], '') != '') AS version_known,
    countIf(coalesce(attributes['mikka.trace.sample_rate'], '') = '') AS sample_rate_missing,
    countIf(coalesce(attributes['mikka.trace.sample_rate'], '') != '' AND (toFloatOrNull(attributes['mikka.trace.sample_rate']) IS NULL OR toFloatOrNull(attributes['mikka.trace.sample_rate']) <= 0 OR toFloatOrNull(attributes['mikka.trace.sample_rate']) > 1)) AS sample_rate_invalid,
    countIf(status_code = 2 AND coalesce(attributes['mikka.trace.sample_rate'], '') = '') AS error_spans_missing_weight
FROM posthog.trace_spans
WHERE {filters}
    AND service_name IN ('mikka-web', 'mikka-daemon')
    AND (resource_attributes['deployment.environment.name'] = 'production' OR resource_attributes['deployment.environment'] = 'production')
GROUP BY service_name
ORDER BY service
LIMIT 50