package worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// ModelOption is the only provider catalogue data sent to the web process.
// Credentials, descriptions, other capabilities and provider error bodies stay here.
type ModelOption struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	PrioritySupported  *bool  `json:"prioritySupported,omitempty"`
	UltrafastSupported *bool  `json:"ultrafastSupported,omitempty"`
	FastSupported      *bool  `json:"fastSupported,omitempty"`
	// Efforts are the reasoning levels the provider lists for this model, in its
	// order; nil when the provider said nothing (unknown), empty when it says none.
	Efforts       []string `json:"efforts,omitempty"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
	// Daybreak lists the Trusted Access for Cyber tiers ("blue", "red") the account's
	// catalogue accepts for this model; omitted when it offers none or says nothing.
	Daybreak []string `json:"daybreak,omitempty"`
}

// effortPattern keeps a provider's level names to short lowercase words.
var effortPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,15}$`)

var modelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// Models reads only the owner's connected account. Like Usage it is a custody
// read, not an inference call, and does not require or create a model binding.
func (w *Worker) Models(ctx context.Context, epoch int64) ([]ModelOption, error) {
	if w.ExecutionOnly || w.Use != nil {
		return nil, ErrUnsupported
	}
	_, auth, err := w.readyAuth(ctx, epoch)
	if err != nil {
		return nil, err
	}
	// Codex's ModelsClient appends client_version to the fixed /models path.
	// The query pins the catalogue protocol compatibility, not a model name.
	// Sources: openai/codex codex-rs/codex-api/src/endpoint/models.rs;
	// anthropics/anthropic-sdk-typescript src/resources/models.ts.
	endpoint := "https://chatgpt.com/backend-api/codex/models?client_version=0.167.0"
	if w.Scope.Provider == "claude" {
		endpoint = "https://api.anthropic.com/v1/models?limit=100"
	} else if w.Scope.Provider != "codex" {
		return nil, ErrUnsupported
	}
	client := http.Client{Timeout: 10 * time.Second}
	if w.ModelsClient != nil {
		client = *w.ModelsClient
	}
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	options := []ModelOption{}
	seen := map[string]bool{}
	for page := 0; page < 5; page++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		token, _ := auth.Metadata["access_token"].(string)
		if token == "" {
			return nil, ErrCredential
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "Mikka/1.0")
		if w.Scope.Provider == "claude" {
			req.Header.Set("anthropic-version", "2023-06-01")
			req.Header.Set("anthropic-beta", "oauth-2025-04-20")
		} else {
			account, _ := auth.Metadata["account_id"].(string)
			req.Header.Set("ChatGPT-Account-Id", account)
		}
		response, err := client.Do(req)
		if err != nil {
			return nil, ErrProvider
		}
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, 1048577))
		response.Body.Close()
		if readErr != nil || len(raw) > 1048576 || response.StatusCode != http.StatusOK {
			return nil, ErrProvider
		}
		var body struct {
			Models []struct {
				Slug            string          `json:"slug"`
				Name            string          `json:"display_name"`
				Visibility      string          `json:"visibility"`
				ServiceTiers    json.RawMessage `json:"service_tiers"`
				ReasoningLevels json.RawMessage `json:"supported_reasoning_levels"`
				DefaultLevel    string          `json:"default_reasoning_level"`
				AccessPrograms  json.RawMessage `json:"available_access_programs"`
			} `json:"models"`
			Data []struct {
				ID               string          `json:"id"`
				Name             string          `json:"display_name"`
				SupportsFastMode *bool           `json:"supports_fast_mode"`
				Capabilities     json.RawMessage `json:"capabilities"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if json.Unmarshal(raw, &body) != nil {
			return nil, ErrProvider
		}
		entries := []ModelOption{}
		if w.Scope.Provider == "codex" {
			if body.Models == nil {
				return nil, ErrProvider
			}
			for _, m := range body.Models {
				if m.Visibility == "" || m.Visibility == "list" {
					efforts := codexEfforts(m.ReasoningLevels)
					entries = append(entries, ModelOption{
						ID:                 m.Slug,
						Name:               m.Name,
						PrioritySupported:  codexPrioritySupported(m.ServiceTiers),
						UltrafastSupported: codexUltrafastSupported(m.ServiceTiers),
						Efforts:            efforts,
						DefaultEffort:      defaultEffort(efforts, m.DefaultLevel),
						Daybreak:           codexDaybreakTiers(m.AccessPrograms),
					})
				}
			}
		} else {
			if body.Data == nil {
				return nil, ErrProvider
			}
			for _, m := range body.Data {
				entries = append(entries, ModelOption{
					ID:            m.ID,
					Name:          m.Name,
					FastSupported: claudeFastSupported(m.SupportsFastMode, m.Capabilities),
					Efforts:       claudeEfforts(m.Capabilities),
				})
			}
		}
		if len(entries) > 500 {
			return nil, ErrProvider
		}
		for _, m := range entries {
			if !modelIDPattern.MatchString(m.ID) {
				continue
			}
			if seen[m.ID] {
				continue
			}
			name := strings.TrimSpace(m.Name)
			if len(name) == 0 || len(name) > 200 || strings.ContainsFunc(name, unicode.IsControl) {
				name = m.ID
			}
			m.Name = name
			options = append(options, m)
			seen[m.ID] = true
			if len(options) > 500 {
				return nil, ErrProvider
			}
		}
		if w.Scope.Provider == "codex" || !body.HasMore {
			break
		}
		if page == 4 || !modelIDPattern.MatchString(body.LastID) {
			return nil, ErrProvider
		}
		next, _ := url.Parse("https://api.anthropic.com/v1/models")
		query := url.Values{"limit": {"100"}, "after_id": {body.LastID}}
		next.RawQuery = query.Encode()
		endpoint = next.String()
	}
	if current, err := w.Repo.Lookup(ctx, w.Scope); err != nil || current.Epoch != epoch || current.State != "connected" {
		return nil, ErrUnavailable
	}
	return options, nil
}

// codexServiceTierSupported projects only the account's current model catalogue.
// Missing or malformed capability data is unknown, never evidence of support.
func codexServiceTierSupported(raw json.RawMessage, target string) *bool {
	var tiers []map[string]json.RawMessage
	if json.Unmarshal(raw, &tiers) != nil || tiers == nil {
		return nil
	}
	supported := false
	for _, tier := range tiers {
		var id string
		if json.Unmarshal(tier["id"], &id) != nil || id == "" {
			return nil
		}
		supported = supported || id == target
	}
	return &supported
}

func codexPrioritySupported(raw json.RawMessage) *bool {
	return codexServiceTierSupported(raw, "priority")
}

func codexUltrafastSupported(raw json.RawMessage) *bool {
	return codexServiceTierSupported(raw, "ultrafast")
}

// claudeFastSupported projects explicit Anthropic fast-mode capability from /v1/models
// without reading Codex service_tiers or legacy speed aliases.
func claudeFastSupported(explicit *bool, capabilities json.RawMessage) *bool {
	if explicit != nil {
		v := *explicit
		return &v
	}
	if len(capabilities) == 0 {
		return nil
	}
	var parsed struct {
		FastMode *struct {
			Supported *bool `json:"supported"`
		} `json:"fast_mode"`
	}
	if json.Unmarshal(capabilities, &parsed) != nil || parsed.FastMode == nil || parsed.FastMode.Supported == nil {
		return nil
	}
	v := *parsed.FastMode.Supported
	return &v
}

// codexDaybreakTiers reads a Codex catalogue entry's available_access_programs:
// {"cyber": ["standard", "daybreak_blue", "daybreak_red", ...], "daybreak_availability": "available"}.
// Source: openai/codex codex-rs/protocol/src/openai_models.rs (ModelInfo) and
// openai_models/access_programs.rs (ModelAccessPrograms, DaybreakAvailability).
// Unknown programs are skipped, as Codex skips them. A model the server says needs
// enrollment, or is unavailable for, offers no tier. Malformed or absent data is none.
func codexDaybreakTiers(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var programs struct {
		Cyber        []json.RawMessage `json:"cyber"`
		Availability json.RawMessage   `json:"daybreak_availability"`
	}
	if json.Unmarshal(raw, &programs) != nil {
		return nil
	}
	var availability string
	_ = json.Unmarshal(programs.Availability, &availability)
	if availability == "enrollment_required" || availability == "unavailable_for_model" {
		return nil
	}
	tiers := []string{}
	for _, item := range programs.Cyber {
		var program string
		if json.Unmarshal(item, &program) != nil {
			continue
		}
		switch program {
		case "daybreak_blue":
			tiers = appendUnique(tiers, "blue")
		case "daybreak_red":
			tiers = appendUnique(tiers, "red")
		}
	}
	if len(tiers) == 0 {
		return nil
	}
	return tiers
}

// codexEfforts reads supported_reasoning_levels ([{effort, description}], or
// plain names). Descriptions stay here; malformed data is unknown (nil).
func codexEfforts(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	efforts := []string{}
	for _, item := range items {
		var name string
		if json.Unmarshal(item, &name) != nil {
			var preset struct {
				Effort string `json:"effort"`
			}
			if json.Unmarshal(item, &preset) != nil {
				return nil
			}
			name = preset.Effort
		}
		if !effortPattern.MatchString(name) {
			return nil
		}
		efforts = appendUnique(efforts, name)
	}
	return efforts
}

// claudeEfforts reads Anthropic's capabilities.effort: {supported, <level>: {supported}}.
// Levels are kept in Anthropic's documented order; absent data is unknown (nil).
func claudeEfforts(capabilities json.RawMessage) []string {
	if len(capabilities) == 0 {
		return nil
	}
	var parsed struct {
		Effort map[string]json.RawMessage `json:"effort"`
	}
	if json.Unmarshal(capabilities, &parsed) != nil || parsed.Effort == nil {
		return nil
	}
	var supported *bool
	if raw, ok := parsed.Effort["supported"]; ok && json.Unmarshal(raw, &supported) != nil {
		return nil
	}
	if supported != nil && !*supported {
		return []string{}
	}
	efforts := []string{}
	for _, level := range []string{"low", "medium", "high", "xhigh", "max"} {
		raw, ok := parsed.Effort[level]
		if !ok {
			continue
		}
		var flag struct {
			Supported *bool `json:"supported"`
		}
		if json.Unmarshal(raw, &flag) != nil || flag.Supported == nil {
			return nil
		}
		if *flag.Supported {
			efforts = append(efforts, level)
		}
	}
	if len(efforts) == 0 && supported == nil {
		return nil
	}
	return efforts
}

// defaultEffort keeps the provider's default only when it is one of the listed levels.
func defaultEffort(efforts []string, level string) string {
	for _, effort := range efforts {
		if effort == level {
			return level
		}
	}
	return ""
}

func appendUnique(list []string, value string) []string {
	for _, item := range list {
		if item == value {
			return list
		}
	}
	return append(list, value)
}
