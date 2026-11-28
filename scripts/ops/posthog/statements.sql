WITH weighted_spans AS (
    SELECT attributes,
        toFloatOrNull(attributes['mikka.trace.sample_rate']) AS sample_rate,
        1 / nullIf(sample_rate, 0) AS inverse_rate,
        if(sample_rate > 0 AND sample_rate <= 1 AND isFinite(inverse_rate), inverse_rate, NULL) AS sample_weight,
        toFloatOrNull(attributes['mikka.db.response_bytes_approx']) AS json_bytes
    FROM posthog.trace_spans
    WHERE {filters}
      AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
      AND startsWith(name, 'pg.query:')
)
SELECT
    coalesce(nullIf(attributes['mikka.db.statement_id'], ''), '(statement id missing)') AS statement_id,
    coalesce(nullIf(attributes['db.query.text'], ''), '(SQL not recorded)') AS parameterized_sql,
    count() AS sampled_queries,
    if(count(sample_weight) = count() AND isFinite(sum(sample_weight)), sum(sample_weight), NULL) AS estimated_queries_weighted,
    count() - count(sample_weight) AS sampled_queries_unknown_weight,
    if(count(json_bytes) = 0, NULL, sum(json_bytes)) AS sampled_json_bytes,
    if(count(json_bytes) > 0 AND count(json_bytes * sample_weight) = count(json_bytes)
        AND isFinite(sum(json_bytes * sample_weight)), sum(json_bytes * sample_weight), NULL) AS estimated_json_bytes_weighted,
    count() - count(json_bytes) AS sampled_queries_missing_bytes
FROM weighted_spans
GROUP BY statement_id, parameterized_sql
ORDER BY if(count(json_bytes) > 0, greatest(
        coalesce(if(isFinite(sum(json_bytes * sample_weight)), sum(json_bytes * sample_weight), NULL), 0),
        coalesce(if(isFinite(sum(json_bytes)), sum(json_bytes), NULL), 0)), NULL) DESC NULLS LAST,
    sampled_queries DESC, statement_id ASC, parameterized_sql ASC
LIMIT 20
