WITH db AS (
    SELECT
        toFloatOrNull(attributes['mikka.trace.sample_rate']) AS sample_rate,
        1 / nullIf(sample_rate, 0) AS inverse_rate,
        if(sample_rate > 0 AND sample_rate <= 1 AND isFinite(inverse_rate), inverse_rate, NULL) AS sample_weight,
        formatDateTime(toTimeZone(timestamp, 'UTC'), '%Y-%m-%d %H:00') AS hour_utc,
        coalesce(nullIf(attributes['mikka.route'], ''), '(unknown route)') AS route,
        toFloatOrNull(attributes['mikka.db.response_bytes_approx']) AS json_bytes
    FROM posthog.trace_spans
    WHERE {filters}
      AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
      AND startsWith(name, 'pg.query:')
), top_routes AS (
    SELECT route
    FROM db
    GROUP BY route
    ORDER BY if(count(json_bytes) > 0, greatest(
        coalesce(if(isFinite(sum(json_bytes * sample_weight)), sum(json_bytes * sample_weight), NULL), 0),
        coalesce(if(isFinite(sum(json_bytes)), sum(json_bytes), NULL), 0)), NULL) DESC NULLS LAST,
        greatest(coalesce(if(isFinite(sum(sample_weight)), sum(sample_weight), NULL), 0), toFloat(count())) DESC, route ASC
    LIMIT 15
)
SELECT
    hour_utc,
    route,
    count() AS sampled_queries,
    if(count(sample_weight) = count() AND isFinite(sum(sample_weight)), sum(sample_weight), NULL) AS estimated_queries_weighted,
    count() - count(sample_weight) AS sampled_queries_unknown_weight,
    if(count(json_bytes) = 0, NULL, sum(json_bytes)) AS sampled_json_bytes,
    if(count(json_bytes) > 0 AND count(json_bytes * sample_weight) = count(json_bytes)
        AND isFinite(sum(json_bytes * sample_weight)), sum(json_bytes * sample_weight), NULL) AS estimated_json_bytes_weighted,
    count() - count(json_bytes) AS sampled_queries_missing_bytes
FROM db
WHERE route IN (SELECT route FROM top_routes)
GROUP BY hour_utc, route
ORDER BY hour_utc ASC, estimated_json_bytes_weighted DESC NULLS LAST, route ASC
LIMIT 3000
