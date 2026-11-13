package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Limit is one usage window: how much of it is used and when it starts over.
type Limit struct {
	Percent  float64 `json:"percent"`
	ResetsAt string  `json:"resets_at,omitempty"`
	Severity string  `json:"severity,omitempty"`
}

// Report is what both the panel and the terminal view draw.
type Report struct {
	Plan      string   `json:"plan,omitempty"`
	FetchedAt string   `json:"fetched_at"`
	Session   *Limit   `json:"session"`
	Weekly    *Limit   `json:"weekly"`
	Model     *Limit   `json:"model"`
	ModelName string   `json:"model_name"`
	Models    []string `json:"models"`
}

// usageError carries a kind the views turn into advice.
type usageError struct {
	Kind string
	Msg  string
}

func (e *usageError) Error() string { return e.Msg }

func errorKind(err error) string {
	var u *usageError
	if errors.As(err, &u) {
		return u.Kind
	}
	return "api"
}

// Stand-ins for tests.
var (
	endpoint        = "https://api.anthropic.com/api/oauth/usage"
	client          = &http.Client{Timeout: 15 * time.Second}
	readCredentials = credentialsJSON
	now             = time.Now
)

// credentialsJSON reads Claude Code's login: a file on Linux, the keychain on macOS
// when there is no file. Claude Code keeps it fresh; this program never renews it,
// since renewing would replace the refresh token Claude Code holds.
func credentialsJSON() ([]byte, error) {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".claude")
	}
	b, err := os.ReadFile(filepath.Join(dir, ".credentials.json"))
	if err == nil {
		return b, nil
	}
	if runtime.GOOS == "darwin" {
		if out, kerr := exec.Command("security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output(); kerr == nil {
			return out, nil
		}
	}
	return nil, &usageError{"login", "Not signed in to Claude: run `claude` and log in"}
}

type credentials struct {
	OAuth *struct {
		AccessToken      string `json:"accessToken"`
		ExpiresAt        int64  `json:"expiresAt"`
		SubscriptionType string `json:"subscriptionType"`
		RateLimitTier    string `json:"rateLimitTier"`
	} `json:"claudeAiOauth"`
}

var tierMultiple = regexp.MustCompile(`(\d+)x`)

// planName turns "max" and "default_claude_max_20x" into "MAX 20X".
func planName(subscription, tier string) string {
	name := strings.ToUpper(subscription)
	if m := tierMultiple.FindStringSubmatch(tier); m != nil && name != "" {
		name += " " + m[1] + "X"
	}
	return name
}

func token() (string, string, error) {
	b, err := readCredentials()
	if err != nil {
		return "", "", err
	}
	var c credentials
	if json.Unmarshal(b, &c) != nil || c.OAuth == nil || c.OAuth.AccessToken == "" {
		return "", "", &usageError{"login", "Not signed in to Claude with a subscription: run `claude` and log in"}
	}
	if c.OAuth.ExpiresAt > 0 && now().UnixMilli() >= c.OAuth.ExpiresAt {
		return "", "", &usageError{"expired", "Claude login expired: start Claude Code once to renew it"}
	}
	return c.OAuth.AccessToken, planName(c.OAuth.SubscriptionType, c.OAuth.RateLimitTier), nil
}

func fetch(ctx context.Context, accessToken string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "claude-usage-herdr-mod/1.0")
	res, err := client.Do(req)
	if err != nil {
		return nil, &usageError{"network", "Can't reach api.anthropic.com: " + err.Error()}
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, &usageError{"network", "Reading the usage answer failed: " + err.Error()}
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return nil, &usageError{"expired", "Claude login expired: start Claude Code once to renew it"}
	case res.StatusCode == http.StatusTooManyRequests:
		return nil, &usageError{"api", "Usage endpoint is rate limiting; trying again later"}
	case res.StatusCode != http.StatusOK:
		return nil, &usageError{"api", fmt.Sprintf("Usage endpoint answered %d", res.StatusCode)}
	}
	return body, nil
}

type rawWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

type rawLimit struct {
	Kind     string   `json:"kind"`
	Percent  *float64 `json:"percent"`
	Severity string   `json:"severity"`
	ResetsAt *string  `json:"resets_at"`
	Scope    *struct {
		Model *struct {
			DisplayName string `json:"display_name"`
		} `json:"model"`
	} `json:"scope"`
}

type rawUsage struct {
	FiveHour *rawWindow `json:"five_hour"`
	SevenDay *rawWindow `json:"seven_day"`
	Limits   []rawLimit `json:"limits"`
}

func str(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func fromLimit(l rawLimit) *Limit {
	if l.Percent == nil {
		return nil
	}
	return &Limit{Percent: *l.Percent, ResetsAt: str(l.ResetsAt), Severity: l.Severity}
}

func fromWindow(w *rawWindow) *Limit {
	if w == nil || w.Utilization == nil {
		return nil
	}
	return &Limit{Percent: *w.Utilization, ResetsAt: str(w.ResetsAt), Severity: "normal"}
}

// parse reads the endpoint's answer. `limits[]` is preferred; the older
// five_hour/seven_day objects stand in when it is missing.
func parse(body []byte, model string) (Report, error) {
	var raw rawUsage
	if err := json.Unmarshal(body, &raw); err != nil {
		return Report{}, &usageError{"api", "Usage endpoint answered something unreadable"}
	}
	report := Report{ModelName: model, Models: []string{}}
	for _, l := range raw.Limits {
		switch l.Kind {
		case "session":
			report.Session = fromLimit(l)
		case "weekly_all":
			report.Weekly = fromLimit(l)
		case "weekly_scoped":
			if l.Scope == nil || l.Scope.Model == nil || l.Scope.Model.DisplayName == "" {
				continue
			}
			name := l.Scope.Model.DisplayName
			report.Models = append(report.Models, name)
			if strings.EqualFold(name, model) && report.Model == nil {
				report.Model = fromLimit(l)
				report.ModelName = name
			}
		}
	}
	if report.Session == nil {
		report.Session = fromWindow(raw.FiveHour)
	}
	if report.Weekly == nil {
		report.Weekly = fromWindow(raw.SevenDay)
	}
	return report, nil
}

// load is one complete read: login, request, answer.
func load(ctx context.Context, model string) (Report, error) {
	accessToken, plan, err := token()
	if err != nil {
		return Report{}, err
	}
	body, err := fetch(ctx, accessToken)
	if err != nil {
		return Report{}, err
	}
	report, err := parse(body, model)
	if err != nil {
		return Report{}, err
	}
	report.Plan = plan
	report.FetchedAt = now().UTC().Format(time.RFC3339)
	return report, nil
}

// Level is how worrying a limit is: "ok", "warn" or "crit". The server's own
// severity wins when it is anything but normal.
func Level(l *Limit) string {
	if l == nil {
		return "ok"
	}
	switch strings.ToLower(l.Severity) {
	case "", "normal", "ok":
	case "critical", "exceeded", "rejected", "blocked", "error":
		return "crit"
	default:
		if l.Percent < 90 {
			return "warn"
		}
	}
	switch {
	case l.Percent >= 90:
		return "crit"
	case l.Percent >= 75:
		return "warn"
	}
	return "ok"
}

// Countdown is the time left, to the second under a day and to the minute above.
func Countdown(d time.Duration) string {
	if d <= 0 {
		return "00h 00m 00s"
	}
	d = d.Truncate(time.Second)
	days := int(d / (24 * time.Hour))
	h := int(d/time.Hour) % 24
	m := int(d/time.Minute) % 60
	s := int(d/time.Second) % 60
	if days > 0 {
		return fmt.Sprintf("%dd %02dh %02dm", days, h, m)
	}
	return fmt.Sprintf("%02dh %02dm %02ds", h, m, s)
}
