package worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func accessProgramsSent(t *testing.T, programs any, present bool) map[string]any {
	t.Helper()
	payload := map[string]any{"model": "fixture-model", "messages": []any{map[string]any{"role": "user", "content": "fixture-user"}}}
	if present {
		payload["access_programs"] = programs
	}
	input, _ := json.Marshal(payload)
	var sent map[string]any
	model := CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(req.Body).Decode(&sent); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(tierTestEvent("response.completed", nil, false)))}, nil
	})}}
	ctx := context.WithValue(context.Background(), codexSessionKey{}, "fixture-session")
	result, err := model.ExecuteStream(ctx, &core.Auth{Metadata: map[string]any{"access_token": "fixture-token", "account_id": "fixture-account"}}, ex.Request{Model: "fixture-model", Payload: input}, ex.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
	}
	return sent
}

// Daybreak reaches the Codex backend only as the documented Responses wire shape.
func TestCodexAccessProgramsPassOnlyDaybreakTiers(t *testing.T) {
	baseline := accessProgramsSent(t, nil, false)
	if _, ok := baseline["access_programs"]; ok {
		t.Fatal("an absent selection was invented")
	}
	for _, tc := range []struct {
		value any
		want  any
	}{
		{map[string]any{"cyber": "daybreak_blue"}, map[string]any{"cyber": "daybreak_blue"}},
		{map[string]any{"cyber": "daybreak_red", "other": "x"}, map[string]any{"cyber": "daybreak_red"}},
		{map[string]any{"cyber": "standard"}, nil},
		{map[string]any{"cyber": "fixture-private"}, nil},
		{"daybreak_blue", nil},
	} {
		sent := accessProgramsSent(t, tc.value, true)
		got, ok := sent["access_programs"]
		if tc.want == nil {
			if ok {
				t.Fatalf("%v reached upstream as %v", tc.value, got)
			}
		} else if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("access_programs = %v, want %v", got, tc.want)
		}
		delete(sent, "access_programs")
		if !reflect.DeepEqual(sent, baseline) {
			t.Fatal("the selection changed other request fields")
		}
	}
}
