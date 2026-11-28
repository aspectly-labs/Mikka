package worker

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The Codex catalogue's available_access_programs, as openai/codex
// protocol/src/openai_models/access_programs.rs reads it.
func TestCodexDaybreakTiersReadAccessPrograms(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
	}{
		{`{"cyber":["standard","daybreak_blue","future_program","daybreak_red"]}`, []string{"blue", "red"}},
		{`{"cyber":["daybreak_red"],"daybreak_availability":"available"}`, []string{"red"}},
		{`{"cyber":["daybreak_blue","daybreak_blue"],"daybreak_availability":"future_status"}`, []string{"blue"}},
		{`{"cyber":["standard","daybreak_blue"],"daybreak_availability":"enrollment_required"}`, nil},
		{`{"cyber":["daybreak_red"],"daybreak_availability":"unavailable_for_model"}`, nil},
		{`{"cyber":["standard"]}`, nil},
		{`{"cyber":[]}`, nil},
		{`{"cyber":[3,"daybreak_red"]}`, []string{"red"}},
		{``, nil},
		{`null`, nil},
		{`"daybreak_blue"`, nil},
	}
	for _, c := range cases {
		if got := codexDaybreakTiers(json.RawMessage(c.raw)); !reflect.DeepEqual(got, c.want) {
			t.Fatalf("codexDaybreakTiers(%s) = %v; want %v", c.raw, got, c.want)
		}
	}
}

func TestModelOptionDaybreakJSON(t *testing.T) {
	raw, _ := json.Marshal(ModelOption{ID: "gpt-6-sol", Name: "GPT-6 Sol", Daybreak: []string{"blue"}})
	if string(raw) != `{"id":"gpt-6-sol","name":"GPT-6 Sol","daybreak":["blue"]}` {
		t.Fatalf("option JSON = %s", raw)
	}
	raw, _ = json.Marshal(ModelOption{ID: "gpt-6-sol", Name: "GPT-6 Sol"})
	if string(raw) != `{"id":"gpt-6-sol","name":"GPT-6 Sol"}` {
		t.Fatalf("no tiers are omitted: %s", raw)
	}
}
