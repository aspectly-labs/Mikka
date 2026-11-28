package worker

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func metadataFixture(t *testing.T) *Worker {
	t.Helper()
	db := testDB(t)
	scope := Scope{newID(), newID(), newID(), "codex"}
	repo := &Repository{DB: db}
	if err := repo.Create(context.Background(), scope); err != nil {
		t.Fatal("metadata fixture create failed")
	}
	if _, err := db.Exec(`update byos_connections set state='pending' where id=$1`, scope.ConnectionID); err != nil {
		t.Fatal("metadata pending fixture failed")
	}
	t.Cleanup(func() { _, _ = db.Exec(`delete from byos_connections where id=$1`, scope.ConnectionID) })
	_, secrets := newFakeInfisical(t)
	issuer := newFakeProvider(t, "codex")
	return &Worker{Repo: repo, Scope: scope, Secrets: secrets, AccessSecrets: secrets, Authenticator: fakeAuthenticator{issuer}}
}

func metadataGuard(t *testing.T, w *Worker) {
	t.Helper()
	job := newID()
	db := w.Repo.DB
	statements := []struct {
		query string
		args  []any
	}{
		{`insert into account_deletion_jobs(id,"subjectUserId","subjectEmailHash",stage,plan) values($1,$2,repeat('0',64),'external_pending',jsonb_build_object('solo',jsonb_build_array($3::text)))`, []any{job, w.Scope.OwnerID, w.Scope.WorkspaceID}},
		{`insert into account_deletion_guards("subjectId","jobId") values($1,$2)`, []any{w.Scope.OwnerID, job}},
		{`insert into account_deletion_workspace_guards("workspaceId","jobId") values($1,$2)`, []any{w.Scope.WorkspaceID, job}},
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`delete from account_deletion_workspace_guards where "jobId"=$1`, job)
		_, _ = db.Exec(`delete from account_deletion_guards where "jobId"=$1`, job)
		_, _ = db.Exec(`delete from account_deletion_jobs where id=$1`, job)
	})
	for _, statement := range statements {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal("metadata deletion guard fixture failed")
		}
	}
}

func metadataDatabaseSetting(t *testing.T, w *Worker, key, value string) *Worker {
	t.Helper()
	u, err := url.Parse(os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"))
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasSuffix(u.Path, "_e2e") {
		t.Fatal("metadata test requires isolated loopback Postgres")
	}
	query := u.Query()
	query.Set(key, value)
	u.RawQuery = query.Encode()
	db, err := sql.Open("pgx", u.String())
	if err != nil || db.Ping() != nil {
		t.Fatal("metadata database setting failed")
	}
	t.Cleanup(func() { _ = db.Close() })
	copy := *w
	copy.Repo = &Repository{DB: db}
	return &copy
}

func metadataRPC(t *testing.T, w *Worker, method string) (map[string]any, string) {
	t.Helper()
	var output bytes.Buffer
	if err := w.Serve(context.Background(), strings.NewReader(`{"id":"fixture","method":"`+method+`","revision":1}`+"\n"), &output); err != nil {
		t.Fatal("metadata RPC failed before response")
	}
	var frame map[string]any
	if err := json.Unmarshal(output.Bytes(), &frame); err != nil {
		t.Fatal("metadata RPC did not return one JSON frame")
	}
	return frame, output.String()
}

func assertMetadataFrame(t *testing.T, frame map[string]any, raw, phase, state string, scope Scope) {
	t.Helper()
	if frame["error"] != string(ErrDatabase) || frame["result"] != nil {
		t.Error("metadata diagnostics changed the original refusal")
	}
	diagnostic, ok := frame["metadataFailure"].(map[string]any)
	if !ok || len(diagnostic) != 3 || diagnostic["phase"] != phase || diagnostic["sqlState"] != state {
		t.Error("metadata failure omitted its exact phase or SQLSTATE")
		return
	}
	build, ok := diagnostic["build"].(map[string]any)
	if !ok || len(build) != 2 {
		t.Fatal("metadata failure omitted its bounded build identity")
	}
	revision, revisionOK := build["revision"].(string)
	dirty, dirtyOK := build["dirty"].(string)
	if !revisionOK || !dirtyOK || !((revision == "unknown" && dirty == "unknown") || (regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(revision) && (dirty == "clean" || dirty == "dirty"))) {
		t.Error("metadata build identity did not fail closed")
	}
	for _, private := range []string{scope.OwnerID, scope.WorkspaceID, scope.ConnectionID, "byos_connections", "postgresql://", "fixture-private", strings.Repeat("f", 40)} {
		if strings.Contains(raw, private) {
			t.Error("metadata IPC disclosed private data or used the API environment as Go identity")
		}
	}
}

func TestMetadataRPCReportsRealDatabaseFailures(t *testing.T) {
	t.Setenv("MIKKA_BUILD_REVISION", strings.Repeat("f", 40))
	w := metadataFixture(t)
	metadataGuard(t, w)
	readOnly := metadataDatabaseSetting(t, w, "default_transaction_read_only", "on")
	missingTable := metadataDatabaseSetting(t, w, "search_path", "pg_catalog")
	cases := []struct {
		name, method, phase, state string
		worker                     *Worker
		probe                      func() error
	}{
		{"record_scan_guard", "acquire", "record_scan", "55000", w, func() error { _, err := w.Repo.BeginAcquire(context.Background(), w.Scope, 1); return err }},
		{"record_scan_missing_relation", "status", "record_scan", "42P01", missingTable, func() error { _, err := missingTable.Repo.Lookup(context.Background(), w.Scope); return err }},
		{"disconnect_guard", "disconnect", "disconnect", "55000", w, func() error { return w.Repo.Disconnect(context.Background(), w.Scope, 1) }},
		{"disconnect_read_only", "disconnect", "disconnect", "25006", readOnly, func() error { return readOnly.Repo.Disconnect(context.Background(), w.Scope, 1) }},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			err := item.probe()
			var cause *pgconn.PgError
			if !errors.Is(err, ErrDatabase) || !errors.As(err, &cause) || cause.Code != item.state || err.Error() != string(ErrDatabase) {
				t.Error("metadata failure lost its original PG cause or refusal identity")
			}
			frame, raw := metadataRPC(t, item.worker, item.method)
			assertMetadataFrame(t, frame, raw, item.phase, item.state, w.Scope)
		})
	}
	record, err := w.Repo.Lookup(context.Background(), w.Scope)
	if err != nil || record.State != "pending" || record.Epoch != 1 {
		t.Fatal("diagnostics changed a guard-refused connection")
	}
}

