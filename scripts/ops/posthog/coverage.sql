WITH weighted_spans AS (
    SELECT service_name, timestamp, name, status_code, attributes,
        toFloatOrNull(attributes['mikka.trace.sample_rate']) AS sample_rate,
        1 / nullIf(sample_rate, 0) AS inverse_rate,
        if(sample_rate > 0 AND sample_rate <= 1 AND isFinite(inverse_rate), inverse_rate, NULL) AS sample_weight
    FROM posthog.trace_spans
    WHERE {filters}
      AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
)
SELECT
    service_name,
    count() AS sampled_spans,
    if(count(sample_weight) = count() AND isFinite(sum(sample_weight)), sum(sample_weight), NULL) AS estimated_spans_weighted,
    count() - count(sample_weight) AS sampled_spans_unknown_weight,
    countIf(startsWith(name, 'pg.query:')) AS sampled_db_queries,
    if(countIf(isNull(sample_weight) AND startsWith(name, 'pg.query:')) = 0
        AND isFinite(coalesce(sumIf(sample_weight, startsWith(name, 'pg.query:')), 0)), coalesce(sumIf(sample_weight, startsWith(name, 'pg.query:')), 0), NULL) AS estimated_db_queries_weighted,
    countIf(isNull(sample_weight) AND startsWith(name, 'pg.query:')) AS sampled_db_queries_unknown_weight,
    countIf(status_code = 2) AS sampled_error_spans,
    if(countIf(isNull(sample_weight) AND status_code = 2) = 0
        AND isFinite(coalesce(sumIf(sample_weight, status_code = 2), 0)), coalesce(sumIf(sample_weight, status_code = 2), 0), NULL) AS estimated_error_spans_weighted,
    countIf(isNull(sample_weight) AND status_code = 2) AS sampled_error_spans_unknown_weight,
    formatDateTime(toTimeZone(min(timestamp), 'UTC'), '%Y-%m-%d %H:%i:%S') AS first_span_utc,
    formatDateTime(toTimeZone(max(timestamp), 'UTC'), '%Y-%m-%d %H:%i:%S') AS latest_span_utc,
    count(DISTINCT toStartOfHour(toTimeZone(timestamp, 'UTC'))) AS observed_hour_buckets,
    round(dateDiff('second', min(timestamp), max(timestamp)) / 3600, 2) AS observed_span_hours,
    countIf(startsWith(name, 'pg.query:') AND coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') IN ('unknown', '(unknown route)')) AS sampled_db_queries_unattributed_route,
    countIf(startsWith(name, 'pg.query:') AND toFloatOrNull(attributes['mikka.db.response_bytes_approx']) IS NULL) AS sampled_db_queries_missing_bytes
FROM weighted_spans
GROUP BY service_name
ORDER BY sampled_spans DESC
LIMIT 10
