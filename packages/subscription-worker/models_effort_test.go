package worker

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestCodexEffortsReadTheAccountCatalogue(t *testing.T) {
	levels := json.RawMessage(`[{"effort":"low","description":"private"},{"effort":"medium"},{"effort":"xhigh"},{"effort":"ultra"},{"effort":"medium"}]`)
	if got, want := codexEfforts(levels), []string{"low", "medium", "xhigh", "ultra"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("codexEfforts = %v; want %v", got, want)
	}
	if got := codexEfforts(json.RawMessage(`["low","high"]`)); !reflect.DeepEqual(got, []string{"low", "high"}) {
		t.Fatalf("plain names = %v", got)
	}
	for _, raw := range []string{``, `null`, `{}`, `[{"effort":"Bad Level"}]`, `[3]`} {
		if got := codexEfforts(json.RawMessage(raw)); got != nil {
			t.Fatalf("codexEfforts(%q) = %v; want unknown", raw, got)
		}
	}
	if got := codexEfforts(json.RawMessage(`[]`)); got == nil || len(got) != 0 {
		t.Fatalf("an empty list is known: none, got %v", got)
	}
	if defaultEffort([]string{"low", "medium"}, "medium") != "medium" || defaultEffort([]string{"low"}, "high") != "" {
		t.Fatal("the default is kept only when it is a listed level")
	}
}

func TestClaudeEffortsReadModelCapabilities(t *testing.T) {
	caps := json.RawMessage(`{"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":false},"max":{"supported":true}}}`)
	if got, want := claudeEfforts(caps), []string{"low", "medium", "high", "max"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("claudeEfforts = %v; want %v", got, want)
	}
	if got := claudeEfforts(json.RawMessage(`{"effort":{"supported":false}}`)); got == nil || len(got) != 0 {
		t.Fatalf("an unsupported effort is known: none, got %v", got)
	}
	for _, raw := range []string{``, `{}`, `{"fast_mode":{"supported":true}}`, `{"effort":{"low":{}}}`, `{"effort":{}}`} {
		if got := claudeEfforts(json.RawMessage(raw)); got != nil {
			t.Fatalf("claudeEfforts(%q) = %v; want unknown", raw, got)
		}
	}
}