func TestMetadataRPCNonSQLFailureDoesNotInventState(t *testing.T) {
	w := metadataFixture(t)
	closed := metadataDatabaseSetting(t, w, "application_name", "metadata-fixture")
	_ = closed.Repo.DB.Close()
	frame, raw := metadataRPC(t, closed, "status")
	assertMetadataFrame(t, frame, raw, "record_scan", "unknown", w.Scope)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := w.Repo.Lookup(ctx, w.Scope)
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrDatabase) {
		t.Error("metadata failure discarded the original cancellation cause")
	}
}

func TestMetadataDiagnosticsLeaveSuccessAndUnavailableUnchanged(t *testing.T) {
	w := metadataFixture(t)
	for _, method := range []string{"status", "disconnect"} {
		frame, _ := metadataRPC(t, w, method)
		if frame["error"] != nil || frame["result"] == nil || frame["metadataFailure"] != nil {
			t.Error("metadata diagnostics changed the successful result")
		}
	}
	frame, _ := metadataRPC(t, w, "disconnect")
	if frame["error"] != string(ErrStale) || frame["metadataFailure"] != nil {
		t.Error("metadata diagnostics changed stale-epoch refusal")
	}
	w.Scope.OwnerID = newID()
	frame, _ = metadataRPC(t, w, "status")
	if frame["error"] != string(ErrUnavailable) || frame["metadataFailure"] != nil {
		t.Error("metadata diagnostics changed wrong-owner refusal")
	}
}

func TestMetadataDiagnosticsPreserveCauseWithoutSerializingIt(t *testing.T) {
	cause := &pgconn.PgError{Code: "55000", Message: "fixture-private SQL postgres://credential", Detail: "fixture-private-owner", Where: "fixture-private-query"}
	failure := &metadataFailure{phase: "disconnect", cause: fmt.Errorf("fixture-private context: %w", cause)}
	if !errors.Is(failure, cause) || !errors.Is(failure, ErrDatabase) || safeCode(failure) != string(ErrDatabase) || failure.Error() != string(ErrDatabase) {
		t.Fatal("metadata wrapper changed cause or refusal semantics")
	}
	diagnostic := metadataDiagnosticFor(failure)
	raw, err := json.Marshal(diagnostic)
	if err != nil || diagnostic == nil || diagnostic.SQLState != "55000" || strings.Contains(string(raw), "fixture-private") || strings.Contains(string(raw), "postgres://") {
		t.Fatal("metadata projection exposed the original error")
	}
	for _, code := range []string{"", "00000", "42p01", "55000\nfixture-private", "fixture-private"} {
		failure.cause = &pgconn.PgError{Code: code}
		if metadataDiagnosticFor(failure).SQLState != "unknown" {
			t.Error("invalid driver state was treated as a known failure")
		}
	}
	failure.cause = errors.New("55000 fixture-private")
	if metadataDiagnosticFor(failure).SQLState != "unknown" {
		t.Error("metadata diagnostic inferred SQLSTATE from error text")
	}
	failure.phase = "fixture-private"
	if metadataDiagnosticFor(failure) != nil || metadataDiagnosticFor(ErrDatabase) != nil {
		t.Error("unobserved phases acquired a diagnostic")
	}
}

