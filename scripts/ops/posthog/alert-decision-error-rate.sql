WITH observed AS (
    SELECT
        count() AS calls,
        uniqExact(tuple(trace_id, span_id)) AS unique_calls,
        countIf(toFloatOrNull(attributes['mikka.trace.sample_rate']) = 1
            AND attributes['mikka.ai.outcome'] IN ('success', 'error', 'cancelled', 'incomplete')) AS known_calls,
        countIf(attributes['mikka.ai.outcome'] IN ('error', 'cancelled', 'incomplete')) AS failed_calls
    FROM posthog.trace_spans
    WHERE service_name = 'mikka-web' AND name = 'mikka.ai.generation'
        AND attributes['mikka.ai.operation'] = 'decision'
        AND attributes['mikka.ai.route'] = 'litellm'
        AND (resource_attributes['deployment.environment.name'] = 'production'
            OR resource_attributes['deployment.environment'] = 'production')
        AND timestamp >= now() - INTERVAL 1 HOUR
)
SELECT
    if(calls < 3 OR calls != unique_calls OR calls != known_calls, NULL,
        if(failed_calls / nullIf(calls, 0) > 0.2, 1, 0)) AS value,
    concat('LiteLLM decision spans: ', toString(failed_calls), '/', toString(calls),
        ' non-success, threshold >20%, minimum 3 calls; coverage=',
        multiIf(calls != unique_calls, 'duplicate spans', calls != known_calls, 'unknown weight/outcome',
            calls < 3, 'low sample', 'known')) AS source
FROM observed
