SELECT
    formatDateTime(toTimeZone(toStartOfHour(timestamp), 'UTC'), '%Y-%m-%d %H:00') AS hour_utc,
    count() AS observed_calls,
    countIf(attributes['mikka.ai.outcome'] = 'error') AS provider_errors,
    countIf(attributes['mikka.ai.outcome'] = 'cancelled') AS cancellations,
    countIf(attributes['mikka.ai.outcome'] = 'incomplete') AS incomplete,
    count() - uniqExact(tuple(trace_id, span_id)) AS duplicate_span_rows,
    count() - countIf(toFloatOrNull(attributes['mikka.trace.sample_rate']) = 1 AND attributes['mikka.ai.outcome'] IN ('success','error','cancelled','incomplete')) AS unknown_coverage,
    if(count() < 3 OR duplicate_span_rows > 0 OR unknown_coverage > 0, NULL,
       if(countIf(attributes['mikka.ai.outcome'] IN ('error','cancelled','incomplete')) / count() > 0.2, 1, 0)) AS candidate_breach
FROM posthog.trace_spans
WHERE {filters}
    AND service_name='mikka-web' AND name='mikka.ai.generation'
    AND attributes['mikka.ai.operation']='decision' AND attributes['mikka.ai.route']='litellm'
    AND (resource_attributes['deployment.environment.name']='production' OR resource_attributes['deployment.environment']='production')
GROUP BY hour_utc ORDER BY hour_utc DESC LIMIT 1000