func TestMetadataBuildIdentityRequiresCompleteEmbeddedGoSettings(t *testing.T) {
	t.Setenv("MIKKA_BUILD_REVISION", strings.Repeat("f", 40))
	revision := strings.Repeat("1", 40)
	settings := []debug.BuildSetting{{Key: "vcs", Value: "git"}, {Key: "vcs.revision", Value: revision}, {Key: "vcs.modified", Value: "false"}}
	for _, dirty := range []string{"false", "true"} {
		info := &debug.BuildInfo{Settings: append([]debug.BuildSetting{}, settings...)}
		info.Settings[2].Value = dirty
		want := "clean"
		if dirty == "true" {
			want = "dirty"
		}
		if got := metadataBuildIdentity(info); got.Revision != revision || got.Dirty != want {
			t.Error("valid Go VCS metadata was lost")
		}
	}
	invalid := []*debug.BuildInfo{nil, {}, {Settings: settings[:2]}, {Settings: settings[1:]},
		{Settings: append(append([]debug.BuildSetting{}, settings...), settings[0])},
	}
	for _, item := range []struct {
		index int
		value string
	}{{0, "fixture-private"}, {1, "fixture-private"}, {1, "unknown"}, {2, "unknown"}, {2, "FALSE"}} {
		info := &debug.BuildInfo{Settings: append([]debug.BuildSetting{}, settings...)}
		info.Settings[item.index].Value = item.value
		invalid = append(invalid, info)
	}
	for _, info := range invalid {
		if got := metadataBuildIdentity(info); got.Revision != "unknown" || got.Dirty != "unknown" {
			t.Error("missing or malformed Go identity did not stay unknown")
		}
	}
}

func TestMetadataProductionExecutableReportsOnlyBoundedDiagnostics(t *testing.T) {
	w := metadataFixture(t)
	metadataGuard(t, w)
	binary := os.Getenv("MIKKA_BYOS_WORKER_BINARY")
	if binary == "" {
		t.Fatal("real production worker executable is required")
	}
	for _, item := range []struct{ method, setting, value, phase, state string }{
		{"disconnect", "", "", "disconnect", "55000"},
		{"disconnect", "default_transaction_read_only", "on", "disconnect", "25006"},
		{"status", "search_path", "pg_catalog", "record_scan", "42P01"},
	} {
		t.Run(item.phase+"_"+item.state, func(t *testing.T) {
			u, err := url.Parse(os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"))
			if err != nil {
				t.Fatal("invalid fixture database URL")
			}
			if item.setting != "" {
				query := u.Query()
				query.Set(item.setting, item.value)
				u.RawQuery = query.Encode()
			}
			config := map[string]any{"scope": w.Scope, "databaseUrl": u.String(), "infisicalOrigin": "https://127.0.0.1:1", "project": "fixture", "environment": "test", "path": "/grants", "workloadToken": "fixture-private-token", "accessPath": "/access", "enableRuntime": false, "enablePlainModels": false}
			var input, output, stderr bytes.Buffer
			encoder := json.NewEncoder(&input)
			if encoder.Encode(config) != nil || encoder.Encode(map[string]any{"id": "fixture", "method": item.method, "revision": 1}) != nil {
				t.Fatal("worker fixture encoding failed")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, binary)
			command.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8", "MIKKA_BUILD_REVISION=" + strings.Repeat("f", 40)}
			command.Stdin, command.Stdout, command.Stderr = &input, &output, &stderr
			if err := command.Run(); err != nil || stderr.Len() != 0 {
				t.Fatal("production worker failed before the bounded response")
			}
			var frame map[string]any
			if json.Unmarshal(output.Bytes(), &frame) != nil {
				t.Fatal("production worker returned invalid IPC")
			}
			assertMetadataFrame(t, frame, output.String(), item.phase, item.state, w.Scope)
		})
	}
}
