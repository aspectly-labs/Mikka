package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Native clients send their original protocol through a task-bound broker.
// Provider access credentials remain in this process, outside the CLI runtime.
// This does not invoke CPA's native fingerprint/identity executors.
type NativeRequest struct {
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type NativeContext struct {
	AccountID string    `json:"accountId"`
	Plan      string    `json:"plan,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (w *Worker) NativeContext(ctx context.Context, epoch int64) (NativeContext, error) {
	if w.Use == nil || w.Use.RunID == "" {
		return NativeContext{}, ErrUnavailable
	}
	if err := w.authorizeRuntime(ctx, epoch, "native", ""); err != nil {
		return NativeContext{}, err
	}
	r, auth, err := w.readyAuth(ctx, epoch)
	if err != nil || core.IsCodexUseSIWC(auth) {
		return NativeContext{}, ErrUnavailable
	}
	expires, known := auth.AccessTokenExpirationTime()
	if !known {
		return NativeContext{}, ErrCredential
	}
	account := r.Subject
	plan := ""
	if w.Scope.Provider == "codex" {
		account, _ = auth.Metadata["account_id"].(string)
		plan, _ = auth.Metadata["plan_type"].(string)
	}
	return NativeContext{AccountID: account, Plan: plan, ExpiresAt: expires}, nil
}

var nativeGenerationID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (w *Worker) NativeStream(ctx context.Context, epoch int64, request NativeRequest, head func(string, string) error, emit func([]byte) error) error {
	if w.Use == nil || w.Use.RunID == "" {
		return ErrUnavailable
	}
	var body struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if len(request.Body) > 262144 || json.Unmarshal(request.Body, &body) != nil || !modelPattern.MatchString(body.Model) || len(request.Headers) > 32 {
		return ErrUnsupported
	}
	ctx, stopAuthority, eventDriven := w.watchActiveAuthority(ctx)
	defer stopAuthority()
	if err := w.authorizeRuntime(ctx, epoch, "native", body.Model); err != nil {
		return err
	}
	var canonical map[string]any
	canonicalDecoder := json.NewDecoder(bytes.NewReader(request.Body))
	canonicalDecoder.UseNumber()
	if canonicalDecoder.Decode(&canonical) != nil {
		return ErrUnsupported
	}
	request.Body, _ = json.Marshal(canonical)
	route := ""
	switch {
	case w.Scope.Provider == "claude" && (request.Path == "/v1/messages" || request.Path == "/v1/messages?beta=true"):
		route = "/v1/mikka/subscription/claude/messages"
		var body map[string]any
		decoder := json.NewDecoder(bytes.NewReader(request.Body))
		decoder.UseNumber()
		if decoder.Decode(&body) != nil {
			return ErrUnsupported
		}
		body["system"] = claudeSubscriptionSystem(body["system"])
		request.Body, _ = json.Marshal(body)
	case w.Scope.Provider == "claude" && request.Path == "/v1/messages/count_tokens":
		route = "/v1/mikka/subscription/claude/count_tokens"
	case w.Scope.Provider == "codex" && request.Path == "/responses":
		route = "/v1/mikka/subscription/codex/responses"
		canonical["store"] = false
		request.Body, _ = json.Marshal(canonical)
	default:
		return ErrUnsupported
	}
	base, err := url.Parse(w.NativeLiteLLMURL)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" ||
		base.User != nil || base.RawQuery != "" || base.Fragment != "" || w.NativeLiteLLMKey == "" {
		return ErrUnavailable
	}
	endpoint := strings.TrimSuffix(strings.TrimRight(base.String(), "/"), "/v1") + route
	r, auth, err := w.readyAuth(ctx, epoch)
	if err != nil || core.IsCodexUseSIWC(auth) {
		return ErrUnavailable
	}
	token, _ := auth.Metadata["access_token"].(string)
	if token == "" {
		return ErrCredential
	}
	callCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	upstream, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(request.Body))
	if err != nil {
		return ErrUnsupported
	}
	// Only protocol headers produced by the actual native client are forwarded.
	// No client-supplied URL, cookie, authorization, account or proxy credentials.
	for key, value := range request.Headers {
		name := strings.ToLower(key)
		if len(value) > 4096 || strings.ContainsAny(value, "\r\n\x00") {
			return ErrUnsupported
		}
		switch name {
		case "accept", "content-type", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta", "originator", "x-app":
			upstream.Header.Set(name, value)
		}
	}
	upstream.Header.Set("Authorization", "Bearer "+token)
	upstream.Header.Set("x-litellm-api-key", "Bearer "+w.NativeLiteLLMKey)
	if w.Scope.Provider == "claude" {
		beta := upstream.Header.Get("anthropic-beta")
		const oauth = "oauth-2025-04-20"
		if beta == "" {
			upstream.Header.Set("anthropic-beta", oauth)
		} else if !strings.Contains(","+strings.ReplaceAll(beta, " ", "")+",", ","+oauth+",") {
			upstream.Header.Set("anthropic-beta", beta+","+oauth)
		}
		if upstream.Header.Get("anthropic-version") == "" {
			upstream.Header.Set("anthropic-version", "2023-06-01")
		}
	}
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("User-Agent", "Mikka/1.0")
	if w.Scope.Provider == "codex" {
		account, _ := auth.Metadata["account_id"].(string)
		upstream.Header.Set("ChatGPT-Account-Id", account)
		upstream.Header.Set("Originator", "Mikka")
	}
	client := http.Client{Timeout: 270 * time.Second}
	if w.NativeClient != nil {
		client = *w.NativeClient
	}
	client.Timeout = 270 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// Check revocation even while upstream is silent; closing IPC also cancels.
	done := make(chan struct{})
	defer close(done)
	if !eventDriven {
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-callCtx.Done():
					return
				case <-ticker.C:
					if w.authorizeRuntime(callCtx, epoch, "native_active", body.Model) != nil {
						cancel()
						return
					}
				}
			}
		}()
	}
	response, err := client.Do(upstream)
	if err != nil {
		if callCtx.Err() != nil {
			return ErrUnavailable
		}
		kind := "network_error"
		if callCtx.Err() == context.DeadlineExceeded {
			kind = "timeout_error"
		}
		return providerTransportFailure(w.Scope.Provider, kind, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		failureBody, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
		return providerFailure(providerStatusFailure(response.StatusCode), w.Scope.Provider, response.StatusCode, failureBody, request.Body, token, w.NativeLiteLLMKey)
	}
	contentType := strings.Split(response.Header.Get("Content-Type"), ";")[0]
	if contentType == "" && w.Scope.Provider == "codex" && body.Stream {
		contentType = "text/event-stream"
	}
	if contentType != "text/event-stream" && contentType != "application/json" {
		return ErrProvider
	}
	if callCtx.Err() != nil {
		return ErrUnavailable
	}
	generationID := response.Header.Get("x-litellm-call-id")
	if !nativeGenerationID.MatchString(generationID) {
		generationID = ""
	}
	if err = head(contentType, generationID); err != nil {
		return ErrUnavailable
	}
	// Retain a token-sized tail so an upstream echo split across chunks cannot
	// leak a bearer into the native client, tools, events or diagnostics.
	carry := []byte{}
	buffer := make([]byte, 8192)
	for {
		n, readErr := response.Body.Read(buffer)
		carry = append(carry, buffer[:n]...)
		if bytes.Contains(carry, []byte(token)) || bytes.Contains(carry, []byte(w.NativeLiteLLMKey)) {
			return ErrIntegrity
		}
		if eventDriven {
			if callCtx.Err() != nil {
				return ErrUnavailable
			}
		} else if w.authorizeRuntime(ctx, r.Epoch, "native_active", body.Model) != nil {
			return ErrUnavailable
		}
		flush := len(carry) - max(len(token), len(w.NativeLiteLLMKey)) + 1
		if readErr == io.EOF {
			flush = len(carry)
		}
		if flush > 0 {
			if callCtx.Err() != nil {
				return ErrUnavailable
			}
			if emit(carry[:flush]) != nil {
				return ErrUnavailable
			}
			carry = append([]byte(nil), carry[flush:]...)
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return ErrProvider
		}
	}
}
