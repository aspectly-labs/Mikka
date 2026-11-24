package worker

import (
	"context"
	"testing"
)

func TestCloneRebindsTheCredentialAndCopiesTheCatalogue(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "codex")
	mustAcquire(t, w)
	source, err := w.Repo.Lookup(context.Background(), w.Scope)
	if err != nil {
		t.Fatal(err)
	}
	target := Scope{OwnerID: "bob", WorkspaceID: newID(), ConnectionID: newID(), Provider: w.Scope.Provider}
	t.Cleanup(func() {
		_, _ = w.Repo.DB.Exec(`delete from byos_bindings where "connectionId"=$1`, target.ConnectionID)
		_, _ = w.Repo.DB.Exec(`delete from byos_secret_artifacts where "connectionId"=$1`, target.ConnectionID)
		_, _ = w.Repo.DB.Exec(`delete from byos_connections where id=$1`, target.ConnectionID)
	})
	result, err := w.Clone(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if result["connectionId"] != target.ConnectionID {
		t.Fatalf("clone answered %v, not the minted connection", result)
	}
	var owner, state, custodyName, custodyDigest, accessName, accessDigest, subject, catalogRevision string
	var epoch, version int64
	if err = w.Repo.DB.QueryRow(`select "ownerId",state,epoch,"credentialVersion","secretName","secretDigest",coalesce("accessSecretName",''),coalesce("accessDigest",''),coalesce("providerSubject",''),"modelCatalog"->>'revision' from byos_connections where id=$1`,
		target.ConnectionID).Scan(&owner, &state, &epoch, &version, &custodyName, &custodyDigest, &accessName, &accessDigest, &subject, &catalogRevision); err != nil {
		t.Fatal(err)
	}
	if owner != "bob" || state != "connected" || epoch != 1 || version != 1 {
		t.Fatalf("clone row %s %s epoch=%d version=%d", owner, state, epoch, version)
	}
	// keyOnlyModel binds modelCatalog->>'revision' to the row epoch — it must
	// read '1' here even when the source catalogue is a later revision.
	if catalogRevision != "1" {
		t.Fatalf("clone modelCatalog revision %q, want 1", catalogRevision)
	}
	if custodyName == "" || custodyName == source.SecretName || custodyDigest == source.Digest || subject != source.Subject {
		t.Fatalf("clone kept the source secret identity %q / digest", custodyName)
	}
	// The copied custody bundle decodes only under the target scope.
	if _, err = decodeBundle(target, inf.values[custodyName], custodyDigest); err != nil {
		t.Fatalf("clone custody bundle does not decode under the target scope: %v", err)
	}
	if _, err = decodeBundle(w.Scope, inf.values[custodyName], custodyDigest); err == nil {
		t.Fatal("clone custody bundle still decodes under the source scope")
	}
	if accessName != "" {
		if _, err = decodeAccessBundle(target, inf.values[accessName], accessDigest); err != nil {
			t.Fatalf("clone access projection does not decode under the target scope: %v", err)
		}
		if accessDigest == source.AccessDigest {
			t.Fatal("access projection reused the source digest")
		}
	}
	// Both artifact kinds landed published so the sweeper tracks them.
	var artifacts int
	if err = w.Repo.DB.QueryRow(`select count(*) from byos_secret_artifacts where "connectionId"=$1 and "publishedAt" is not null`, target.ConnectionID).Scan(&artifacts); err != nil {
		t.Fatal(err)
	}
	if artifacts != 2 {
		t.Fatalf("clone wrote %d published artifacts, want 2", artifacts)
	}
	// The catalogue binding the fixture created is re-owned by the target.
	var consumer, route, model string
	var revision int64
	if err = w.Repo.DB.QueryRow(`select "consumerId",route,"modelId","connectionRevision" from byos_bindings where "connectionId"=$1 and "ownerId"='bob'`, target.ConnectionID).Scan(&consumer, &route, &model, &revision); err != nil {
		t.Fatal(err)
	}
	if consumer != "fixture-consumer" || route != "codex_cpa" || model != "fixture-model" || revision != 1 {
		t.Fatalf("copied binding %s %s %s rev=%d", consumer, route, model, revision)
	}
	// The source connection is untouched.
	after, err := w.Repo.Lookup(context.Background(), w.Scope)
	if err != nil {
		t.Fatal(err)
	}
	if after.SecretName != source.SecretName || after.Digest != source.Digest || after.State != "connected" {
		t.Fatal("clone disturbed the source connection")
	}
}

func TestCloneRefusesANonConnectedSource(t *testing.T) {
	w, _, _ := fixtureWorker(t, "claude")
	if _, err := w.Clone(context.Background(), Scope{OwnerID: "bob", WorkspaceID: newID(), ConnectionID: newID(), Provider: "claude"}); err != ErrUnavailable {
		t.Fatalf("pending source clone = %v, want ErrUnavailable", err)
	}
}
