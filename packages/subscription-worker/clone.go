package worker

import (
	"context"
)

// Clone copies a connected credential to another owner in one operation: the
// custody and access bundles are re-bound to the target scope and re-digested
// under fresh secret names, then a single transaction writes the new
// connection row, the artifact rows the sweeper needs, and the source's
// catalogue bindings. Secret writes happen before the transaction; a failed
// transaction deletes them again so the vault never holds an untracked secret.
func (w *Worker) Clone(ctx context.Context, target Scope) (map[string]any, error) {
	if !validScope(target) || target.Provider != w.Scope.Provider {
		return nil, ErrUnsupported
	}
	source, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil {
		return nil, err
	}
	if source.State != "connected" || source.SecretName == "" || source.Digest == "" {
		return nil, ErrUnavailable
	}
	raw, err := w.Secrets.Read(ctx, source.SecretName)
	if err != nil {
		return nil, err
	}
	b, err := decodeBundle(w.Scope, raw, source.Digest)
	if err != nil {
		return nil, err
	}
	b.OwnerID, b.WorkspaceID, b.ConnectionID = target.OwnerID, target.WorkspaceID, target.ConnectionID
	custodyRaw, custodyDigest, err := encodeBundle(b)
	if err != nil {
		return nil, err
	}
	var accessRaw []byte
	var accessDigest, accessName string
	if source.AccessName != "" && w.AccessSecrets != nil {
		projection, err := accessProjection(b)
		if err != nil {
			return nil, err
		}
		accessRaw, accessDigest, err = encodeBundle(projection)
		if err != nil {
			return nil, err
		}
		accessName = "mikka-byos-" + newID()
	}
	custodyName := "mikka-byos-" + newID()
	// A failed Create may still have stored the secret (lost response), so every
	// bail-out deletes both names — Delete of an absent name is harmless.
	scrub := func() {
		_ = w.Secrets.Delete(context.WithoutCancel(ctx), custodyName)
		if accessName != "" {
			_ = w.AccessSecrets.Delete(context.WithoutCancel(ctx), accessName)
		}
	}
	if err := w.Secrets.Create(ctx, custodyName, custodyRaw); err != nil {
		scrub()
		return nil, err
	}
	if accessName != "" {
		if err := w.AccessSecrets.Create(ctx, accessName, accessRaw); err != nil {
			scrub()
			return nil, err
		}
	}
	tx, err := w.Repo.DB.BeginTx(ctx, nil)
	if err != nil {
		scrub()
		return nil, ErrDatabase
	}
	fail := func(err error) (map[string]any, error) {
		_ = tx.Rollback()
		scrub()
		return nil, err
	}
	result, err := tx.ExecContext(ctx, `insert into byos_connections
		(id,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","secretName","secretDigest","accessSecretName","accessDigest","providerSubject",quota,"accountLabel","modelCatalog","modelSettings",paused)
		select $1,$2,$3,provider,'connected',1,1,$4,$5,$6,$7,"providerSubject",quota,"accountLabel","modelCatalog","modelSettings",false
		from byos_connections where id=$8 and "ownerId"=$9 and state='connected' and "removedAt" is null`,
		target.ConnectionID, target.OwnerID, target.WorkspaceID, custodyName, custodyDigest, accessName, accessDigest, source.ConnectionID, source.OwnerID)
	if err != nil {
		return fail(ErrDatabase)
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return fail(ErrUnavailable)
	}
	for _, artifact := range []struct{ name, kind string }{{custodyName, "grant"}, {accessName, "access"}} {
		if artifact.name == "" {
			continue
		}
		if _, err = tx.ExecContext(ctx, `insert into byos_secret_artifacts (name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","createStarted","createSettled","publishedAt") values ($1,$2,$3,$4,$5,$6,now(),true,true,now())`,
			artifact.name, target.ConnectionID, target.OwnerID, target.WorkspaceID, source.Provider, artifact.kind); err != nil {
			return fail(ErrDatabase)
		}
	}
	// The target's catalogue mirrors the source's saved options: every binding
	// the source connection carries, re-owned. Bindings naming the source
	// owner's agents stay inert — no target agent matches their consumerId.
	if _, err = tx.ExecContext(ctx, `insert into byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId","createdAt")
		select gen_random_uuid(),$2,$3,"consumerId",$1,1,route,"modelId",now() from byos_bindings where "connectionId"=$4 and "ownerId"=$5`,
		target.ConnectionID, target.OwnerID, target.WorkspaceID, source.ConnectionID, source.OwnerID); err != nil {
		return fail(ErrDatabase)
	}
	if err = tx.Commit(); err != nil {
		return fail(ErrDatabase)
	}
	return map[string]any{"connectionId": target.ConnectionID, "revision": int64(1)}, nil
}
